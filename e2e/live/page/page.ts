// Runs in Chrome, one page per participant, each in its own browser context with its own virtual
// authenticator. It exposes the real packages/keys code to the driver and does nothing else:
// passkey creation, the PRF-derived key, signing and one-touch share release all happen here.
// Everything crosses to the driver as hex.
import { createWebAuthnKeys, KeyError } from '@paperseal/keys';

const toHex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string) => Uint8Array.from(hex.replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16));

// Wraps navigator.credentials only to count the touches; the authenticator still answers every call.
const touches = { create: 0, get: 0 };
const counting = {
  create(options?: CredentialCreationOptions) {
    touches.create += 1;
    return navigator.credentials.create(options);
  },
  get(options?: CredentialRequestOptions) {
    touches.get += 1;
    return navigator.credentials.get(options);
  },
};

const keys = createWebAuthnKeys({ rpId: location.hostname, rpName: 'Paper Seal live run', credentials: counting });

export type Attempt<T> = { ok: true; value: T } | { ok: false; name: string; code: string | null; message: string };
async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const e = error as Error;
    return { ok: false, name: e.name, code: error instanceof KeyError ? error.code : null, message: e.message };
  }
}

const api = {
  label: (text: string) => {
    (document.getElementById('who') as HTMLElement).textContent = text;
  },
  /**
   * Everything POST /v1/register needs. A setter passes no owner: `keys.register` makes it from the new
   * passkey. The challenge is passed on as the TEE gave it, whatever its width.
   */
  register: (owner: string | null, role: 'holder' | 'setter', challengeHex: string) =>
    attempt(async () => {
      const challenge = fromHex(challengeHex);
      const r = await keys.register(role === 'setter' || owner === null ? { role: 'setter', challenge } : { role: 'holder', owner, challenge });
      return { credentialId: toHex(r.credentialId), owner: r.owner, request: r.request };
    }),
  getPublicKey: (credentialIdHex: string) => attempt(async () => toHex(await keys.getPublicKey(fromHex(credentialIdHex)))),
  sign: (credentialIdHex: string, messageHex: string) =>
    attempt(async () => {
      const s = await keys.sign(fromHex(credentialIdHex), fromHex(messageHex));
      return { signature: toHex(s.signature), authenticatorData: toHex(s.authenticatorData), clientDataJSON: toHex(s.clientDataJSON) };
    }),
  /** One touch: signs the message and opens the sealed share. */
  releaseShare: (credentialIdHex: string, examIdHex: string, messageHex: string, sealedHex: string) =>
    attempt(async () => {
      const r = await keys.releaseShare(fromHex(credentialIdHex), fromHex(examIdHex), fromHex(messageHex), fromHex(sealedHex));
      return {
        share: toHex(r.share),
        signature: toHex(r.signature.signature),
        authenticatorData: toHex(r.signature.authenticatorData),
        clientDataJSON: toHex(r.signature.clientDataJSON),
      };
    }),
  openKeyPriv: (credentialIdHex: string, examIdHex: string, sealedHex: string) =>
    attempt(async () => toHex(await keys.openKeyPriv(fromHex(credentialIdHex), fromHex(examIdHex), fromHex(sealedHex)))),
  touches: () => ({ ...touches }),
};

export type PageApi = typeof api;
(window as unknown as { ps: PageApi }).ps = api;
