import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { encodeAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  checkManifestCoverage,
  constants,
  decodeRelease,
  encodeMessage,
  encodePaper,
  encodeQuestion,
  encodeRelease,
  encodeReleaseEntries,
  encodeReleaseFiles,
  entriesHash,
  filesHash,
  FormatError,
  fromHex,
  noInviteTag,
  prfInput,
  hashMessage,
  limits,
  pad,
  padPaper,
  padQuestion,
  parseManifest,
  parsePaper,
  parseQuestion,
  releaseEntryFromWire,
  releaseFileFromWire,
  sortReleaseFiles,
  requireSecurityKeyAttestation,
  stages,
  storageManifestHash,
  storageNames,
  toHex,
  unpad,
  unpadPaper,
  unpadQuestion,
  type Hex,
} from './index';

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const point = (fill: number) => Uint8Array.from([4, ...bytes(64, fill)]);
const sha = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());

describe('constants and stages', () => {
  it('has a schema for every one of the 14 domain tags', () => {
    expect(Object.keys(constants.domainTags)).toHaveLength(14);
    const sample = { examId: bytes(32, 1), encryptionPublicKey: point(2) };
    expect(constants.domainTags.instanceKey).toBe('paperseal/v1/instance-key');
    expect(encodeMessage('instanceKey', sample).length).toBeGreaterThan(0);
  });

  it('exports requireSecurityKeyAttestation from constants.json', () => {
    expect(requireSecurityKeyAttestation).toBe(constants.webauthn.requireSecurityKeyAttestation);
  });

  it('includes the TEE API stages', () => {
    for (const stage of ['onboard', 'submit', 'lock', 'build', 'distribute', 'unlock', 'released', 'failed']) {
      expect(stages).toContain(stage);
    }
  });
});

describe('instanceKey message', () => {
  const examId = bytes(32, 0x11);
  const key = point(0x22);

  it('is SHA-256(abi.encode(tag, bytes32 examId, bytes encryptionPublicKey))', () => {
    const preimage = fromHex(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'bytes32' }, { type: 'bytes' }],
        [constants.domainTags.instanceKey, toHex(examId), toHex(key)],
      ),
    );
    expect(encodeMessage('instanceKey', { examId, encryptionPublicKey: key })).toEqual(preimage);
    expect(hashMessage('instanceKey', { examId, encryptionPublicKey: key })).toEqual(sha(preimage));
  });

  it('rejects a key that is not a 65-byte uncompressed point', () => {
    expect(() => encodeMessage('instanceKey', { examId, encryptionPublicKey: bytes(33, 2) })).toThrow(RangeError);
    expect(() => encodeMessage('instanceKey', { examId, encryptionPublicKey: bytes(65, 5) })).toThrow(RangeError);
  });

  it('has a tee/ vector for instanceKey', () => {
    const vectorsPath = resolve(import.meta.dirname, '../../../tee/testdata/vectors.json');
    expect(existsSync(vectorsPath), `${vectorsPath} is missing`).toBe(true);
    const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { hash: { message: string }[] };
    expect(vectors.hash.some((v) => v.message === 'instanceKey')).toBe(true);
  });
});

describe('prfInput', () => {
  const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../tee/testdata/vectors.json'), 'utf8')) as {
    hash: { message: string; fields: { name: string; value: string }[]; encoded: string; hash: string }[];
  };

  it('matches the Go vectors, and differs per exam', () => {
    const found = vectors.hash.filter((vector) => vector.message === 'prfInput');
    expect(found).toHaveLength(2);
    for (const vector of found) {
      const examId = fromHex(vector.fields.find((field) => field.name === 'examId')?.value as Hex);
      expect(toHex(prfInput(examId))).toBe(vector.hash);
    }
    expect(found[0]?.hash).not.toBe(found[1]?.hash);
  });

  it('pins a registration by name, with its zero tag', () => {
    const vector = vectors.hash.find((item) => item.message === 'registration' && item.fields.some((field) => field.value === toHex(noInviteTag)));
    const field = (name: string) => fromHex(vector?.fields.find((item) => item.name === name)?.value as Hex);
    const message = hashMessage('registration', {
      derivedPublicKey: field('derivedPublicKey'),
      holderId: field('holderId'),
      challenge: field('challenge'),
      inviteTag: noInviteTag,
    });
    expect(toHex(message)).toBe(vector?.hash);
  });
});

