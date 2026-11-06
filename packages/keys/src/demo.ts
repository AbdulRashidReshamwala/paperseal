import { mapHashToField } from '@noble/curves/abstract/modular';
import { p256 } from '@noble/curves/nist';
import { passkeyRecordValue, toHex, utf8ToBytes, type Hex } from '@paperseal/protocol';

/*
 * Planted demo keys, for showing a whole exam on one machine (`pnpm demo:keys`, see apps/web/src/demo).
 *
 * This file is a demo tool. It is outside the package's main entry on purpose, so nothing reaches it
 * without importing `@paperseal/keys/demo`, and only the web app's demo mode and the demo commands do.
 * Everything here comes from the seed printed below, so anyone can sign as any demo person. These keys
 * must never be on a real exam.
 *
 * Nothing is faked. `softwareCredentials` is a software authenticator, like Chrome's virtual
 * authenticator: each key is a real P-256 key and each signature a real ES256 signature, made by the
 * audited library the repo already uses, in the WebAuthn format the sealed machine checks.
 * `spec/fixtures/demo-keys.json` is written by this code, and the Go tests pass it to `webauthn.Verify`.
 */

/** Public on purpose. Changing it changes every planted key, and so the records on every demo name. */
export const demoSeed = 'paperseal/demo-keys/v1: public seed, for demos only, never for a real exam';

const ES256 = -7;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED = 0x40;
/** A WebAuthn PRF input is hashed with this prefix before it reaches the authenticator. */
const PRF_PREFIX = utf8ToBytes('WebAuthn PRF\0');

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
const view = (source: BufferSource): Uint8Array =>
  ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer(bytes)));

async function hkdf(purpose: string, label: string, bytes: number): Promise<Uint8Array> {
  const seed = await globalThis.crypto.subtle.importKey('raw', buffer(utf8ToBytes(demoSeed)), 'HKDF', false, ['deriveBits']);
  const info = buffer(utf8ToBytes(`${purpose}/${label}`));
  return new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info }, seed, bytes * 8));
}

export interface PlantedKey {
  /** The person's label, such as `centre-1`. */
  label: string;
  credentialId: Uint8Array;
  /** The 65-byte uncompressed P-256 public key. */
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  /** Stands in for a security key's hmac-secret. */
  prfSecret: Uint8Array;
}

/** The same label always gives the same key, so a reload or a restart loses nothing. */
export async function plantedKey(label: string): Promise<PlantedKey> {
  const privateKey = mapHashToField(await hkdf('p256', label, 48), p256.CURVE.n);
  return {
    label,
    credentialId: await hkdf('credential', label, 32),
    publicKey: p256.getPublicKey(privateKey, false),
    privateKey,
    prfSecret: await hkdf('prf', label, 32),
  };
}

/** The public values a name's records hold. Compare `KeyCard` in @paperseal/protocol. */
export function plantedRecords(key: Pick<PlantedKey, 'credentialId' | 'publicKey'>): { passkey: Hex; credentialId: Hex } {
  return { passkey: passkeyRecordValue(key.publicKey), credentialId: toHex(key.credentialId) };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/** The JSON a browser hands an authenticator, in the browser's own key order. */
function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: BufferSource, origin: string): Uint8Array {
  return utf8ToBytes(JSON.stringify({ type, challenge: base64url(view(challenge)), origin, crossOrigin: false }));
}

/** rpIdHash, flags and a zero counter. Both backup flags stay clear: this key does not sync. */
async function authenticatorData(rpId: string, extraFlags = 0, attested: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
  return concat(await sha256(utf8ToBytes(rpId)), new Uint8Array([FLAG_USER_PRESENT | FLAG_USER_VERIFIED | extraFlags, 0, 0, 0, 0]), attested);
}

/** A COSE_Key for an ES256 key (RFC 9053), in CBOR: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
function coseKey(publicKey: Uint8Array): Uint8Array {
  const x = publicKey.subarray(1, 33);
  const y = publicKey.subarray(33);
  return concat(new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, new Uint8Array([0x22, 0x58, 0x20]), y);
}

/** An object in the `none` format, in CBOR: {fmt: "none", attStmt: {}, authData}. */
function attestationObject(data: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([0xa3, 0x63]),
    utf8ToBytes('fmt'),
    new Uint8Array([0x64]),
    utf8ToBytes('none'),
    new Uint8Array([0x67]),
    utf8ToBytes('attStmt'),
    new Uint8Array([0xa0, 0x68]),
    utf8ToBytes('authData'),
    new Uint8Array([0x59, data.length >> 8, data.length & 0xff]),
    data,
  );
}

