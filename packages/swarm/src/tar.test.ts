import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkCollectionPath, collectionTar, InvalidPathError, maxPathBytes } from './index';

const dir = mkdtempSync(join(tmpdir(), 'paperseal-swarm-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const encoder = new TextEncoder();
// The real storage names: a 65-byte P-256 key in lowercase hex with its 0x prefix.
const derivedPublicKey = `0x04${'ab'.repeat(64)}`;
const manifest = { path: 'manifest.json', bytes: encoder.encode('{"examId":"0x01","files":[]}') };
const longPath = `key-priv/${derivedPublicKey}.bin`;
const files = [
  manifest,
  { path: 'paper.bin', bytes: crypto.getRandomValues(new Uint8Array(5000)) },
  { path: 'empty.bin', bytes: new Uint8Array(0) },
  { path: 'exactly-512.bin', bytes: new Uint8Array(512).fill(7) },
  { path: `shares/${derivedPublicKey}.bin`, bytes: encoder.encode('share') },
  { path: longPath, bytes: encoder.encode('key-priv') },
];

/** Writes `tar` to disk and returns its path. */
function save(name: string, tar: Uint8Array): string {
  const file = join(dir, name);
  writeFileSync(file, tar);
  return file;
}

describe('collectionTar', () => {
  it('is read back by the system tar, long names included', async () => {
    expect(encoder.encode(longPath).length).toBe(145);
    const archive = save('collection.tar', await collectionTar(files));

    const listing = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n');
    expect(listing).toEqual(files.map((file) => file.path));

    const verbose = execFileSync('tar', ['-tvf', archive], { encoding: 'utf8' });
    expect(verbose).toMatch(/-rw-r--r--.* 5000 .*paper\.bin/);

    const out = join(dir, 'extracted');
    mkdirSync(out);
    execFileSync('tar', ['-xf', archive, '-C', out]);
    for (const file of files) {
      expect(new Uint8Array(readFileSync(join(out, file.path)))).toEqual(file.bytes);
    }
  });

  it('is plain uncompressed tar with the ustar magic and an end-of-archive marker', async () => {
    const tar = await collectionTar([{ path: 'a.txt', bytes: encoder.encode('hi') }]);
    expect(tar.length % 512).toBe(0);
    expect(new TextDecoder().decode(tar.subarray(257, 262))).toBe('ustar');
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
    expect(new TextDecoder().decode(tar.subarray(0, 5))).toBe('a.txt');
  });

  it('still ends with an end-of-archive marker when the entries fill a 10240-byte record', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}`, bytes: new Uint8Array(0) }));
    const tar = await collectionTar(twenty);
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
    const archive = save('twenty.tar', tar);
    expect(execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(20);
  });

  it('gives the same bytes for the same files', async () => {
    expect(await collectionTar(files)).toEqual(await collectionTar(files));
  });

  it('rejects an empty collection and duplicate paths', async () => {
    await expect(collectionTar([])).rejects.toThrow('at least one file');
    const twice = [manifest, manifest];
    await expect(collectionTar(twice)).rejects.toThrow(InvalidPathError);
  });

  it('rejects a bad path before building anything', async () => {
    await expect(collectionTar([{ path: '../escape', bytes: new Uint8Array(1) }])).rejects.toThrow(InvalidPathError);
  });
});

describe('checkCollectionPath', () => {
  it.each([
    'manifest.json',
    'key-priv/0x04ab.bin',
    'a/b/c.txt',
    'résumé.txt',
    'x'.repeat(maxPathBytes),
  ])('accepts %s', (path) => {
    expect(() => checkCollectionPath(path)).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['/manifest.json', 'leading /'],
    ['../manifest.json', '.. segment'],
    ['a/../b', '.. segment'],
    ['a/./b', '. segment'],
    ['.', '. segment'],
    ['a//b', 'empty segment'],
    ['a/', 'empty segment'],
    ['a\\b', 'backslash'],
    ['a\u0000b', 'control character'],
    ['a\nb', 'control character'],
    ['x'.repeat(maxPathBytes + 1), `over ${maxPathBytes} bytes`],
    ['é'.repeat(128), `over ${maxPathBytes} bytes`],
  ])('rejects %j (%s)', (path, reason) => {
    expect(() => checkCollectionPath(path)).toThrow(reason);
  });
});
