import { hpkeSeal, verifyTeeSignature } from '@paperseal/crypto';
import type { Keys, PasskeySignature } from '@paperseal/keys';
import {
  approvedListHash,
  concatBytes,
  encodeMessage,
  equalBytes,
  fromHex,
  hashMessage,
  toHex,
  uintBE,
  type Hex,
} from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';

export const releaseSteps = [
  'fetch',
  'timelock',
  'attest',
  'listHash',
  'challenge',
  'release',
  'submit',
] as const;
export type ReleaseStep = (typeof releaseSteps)[number];

export const releaseStepLabels: Record<ReleaseStep, string> = {
  fetch: 'Download your encrypted share',
  timelock: 'Open the time seal',
  attest: 'Check the TEE attestation',
  listHash: 'Match the signed list to the chain',
  challenge: 'Get a fresh challenge',
  release: 'Touch your security key once to sign and open your share',
  submit: 'Send the share to the TEE',
};

export class ReleaseAbortedError extends Error {
  readonly step: ReleaseStep;

  constructor(step: ReleaseStep, message: string) {
    super(message);
    this.name = 'ReleaseAbortedError';
    this.step = step;
  }
}

export interface ReleaseContext {
  examId: Hex;
  holderId: string;
  credentialId: Uint8Array;
  keys: Pick<Keys, 'releaseShare'>;
  tee: Pick<TeeClient, 'attestation' | 'status' | 'releaseChallenge' | 'releaseShare'>;
  /** The holder's timelocked copy from public storage. */
  fetchEncryptedShare: () => Promise<string>;
  timelockDecrypt: (ciphertext: string) => Promise<Uint8Array>;
  /** Must throw unless the token is fully trusted, signature included. */
  verifyAttestation: (token: string, instancePublicKey: Hex) => Promise<void>;
  /** The approved list hash stored in ExamRegistry (`getApprovedList(examId).listHash`). */
  readOnChainListHash: () => Promise<Hex>;
  onStep?: (step: ReleaseStep) => void;
}

/** Provisional: spec/api.md does not define this body yet. Each part has a uint32 length. */
function encodeSubmission(share: Uint8Array, signed: PasskeySignature): Uint8Array {
  const framed = (bytes: Uint8Array) => concatBytes(uintBE(bytes.length, 4), bytes);
  return concatBytes(
    framed(share),
    framed(signed.signature),
    framed(signed.authenticatorData),
    framed(signed.clientDataJSON),
  );
}

/**
 * Confirm, Submit and the signature of the README's Share Release. Nothing is
 * signed or decrypted until the attestation has passed and the list hash the
 * TEE signed matches the chain. The one touch signs `shareRelease` (examId and
 * challenge) and opens the share in the same WebAuthn request. This flow stops at the holder's
 * own share: K_priv is never handled here.
 */
export async function runRelease(context: ReleaseContext): Promise<void> {
  const { keys, tee, examId, holderId, credentialId } = context;
  const step = (name: ReleaseStep) => context.onStep?.(name);

  step('fetch');
  const encrypted = await context.fetchEncryptedShare();

  step('timelock');
  const sealedShare = await context.timelockDecrypt(encrypted);

  step('attest');
  const { token, instancePublicKey } = await tee.attestation();
  await context.verifyAttestation(token, instancePublicKey);

  step('listHash');
  const { approvedList } = await tee.status();
  if (!approvedList) throw new ReleaseAbortedError('listHash', 'The TEE has no signed list.');
  if (approvedList.examId.toLowerCase() !== examId.toLowerCase()) {
    throw new ReleaseAbortedError('listHash', 'The TEE list is for a different exam.');
  }
  const message = encodeMessage('approvedList', {
    examId: fromHex(approvedList.examId),
    entries: fromHex(approvedList.entries),
  });
  const signedHash = approvedListHash(fromHex(approvedList.examId), fromHex(approvedList.entries));
  if (!equalBytes(signedHash, fromHex(approvedList.hash))) {
    throw new ReleaseAbortedError('listHash', 'The TEE list hash does not match its own list.');
  }
  const chainHash = await context.readOnChainListHash();
  if (!equalBytes(fromHex(chainHash), signedHash)) {
    throw new ReleaseAbortedError('listHash', 'The TEE list hash does not match the chain.');
  }
  const validSignature = await verifyTeeSignature(
    fromHex(instancePublicKey),
    fromHex(approvedList.teeSignature),
    message,
  );
  if (!validSignature) {
    throw new ReleaseAbortedError('listHash', 'The TEE signature on the list is invalid.');
  }

  step('challenge');
  const { challenge } = await tee.releaseChallenge({ holderId });

  step('release');
  const digest = hashMessage('shareRelease', {
    examId: fromHex(examId),
    challenge: fromHex(challenge),
  });
  // One touch: the passkey signs the digest and the same request opens the share.
  const { share, signature: signed } = await keys.releaseShare(credentialId, digest, sealedShare);
  try {
    step('submit');
    const sealed = await hpkeSeal(fromHex(instancePublicKey), encodeSubmission(share, signed));
    await tee.releaseShare({ examId, holderId, sealed: toHex(sealed) });
  } finally {
    share.fill(0);
  }
}
