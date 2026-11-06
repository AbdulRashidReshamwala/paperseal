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

/** The file's exact bytes, or null if the bucket has no such file. Any other failure throws. */
export async function fetchStorageFile(
  send: Fetch,
  baseUrl: string,
  examId: Hex,
  name: string,
  timeoutMs = 20_000,
): Promise<Uint8Array | null> {
  const url = storageObjectUrl(baseUrl, examId, name);
  const response = await send(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`storage returned ${String(response.status)} for ${name}`);
  return new Uint8Array(await response.arrayBuffer());
}