describe('padding', () => {
  it('frames a big-endian length, the data, then zeros', () => {
    const padded = pad(Uint8Array.of(7, 8, 9), 16);
    expect(toHex(padded)).toBe('0x00000003070809' + '00'.repeat(9));
    expect(unpad(padded, 16)).toEqual(Uint8Array.of(7, 8, 9));
  });

  it('round-trips empty data and exactly full data', () => {
    expect(unpad(pad(new Uint8Array(), 8), 8)).toEqual(new Uint8Array());
    const full = bytes(4, 9);
    expect(unpad(pad(full, 8), 8)).toEqual(full);
  });

  it('rejects data that does not fit', () => {
    expect(() => pad(bytes(5, 1), 8)).toThrow('does not fit');
  });

  it('rejects non-zero padding, a wrong size and a bad length', () => {
    const padded = pad(Uint8Array.of(1), 16);
    const dirty = padded.slice();
    dirty[15] = 1;
    expect(() => unpad(dirty, 16)).toThrow('not zero');
    expect(() => unpad(padded, 32)).toThrow('must be 32 bytes');
    const long = padded.slice();
    long[3] = 13;
    expect(() => unpad(long, 16)).toThrow('does not fit');
  });

  it('uses the sizes from constants.json', () => {
    expect(padQuestion(Uint8Array.of(1)).length).toBe(constants.padding.questionBytes);
    expect(padPaper(Uint8Array.of(1)).length).toBe(constants.padding.paperBytes);
    expect(unpadQuestion(padQuestion(Uint8Array.of(1)))).toEqual(Uint8Array.of(1));
    expect(unpadPaper(padPaper(Uint8Array.of(1)))).toEqual(Uint8Array.of(1));
  });
});