/** A real SubjectPublicKeyInfo, from WebCrypto. */
async function spki(publicKey: Uint8Array): Promise<ArrayBuffer> {
  const key = await globalThis.crypto.subtle.importKey('raw', buffer(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return globalThis.crypto.subtle.exportKey('spki', key);
}

async function prfResult(secret: Uint8Array, input: BufferSource): Promise<ArrayBuffer> {
  const key = await globalThis.crypto.subtle.importKey('raw', buffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return globalThis.crypto.subtle.sign('HMAC', key, buffer(await sha256(concat(PRF_PREFIX, view(input)))));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);

function checkRp(rpId: string | undefined, origin: string): string {
  if (!rpId || new URL(origin).hostname !== rpId) throw new DOMException(`${String(rpId)} is not this page's domain.`, 'SecurityError');
  return rpId;
}

/**
 * Answers `create` and `get` as one security key holding one planted key would, with the responses a
 * browser returns. `origin` is the page's, and goes into clientDataJSON as the browser would put it.
 */
export function softwareCredentials(key: PlantedKey, origin: string): Pick<CredentialsContainer, 'create' | 'get'> {
  const credential = (response: unknown, extensions: AuthenticationExtensionsClientOutputs) =>
    ({
      type: 'public-key',
      id: base64url(key.credentialId),
      rawId: buffer(key.credentialId),
      authenticatorAttachment: 'cross-platform',
      response,
      getClientExtensionResults: () => extensions,
    }) as unknown as Credential;

  return {
    async create(options) {
      const request = options?.publicKey;
      if (!request) throw new DOMException('Only public key credentials are made here.', 'NotSupportedError');
      const rpId = checkRp(request.rp.id, origin);
      if (!request.pubKeyCredParams.some(({ alg }) => alg === ES256)) throw new DOMException('Only ES256 keys are made here.', 'NotSupportedError');
      if (request.excludeCredentials?.some(({ id }) => sameBytes(view(id), key.credentialId))) {
        throw new DOMException('This key already holds that credential.', 'InvalidStateError');
      }
      const length = new Uint8Array([key.credentialId.length >> 8, key.credentialId.length & 0xff]);
      const attested = concat(new Uint8Array(16), length, key.credentialId, coseKey(key.publicKey));
      const data = await authenticatorData(rpId, FLAG_ATTESTED, attested);
      const publicKey = await spki(key.publicKey);
      const response = {
        clientDataJSON: buffer(clientData('webauthn.create', request.challenge, origin)),
        attestationObject: buffer(attestationObject(data)),
        getAuthenticatorData: () => buffer(data),
        getPublicKey: () => publicKey.slice(0),
        getPublicKeyAlgorithm: () => ES256,
        getTransports: () => ['usb'],
      };
      return credential(response, request.extensions?.prf ? { prf: { enabled: true } } : {});
    },

    async get(options) {
      const request = options?.publicKey;
      if (!request) throw new DOMException('Only public key credentials are read here.', 'NotSupportedError');
      const rpId = checkRp(request.rpId, origin);
      // A real key with no matching credential never answers, and the browser reports that like this.
      if (!request.allowCredentials?.some(({ id }) => sameBytes(view(id), key.credentialId))) {
        throw new DOMException('This key does not hold that credential.', 'NotAllowedError');
      }
      const client = clientData('webauthn.get', request.challenge, origin);
      const data = await authenticatorData(rpId);
      const signed = await sha256(concat(data, await sha256(client)));
      const signature = p256.sign(signed, key.privateKey, { prehash: false, lowS: false }).toDERRawBytes();
      const input = request.extensions?.prf?.eval?.first;
      const response = { clientDataJSON: buffer(client), authenticatorData: buffer(data), signature: buffer(signature), userHandle: null };
      return credential(response, input ? { prf: { results: { first: await prfResult(key.prfSecret, input) } } } : {});
    },
  };
}
