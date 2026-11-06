// Runs in Chrome, one page per participant, each in its own browser context with its own virtual
// authenticator. It exposes the real packages/keys code to the driver and does nothing else:
// passkey creation, the PRF-derived key, signing and one-touch share release all happen here.
// Everything crosses to the driver as hex.
import { createWebAuthnKeys, KeyError } from '@paperseal/keys';
import type { Hex } from '@paperseal/protocol';

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
   * Everything POST /v1/register needs for a setter. `keys.register` makes the owner from the new
   * passkey. The challenge is passed on as the TEE gave it, whatever its width. The invite secret comes
   * from the invite link and stays in this page: only the tag made from it is in the request.
   */
  register: (challengeHex: string, inviteSecretHex: string) =>
    attempt(async () => {
      const r = await keys.register({ role: 'setter', challenge: fromHex(challengeHex), inviteSecret: fromHex(inviteSecretHex) });
      return { credentialId: toHex(r.credentialId), owner: r.owner, request: r.request };
    }),
  /** Enrolment: a permanent PRF passkey and its public values. */
  enrol: () =>
    attempt(async () => {
      const k = await keys.generateKey({ id: crypto.getRandomValues(new Uint8Array(32)), name: 'Paper Seal key' });
      return { credentialId: toHex(k.credentialId), passkeyPublicKey: toHex(k.passkeyPublicKey), attestationObject: toHex(k.attestationObject) };
    }),
  /** Registration by name, with no invite. Two touches. */
  registerByName: (owner: string, examIdHex: string, credentialIdHex: string, passkey: Hex, challengeHex: string, attestationHex: string) =>
    attempt(async () => {
      const r = await keys.registerByName({
        owner,
        examId: fromHex(examIdHex),
        credentialId: fromHex(credentialIdHex),
        passkey,
        challenge: () => Promise.resolve(fromHex(challengeHex)),
        attestationObject: fromHex(attestationHex),
      });
      return { request: r.request };
    }),
  getPublicKey: (credentialIdHex: string, examIdHex: string) => attempt(async () => toHex(await keys.getPublicKey(fromHex(credentialIdHex), fromHex(examIdHex)))),
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