describe('questions and papers', () => {
  const criteria = {
    topics: [
      { name: 'algebra', questions: 1 },
      { name: 'geometry', questions: 2 },
    ],
  };
  const examId = toHex(bytes(32, 0xab));
  const text = new TextEncoder();

  it('round-trips a question and checks its topic', () => {
    const encoded = encodeQuestion({ topic: 'algebra', text: 'x² = 4?' });
    expect(parseQuestion(encoded, criteria)).toEqual({ topic: 'algebra', text: 'x² = 4?' });
    expect(() => parseQuestion(encoded, { topics: [{ name: 'other', questions: 1 }] })).toThrow('not a criteria topic');
  });

  it.each([
    ['extra key', '{"topic":"a","text":"b","x":1}'],
    ['missing key', '{"topic":"a"}'],
    ['non-string', '{"topic":"a","text":2}'],
    ['array', '[]'],
    ['null', 'null'],
    ['not JSON', '{topic'],
  ])('rejects a question with %s', (_name, json) => {
    expect(() => parseQuestion(json)).toThrow();
  });

  it('encodes a written question to the same bytes as before, with no options key', () => {
    const encoded = encodeQuestion({ topic: 'algebra', text: 'x² = 4?' });
    expect(new TextDecoder().decode(encoded)).toBe('{"topic":"algebra","text":"x² = 4?"}');
  });

  it('round-trips a multiple choice question in key order, keeping the option order', () => {
    const question = { topic: 'algebra', text: 'x² = 4?', options: ['2', '-2', 'Both', 'Neither'] };
    const encoded = encodeQuestion(question);
    expect(new TextDecoder().decode(encoded)).toBe(
      '{"topic":"algebra","text":"x² = 4?","options":["2","-2","Both","Neither"]}',
    );
    expect(parseQuestion(encoded, criteria)).toEqual(question);
    // Key order is fixed by the encoder, whatever order the caller built the object in.
    const shuffled = { options: question.options, text: question.text, topic: question.topic };
    expect(encodeQuestion(shuffled)).toEqual(encoded);
  });

  it('accepts the minimum and the maximum number of options', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `option ${String(i)}`);
    for (const n of [limits.questionOptionsMin, limits.questionOptionsMax]) {
      const question = { topic: 'algebra', text: 'q', options: many(n) };
      expect(parseQuestion(encodeQuestion(question))).toEqual(question);
    }
  });

  it.each([
    ['null options', '{"topic":"a","text":"b","options":null}', 'must be a list'],
    ['an empty list', '{"topic":"a","text":"b","options":[]}', 'between'],
    ['one option', '{"topic":"a","text":"b","options":["x"]}', 'between'],
    ['too many options', `{"topic":"a","text":"b","options":${JSON.stringify(Array.from({ length: limits.questionOptionsMax + 1 }, (_, i) => String(i)))}}`, 'between'],
    ['a blank option', '{"topic":"a","text":"b","options":["x"," \\t "]}', 'blank'],
    ['an empty option', '{"topic":"a","text":"b","options":["x",""]}', 'blank'],
    ['a duplicate option', '{"topic":"a","text":"b","options":["x","y","x"]}', 'more than once'],
    ['a non-string option', '{"topic":"a","text":"b","options":["x",2]}', 'must be a string'],
    ['options as a string', '{"topic":"a","text":"b","options":"xy"}', 'must be a list'],
    ['options before text', '{"topic":"a","options":["x","y"]}', 'exactly'],
  ])('refuses a question with %s', (_name, json, message) => {
    expect(() => parseQuestion(json)).toThrow(message);
  });

  it('refuses to encode invalid options, including an undefined options key', () => {
    const base = { topic: 'algebra', text: 'q' };
    expect(() => encodeQuestion({ ...base, options: [] })).toThrow('between');
    expect(() => encodeQuestion({ ...base, options: ['a'] })).toThrow('between');
    expect(() => encodeQuestion({ ...base, options: ['a', ' '] })).toThrow('blank');
    expect(() => encodeQuestion({ ...base, options: ['a', 'a'] })).toThrow('more than once');
    expect(() => encodeQuestion({ ...base, options: undefined } as never)).toThrow('must be a list');
    expect(() => encodeQuestion({ ...base, options: null } as never)).toThrow('must be a list');
  });

  it('round-trips a paper that mixes written and multiple choice questions', () => {
    const questions = [
      { topic: 'algebra', text: 'a', options: ['1', '2'] },
      { topic: 'geometry', text: 'b' },
      { topic: 'geometry', text: 'c', options: ['x', 'y', 'z'] },
    ];
    const encoded = encodePaper({ examId: examId as `0x${string}`, questions });
    const parsed = parsePaper(encoded, criteria);
    expect(parsed).toEqual({ examId, questions });
    expect('options' in (parsed.questions[1] ?? {})).toBe(false);
    expect(() =>
      parsePaper(`{"examId":"${examId}","questions":[{"topic":"algebra","text":"a","options":["1","1"]}]}`),
    ).toThrow('paper question 0');
  });

  it('rejects invalid UTF-8 and a byte order mark', () => {
    expect(() => parseQuestion(Uint8Array.of(0x7b, 0xff, 0x7d))).toThrow('UTF-8');
    expect(() => parseQuestion(Uint8Array.of(0xef, 0xbb, 0xbf, ...text.encode('{"topic":"a","text":"b"}')))).toThrow();
  });

  it('round-trips a paper and checks it against criteria', () => {
    const questions = [
      { topic: 'algebra', text: 'a' },
      { topic: 'geometry', text: 'b' },
      { topic: 'geometry', text: 'c' },
    ];
    const encoded = encodePaper({ examId: examId as `0x${string}`, questions });
    expect(parsePaper(encoded, criteria)).toEqual({ examId, questions });
    expect(() => parsePaper(encoded, { topics: [{ name: 'algebra', questions: 2 }, ...criteria.topics.slice(1)] })).toThrow(
      'expected 2',
    );
    expect(() => parsePaper('{"examId":"0x01","questions":[]}')).toThrow('examId');
    expect(() => parsePaper(`{"examId":"${examId}","questions":[],"x":1}`)).toThrow('exactly');
  });
});

