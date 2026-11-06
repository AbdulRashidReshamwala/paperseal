import { attestation as attestationSpec, attestationNonce, chain, encodeMessage, firstRoundAtOrAfter, fromHex, startupArgs, toHex, type ExamSettings, type Hex } from '@paperseal/protocol';
import type { AttestationResponse } from '@paperseal/tee-client';

import { makeMockPki } from '../../../../../e2e/mock/pki';
import type { ChainExam } from './machineVerdict';

/*
 * A sealed machine for tests: real RS256 tokens through a throwaway certificate chain and real P-256
 * keys, so the real checks run. Only the root differs, which a test trusts through mock mode's
 * `VITE_MOCK_TRUST_ROOT`.
 */

const subtle = globalThis.crypto.subtle;
const ecdsa = { name: 'ECDSA', namedCurve: 'P-256' };
const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Low-s r || s over the message preimage, as the machine signs. */
async function sign(key: CryptoKey, preimage: Uint8Array): Promise<Hex> {
  const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(preimage)));
  let s = 0n;
  for (const byte of raw.subarray(32)) s = (s << 8n) | BigInt(byte);
  if (s > order / 2n) raw.set(fromHex(`0x${(order - s).toString(16).padStart(64, '0')}`), 32);
  return toHex(raw);
}

export const REGISTRY: Hex = `0x${'c2'.repeat(20)}`;
export const BUCKET = 'exam-bucket';
export const examIdOf = (n: number): Hex => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;

/** A published exam, `startsIn` seconds away. */
export function chainExam(examId: Hex, startsIn = 86_400): ChainExam {
  const start = Math.floor(Date.now() / 1000) + startsIn;
  const round = (seconds: number) => BigInt(firstRoundAtOrAfter(seconds));
  return {
    commitHash: `0x${'01'.repeat(20)}`,
    imageDigest: `0x${'ab'.repeat(32)}`,
    createdAt: 1n,
    createdBlock: 1n,
    settings: {
      examId,
      examStart: BigInt(start),
      delta: 600n,
      lockRound: round(start - 7200),
      unlockRound: round(start - 600),
      endRound: round(start + 14_400),
      criteriaHash: `0x${'03'.repeat(32)}`,
      rpcHost: 'rpc.example.org',
    },
  };
}

function settingsOf(exam: ChainExam): ExamSettings {
  const { settings } = exam;
  return {
    examId: settings.examId,
    examStart: Number(settings.examStart),
    delta: Number(settings.delta),
    lockRound: settings.lockRound.toString(),
    unlockRound: settings.unlockRound.toString(),
    endRound: settings.endRound.toString(),
    criteriaHash: settings.criteriaHash,
    rpcHost: settings.rpcHost,
    registry: REGISTRY,
    chainId: chain.chainId,
  };
}

export interface Started {
  /** Start the machine with these settings in place of the exam's. */
  settings?: Partial<ExamSettings>;
  digest?: Hex;
  claims?: Record<string, unknown>;
  bucket?: string;
  /** A signature over some other exam's key message. */
  wrongInstanceKey?: boolean;
}

export async function testMachine() {
  const pki = makeMockPki();
  const signing = await subtle.generateKey(ecdsa, true, ['sign', 'verify']);
  const encryption = await subtle.generateKey(ecdsa, true, ['sign', 'verify']);
  const instancePublicKey = new Uint8Array(await subtle.exportKey('raw', signing.publicKey));
  const encryptionPublicKey = new Uint8Array(await subtle.exportKey('raw', encryption.publicKey));

  /** What the machine answers when it was started for `exam`. */
  async function started(exam: ChainExam, change: Started = {}): Promise<AttestationResponse> {
    const settings = { ...settingsOf(exam), ...change.settings };
    const examBytes = fromHex(settings.examId);
    const iat = Math.floor(Date.now() / 1000);
    const args = startupArgs(settings);
    const token = pki.mint({
      iss: attestationSpec.issuer,
      aud: attestationSpec.audience,
      iat,
      exp: iat + 3600,
      swname: attestationSpec.swname,
      dbgstat: attestationSpec.dbgstat,
      hwmodel: attestationSpec.hwModels[0],
      secboot: true,
      eat_nonce: attestationNonce(instancePublicKey, examBytes),
      submods: {
        confidential_space: { support_attributes: [attestationSpec.supportAttribute] },
        container: {
          image_digest: `sha256:${(change.digest ?? exam.imageDigest).slice(2)}`,
          args: ['/tee', ...args],
          cmd_override: args,
          env_override: { STORAGE_BUCKET: change.bucket ?? BUCKET },
        },
      },
      ...change.claims,
    });
    const signed = change.wrongInstanceKey ? new Uint8Array(32).fill(7) : examBytes;
    return {
      token,
      attested: true,
      instancePublicKey: toHex(instancePublicKey),
      encryptionPublicKey: toHex(encryptionPublicKey),
      instanceKeySignature: await sign(signing.privateKey, encodeMessage('instanceKey', { examId: signed, encryptionPublicKey })),
    };
  }

  return { started, rootBase64: btoa(String.fromCharCode(...pki.rootDer)), stop: pki.stop };
}
