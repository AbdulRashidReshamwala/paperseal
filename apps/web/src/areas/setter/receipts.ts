import { verifyTeeSignature } from '@paperseal/crypto';
import { encodeMessage, equalBytes, fromHex, type Hex } from '@paperseal/protocol';

/** One sealed question. Only hashes and keys are kept, never the question text. */
export interface StoredReceipt {
  questionHash: Hex;
  /** The key that signed the receipt. After the Build it must equal the Build's key. */
  instancePublicKey: Hex;
  teeSignature: Hex;
  sealedAt: number;
}

const storageKey = (examId: Hex) => `paperseal.receipts.${examId.toLowerCase()}`;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function loadReceipts(examId: Hex): StoredReceipt[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(storageKey(examId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const hex = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]+$/.test(v);
    return parsed.filter(
      (r): r is StoredReceipt =>
        typeof r === 'object' &&
        r !== null &&
        hex((r as StoredReceipt).questionHash) &&
        hex((r as StoredReceipt).instancePublicKey) &&
        hex((r as StoredReceipt).teeSignature),
    );
  } catch {
    return [];
  }
}

export function saveReceipt(examId: Hex, receipt: StoredReceipt): StoredReceipt[] {
  const all = loadReceipts(examId).filter((r) => r.questionHash !== receipt.questionHash);
  all.push(receipt);
  storage()?.setItem(storageKey(examId), JSON.stringify(all));
  return all;
}

/**
 * Checks a TEE signature over the `questionReceipt` message with the key the receipt names.
 * Returns false for any malformed input.
 */
export async function verifyReceipt(
  examId: Hex,
  passkeyPublicKey: Hex,
  receipt: Pick<StoredReceipt, 'questionHash' | 'instancePublicKey' | 'teeSignature'>,
): Promise<boolean> {
  try {
    const message = encodeMessage('questionReceipt', {
      examId: fromHex(examId),
      passkeyPublicKey: fromHex(passkeyPublicKey),
      questionHash: fromHex(receipt.questionHash),
    });
    return await verifyTeeSignature(fromHex(receipt.instancePublicKey), fromHex(receipt.teeSignature), message);
  } catch {
    return false;
  }
}

export type BuildMatch = 'match' | 'mismatch' | 'pending';

/**
 * Compares each receipt's instance key with `getBuild(...).instancePublicKey`. A null Build means
 * it is not posted yet, so nothing can be said. A mismatch means the question went to a TEE
 * other than the one that built the paper.
 */
export function compareWithBuild(
  receipts: readonly StoredReceipt[],
  buildInstancePublicKey: Hex | null,
): { receipt: StoredReceipt; match: BuildMatch }[] {
  return receipts.map((receipt) => {
    if (buildInstancePublicKey === null) return { receipt, match: 'pending' };
    const same = equalBytes(fromHex(receipt.instancePublicKey), fromHex(buildInstancePublicKey));
    return { receipt, match: same ? 'match' : 'mismatch' };
  });
}
