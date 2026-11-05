// Runs in Chromium. It bundles the real packages/keys code and exposes it to the test driver,
// which passes bytes as hex strings. Nothing from packages/keys is stubbed.
import { createWebAuthnKeys, KeyError, readBackupFlags } from '../src/index';

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** What the real code asked the browser for. */
interface RecordedRequest {
  kind: 'create' | 'get';
  userVerification: string | undefined;
  prfSaltHex: string | null;
  attestation: string | undefined;
  residentKey: string | undefined;
}
const requests: RecordedRequest[] = [];

/**
 * Forwards to the browser's real credential API and records each request's options. The real
 * authenticator still answers every call.
 */
const recording = {
  create(options?: CredentialCreationOptions) {
    const pk = options?.publicKey;
    requests.push({
      kind: 'create',
      userVerification: pk?.authenticatorSelection?.userVerification,
      prfSaltHex: null,
      attestation: pk?.attestation,
      residentKey: pk?.authenticatorSelection?.residentKey,
    });
    return navigator.credentials.create(options);
  },
  get(options?: CredentialRequestOptions) {
    const pk = options?.publicKey;
    const first = pk?.extensions?.prf?.eval?.first;
    requests.push({
      kind: 'get',
      userVerification: pk?.userVerification,
      prfSaltHex: first ? toHex(new Uint8Array(first as ArrayBuffer)) : null,
      attestation: undefined,
      residentKey: undefined,
    });
    return navigator.credentials.get(options);
  },
};

const keys = createWebAuthnKeys({ rpId: location.hostname, rpName: 'Paper Seal e2e', credentials: recording });

/** Turns a thrown error into plain data, so the driver can inspect it. */
async function attempt<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; name: string; code: string | null; message: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const e = error as Error;
    return { ok: false, name: e.name, code: error instanceof KeyError ? error.code : null, message: e.message };
  }
}

const api = {
  generateKey: (userIdHex: string, name: string) =>
    attempt(async () => {
      const k = await keys.generateKey({ id: fromHex(userIdHex), name });
      return {
        credentialId: toHex(k.credentialId),
        passkeyPublicKey: toHex(k.passkeyPublicKey),
        attestationObject: toHex(k.attestationObject),
        clientDataJSON: toHex(k.clientDataJSON),
      };
    }),
  getPublicKey: (credentialIdHex: string) => attempt(async () => toHex(await keys.getPublicKey(fromHex(credentialIdHex)))),
  decryptShare: (credentialIdHex: string, sealedHex: string) =>
    attempt(async () => toHex(await keys.decryptShare(fromHex(credentialIdHex), fromHex(sealedHex)))),
  sign: (credentialIdHex: string, messageHex: string) =>
    attempt(async () => {
      const s = await keys.sign(fromHex(credentialIdHex), fromHex(messageHex));
      return {
        signature: toHex(s.signature),
        authenticatorData: toHex(s.authenticatorData),
        clientDataJSON: toHex(s.clientDataJSON),
        flags: readBackupFlags(s.authenticatorData),
      };
    }),
  releaseShare: (credentialIdHex: string, messageHex: string, sealedHex: string) =>
    attempt(async () => {
      const r = await keys.releaseShare(fromHex(credentialIdHex), fromHex(messageHex), fromHex(sealedHex));
      return {
        share: toHex(r.share),
        signature: toHex(r.signature.signature),
        authenticatorData: toHex(r.signature.authenticatorData),
        clientDataJSON: toHex(r.signature.clientDataJSON),
      };
    }),
  /** Reads the authenticator data flags straight from the browser, bypassing the device-bound check. */
  rawBackupFlags: (credentialIdHex: string) =>
    attempt(async () => {
      const credential = (await navigator.credentials.get({
        publicKey: {
          rpId: location.hostname,
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: 'public-key', id: fromHex(credentialIdHex) }],
          userVerification: 'required',
        },
      })) as PublicKeyCredential;
      const data = new Uint8Array((credential.response as AuthenticatorAssertionResponse).authenticatorData);
      return { flagsByte: data[32], ...readBackupFlags(data) };
    }),
  requests: () => requests,
  clearRequests: () => {
    requests.length = 0;
  },
};

export type PageApi = typeof api;
(window as unknown as { ps: PageApi }).ps = api;
