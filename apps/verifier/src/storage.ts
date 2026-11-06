import { type Hex } from '@paperseal/protocol';

/** The public bucket, read from the viewer's own base URL. Hashes protect the content. */
export interface StorageReader {
  /** The full URL of a file under `<examId>/`. */
  url: (name: string) => string;
  /** The file's bytes, or null if the bucket has no such file. Any other failure throws. */
  get: (name: string) => Promise<Uint8Array | null>;
}

export function createStorage(
  baseUrl: string,
  examId: Hex,
  send: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): StorageReader {
  const base = baseUrl.replace(/\/+$/, '');
  const url = (name: string) => `${base}/${examId}/${name}`;
  return {
    url,
    get: async (name) => {
      const response = await send(url(name));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`The public files returned error ${String(response.status)} for ${name}.`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export const utf8Text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** `release-token.jwt` in spec/api.md. @paperseal/protocol's storageNames does not list it yet. */
export const releaseTokenName = 'release-token.jwt';
