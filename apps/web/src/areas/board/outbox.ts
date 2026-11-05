import { verifyTeeSignature } from '@paperseal/crypto';
import { encodeMessage, equalBytes, fromHex, type Hex } from '@paperseal/protocol';
import type { OutboxMessage } from '@paperseal/tee-client';

import type { BuildPost } from './postFlow';

export class OutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxError';
  }
}

const bytes32Fields = ['examId', 'approvedListHash', 'paperHash', 'storageManifestHash', 'saltedPaperHash', 'criteriaHash'] as const;
const countFields = ['selected', 'bankSize'] as const;

function bytes32(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new OutboxError(`The message field ${name} is not 32 bytes of lowercase hex.`);
  }
  return value as Hex;
}

function count(value: unknown, name: string): number {
  const number = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number >= 2 ** 32) {
    throw new OutboxError(`The message field ${name} is not a uint32.`);
  }
  return number;
}

/**
 * Checks an outbox Build before the board's wallet is asked to post it: the fields are exactly the
 * `build` message's, they name this exam, and the TEE's signature over them verifies under the
 * instance key. `attestedInstancePublicKey` is the key from an attestation that passed `checkToken`,
 * and the message must be signed by that key, so it traces to the attested code. Returns the
 * `postBuild` arguments. Throws `OutboxError` with the reason.
 */
export async function verifyOutboxBuild(
  message: OutboxMessage,
  expected: { examId: Hex; attestedInstancePublicKey: Hex },
): Promise<BuildPost> {
  if (message.kind !== 'build') throw new OutboxError(`Unknown message kind ${String(message.kind)}.`);
  const { fields } = message;
  const allowed = new Set<string>([...bytes32Fields, ...countFields]);
  const names = Object.keys(fields);
  if (names.length !== allowed.size || names.some((name) => !allowed.has(name))) {
    throw new OutboxError('The message does not carry exactly the fields of the build message.');
  }
  const build = {
    examId: bytes32(fields.examId, 'examId'),
    approvedListHash: bytes32(fields.approvedListHash, 'approvedListHash'),
    paperHash: bytes32(fields.paperHash, 'paperHash'),
    storageManifestHash: bytes32(fields.storageManifestHash, 'storageManifestHash'),
    saltedPaperHash: bytes32(fields.saltedPaperHash, 'saltedPaperHash'),
    selected: count(fields.selected, 'selected'),
    bankSize: count(fields.bankSize, 'bankSize'),
    criteriaHash: bytes32(fields.criteriaHash, 'criteriaHash'),
  };
  if (message.examId !== build.examId || build.examId !== expected.examId.toLowerCase()) {
    throw new OutboxError('The message is for a different exam from the one shown here.');
  }
  let valid: boolean;
  try {
    valid = await verifyTeeSignature(
      fromHex(message.instancePublicKey),
      fromHex(message.teeSignature),
      encodeMessage('build', {
        examId: fromHex(build.examId),
        approvedListHash: fromHex(build.approvedListHash),
        paperHash: fromHex(build.paperHash),
        storageManifestHash: fromHex(build.storageManifestHash),
        saltedPaperHash: fromHex(build.saltedPaperHash),
        selected: build.selected,
        bankSize: build.bankSize,
        criteriaHash: fromHex(build.criteriaHash),
      }),
    );
  } catch (error) {
    throw new OutboxError(`The TEE signature could not be checked: ${(error as Error).message}`);
  }
  if (!valid) throw new OutboxError('The TEE signature on the Build does not verify under its instance key.');
  if (!equalBytes(fromHex(message.instancePublicKey), fromHex(expected.attestedInstancePublicKey))) {
    throw new OutboxError('The Build is signed by a key other than the attested instance key.');
  }
  return { ...build, teeSignature: message.teeSignature, instancePublicKey: message.instancePublicKey };
}
