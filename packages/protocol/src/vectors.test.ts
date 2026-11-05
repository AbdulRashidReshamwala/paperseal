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
  entriesHash,
  fromHex,
  pad,
  parseManifest,
  releaseEntryFromWire,
  selectedCount,
  storageManifestHash,
  toHex,
  unpad,
  utf8ToBytes,
  type ReleaseEntryWire,
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
  manifest: { manifest: string; storageManifestHash: string };
}

const path = resolve(import.meta.dirname, '../../../tee/testdata/vectors.json');
const vectors = JSON.parse(readFileSync(path, 'utf8')) as Vectors;

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
