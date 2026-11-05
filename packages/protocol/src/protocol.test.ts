import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { encodeAbiParameters, keccak256, toHex as viemHex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  ApprovedListError,
  approvedListHash,
  attestationNonce,
  checkApprovedList,
  isSetterCommitment,
  setterCommitment,
  constants,
  CriteriaError,
  criteriaHash,
  decodeApprovedList,
  decodeCriteria,
  encodeApprovedList,
  encodeCriteria,
  encodeMessage,
  encodeRound,
  encryptedPaperHash,
  examIdFromName,
  fromHex,
  hashMessage,
  questionHash,
  roles,
  roundAtSeconds,
  roundTimeSeconds,
  saltedPaperHash,
  selectedCount,
  threshold,
  toHex,
  type ApprovedListEntry,
  type Criteria,
  type ExamSettings,
  ScheduleError,
  checkSchedule,
  firstRoundAtOrAfter,
  startupArgs,
  type MessageName,
} from './index';

const sha = (...parts: (Uint8Array | string)[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const fill = (byte: number, length = 32) => new Uint8Array(length).fill(byte);
const key = (n: number) => {
  const k = fill(n, 65);
  k[0] = 0x04;
  return k;
};
/** Independent abi.encode through viem's one-shot parameters, not the schema table. */
const abi = (types: string[], values: unknown[]) =>
  fromHex(encodeAbiParameters(types.map((type) => ({ type })), values));

describe('constants', () => {
  it('comes from spec/constants.json', () => {
    const raw: unknown = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../spec/constants.json'), 'utf8'),
    );
    expect(constants).toEqual(raw);
    expect(threshold.required).toBe(8);
  });
});

describe('abi.encode messages', () => {
  it('encodes the tag as a string, then the fields', () => {
    const examId = fill(1);
    const entries = fill(2, 5);
    const expected = abi(['string', 'bytes32', 'bytes'], ['paperseal/v1/approved-list', toHex(examId), toHex(entries)]);
    expect(toHex(encodeMessage('approvedList', { examId, entries }))).toBe(toHex(expected));
    expect(hashMessage('approvedList', { examId, entries })).toEqual(sha(expected));
    expect(toHex(expected).slice(2, 66)).toBe(`${'0'.repeat(62)}60`); // tag offset, no packed tag
  });

  it('encodes setterCommitment as tag, bytes32 examId, string name, bytes32 salt', () => {
    const examId = fill(1);
    const salt = fill(7);
    const expected = abi(
      ['string', 'bytes32', 'string', 'bytes32'],
      ['paperseal/v1/setter-commitment', toHex(examId), 'Asha Rao', toHex(salt)],
    );
    expect(toHex(encodeMessage('setterCommitment', { examId, name: 'Asha Rao', salt }))).toBe(toHex(expected));
    expect(setterCommitment(examId, 'Asha Rao', salt)).toBe(toHex(sha(expected)));
  });

  it('encodes registration with an empty derived key for setters', () => {
    const holderId = Buffer.from('holder-1');
    const challenge = fill(5, 3);
    const expected = abi(
      ['string', 'bytes', 'bytes', 'bytes'],
      ['paperseal/v1/registration', '0x', toHex(holderId), toHex(challenge)],
    );
    expect(
      toHex(encodeMessage('registration', { derivedPublicKey: new Uint8Array(), holderId, challenge })),
    ).toBe(toHex(expected));
  });

  it('encodes build with uint32 counts in table order', () => {
    const fields = {
      examId: fill(1),
      approvedListHash: fill(2),
      paperHash: fill(3),
      storageManifestHash: fill(4),
      saltedPaperHash: fill(5),
      selected: 20,
      bankSize: 300,
      criteriaHash: fill(6),
    };
    const expected = abi(
      ['string', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint32', 'uint32', 'bytes32'],
      ['paperseal/v1/build', ...[1, 2, 3, 4, 5].map((n) => toHex(fill(n))), 20, 300, toHex(fill(6))],
    );
    expect(toHex(encodeMessage('build', fields))).toBe(toHex(expected));
  });

  it('encodes the question and release messages', () => {
    const examId = fill(1);
    const challenge = fill(2, 7);
    expect(toHex(encodeMessage('questionSubmission', { examId, challenge, questionHash: fill(3) }))).toBe(
      toHex(abi(['string', 'bytes32', 'bytes', 'bytes32'], ['paperseal/v1/question-submission', toHex(examId), toHex(challenge), toHex(fill(3))])),
    );
    expect(toHex(encodeMessage('questionReceipt', { examId, passkeyPublicKey: key(2), questionHash: fill(3) }))).toBe(
      toHex(abi(['string', 'bytes32', 'bytes', 'bytes32'], ['paperseal/v1/question-receipt', toHex(examId), toHex(key(2)), toHex(fill(3))])),
    );
    expect(toHex(encodeMessage('shareRelease', { examId, challenge }))).toBe(
      toHex(abi(['string', 'bytes32', 'bytes'], ['paperseal/v1/share-release', toHex(examId), toHex(challenge)])),
    );
    expect(toHex(encodeMessage('releaseLog', { examId, entriesHash: fill(9) }))).toBe(
      toHex(abi(['string', 'bytes32', 'bytes32'], ['paperseal/v1/release-log', toHex(examId), toHex(fill(9))])),
    );
  });

  it('hashes ciphertexts plainly and the paper only with its seed', () => {
    const file = Buffer.from('ciphertext');
    expect(encryptedPaperHash(file)).toEqual(sha(file));
    expect(questionHash(file)).toEqual(sha(file));
    const seed = fill(7);
    const paper = Buffer.from('paper');
    expect(saltedPaperHash(seed, paper)).toEqual(
      sha(abi(['string', 'bytes32', 'bytes'], ['paperseal/v1/paper-hash', toHex(seed), toHex(paper)])),
    );
    expect(saltedPaperHash(fill(8), paper)).not.toEqual(saltedPaperHash(seed, paper));
  });

  it('separates messages by tag', () => {
    expect(hashMessage('releaseLog', { examId: fill(1), entriesHash: fill(2) })).not.toEqual(
      hashMessage('shareRelease', { examId: fill(1), challenge: fill(2) }),
    );
  });

  it('rejects malformed fields', () => {
    expect(() => encodeMessage('releaseLog', { examId: fill(1, 31), entriesHash: fill(2) })).toThrow('examId must be 32 bytes');
    const build = { examId: fill(1), approvedListHash: fill(1), paperHash: fill(1), storageManifestHash: fill(1), saltedPaperHash: fill(1), bankSize: 1, criteriaHash: fill(1) };
    expect(() => encodeMessage('build', { ...build, selected: -1 })).toThrow(RangeError);
    expect(() => encodeMessage('build', { ...build, selected: 2 ** 32 })).toThrow(RangeError);
    expect(() => encodeMessage('questionReceipt', { examId: fill(1), passkeyPublicKey: fill(4, 64), questionHash: fill(1) })).toThrow('65-byte');
    expect(() => encodeMessage('questionReceipt', { examId: fill(1), passkeyPublicKey: fill(2, 65), questionHash: fill(1) })).toThrow('0x04');
    expect(() => encodeMessage('registration', { derivedPublicKey: fill(4, 64), holderId: fill(1, 1), challenge: fill(1, 1) })).toThrow('65-byte');
    expect(() => encodeMessage('approvedList', { examId: fill(1) } as never)).toThrow('missing entries');
  });

  it('encodes drand rounds as big-endian uint64', () => {
    expect(encodeRound(258)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 1, 2]));
    expect(encodeRound(2n ** 64n - 1n)).toEqual(fill(0xff, 8));
    expect(() => encodeRound(2n ** 64n)).toThrow(RangeError);
  });
});

