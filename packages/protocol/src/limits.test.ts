import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ApprovedListError,
  CriteriaError,
  decodeApprovedList,
  decodeCriteria,
  encodeApprovedList,
  encodeCriteria,
  fromHex,
  limits,
  roles,
  type ApprovedListEntry,
  type Criteria,
} from './index';

const word = (value: number | bigint): Uint8Array => {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(24, BigInt(value));
  return out;
};
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const key = (n: number): Uint8Array => Uint8Array.from([4, ...new Uint8Array(64).fill(n)]);
const neutral = (n: number, owner = `owner-${String(n)}`): ApprovedListEntry => ({
  role: roles.neutral,
  passkeyPublicKey: key(n % 256),
  derivedPublicKey: key((n + 100) % 256),
  owner,
});
const setter = (n: number): ApprovedListEntry => ({
  role: roles.setter,
  // Distinct passkeys beyond one byte of fill.
  passkeyPublicKey: Uint8Array.from([4, n >> 8, n & 255, ...new Uint8Array(62).fill(9)]),
  derivedPublicKey: new Uint8Array(),
  owner: `0x${n.toString(16).padStart(64, '0')}`,
});
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
};

describe('limits', () => {
  it('is exported from spec/constants.json', () => {
    expect(limits).toEqual({
      entriesBytes: 327680,
      criteriaBytes: 16384,
      entries: 512,
      topics: 64,
      ownerBytes: 128,
      topicNameBytes: 64,
    });
  });
});

