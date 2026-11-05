/** A copy backed by a plain ArrayBuffer, the form WebCrypto and HPKE accept. */
export function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** A standalone ArrayBuffer holding exactly these bytes. */
export function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return buf(bytes).buffer;
}