describe('attestation nonce', () => {
  it('is the lowercase hex of the attestationNonce message hash', () => {
    const k = key(4);
    const examId = fill(9);
    const expected = createHash('sha256')
      .update(abi(['string', 'bytes', 'bytes32'], ['paperseal/v1/attestation-nonce', toHex(k), toHex(examId)]))
      .digest('hex');
    expect(attestationNonce(k, examId)).toBe(expected);
  });

  it('rejects a malformed exam ID or key', () => {
    expect(() => attestationNonce(key(4), fill(9, 31))).toThrow(RangeError);
    expect(() => attestationNonce(fill(4, 33), fill(9))).toThrow(RangeError);
    expect(() => attestationNonce(fill(2, 65), fill(9))).toThrow(RangeError);
  });
});

const commitmentFor = (n: number) => setterCommitment(fill(9), `setter-${String(n)}`, fill(n + 50));
const entry = (role: number, n: number): ApprovedListEntry => ({
  role,
  passkeyPublicKey: key(n),
  derivedPublicKey: role === roles.setter ? new Uint8Array() : key(n + 100),
  owner: role === roles.setter ? commitmentFor(n) : `owner-${String(n)}`,
});
const validList = (): ApprovedListEntry[] => [
  entry(roles.setter, 1),
  entry(roles.setter, 2),
  ...Array.from({ length: threshold.neutrals }, (_, i) => entry(roles.neutral, 10 + i)),
  ...Array.from({ length: threshold.centres }, (_, i) => entry(roles.centreKeyHolder, 20 + i)),
  entry(roles.centre, 40),
];