describe('release plaintext', () => {
  const release = {
    share: bytes(33, 1),
    signature: bytes(70, 2),
    authenticatorData: bytes(37, 3),
    clientDataJSON: text('{"type":"webauthn.get"}'),
  };

  function text(value: string) {
    return new TextEncoder().encode(value);
  }

  it('is abi.encode(bytes share, bytes signature, bytes authenticatorData, bytes clientDataJSON)', () => {
    const expected = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }],
      [toHex(release.share), toHex(release.signature), toHex(release.authenticatorData), toHex(release.clientDataJSON)],
    );
    expect(toHex(encodeRelease(release))).toBe(expected);
    expect(decodeRelease(encodeRelease(release))).toEqual(release);
  });

  it('rejects garbage and non-canonical bytes', () => {
    expect(() => decodeRelease(Uint8Array.of(1, 2, 3))).toThrow('release');
    expect(() => decodeRelease(new Uint8Array([...encodeRelease(release), 0]))).toThrow();
  });
});

describe('release entries', () => {
  const entries = [
    { passkeyPublicKey: point(1), shareHash: bytes(32, 5), round: 123n },
    { passkeyPublicKey: point(2), shareHash: bytes(32, 6), round: 2n ** 63n },
  ];

  it('hashes abi.encode(ReleaseEntry[]) in order received', () => {
    const encoded = fromHex(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            components: [
              { name: 'passkeyPublicKey', type: 'bytes' },
              { name: 'shareHash', type: 'bytes32' },
              { name: 'round', type: 'uint64' },
            ],
          },
        ],
        [entries.map((e) => ({ passkeyPublicKey: toHex(e.passkeyPublicKey), shareHash: toHex(e.shareHash), round: e.round }))],
      ),
    );
    expect(encodeReleaseEntries(entries)).toEqual(encoded);
    expect(entriesHash(entries)).toEqual(sha(encoded));
    expect(entriesHash([...entries].reverse())).not.toEqual(entriesHash(entries));
  });

  it('feeds the releaseLog message', () => {
    const examId = bytes(32, 9);
    expect(hashMessage('releaseLog', { examId, entriesHash: entriesHash(entries), filesHash: filesHash([]) })).toHaveLength(32);
  });

  const first = { passkeyPublicKey: point(1), shareHash: bytes(32, 5), round: 123n };

  it('reads wire entries and rejects a bad round or hash', () => {
    const wire = { passkeyPublicKey: toHex(point(1)), shareHash: toHex(bytes(32, 5)), round: '123' } as const;
    expect(releaseEntryFromWire(wire).round).toBe(123n);
    expect(() => releaseEntryFromWire({ ...wire, round: '01' })).toThrow('decimal');
    expect(() => encodeReleaseEntries([{ ...first, shareHash: bytes(31, 0) }])).toThrow(RangeError);
    expect(() => encodeReleaseEntries([{ ...first, round: 2n ** 64n }])).toThrow(RangeError);
  });
});

