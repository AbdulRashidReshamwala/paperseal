/**
 * The in-memory tar that `POST /bzz` turns into a Swarm collection. Bee reads it with Go's
 * `archive/tar`, so every entry becomes one path in the collection's manifest.
 */
import { packTar, type TarEntry } from 'modern-tar';

/** One file of a collection, under the same name it has in the storage bucket. */
export interface CollectionFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * The longest path accepted, in UTF-8 bytes. Storage names such as
 * `key-priv/0x<130 hex>.bin` are 145 bytes, past ustar's 100-byte name field, and their last
 * segment alone is over 100, so the ustar prefix can't split them. modern-tar writes such names
 * as a PAX `path` record, which Go's `archive/tar` reads. The cap only stops absurd names.
 */
export const maxPathBytes = 255;

export class InvalidPathError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`invalid collection path ${JSON.stringify(path)}: ${reason}`);
    this.name = 'InvalidPathError';
    this.path = path;
  }
}

/**
 * Throws `InvalidPathError` unless `path` is a plain relative path: `/`-separated, with no
 * leading `/`, no empty, `.` or `..` segments, no backslashes and no control characters. Bee
 * would resolve or reject the others in ways the bucket's names never need.
 */
export function checkCollectionPath(path: string): void {
  if (path === '') throw new InvalidPathError(path, 'empty');
  if (path.startsWith('/')) throw new InvalidPathError(path, 'leading /');
  if (path.includes('\\')) throw new InvalidPathError(path, 'backslash');
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw new InvalidPathError(path, 'control character');
  }
  for (const segment of path.split('/')) {
    if (segment === '') throw new InvalidPathError(path, 'empty segment');
    if (segment === '.' || segment === '..') throw new InvalidPathError(path, `${segment} segment`);
  }
  if (new TextEncoder().encode(path).length > maxPathBytes) {
    throw new InvalidPathError(path, `over ${maxPathBytes} bytes`);
  }
}

/**
 * An uncompressed tar of `files`, in the order given. Every header field that isn't the name or
 * size is fixed (mode 0644, owner 0, mtime 0), so the same files always give the same bytes.
 */
export async function collectionTar(files: readonly CollectionFile[]): Promise<Uint8Array<ArrayBuffer>> {
  if (files.length === 0) throw new Error('a collection needs at least one file');
  const seen = new Set<string>();
  const entries: TarEntry[] = files.map(({ path, bytes }) => {
    checkCollectionPath(path);
    if (seen.has(path)) throw new InvalidPathError(path, 'duplicate');
    seen.add(path);
    return {
      header: {
        name: path,
        size: bytes.length,
        type: 'file',
        mode: 0o644,
        mtime: new Date(0),
        uid: 0,
        gid: 0,
        uname: '',
        gname: '',
      },
      body: bytes,
    };
  });
  return packTar(entries);
}