describe('approved list size limits', () => {
  it('passes the byte cap exactly at it and rejects one byte over', () => {
    const atCap = new Uint8Array(limits.entriesBytes);
    atCap.set(word(32), 0);
    atCap.set(word(0), 32); // an empty array, then trailing zeros
    const atMessage = message(() => decodeApprovedList(atCap));
    expect(atMessage).not.toContain('longer than');
    expect(() => decodeApprovedList(new Uint8Array(limits.entriesBytes + 1))).toThrow(/longer than 327680/);
    expect(() => decodeApprovedList(new Uint8Array(limits.entriesBytes + 1))).toThrow(ApprovedListError);
  });

  it('allows 512 entries to reach the list rules and rejects 513 after decoding', () => {
    const at = Array.from({ length: limits.entries }, (_, i) => setter(i + 1));
    expect(message(() => decodeApprovedList(encodeApprovedList(at)))).not.toContain('more than');
    const over = [...at, setter(limits.entries + 1)];
    expect(() => decodeApprovedList(encodeApprovedList(over))).toThrow(/more than 512 entries/);
  });

  it('allows a 128-byte owner and rejects 129', () => {
    const ok = [neutral(1, 'a'.repeat(limits.ownerBytes))];
    expect(message(() => decodeApprovedList(encodeApprovedList(ok)))).not.toContain('owner is longer');
    const over = [neutral(1, 'a'.repeat(limits.ownerBytes + 1))];
    expect(() => decodeApprovedList(encodeApprovedList(over))).toThrow(/owner is longer than 128/);
  });

  it('counts owner bytes, not characters', () => {
    const over = [neutral(1, 'é'.repeat(limits.ownerBytes / 2 + 1))];
    expect(() => decodeApprovedList(encodeApprovedList(over))).toThrow(/owner is longer than 128/);
  });

  it('rejects offsets that share one element, before decoding', () => {
    const [one] = [encodeApprovedList([neutral(1)])];
    // abi.encode(Entry[]) of one entry: word 0 = 32, word 1 = length 1, word 2 = offset 32, then the element.
    const element = one.slice(96);
    const count = 4000;
    const shared = join(word(32), word(count), ...Array.from({ length: count }, () => word(count * 32)), element);
    expect(shared.length).toBeLessThan(limits.entriesBytes);
    const started = performance.now();
    expect(() => decodeApprovedList(shared)).toThrow(/overlap/);
    expect(() => decodeApprovedList(shared)).toThrow(ApprovedListError);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('rejects a huge claimed length without allocating for it', () => {
    const huge = join(word(32), word(2 ** 32 - 1), word(64));
    expect(() => decodeApprovedList(huge)).toThrow(ApprovedListError);
    const bigWord = join(word(32), new Uint8Array(32).fill(255));
    expect(() => decodeApprovedList(bigWord)).toThrow(ApprovedListError);
  });

  it('rejects a first offset that leaves a gap after the head, and elements that overlap', () => {
    const encoded = encodeApprovedList([neutral(1), neutral(2)]);
    const gap = encoded.slice();
    gap.set(word(0x80), 64); // first offset should be 64
    expect(() => decodeApprovedList(gap)).toThrow(ApprovedListError);
    const overlap = encoded.slice();
    overlap.set(word(64 + 32), 96); // second element starts inside the first
    expect(() => decodeApprovedList(overlap)).toThrow(ApprovedListError);
  });
});

describe('criteria size limits', () => {
  it('passes the byte cap exactly at it and rejects one byte over', () => {
    const atCap = new Uint8Array(limits.criteriaBytes);
    atCap.set(word(32), 0);
    expect(message(() => decodeCriteria(atCap))).not.toContain('longer than');
    expect(() => decodeCriteria(new Uint8Array(limits.criteriaBytes + 1))).toThrow(/longer than 16384/);
    expect(() => decodeCriteria(new Uint8Array(limits.criteriaBytes + 1))).toThrow(CriteriaError);
  });

  it('allows 64 topics and rejects 65', () => {
    const named = (count: number): Criteria => ({
      maxSetterPercent: 40,
      minBankMultiple: 3,
      topics: Array.from({ length: count }, (_, i) => ({ name: `topic-${String(i)}`, questions: 1 })),
    });
    expect(decodeCriteria(encodeCriteria(named(limits.topics)))).toEqual(named(limits.topics));
    expect(() => decodeCriteria(encodeCriteria(named(limits.topics + 1)))).toThrow(/more than 64 topics/);
  });

  it('allows a 64-byte topic name and rejects 65', () => {
    const one = (name: string): Criteria => ({ maxSetterPercent: 40, minBankMultiple: 3, topics: [{ name, questions: 1 }] });
    expect(decodeCriteria(encodeCriteria(one('a'.repeat(64)))).topics[0]?.name).toBe('a'.repeat(64));
    expect(() => decodeCriteria(encodeCriteria(one('a'.repeat(65))))).toThrow(/name is longer than 64/);
  });

  it('rejects offsets that share one topic, before decoding', () => {
    const one = encodeCriteria({ maxSetterPercent: 40, minBankMultiple: 3, topics: [{ name: 'algebra', questions: 1 }] });
    // word 0 = 32, words 1-3 = head, word 4 = array length, word 5 = first offset, then the element.
    const element = one.slice(6 * 32);
    const count = 400;
    const shared = join(
      word(32),
      word(40),
      word(3),
      word(96),
      word(count),
      ...Array.from({ length: count }, () => word(count * 32)),
      element,
    );
    expect(shared.length).toBeLessThan(limits.criteriaBytes);
    expect(() => decodeCriteria(shared)).toThrow(/overlap/);
    expect(() => decodeCriteria(shared)).toThrow(CriteriaError);
  });

  it('rejects a huge claimed topic count', () => {
    const huge = join(word(32), word(40), word(3), word(96), word(2 ** 32 - 1));
    expect(() => decodeCriteria(huge)).toThrow(CriteriaError);
  });
});

describe('tee/ vectors: size limits', () => {
  interface Reject {
    name: string;
    kind: 'entries' | 'criteria';
    reason: 'overCap' | 'sharedOffsets';
    prefix: string;
    length: number;
  }
  const path = resolve(import.meta.dirname, '../../../tee/testdata/vectors.json');
  const vectors = JSON.parse(readFileSync(path, 'utf8')) as { limits: { reject: Reject[] } };
  const rejects = vectors.limits.reject;

  it('has the four reject inputs', () => {
    expect(rejects.map((r) => `${r.kind}/${r.reason}`).sort()).toEqual([
      'criteria/overCap',
      'criteria/sharedOffsets',
      'entries/overCap',
      'entries/sharedOffsets',
    ]);
  });

  it.each(rejects)('rejects $name', ({ kind, reason, prefix, length }) => {
    const head = fromHex(prefix);
    const input = new Uint8Array(length);
    input.set(head);
    const decode = kind === 'criteria' ? decodeCriteria : decodeApprovedList;
    const error = kind === 'criteria' ? CriteriaError : ApprovedListError;
    expect(() => decode(input)).toThrow(error);
    if (reason === 'overCap') expect(() => decode(input)).toThrow(/longer than/);
    else expect(() => decode(input)).toThrow(/overlap/);
  });
});