describe('release files', () => {
  const file = (name: string, fill = 1) => ({ name, sha256: bytes(32, fill) });

  it('hashes abi.encode(ReleaseFile[])', () => {
    const files = [file('key-priv.tlock', 1), file('key-priv/a.bin', 2)];
    const encoded = fromHex(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            components: [
              { name: 'name', type: 'string' },
              { name: 'sha256', type: 'bytes32' },
            ],
          },
        ],
        [files.map((f) => ({ name: f.name, sha256: toHex(f.sha256) }))],
      ),
    );
    expect(encodeReleaseFiles(files)).toEqual(encoded);
    expect(filesHash(files)).toEqual(sha(encoded));
  });

  it('sorts a copy in UTF-8 byte order, unlike locale order or UTF-16 order', () => {
    const names = (list: { name: string }[]) => list.map((f) => f.name);
    const input = [file('a'), file('Z'), file('key-priv/x'), file('key-priv.tlock')];
    expect(names(sortReleaseFiles(input))).toEqual(['Z', 'a', 'key-priv.tlock', 'key-priv/x']);
    expect(names(input)).toEqual(['a', 'Z', 'key-priv/x', 'key-priv.tlock']);
    // U+FF21 comes before U+1F600 in UTF-8, and after its surrogates in UTF-16.
    expect(names(sortReleaseFiles([file('\u{1F600}'), file('\uFF21')]))).toEqual(['\uFF21', '\u{1F600}']);
    // A name that is a prefix of another comes first.
    expect(names(sortReleaseFiles([file('ab'), file('a')]))).toEqual(['a', 'ab']);
  });

  it('refuses unsorted or repeated names and a bad hash', () => {
    expect(() => encodeReleaseFiles([file('b'), file('a')])).toThrow(FormatError);
    expect(() => encodeReleaseFiles([file('a', 1), file('a', 2)])).toThrow(FormatError);
    expect(() => filesHash([file('a'), file('Z')])).toThrow('sorted');
    expect(() => encodeReleaseFiles([{ name: 'a', sha256: bytes(31, 0) }])).toThrow(RangeError);
  });

  it('reads wire files and rejects a bad hash', () => {
    const wire = { name: 'a', sha256: toHex(bytes(32, 0xab)) };
    expect(releaseFileFromWire(wire)).toEqual({ name: 'a', sha256: bytes(32, 0xab) });
    expect(() => releaseFileFromWire({ ...wire, sha256: toHex(bytes(31, 0)) })).toThrow(FormatError);
    expect(() => releaseFileFromWire({ ...wire, sha256: `0x${'AB'.repeat(32)}` })).toThrow(FormatError);
    expect(() => releaseFileFromWire({ ...wire, name: 1 as never })).toThrow(FormatError);
  });
});

describe('manifest', () => {
  const holder = point(7);
  const examId = toHex(bytes(32, 1));
  const h = (n: number) => toHex(bytes(32, n));
  const manifest = {
    examId,
    files: [
      { name: 'key-pub.tlock', sha256: h(2) },
      { name: 'paper.bin', sha256: h(3) },
      { name: storageNames.share(holder), sha256: h(4), recipient: toHex(holder), shareHash: h(5) },
      { name: 'token.jwt', sha256: h(6) },
    ],
  };
  const json = JSON.stringify(manifest);

  it('parses, hashes the stored bytes and checks coverage', () => {
    expect(parseManifest(json)).toEqual(manifest);
    const stored = new TextEncoder().encode(json);
    expect(storageManifestHash(stored)).toEqual(sha(stored));
    expect(() => checkManifestCoverage(parseManifest(json), [holder])).not.toThrow();
  });

  it('rejects missing, extra and incomplete entries', () => {
    expect(() => checkManifestCoverage(parseManifest(json), [])).toThrow('unexpected');
    expect(() => checkManifestCoverage(parseManifest(json), [holder, point(8)])).toThrow('does not list');
    const noToken = { ...manifest, files: manifest.files.filter((f) => f.name !== 'token.jwt') };
    expect(() => checkManifestCoverage(parseManifest(JSON.stringify(noToken)), [holder])).toThrow('token.jwt');
    const noHash = { ...manifest, files: manifest.files.map((f) => ({ name: f.name, sha256: f.sha256 })) };
    expect(() => checkManifestCoverage(parseManifest(JSON.stringify(noHash)), [holder])).toThrow('recipient');
  });

  it.each([
    ['unsorted', { ...manifest, files: [...manifest.files].reverse() }, 'sorted'],
    ['repeated', { ...manifest, files: [manifest.files[0], manifest.files[0]] }, 'sorted'],
    ['unknown key', { ...manifest, files: [{ ...manifest.files[0], extra: 1 }] }, 'unknown key'],
    ['short hash', { ...manifest, files: [{ name: 'a', sha256: '0x00' }] }, 'sha256'],
    ['uppercase hex', { ...manifest, files: [{ name: 'a', sha256: `0x${'AB'.repeat(32)}` }] }, 'sha256'],
    ['extra top key', { ...manifest, more: 1 }, 'exactly'],
  ])('rejects a %s manifest', (_name, value, message) => {
    expect(() => parseManifest(JSON.stringify(value))).toThrow(message);
  });
});
