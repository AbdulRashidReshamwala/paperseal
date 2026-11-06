import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  criteriaHash,
  decodeCriteria,
  decodeRelease,
  encodeCriteria,
  encodeRelease,
  encodeReleaseEntries,
  encodeReleaseFiles,
  encodePaper,
  entriesHash,
  filesHash,
  fromHex,
  parsePaper,
  pad,
  parseManifest,
  releaseEntryFromWire,
  releaseFileFromWire,
  saltedPaperHash,
  selectedCount,
  sortReleaseFiles,
  storageManifestHash,
  toHex,
  unpad,
  utf8ToBytes,
  type Hex,
  type Question,
  type ReleaseEntryWire,
  type ReleaseFileWire,
} from './index';

/*
 * Cross-language checks against tee/testdata/vectors.json, which the Go side generates. The file
 * is committed, so a missing or malformed file fails here and never skips.
 */

interface Vectors {
  criteria: {
    decoded: { maxSetterPercent: number; minBankMultiple: number; topics: { name: string; questions: number }[] };
    encoded: string;
    hash: string;
    selected: number;
  };
  padding: { data: string; size: number; padded: string }[];
  release: { share: string; signature: string; authenticatorData: string; clientDataJSON: string; encoded: string };
  releaseEntries: { entries: ReleaseEntryWire[]; preimage: string; entriesHash: string };
  releaseFiles: {
    files: ReleaseFileWire[];
    preimage: string;
    filesHash: string;
    emptyPreimage: string;
    emptyFilesHash: string;
  };
  manifest: { manifest: string; storageManifestHash: string };
  paper: { name: string; examId: Hex; questions: Question[]; bytes: string; seed: string; saltedPaperHash: string }[];
}

const path = resolve(import.meta.dirname, '../../../tee/testdata/vectors.json');
const vectors = JSON.parse(readFileSync(path, 'utf8')) as Vectors;

describe('tee/ vectors: paper', () => {
  it('has written, multiple choice and awkward-character cases', () => {
    expect(vectors.paper.length).toBeGreaterThanOrEqual(3);
  });

  it.each(vectors.paper)('$name: encodes to the same bytes, parses back, and has the same salted hash', (vector) => {
    const paper = { examId: vector.examId, questions: vector.questions };
    expect(toHex(utf8ToBytes(JSON.stringify(paper)))).toBe(vector.bytes);
    expect(toHex(saltedPaperHash(fromHex(vector.seed), fromHex(vector.bytes)))).toBe(vector.saltedPaperHash);
    expect(toHex(encodePaper(paper))).toBe(vector.bytes);
    const parsed = parsePaper(fromHex(vector.bytes));
    expect(parsed).toEqual(paper);
    vector.questions.forEach((q, i) => {
      expect('options' in (parsed.questions[i] ?? {})).toBe('options' in q);
    });
  });
});

describe('tee/ vectors: padding', () => {
  it.each(vectors.padding)('size $size, $data', ({ data, size, padded }) => {
    const bytes = fromHex(data);
    if (padded === '') {
      // Go refused: the data and its 4-byte length do not fit.
      expect(() => pad(bytes, size)).toThrow('does not fit');
      return;
    }
    expect(toHex(pad(bytes, size))).toBe(padded);
    expect(unpad(fromHex(padded), size)).toEqual(bytes);
  });
});

describe('tee/ vectors: release plaintext', () => {
  const { release } = vectors;

  it('decodes the Go encoding into its four fields', () => {
    const decoded = decodeRelease(fromHex(release.encoded));
    expect(toHex(decoded.share)).toBe(release.share);
    expect(toHex(decoded.signature)).toBe(release.signature);
    expect(toHex(decoded.authenticatorData)).toBe(release.authenticatorData);
    expect(toHex(decoded.clientDataJSON)).toBe(release.clientDataJSON);
  });

  it('re-encodes to the same bytes', () => {
    const encoded = encodeRelease({
      share: fromHex(release.share),
      signature: fromHex(release.signature),
      authenticatorData: fromHex(release.authenticatorData),
      clientDataJSON: fromHex(release.clientDataJSON),
    });
    expect(toHex(encoded)).toBe(release.encoded);
  });
});

describe('tee/ vectors: release entries', () => {
  const { releaseEntries } = vectors;
  const entries = releaseEntries.entries.map(releaseEntryFromWire);

  it('encodes abi.encode(ReleaseEntry[]) to the Go preimage', () => {
    expect(toHex(encodeReleaseEntries(entries))).toBe(releaseEntries.preimage);
  });

  it('recomputes entriesHash', () => {
    expect(toHex(entriesHash(entries))).toBe(releaseEntries.entriesHash);
  });
});

describe('tee/ vectors: release files', () => {
  const { releaseFiles } = vectors;
  const files = releaseFiles.files.map(releaseFileFromWire);

  it('sorts names in the Go order, from any starting order', () => {
    const names = releaseFiles.files.map((file) => file.name);
    expect(names.indexOf('key-priv/Z.bin')).toBeLessThan(names.indexOf('key-priv/a.bin'));
    expect(sortReleaseFiles([...files].reverse()).map((file) => file.name)).toEqual(names);
    expect(sortReleaseFiles([...releaseFiles.files].reverse())).toEqual(releaseFiles.files);
  });

  it('encodes abi.encode(ReleaseFile[]) to the Go preimage', () => {
    expect(toHex(encodeReleaseFiles(sortReleaseFiles(files)))).toBe(releaseFiles.preimage);
  });

  it('recomputes filesHash', () => {
    expect(toHex(filesHash(sortReleaseFiles(files)))).toBe(releaseFiles.filesHash);
  });

  it('matches Go for the empty list, the log before the threshold', () => {
    expect(toHex(encodeReleaseFiles([]))).toBe(releaseFiles.emptyPreimage);
    expect(toHex(filesHash([]))).toBe(releaseFiles.emptyFilesHash);
  });

  it('refuses the same files out of order', () => {
    expect(() => filesHash([...files].reverse())).toThrow('sorted');
  });
});

describe('tee/ vectors: storage manifest', () => {
  const { manifest } = vectors;

  it('recomputes the storage manifest hash over the exact manifest bytes', () => {
    expect(toHex(storageManifestHash(utf8ToBytes(manifest.manifest)))).toBe(manifest.storageManifestHash);
  });

  it('parses strictly', () => {
    const parsed = parseManifest(manifest.manifest);
    expect(parsed.examId).toBe(`0x${'11'.repeat(32)}`);
    expect(parsed.files.map((f) => f.name)).toContain('key-pub.tlock');
  });
});

describe('tee/ vectors: criteria', () => {
  const { criteria } = vectors;

  it('matches the encoding, hash and selected count', () => {
    expect(toHex(encodeCriteria(criteria.decoded))).toBe(criteria.encoded);
    expect(toHex(criteriaHash(fromHex(criteria.encoded)))).toBe(criteria.hash);
    expect(selectedCount(criteria.decoded)).toBe(criteria.selected);
  });

  it('decodes the Go encoding', () => {
    expect(decodeCriteria(fromHex(criteria.encoded))).toEqual(criteria.decoded);
  });
});