describe('approved list', () => {
  it('matches abi.encode(Entry[])', () => {
    const entries = validList();
    const expected = fromHex(
      encodeAbiParameters(
        [{ type: 'tuple[]', components: [{ name: 'role', type: 'uint8' }, { name: 'passkeyPublicKey', type: 'bytes' }, { name: 'derivedPublicKey', type: 'bytes' }, { name: 'owner', type: 'string' }] }],
        [entries.map((e) => ({ role: e.role, passkeyPublicKey: toHex(e.passkeyPublicKey), derivedPublicKey: toHex(e.derivedPublicKey), owner: e.owner }))],
      ),
    );
    expect(encodeApprovedList(entries)).toEqual(expected);
  });

  it('round-trips and hashes the approvedList message', () => {
    const entries = validList();
    const encoded = encodeApprovedList(entries);
    expect(decodeApprovedList(encoded)).toEqual(entries);
    const examId = fill(1);
    expect(approvedListHash(examId, encoded)).toEqual(hashMessage('approvedList', { examId, entries: encoded }));
  });

  it('accepts any order', () => {
    expect(() => decodeApprovedList(encodeApprovedList(validList().reverse()))).not.toThrow();
  });

  it('rejects a non-canonical encoding', () => {
    const encoded = encodeApprovedList(validList());
    expect(() => decodeApprovedList(new Uint8Array([...encoded, 0]))).toThrow('canonical');
    expect(() => decodeApprovedList(encoded.slice(0, 40))).toThrow(ApprovedListError);
  });

  it('rejects unknown roles', () => {
    const list = validList();
    list[0] = { ...entry(roles.setter, 1), role: 5 };
    expect(() => encodeApprovedList(list)).toThrow('unknown role');
    list[0] = { ...entry(roles.setter, 1), role: 0 };
    expect(() => checkApprovedList(list)).toThrow('unknown role');
  });

  it('rejects a repeated passkey or derived key', () => {
    const list = validList();
    list[3] = { ...(list[3] as ApprovedListEntry), passkeyPublicKey: (list[2] as ApprovedListEntry).passkeyPublicKey };
    expect(() => checkApprovedList(list)).toThrow('passkey is repeated');
    const list2 = validList();
    list2[3] = { ...(list2[3] as ApprovedListEntry), derivedPublicKey: (list2[2] as ApprovedListEntry).derivedPublicKey };
    expect(() => checkApprovedList(list2)).toThrow('derived key is repeated');
  });

  it('allows several empty derived keys but not one on a setter', () => {
    expect(() => checkApprovedList(validList())).not.toThrow();
    const list = validList();
    list[0] = { ...(list[0] as ApprovedListEntry), derivedPublicKey: key(77) };
    expect(() => checkApprovedList(list)).toThrow('empty derivedPublicKey');
    const list2 = validList();
    list2[3] = { ...(list2[3] as ApprovedListEntry), derivedPublicKey: new Uint8Array() };
    expect(() => checkApprovedList(list2)).toThrow('derivedPublicKey must be');
  });

  it('requires a setter owner to be a commitment and rejects a plain name', () => {
    expect(isSetterCommitment(commitmentFor(1))).toBe(true);
    for (const bad of ['Asha Rao', '0x1234', commitmentFor(1).toUpperCase(), commitmentFor(1).slice(2), `${commitmentFor(1)}00`]) {
      expect(isSetterCommitment(bad)).toBe(false);
      const list = validList();
      list[0] = { ...(list[0] as ApprovedListEntry), owner: bad };
      expect(() => checkApprovedList(list)).toThrow('setter commitment');
    }
    // Other roles keep names.
    expect(() => checkApprovedList(validList())).not.toThrow();
  });

  it('commits to the exam, the name and the salt', () => {
    const base = setterCommitment(fill(1), 'A', fill(2));
    expect(base).toMatch(/^0x[0-9a-f]{64}$/);
    expect(setterCommitment(fill(3), 'A', fill(2))).not.toBe(base);
    expect(setterCommitment(fill(1), 'B', fill(2))).not.toBe(base);
    expect(setterCommitment(fill(1), 'A', fill(4))).not.toBe(base);
    expect(setterCommitment(fill(1), 'A', fill(2))).toBe(base);
    expect(() => setterCommitment(fill(1), 'A', fill(2, 31))).toThrow(RangeError);
  });

  it('rejects wrong key-holder counts and empty owners', () => {
    expect(() => checkApprovedList(validList().slice(0, -2))).toThrow('key holders');
    expect(() => checkApprovedList(validList().filter((e) => e.role !== roles.neutral))).toThrow('key holders');
    expect(() => checkApprovedList([...validList(), entry(roles.neutral, 90)])).toThrow('key holders');
    const list = validList();
    list[0] = { ...(list[0] as ApprovedListEntry), owner: '' };
    expect(() => checkApprovedList(list)).toThrow('empty owner');
  });
});

