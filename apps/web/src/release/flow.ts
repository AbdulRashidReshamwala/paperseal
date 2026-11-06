import type { TokenVerdict } from '@paperseal/attestation';
import { sealRelease, verifyTeeSignature } from '@paperseal/crypto';
import type { Keys } from '@paperseal/keys';
import {
  approvedListHash,
  decodeApprovedList,
  encodeMessage,
  equalBytes,
  fromHex,
  hashMessage,
  roles,
  storageNames,
  toHex,
  type Hex,
} from '@paperseal/protocol';
import { isReleaseNotOpen, RELEASE_NOT_OPEN_MESSAGE, type AttestationResponse, type TeeClient } from '@paperseal/tee-client';

import { describeVerdict } from '../shared/attest';
import { fetchListedFile, fetchManifest, StorageVerificationError, type BuildCommitment, type FetchFile } from '../shared/storage';

export const releaseSteps = ['attest', 'listHash', 'fetch', 'challenge', 'release', 'submit'] as const;
export type ReleaseStep = (typeof releaseSteps)[number];

export const releaseStepLabels: Record<ReleaseStep, string> = {
  attest: 'Check that this is the real Paper Seal',
  listHash: 'Check the list of people against the public record',
  fetch: 'Download your part of the key',
  challenge: 'Get ready for your security key',
  release: 'Touch your security key once',
  submit: 'Send your part of the key',
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
  credentialId: Uint8Array;
  /** The holder's own passkey public key, which the TEE and the approved list know them by. */
  passkeyPublicKey: Hex;
  /** Names the holder's share file, `shares/<derivedPublicKey>.bin`. */
  derivedPublicKey: Hex;
  keys: Pick<Keys, 'releaseShare'>;
  tee: Pick<TeeClient, 'attestation' | 'status' | 'releaseChallenge' | 'releaseShare'>;
  /** Runs `checkToken` on the attestation against ExamRegistry. Only `trusted` lets the flow go on. */
  checkAttestation: (attestation: AttestationResponse) => Promise<TokenVerdict>;
  /** The approved list hash stored in ExamRegistry (`getApprovedList(examId).listHash`). */
  readOnChainListHash: () => Promise<Hex>;
  /** The posted Build, which commits to the storage manifest. */
  readBuild: () => Promise<BuildCommitment>;
  fetchFile: FetchFile;
  onStep?: (step: ReleaseStep) => void;
}

/** What the checks that don't need the key found, kept to be used at the touch. */
export interface PreparedRelease {
  encryptionPublicKey: Hex;
  /** The holder's share file, already checked against the manifest and the Build. */
  sealedShare: Uint8Array;
  expectedShareHash: Uint8Array;
  /** When the checks ran, in milliseconds. */
  preparedAt: number;
}

/**
 * Confirm and Submit from the README's Share Release. Nothing is signed, opened or sent until the
 * attestation is trusted and the list hash the TEE signed matches the chain. The share is
 * HPKE-encrypted to this holder alone, so there is no time seal to open: the share file is checked
 * against the manifest and the manifest against the Build, then one touch signs `shareRelease` and
 * opens the share in the same WebAuthn request. The share is sealed to the TEE's
 * `encryptionPublicKey`, the key the instance key signed, never to `instancePublicKey`. This flow
 * stops at the holder's own share: K_priv is never handled here.
 *
 * `prepareRelease` is every check that does not need the key, so a page can run it as soon as it is
 * ready. `finishRelease` is the challenge, the touch and the send, and always runs at the press.
 */
