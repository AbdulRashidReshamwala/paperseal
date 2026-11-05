import { fromHex, roles, setterCommitment, type ApprovedListEntry, type Hex } from '@paperseal/protocol';

import type { CheckResult } from './checks';

/*
 * Setters are on the chain as a salted hash, so this check can only run after the board publishes
 * each setter's name and salt. Nothing here guesses a name: a published entry either recomputes to
 * a commitment on the list or it doesn't.
 */

export interface PublishedSetter {
  name: string;
  salt: Hex;
}

export class SetterJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetterJsonError';
  }
}

/** The board's JSON: an array of `{name, salt}`, with `salt` as 0x and 64 lowercase hex digits. */
export function parsePublishedSetters(text: string): PublishedSetter[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SetterJsonError('This is not JSON.');
  }
  if (!Array.isArray(value)) throw new SetterJsonError('Expected a JSON array of {name, salt}.');
  if (value.length === 0) throw new SetterJsonError('The array is empty.');
  return value.map((item: unknown, index): PublishedSetter => {
    const at = `Entry ${String(index + 1)}`;
    if (typeof item !== 'object' || item === null) throw new SetterJsonError(`${at} is not an object.`);
    const { name, salt } = item as { name?: unknown; salt?: unknown };
    if (typeof name !== 'string' || name === '') throw new SetterJsonError(`${at} needs a name.`);
    if (typeof salt !== 'string' || !/^0x[0-9a-f]{64}$/.test(salt)) {
      throw new SetterJsonError(`${at} needs a salt: 0x and 64 lowercase hex digits.`);
    }
    return { name, salt: salt as Hex };
  });
}

export interface SetterRow {
  name: string;
  commitment: Hex;
  /** Pass when the recomputed commitment is a setter's owner on the on-chain list. */
  check: CheckResult;
}

export interface SetterReport {
  rows: SetterRow[];
  /** On-chain setter commitments that no published entry produced. */
  unmatched: string[];
  /** Pass only when every setter on the chain was matched by a published entry. */
  coverage: CheckResult;
}

export const setterCommitments = (entries: readonly ApprovedListEntry[]): string[] =>
  entries.filter((entry) => entry.role === roles.setter).map((entry) => entry.owner.toLowerCase());

/** Recomputes each published commitment and looks for it among the setters on the chain. */
export function checkPublishedSetters(
  examId: Hex,
  entries: readonly ApprovedListEntry[],
  published: readonly PublishedSetter[],
): SetterReport {
  const onChain = setterCommitments(entries);
  const rows = published.map(({ name, salt }): SetterRow => {
    const commitment = setterCommitment(fromHex(examId), name, fromHex(salt));
    return { name, commitment, check: onChain.includes(commitment) ? 'pass' : 'fail' };
  });
  const matched = new Set(rows.filter((row) => row.check === 'pass').map((row) => row.commitment));
  const unmatched = onChain.filter((commitment) => !matched.has(commitment as Hex));
  return { rows, unmatched, coverage: unmatched.length === 0 ? 'pass' : 'fail' };
}