const criteria: Criteria = {
  maxSetterPercent: 40,
  minBankMultiple: 3,
  topics: [
    { name: 'algebra', questions: 12 },
    { name: 'geometry', questions: 8 },
  ],
};

describe('selection criteria', () => {
  it('matches abi.encode(Criteria)', () => {
    const expected = fromHex(
      encodeAbiParameters(
        [{ type: 'tuple', components: [{ name: 'maxSetterPercent', type: 'uint32' }, { name: 'minBankMultiple', type: 'uint32' }, { name: 'topics', type: 'tuple[]', components: [{ name: 'name', type: 'string' }, { name: 'questions', type: 'uint32' }] }] }],
        [criteria],
      ),
    );
    expect(encodeCriteria(criteria)).toEqual(expected);
    expect(decodeCriteria(expected)).toEqual(criteria);
  });

  it('hashes the criteria message and sums the questions', () => {
    const encoded = encodeCriteria(criteria);
    expect(criteriaHash(encoded)).toEqual(sha(abi(['string', 'bytes'], ['paperseal/v1/criteria', toHex(encoded)])));
    expect(selectedCount(criteria)).toBe(20);
  });

  it.each<[string, Criteria]>([
    ['maxSetterPercent 0', { ...criteria, maxSetterPercent: 0 }],
    ['maxSetterPercent 101', { ...criteria, maxSetterPercent: 101 }],
    ['minBankMultiple 1', { ...criteria, minBankMultiple: 1 }],
    ['no topics', { ...criteria, topics: [] }],
    ['empty name', { ...criteria, topics: [{ name: '', questions: 1 }] }],
    ['repeated name', { ...criteria, topics: [{ name: 'a', questions: 1 }, { name: 'a', questions: 2 }] }],
    ['zero questions', { ...criteria, topics: [{ name: 'a', questions: 0 }] }],
  ])('rejects %s', (_, bad) => {
    expect(() => encodeCriteria(bad)).toThrow(CriteriaError);
  });

  it('accepts the bounds', () => {
    expect(() => encodeCriteria({ ...criteria, maxSetterPercent: 1 })).not.toThrow();
    expect(() => encodeCriteria({ ...criteria, maxSetterPercent: 100, minBankMultiple: 2 })).not.toThrow();
  });

  it('rejects bad bytes on decode', () => {
    const encoded = encodeCriteria(criteria);
    expect(() => decodeCriteria(new Uint8Array([...encoded, 0]))).toThrow('canonical');
    expect(() => decodeCriteria(encoded.slice(0, 50))).toThrow(CriteriaError);
    const bad = fromHex(
      encodeAbiParameters(
        [{ type: 'tuple', components: [{ name: 'a', type: 'uint32' }, { name: 'b', type: 'uint32' }, { name: 't', type: 'tuple[]', components: [{ name: 'n', type: 'string' }, { name: 'q', type: 'uint32' }] }] }],
        [{ a: 0, b: 3, t: [{ n: 'x', q: 1 }] }],
      ),
    );
    expect(() => decodeCriteria(bad)).toThrow('maxSetterPercent');
  });
});

