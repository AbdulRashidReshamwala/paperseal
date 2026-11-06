import { storageNames } from '@paperseal/protocol';
import type { Hex } from 'viem';

/*
 * Public storage, read the way apps/verifier/src/storage.ts reads it: `<base>/<examId>/<name>`,
 * with a 404 meaning "not there yet". The relay checks nothing about the bytes beyond what the
 * row needs: readers check every body.
 */

export type Fetch = typeof globalThis.fetch;

/** The two files written at unlock that spec/arkiv.md lets the relay mirror. */
export const releaseFiles = {
  log: storageNames.releaseLog,
  /** `release-token.jwt` in spec/api.md. @paperseal/protocol's storageNames does not list it yet. */
  token: 'release-token.jwt',
} as const;

export function storageObjectUrl(baseUrl: string, examId: Hex, name: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${examId.toLowerCase()}/${name}`;
}

/** A file is larger than the caller allows. Raised before the rest of the body is read. */
export class OverCapError extends Error {
  readonly file: string;
  readonly cap: number;
  constructor(file: string, cap: number) {
    super(`${file} is over its ${String(cap)}-byte cap`);
    this.name = 'OverCapError';
    this.file = file;
    this.cap = cap;
  }
}

/**
 * The file's exact bytes, or null if the bucket has no such file. Any other failure throws.
 * With `maxBytes`, a file past it throws `OverCapError`, and the body is never read past the cap.
 */
export async function fetchStorageFile(
  send: Fetch,
  baseUrl: string,
  examId: Hex,
  name: string,
  timeoutMs = 20_000,
  maxBytes?: number,
): Promise<Uint8Array | null> {
  const url = storageObjectUrl(baseUrl, examId, name);
  const response = await send(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`storage returned ${String(response.status)} for ${name}`);
  if (maxBytes === undefined) return new Uint8Array(await response.arrayBuffer());
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new OverCapError(name, maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new OverCapError(name, maxBytes);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
