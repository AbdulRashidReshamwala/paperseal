import { verifyTeeSignature } from '@paperseal/crypto';
import { encodeMessage, equalBytes, fromHex, type Hex } from '@paperseal/protocol';
import type { OutboxMessage } from '@paperseal/tee-client';

/** The fields of a verified outbox Build, in the order `postBuild` takes them. Mirrors apps/web areas/board/outbox.ts. */
export interface BuildPost {
  examId: Hex;
  approvedListHash: Hex;
  paperHash: Hex;
  storageManifestHash: Hex;
  saltedPaperHash: Hex;
  selected: number;
  bankSize: number;
  criteriaHash: Hex;
  teeSignature: Hex;
  instancePublicKey: Hex;
}

const bytes32Fields = ['examId', 'approvedListHash', 'paperHash', 'storageManifestHash', 'saltedPaperHash', 'criteriaHash'] as const;
const countFields = ['selected', 'bankSize'] as const;

function bytes32(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error(`the Build field ${name} is not 32 bytes of lowercase hex`);
  return value as Hex;
}

function count(value: unknown, name: string): number {
  const number = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number >= 2 ** 32) throw new Error(`the Build field ${name} is not a uint32`);
  return number;
}

/**
 * Checks an outbox Build before it is posted: exactly the `build` message's fields, for this exam,
 * with the TEE signature verifying under its instance key, and that key equal to the key of an
 * attestation that passed `checkToken`.
 */
export async function verifyOutboxBuild(
  message: OutboxMessage,
  expected: { examId: Hex; attestedInstancePublicKey: Hex },
): Promise<BuildPost> {
  if (message.kind !== 'build') throw new Error(`unknown outbox message kind ${String(message.kind)}`);
  const { fields } = message;
  const allowed = new Set<string>([...bytes32Fields, ...countFields]);
  const names = Object.keys(fields);
  if (names.length !== allowed.size || names.some((name) => !allowed.has(name))) {
    throw new Error(`the outbox message fields are ${names.join(', ')}, not exactly those of the build message`);
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
    throw new Error('the Build is for a different exam from this run');
  }
  const valid = await verifyTeeSignature(
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
  if (!valid) throw new Error('the TEE signature on the Build does not verify under its instance key');
  if (!equalBytes(fromHex(message.instancePublicKey), fromHex(expected.attestedInstancePublicKey))) {
    throw new Error(`the Build is signed by ${message.instancePublicKey}, not the attested instance key ${expected.attestedInstancePublicKey}`);
  }
  return { ...build, teeSignature: message.teeSignature, instancePublicKey: message.instancePublicKey };
}

export const buildArgs = (b: BuildPost) =>
  [b.examId, b.approvedListHash, b.paperHash, b.storageManifestHash, b.saltedPaperHash, b.selected, b.bankSize, b.criteriaHash, b.teeSignature, b.instancePublicKey] as const;
