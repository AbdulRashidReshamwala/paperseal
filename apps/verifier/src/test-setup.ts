/*
 * Under jsdom, `Uint8Array` is jsdom's, while Node's TextEncoder, WebCrypto and Response return
 * Node's. Libraries that check `instanceof Uint8Array` then reject real bytes. Point the global
 * back at Node's class, so every byte array in a test is the same kind.
 */
const nodeUint8Array = new TextEncoder().encode('').constructor as Uint8ArrayConstructor;
if (globalThis.Uint8Array !== nodeUint8Array) globalThis.Uint8Array = nodeUint8Array;
