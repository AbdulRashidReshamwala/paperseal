import { rabdi } from '@arkiv-network/sdk/chains';
import { defineChain, http, isHex, size, type Chain, type Hex, type Transport } from 'viem';

import { arkiv } from './spec';

/** Where to reach Arkiv. Shared by the reader and the writer. */
export interface ArkivConnection {
  /** RPC endpoint. Defaults to Rabdi's, with `accessKey` if given. Ignored when `transport` is given. */
  rpcUrl?: string | undefined;
  /**
   * An Arkiv Hub access key. Without one, requests go to the public RPC, which is rate limited.
   * Writers should use one. Readers in a static page may leave it out, since anyone can read it.
   */
  accessKey?: string | undefined;
  transport?: Transport | undefined;
}

/**
 * Rabdi, checked against `network` in spec/arkiv.json. With an access key it is the SDK's chain,
 * which carries the key in its RPC URL. Without one it is built from the spec, since the SDK's
 * `rabdi({ accessKey: '' })` warns on the console, which a static page reading the public RPC
 * would print for every viewer.
 */
export function arkivChain(accessKey = ''): Chain {
  // The SDK's chain is built either way so the spec is checked against it, but without a key it is
  // only compared, never used, so the placeholder key is never sent.
  const sdkChain = rabdi({ accessKey: accessKey === '' ? 'unused' : accessKey });
  if (
    sdkChain.id !== arkiv.network.chainId ||
    !sdkChain.rpcUrls.default.http[0]?.startsWith(`${arkiv.network.rpcUrl}/`)
  ) {
    throw new Error('spec/arkiv.json network does not match the SDK rabdi chain');
  }
  if (accessKey !== '') return sdkChain;
  // Every URL is replaced, so none carries the placeholder.
  return defineChain({
    ...sdkChain,
    rpcUrls: { default: { http: [arkiv.network.rpcUrl] } },
    blockExplorers: { default: { name: sdkChain.blockExplorers.default.name, url: arkiv.network.explorer } },
  });
}

/** `http()` with no URL uses the chain's RPC URL, which carries the access key. */
export const arkivTransport = (connection: ArkivConnection): Transport =>
  connection.transport ?? http(connection.rpcUrl);

/** The `examId` column: the 32-byte exam ID as lowercase `0x` hex. */
export function examIdColumn(examId: Hex): string {
  if (!isHex(examId, { strict: true }) || size(examId) !== 32) {
    throw new TypeError(`examId must be 32 bytes of hex, got ${examId}`);
  }
  return examId.toLowerCase();
}
