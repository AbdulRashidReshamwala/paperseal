import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import type { Hex } from './types';

export { concatBytes, utf8ToBytes };

export function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}`;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^0x([0-9a-f]{2})*$/.test(hex)) {
    throw new Error('expected lowercase hex with a 0x prefix');
  }
  return hexToBytes(hex.slice(2)) as Uint8Array<ArrayBuffer>;
}

/** Big-endian encoding of an unsigned integer in `byteLength` bytes. */
export function uintBE(value: number | bigint, byteLength: number): Uint8Array {
  let rest = BigInt(value);
  if (rest < 0n || rest >= 1n << BigInt(byteLength * 8)) {
    throw new RangeError(`${value.toString()} does not fit in ${String(byteLength)} bytes`);
  }
  const out = new Uint8Array(byteLength);
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