describe('identifiers and rounds', () => {
  it('derives examId with keccak256', () => {
    expect(examIdFromName('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(examIdFromName('Maths 2026')).toBe(keccak256(viemHex('Maths 2026')));
  });

  it('round-trips hex and rejects non-canonical forms', () => {
    expect(toHex(fromHex('0x00ff'))).toBe('0x00ff');
    expect(() => fromHex('00ff')).toThrow();
    expect(() => fromHex('0x00FF')).toThrow();
  });

  it('maps quicknet rounds to time', () => {
    expect(roundTimeSeconds(1)).toBe(1692803367);
    expect(roundAtSeconds(1692803367)).toBe(1);
    expect(roundAtSeconds(1692803370)).toBe(2);
    expect(roundAtSeconds(0)).toBe(0);
  });
});

/** Cross-language check against tee/, which writes tee/testdata/vectors.json. */
const vectorsPath = resolve(import.meta.dirname, '../../../tee/testdata/vectors.json');
const hasVectors = existsSync(vectorsPath);

interface HashVector {
  message: string;
  tag: string;
  fields: { name: string; type: string; value: string }[];
  preimage: string;
  hash: string;
}
interface ListVector {
  examId: string;
  entries: string;
  hash: string;
  decoded: { role: number; passkeyPublicKey: string; derivedPublicKey: string; owner: string }[];
}
interface Vectors {
  hash: HashVector[];
  approvedList: ListVector;
  attestationNonce: { instancePublicKey: string; examId: string; preimage: string; nonce: string };
}

const vectors = (hasVectors
  ? JSON.parse(readFileSync(vectorsPath, 'utf8'))
  : { hash: [], attestationNonce: [] }) as unknown as Vectors;

/** tee/ names the salted preimage after the field. This repo names it after its domain tag. */
const messageNames: Record<string, MessageName | undefined> = { saltedPaperHash: 'paperHash' };

describe('tee/ cross-language vectors', () => {
  it('tee/testdata/vectors.json exists', () => {
    expect(hasVectors, `${vectorsPath} is missing`).toBe(true);
  });

  it.each(vectors.hash)('matches tee/ for $message', (vector) => {
    const name = messageNames[vector.message] ?? (vector.message as MessageName);
    const fields = Object.fromEntries(
      vector.fields.map(({ name: field, type, value }) => [
        field,
        type === 'uint32' ? Number(BigInt(value)) : type === 'string' ? value : fromHex(value),
      ]),
    ) as never;
    expect(constants.domainTags[name]).toBe(vector.tag);
    expect(toHex(encodeMessage(name, fields))).toBe(vector.preimage);
    expect(toHex(hashMessage(name, fields))).toBe(vector.hash);
  });

  it('matches tee/ for the approved list encoding and hash', () => {
    const list = vectors.approvedList;
    const entries = list.decoded.map((e) => ({
      role: e.role,
      passkeyPublicKey: fromHex(e.passkeyPublicKey),
      derivedPublicKey: fromHex(e.derivedPublicKey),
      owner: e.owner,
    }));
    expect(toHex(encodeApprovedList(entries))).toBe(list.entries);
    expect(toHex(approvedListHash(fromHex(list.examId), fromHex(list.entries)))).toBe(list.hash);
    // The sample has the wrong key-holder counts on purpose, so the TEE and this decoder reject it.
    expect(() => decodeApprovedList(fromHex(list.entries))).toThrow('key holders');
  });

  it('matches the tee/ setter commitment vector through setterCommitment()', () => {
    const vector = vectors.hash.find((v) => v.message === 'setterCommitment');
    // The vector is in the hash list, so it also passes through encodeMessage above.
    expect(vector, 'tee/testdata/vectors.json has no setterCommitment vector').toBeDefined();
    const field = (name: string) => vector?.fields.find((f) => f.name === name)?.value ?? '';
    expect(setterCommitment(fromHex(field('examId')), field('name'), fromHex(field('salt')))).toBe(vector?.hash);
  });

  it('matches tee/ for the attestation nonce', () => {
    const vector = vectors.attestationNonce;
    const fields = { instancePublicKey: fromHex(vector.instancePublicKey), examId: fromHex(vector.examId) };
    expect(toHex(encodeMessage('attestationNonce', fields))).toBe(vector.preimage);
    expect(attestationNonce(fromHex(vector.instancePublicKey), fromHex(vector.examId))).toBe(vector.nonce);
  });
});

describe('schedule', () => {
  const genesis = constants.drand.genesisTime;
  const period = constants.drand.periodSeconds;
  const settings = (): ExamSettings => ({
    examId: `0x${'11'.repeat(32)}`,
    examStart: genesis + 3000 * period + 1,
    delta: 600,
    lockRound: '100',
    unlockRound: String(firstRoundAtOrAfter(genesis + 3000 * period + 1 - 600)),
    endRound: '4000',
    criteriaHash: `0x${'22'.repeat(32)}`,
    rpcHost: 'rpc.example.org',
    registry: `0x${'AB'.repeat(20)}`,
    chainId: constants.chain.chainId,
  });
  const code = (s: ExamSettings) => {
    try {
      checkSchedule(s);
    } catch (e) {
      expect(e).toBeInstanceOf(ScheduleError);
      return (e as ScheduleError).code;
    }
    return undefined;
  };

  it('computes the first round at or after a time, either side of the boundary', () => {
    expect(firstRoundAtOrAfter(genesis)).toBe(1);
    expect(firstRoundAtOrAfter(genesis + 1)).toBe(2);
    expect(firstRoundAtOrAfter(genesis + period)).toBe(2);
    expect(firstRoundAtOrAfter(genesis + period + 1)).toBe(3);
    expect(roundTimeSeconds(firstRoundAtOrAfter(genesis + 10 * period))).toBe(genesis + 10 * period);
    expect(() => firstRoundAtOrAfter(genesis - 1)).toThrow(RangeError);
  });

  it('accepts a valid schedule', () => {
    expect(code(settings())).toBeUndefined();
  });

  it('pins unlockRound exactly', () => {
    const s = settings();
    const n = Number(s.unlockRound);
    expect(code({ ...s, unlockRound: String(n - 1) })).toBe('unlock_round');
    expect(code({ ...s, unlockRound: String(n + 1) })).toBe('unlock_round');
    // On an exact round boundary the same round is correct, one second later the next.
    const exact = { ...s, examStart: genesis + 3000 * period + 600 };
    expect(code({ ...exact, unlockRound: String(firstRoundAtOrAfter(genesis + 3000 * period)) })).toBeUndefined();
    expect(code({ ...exact, examStart: exact.examStart + 1 })).toBe('unlock_round');
  });

  it('requires endRound to be produced after examStart', () => {
    const s = settings();
    const first = Math.floor((s.examStart - genesis) / period) + 1; // latest round produced at or before examStart
    const at = first + (roundTimeSeconds(first) === s.examStart ? 0 : 0);
    expect(code({ ...s, endRound: String(at) })).toBe('end_round');
    expect(code({ ...s, endRound: String(at + 1) })).toBeUndefined();
  });

  it('checks order, delta, genesis and chain', () => {
    const s = settings();
    expect(code({ ...s, lockRound: s.unlockRound })).toBe('round_order');
    expect(code({ ...s, endRound: s.unlockRound })).toBe('round_order');
    expect(code({ ...s, delta: 0 })).toBe('delta_zero');
    expect(code({ ...s, examStart: genesis + 600, delta: 600 })).toBe('before_genesis');
    expect(code({ ...s, chainId: 1 })).toBe('chain_id');
  });

  it('lists startup arguments in table order', () => {
    const s = settings();
    expect(startupArgs(s)).toEqual([
      `--exam-id=0x${'11'.repeat(32)}`,
      `--exam-start=${String(s.examStart)}`,
      '--delta=600',
      '--lock-round=100',
      `--unlock-round=${s.unlockRound}`,
      '--end-round=4000',
      `--criteria-hash=0x${'22'.repeat(32)}`,
      '--rpc-host=rpc.example.org',
      `--registry=0x${'ab'.repeat(20)}`,
      '--chain-id=11155111',
    ]);
    expect(() => startupArgs({ ...s, lockRound: '007' })).toThrow(TypeError);
  });
});
