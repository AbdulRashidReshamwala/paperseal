import { fromHex, toHex, type Hex } from '@paperseal/protocol';

/*
 * The key touch, for show. In demo mode a real security key can still be asked for a touch, so the
 * demo looks like the real thing. It proves nothing and nothing depends on it: its result is thrown
 * away, and every key, signature and PRF output comes from the planted key. It never stops the demo.
 * The credential here is a throwaway, made on the plugged-in key the first time, used for nothing else.
 */

const enabledKey = 'paperseal-demo.touch';
const credentialKey = 'paperseal-demo.touch-credential';
/** A key that is not there must not hold the flow up for long. */
const TOUCH_WAIT_MS = 30_000;

export function touchEnabled(storage: Storage = globalThis.localStorage): boolean {
  return storage.getItem(enabledKey) !== 'off';
}

export function setTouchEnabled(on: boolean, storage: Storage = globalThis.localStorage): void {
  storage.setItem(enabledKey, on ? 'on' : 'off');
}

let asked = false;

/** One click on the page is one user action, however many ceremonies it needs. */
export function newUserAction(): void {
  asked = false;
}

const random = (bytes: number) => globalThis.crypto.getRandomValues(new Uint8Array(bytes));
/** Not yet in TypeScript's DOM lib. It keeps the browser from offering a phone or a password manager. */
const securityKeyOnly = { hints: ['security-key'] };

async function ask(real: Pick<CredentialsContainer, 'create' | 'get'>, storage: Storage, signal: AbortSignal): Promise<void> {
  const rpId = globalThis.location.hostname;
  const stored = storage.getItem(credentialKey) as Hex | null;
  if (stored) {
    await real.get({
      signal,
      publicKey: {
        rpId,
        challenge: random(32),
        allowCredentials: [{ type: 'public-key', id: new Uint8Array(fromHex(stored)) }],
        userVerification: 'discouraged',
        ...securityKeyOnly,
      },
    });
    return;
  }
  const made = await real.create({
    signal,
    publicKey: {
      rp: { id: rpId, name: 'Paper Seal demo touch' },
      user: { id: random(32), name: 'Demo touch', displayName: 'Demo touch' },
      challenge: random(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: 'cross-platform', residentKey: 'discouraged', userVerification: 'discouraged' },
      attestation: 'none',
      ...securityKeyOnly,
    },
  });
  if (made) storage.setItem(credentialKey, toHex(new Uint8Array((made as PublicKeyCredential).rawId)));
}

/** At most one touch per user action. It returns once the touch is over, whatever became of it. */
export async function touchForShow(
  real: Pick<CredentialsContainer, 'create' | 'get'> = globalThis.navigator.credentials,
  storage: Storage = globalThis.localStorage,
  waitMs: number = TOUCH_WAIT_MS,
): Promise<void> {
  if (asked || !touchEnabled(storage)) return;
  asked = true;
  try {
    await ask(real, storage, AbortSignal.timeout(waitMs));
  } catch {
    // No key, a cancel, or an error. The planted key carries on either way.
  }
}
