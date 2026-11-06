import { encryptedPaperHash, toHex, type Hex } from '@paperseal/protocol';

/** The public bucket, read from the viewer's own base URL. Hashes protect the content. */
export interface StorageReader {
  /** The full URL of a file under `<examId>/`. */
  url: (name: string) => string;
  /** The file's bytes, or null if the bucket has no such file. Any other failure throws. */
  get: (name: string) => Promise<Uint8Array | null>;
  /** When the store says it last wrote a file already read, in Unix seconds. For display only. */
  modified?: (name: string) => number | null;
}

export function createStorage(
  baseUrl: string,
  examId: Hex,
  send: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): StorageReader {
  const base = baseUrl.replace(/\/+$/, '');
  const url = (name: string) => `${base}/${examId}/${name}`;
  const times = new Map<string, number>();
  return {
    url,
    modified: (name) => times.get(name) ?? null,
    get: async (name) => {
      const response = await send(url(name));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`The public files returned error ${String(response.status)} for ${name}.`);
      const at = Date.parse(response.headers.get('last-modified') ?? '');
      if (!Number.isNaN(at)) times.set(name, Math.floor(at / 1000));
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export const utf8Text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The plain SHA-256 of a stored file. @paperseal/protocol only names it per file. */
export const fileSha256 = (bytes: Uint8Array): Hex => toHex(encryptedPaperHash(bytes));

/** `release-token.jwt` in spec/api.md. @paperseal/protocol's storageNames does not list it yet. */
export const releaseTokenName = 'release-token.jwt';