export async function prepareRelease(context: ReleaseContext): Promise<PreparedRelease> {
  const { tee, examId, passkeyPublicKey, derivedPublicKey } = context;
  const step = (name: ReleaseStep) => context.onStep?.(name);

  step('attest');
  const attestation = await tee.attestation();
  const verdict = await context.checkAttestation(attestation);
  if (!verdict.trusted) throw new ReleaseAbortedError('attest', describeVerdict(verdict));
  const { instancePublicKey, encryptionPublicKey } = attestation;

  step('listHash');
  const { approvedList } = await tee.status();
  if (!approvedList) throw new ReleaseAbortedError('listHash', 'The TEE has no signed list.');
  if (approvedList.examId.toLowerCase() !== examId.toLowerCase()) {
    throw new ReleaseAbortedError('listHash', 'The TEE list is for a different exam.');
  }
  const signedHash = approvedListHash(fromHex(approvedList.examId), fromHex(approvedList.entries));
  if (!equalBytes(signedHash, fromHex(approvedList.hash))) {
    throw new ReleaseAbortedError('listHash', 'The TEE list hash does not match its own list.');
  }
  const chainHash = await context.readOnChainListHash();
  if (!equalBytes(fromHex(chainHash), signedHash)) {
    throw new ReleaseAbortedError('listHash', 'The TEE list hash does not match the chain.');
  }
  const message = encodeMessage('approvedList', {
    examId: fromHex(approvedList.examId),
    entries: fromHex(approvedList.entries),
  });
  const validSignature = await verifyTeeSignature(
    fromHex(instancePublicKey),
    fromHex(approvedList.teeSignature),
    message,
  );
  if (!validSignature) {
    throw new ReleaseAbortedError('listHash', 'The TEE signature on the list is invalid.');
  }
  let entries;
  try {
    entries = decodeApprovedList(fromHex(approvedList.entries));
  } catch (error) {
    throw new ReleaseAbortedError('listHash', `The approved list is malformed: ${(error as Error).message}`);
  }
  const own = entries.find((entry) => equalBytes(entry.passkeyPublicKey, fromHex(passkeyPublicKey)));
  if (!own || (own.role !== roles.neutral && own.role !== roles.centreKeyHolder)) {
    throw new ReleaseAbortedError('listHash', 'Your security key is not a key holder on the approved list.');
  }
  if (!equalBytes(own.derivedPublicKey, fromHex(derivedPublicKey))) {
    throw new ReleaseAbortedError('listHash', 'The list holds a different derived key for your security key.');
  }

  step('fetch');
  const build = await context.readBuild();
  const shareName = storageNames.share(fromHex(derivedPublicKey));
  let sealedShare: Uint8Array;
  let expectedShareHash: Uint8Array;
  try {
    const manifest = await fetchManifest(context.fetchFile, build, examId);
    const entry = manifest.manifest.files.find((file) => file.name === shareName);
    if (!entry) throw new StorageVerificationError(`The manifest does not list ${shareName}.`);
    if (entry.recipient !== derivedPublicKey.toLowerCase() || entry.shareHash === undefined) {
      throw new StorageVerificationError('The manifest does not name you as the recipient of this share.');
    }
    expectedShareHash = fromHex(entry.shareHash);
    sealedShare = await fetchListedFile(context.fetchFile, manifest, build, shareName);
  } catch (error) {
    throw new ReleaseAbortedError('fetch', (error as Error).message);
  }
  return { encryptionPublicKey, sealedShare, expectedShareHash, preparedAt: Date.now() };
}

/**
 * The part that needs the security key: a fresh challenge, the one touch and the send. `prepared`
 * comes from `prepareRelease`, and is only as good as it is recent.
 */
export async function finishRelease(context: ReleaseContext, prepared: PreparedRelease): Promise<void> {
  const { keys, tee, examId, credentialId, passkeyPublicKey } = context;
  const { encryptionPublicKey, sealedShare, expectedShareHash } = prepared;
  const step = (name: ReleaseStep) => context.onStep?.(name);

  step('challenge');
  let challenge: Hex;
  try {
    // The challenge is longer than 32 bytes and is used as given, never cut or padded to a width.
    ({ challenge } = await tee.releaseChallenge());
  } catch (error) {
    // The TEE refuses release challenges until `unlockRound` is published. That is not a fault.
    if (isReleaseNotOpen(error)) throw new ReleaseAbortedError('challenge', RELEASE_NOT_OPEN_MESSAGE);
    throw error;
  }

  step('release');
  const digest = hashMessage('shareRelease', { examId: fromHex(examId), challenge: fromHex(challenge) });
  // One touch: the passkey signs the digest and the same request opens the share.
  const { share, signature } = await keys.releaseShare(credentialId, fromHex(examId), digest, sealedShare);
  try {
    if (!equalBytes(hashMessage('shareHash', { share }), expectedShareHash)) {
      throw new ReleaseAbortedError('release', 'Your share does not match the share hash in the manifest, so it was not sent.');
    }
    step('submit');
    const sealed = await sealRelease(fromHex(encryptionPublicKey), fromHex(examId), {
      share,
      signature: signature.signature,
      authenticatorData: signature.authenticatorData,
      clientDataJSON: signature.clientDataJSON,
    });
    await tee.releaseShare({
      passkeyPublicKey,
      challenge,
      sealed: toHex(sealed),
    });
  } finally {
    share.fill(0);
  }
}

/** All of it, in order: the checks that don't need the key, then the touch. */
export async function runRelease(context: ReleaseContext): Promise<void> {
  await finishRelease(context, await prepareRelease(context));
}
