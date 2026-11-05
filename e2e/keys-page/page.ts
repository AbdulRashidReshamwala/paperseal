// Runs in Chrome. It exposes the real packages/keys code to the test driver, and prints each step
// on the page. Like packages/keys/e2e/page.ts it wraps navigator.credentials only to count and
// record what the real code asked for. The authenticator still answers every call.
import { createWebAuthnKeys, KeyError } from '@paperseal/keys';

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

interface RecordedRequest {
  kind: 'create' | 'get';
  userVerification: string | undefined;
  prfSaltHex: string | null;
}
const requests: RecordedRequest[] = [];

const recording = {
  create(options?: CredentialCreationOptions) {
    requests.push({ kind: 'create', userVerification: options?.publicKey?.authenticatorSelection?.userVerification, prfSaltHex: null });
    return navigator.credentials.create(options);
  },
  get(options?: CredentialRequestOptions) {
    const first = options?.publicKey?.extensions?.prf?.eval?.first;
    requests.push({
      kind: 'get',
      userVerification: options?.publicKey?.userVerification,
      prfSaltHex: first ? toHex(new Uint8Array(first as ArrayBuffer)) : null,
    });
    return navigator.credentials.get(options);
  },
};

const keys = createWebAuthnKeys({ rpId: location.hostname, rpName: 'Paper Seal e2e', credentials: recording });

const log = document.getElementById('log') as HTMLElement;
document.getElementById('origin')!.textContent = location.origin;
function print(text: string, tone: 'step' | 'ok' | 'bad' | 'dim' | '' = ''): void {
  const line = document.createElement('div');
  line.className = tone;
  line.textContent = text;
  log.appendChild(line);
  window.scrollTo(0, document.body.scrollHeight);
}

type Attempt<T> = { ok: true; value: T } | { ok: false; name: string; code: string | null; message: string };
async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const e = error as Error;
    return { ok: false, name: e.name, code: error instanceof KeyError ? error.code : null, message: e.message };
  }
}

const api = {
  print,
  generateKey: (userIdHex: string, name: string) =>
    attempt(async () => {
      const k = await keys.generateKey({ id: fromHex(userIdHex), name });
      return { credentialId: toHex(k.credentialId), passkeyPublicKey: toHex(k.passkeyPublicKey) };
    }),
  getPublicKey: (credentialIdHex: string) => attempt(async () => toHex(await keys.getPublicKey(fromHex(credentialIdHex)))),
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
  requests: () => requests,
  clearRequests: () => {
    requests.length = 0;
  },
};

export type PageApi = typeof api;
(window as unknown as { ps: PageApi }).ps = api;
