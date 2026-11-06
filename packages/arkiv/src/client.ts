import { rabdi } from '@arkiv-network/sdk/chains';
import { http, isHex, size, type Hex, type Transport } from 'viem';

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

/** Rabdi, from the SDK, checked against `network` in spec/arkiv.json. */
export function arkivChain(accessKey = '') {
  const chain = rabdi({ accessKey });
  if (chain.id !== arkiv.network.chainId) {
    throw new Error('spec/arkiv.json network does not match the SDK rabdi chain');
  }
  return chain;
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
