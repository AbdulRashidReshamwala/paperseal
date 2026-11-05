import { createPublicKey, createHash, verify } from 'node:crypto';

import { hpkeContext, hpkeSeal } from '@paperseal/crypto';
import { hashMessage, inviteTag, setterOwner, utf8ToBytes, webauthn } from '@paperseal/protocol';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PageApi } from './page';

/**
 * Drives the real createWebAuthnKeys in the locally installed Chrome, against Chrome's virtual
 * authenticator. Run with `pnpm --filter @paperseal/keys e2e`.
 */

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

type Attempt<T> = { ok: true; value: T } | { ok: false; name: string; code: string | null; message: string };
const ok = <T>(result: Attempt<T>): T => {
  if (!result.ok) throw new Error(`${result.name} (${result.code ?? 'no code'}): ${result.message}`);
  return result.value;
};

/** The options for WebAuthn.addVirtualAuthenticator. The names come from the CDP protocol types. */
interface AuthenticatorOptions {
  isUserVerified: boolean;
  defaultBackupEligibility: boolean;
  defaultBackupState: boolean;
}
const DEVICE_BOUND: AuthenticatorOptions = {
  isUserVerified: true,
  defaultBackupEligibility: false,
  defaultBackupState: false,
};

let server: ViteDevServer;
let browser: Browser;
let origin: string;

const launch = () => chromium.launch({ channel: 'chrome', headless: true });

interface Session {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId: string;
  ps: <K extends keyof PageApi>(method: K, ...args: Parameters<PageApi[K]>) => Promise<Awaited<ReturnType<PageApi[K]>>>;
}

async function addAuthenticator(cdp: CDPSession, options: AuthenticatorOptions): Promise<string> {
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      // Every touch is approved at once, so the test never waits for a person.
      automaticPresenceSimulation: true,
      ...options,
    },
  });
  return authenticatorId;
}

async function openSession(
  from: Browser,
  options: AuthenticatorOptions = DEVICE_BOUND,
  context?: BrowserContext,
): Promise<Session> {
  const ctx = context ?? (await from.newContext());
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const authenticatorId = await addAuthenticator(cdp, options);
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => 'ps' in window);
  const ps = ((method: string, ...args: unknown[]) =>
    page.evaluate(([m, a]) => (window as unknown as { ps: Record<string, (...x: unknown[]) => unknown> }).ps[m as string]?.(...(a as unknown[])), [
      method,
      args,
    ] as const)) as Session['ps'];
  return { context: ctx, page, cdp, authenticatorId, ps };
}

/** Reads a 0x-prefixed wire field, the form of the POST /v1/register body. */
const wire = (hex: string) => fromHex(hex.slice(2));
const EXAM_ID = new Uint8Array(32).fill(0xe1);
const sealFor = (key: Uint8Array, plaintext: Uint8Array, purpose: 'share' | 'keyPriv' = 'share') =>
  hpkeSeal(key, plaintext, hpkeContext(purpose, EXAM_ID));
const USER = { id: toHex(utf8ToBytes('holder-1')), name: 'holder-1@example.test' };
const log = (finding: string, data: unknown) => console.info(`FINDING ${finding}: ${JSON.stringify(data)}`);

beforeAll(async () => {
  server = await createServer({ configFile: new URL('./vite.config.ts', import.meta.url).pathname });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('the dev server has no port');
  origin = `http://localhost:${address.port}`;
  try {
    browser = await launch();
  } catch (error) {
    throw new Error(`Could not start the installed Chrome (channel "chrome"). Is it installed? ${String(error)}`, { cause: error });
  }
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('createWebAuthnKeys against Chrome virtual authenticator', () => {
  let session: Session;
  let credentialId: string;
  let publicKey: string;
  let passkeyPublicKey: string;

  beforeAll(async () => {
    session = await openSession(browser);
  });

  it('generateKey creates a device-bound passkey with PRF and a 65-byte P-256 key', async () => {
    const key = ok(await session.ps('generateKey', USER.id, USER.name));
    credentialId = key.credentialId;
    passkeyPublicKey = key.passkeyPublicKey;
    expect(fromHex(key.credentialId).length).toBeGreaterThan(0);
    expect(fromHex(key.passkeyPublicKey)).toHaveLength(65);
    expect(fromHex(key.passkeyPublicKey)[0]).toBe(0x04);
    expect(fromHex(key.attestationObject).length).toBeGreaterThan(0);

    const requests = await session.ps('requests');
    expect(requests).toEqual([
      expect.objectContaining({ kind: 'create', userVerification: 'required', attestation: 'direct', residentKey: 'required' }),
    ]);
    const credentials = await session.cdp.send('WebAuthn.getCredentials', { authenticatorId: session.authenticatorId });
    expect(credentials.credentials).toHaveLength(1);
    expect(credentials.credentials[0]?.isResidentCredential).toBe(true);
  });

  it('getPublicKey returns the same 65-byte key on every call', async () => {
    await session.ps('clearRequests');
    publicKey = ok(await session.ps('getPublicKey', credentialId));
    expect(fromHex(publicKey)).toHaveLength(65);
    expect(fromHex(publicKey)[0]).toBe(0x04);
    expect(ok(await session.ps('getPublicKey', credentialId))).toBe(publicKey);
    expect(ok(await session.ps('getPublicKey', credentialId))).toBe(publicKey);

    // Every request used the spec's salt and required user verification.
    const requests = await session.ps('requests');
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.kind).toBe('get');
      expect(request.userVerification).toBe(webauthn.userVerification);
      expect(request.userVerification).toBe('required');
      expect(request.prfSaltHex).toBe(toHex(utf8ToBytes(webauthn.prfSalt)));
    }
  });

  it('returns the same key after a page reload in the same browser', async () => {
    await session.page.reload();
    await session.page.waitForFunction(() => 'ps' in window);
    expect(ok(await session.ps('getPublicKey', credentialId))).toBe(publicKey);
  });

  it('decryptShare opens a value sealed with hpkeSeal to that key', async () => {
    const share = crypto.getRandomValues(new Uint8Array(33));
    const sealed = await sealFor(fromHex(publicKey), share);
    const opened = ok(await session.ps('decryptShare', credentialId, toHex(EXAM_ID), toHex(sealed)));
    expect(opened).toBe(toHex(share));
  });

  it('decryptShare rejects a value sealed to a different key', async () => {
    const other = await session.page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      return Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    });
    const sealed = await sealFor(Uint8Array.from(other), utf8ToBytes('not for you'));
    const result = await session.ps('decryptShare', credentialId, toHex(EXAM_ID), toHex(sealed));
    expect(result.ok).toBe(false);
  });

  it('sign returns an assertion that verifies under the passkey public key', async () => {
    await session.ps('clearRequests');
    const message = utf8ToBytes('exam-1|challenge|ciphertext-hash');
    const signed = ok(await session.ps('sign', credentialId, toHex(message)));
    expect(fromHex(signed.signature).length).toBeGreaterThan(0);
    expect(signed.flags).toEqual({ backupEligible: false, backedUp: false });

    const [request] = await session.ps('requests');
    expect(request).toMatchObject({ kind: 'get', userVerification: 'required', prfSaltHex: null });

    // The challenge in clientDataJSON is the message, and the signature is valid ES256.
    const clientData = JSON.parse(Buffer.from(signed.clientDataJSON, 'hex').toString('utf8')) as { challenge: string; origin: string; type: string };
    expect(Buffer.from(clientData.challenge, 'base64url').toString('hex')).toBe(toHex(message));
    expect(clientData.origin).toBe(origin);
    expect(clientData.type).toBe('webauthn.get');
    const point = fromHex(passkeyPublicKey);
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: Buffer.from(point.slice(1, 33)).toString('base64url'), y: Buffer.from(point.slice(33)).toString('base64url') },
      format: 'jwk',
    });
    const signedData = Buffer.concat([fromHex(signed.authenticatorData), createHash('sha256').update(fromHex(signed.clientDataJSON)).digest()]);
    expect(verify('sha256', signedData, key, fromHex(signed.signature))).toBe(true);
    // User verification: the UV flag (0x04) is set in the authenticator data.
    expect((fromHex(signed.authenticatorData)[32] ?? 0) & 0x04).toBe(0x04);
  });

  it('releaseShare does one request: the share opens and the signature verifies', async () => {
    const share = crypto.getRandomValues(new Uint8Array(33));
    const sealed = await sealFor(fromHex(publicKey), share);
    const message = utf8ToBytes('exam-1|tee-challenge');
    await session.ps('clearRequests');
    const released = ok(await session.ps('releaseShare', credentialId, toHex(EXAM_ID), toHex(message), toHex(sealed)));

    const requests = await session.ps('requests');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'get', userVerification: 'required', prfSaltHex: toHex(utf8ToBytes(webauthn.prfSalt)) });
    expect(released.share).toBe(toHex(share));

    const clientData = JSON.parse(Buffer.from(released.clientDataJSON, 'hex').toString('utf8')) as { challenge: string; type: string };
    expect(Buffer.from(clientData.challenge, 'base64url').toString('hex')).toBe(toHex(message));
    expect(clientData.type).toBe('webauthn.get');
    const point = fromHex(passkeyPublicKey);
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: Buffer.from(point.slice(1, 33)).toString('base64url'), y: Buffer.from(point.slice(33)).toString('base64url') },
      format: 'jwk',
    });
    const signedData = Buffer.concat([fromHex(released.authenticatorData), createHash('sha256').update(fromHex(released.clientDataJSON)).digest()]);
    expect(verify('sha256', signedData, key, fromHex(released.signature))).toBe(true);
    console.info(`FINDING releaseShare signature: ${released.signature}`);
  });
});

/** Verifies an ES256 WebAuthn signature in DER form under a 65-byte P-256 point. */
function verifyPasskey(point: Uint8Array, authenticatorData: string, clientDataJSON: string, signature: string): boolean {
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: Buffer.from(point.slice(1, 33)).toString('base64url'), y: Buffer.from(point.slice(33)).toString('base64url') },
    format: 'jwk',
  });
  const signedData = Buffer.concat([fromHex(authenticatorData), createHash('sha256').update(fromHex(clientDataJSON)).digest()]);
  return verify('sha256', signedData, key, fromHex(signature));
}

describe('register and keyPriv', () => {
  const challenge = new Uint8Array(32).fill(0x42);
  const inviteSecret = new Uint8Array(32).fill(0x24);

  it('registers a key holder: the derived key matches getPublicKey and the passkey signs the registration message', async () => {
    const session = await openSession(browser);
    const { credentialId, request } = ok(await session.ps('register', 'neutral-01', 'holder', toHex(challenge), toHex(inviteSecret)));
    const requests = await session.ps('requests');
    log('holder register ceremonies', requests.map((r) => r.kind));
    log('PRF at creation answered by Chrome virtual authenticator', requests.filter((r) => r.kind === 'get').length === 1);

    expect(Object.keys(request).sort()).toEqual(
      ['attestationObject', 'authenticatorData', 'challenge', 'clientDataJSON', 'derivedPublicKey', 'inviteTag', 'owner', 'passkeyPublicKey', 'signature'],
    );
    expect(request.owner).toBe('neutral-01');
    expect(wire(request.inviteTag)).toEqual(inviteTag(inviteSecret, wire(request.passkeyPublicKey)));
    expect(request.challenge).toBe(`0x${toHex(challenge)}`);
    expect(wire(request.derivedPublicKey)).toHaveLength(65);
    expect(wire(request.attestationObject).length).toBeGreaterThan(0);
    // Same key as the one a later get derives, so the registered key can open a share.
    expect(request.derivedPublicKey).toBe(`0x${ok(await session.ps('getPublicKey', credentialId))}`);

    const message = hashMessage('registration', {
      derivedPublicKey: wire(request.derivedPublicKey),
      holderId: utf8ToBytes('neutral-01'),
      challenge,
      inviteTag: wire(request.inviteTag),
    });
    const clientData = JSON.parse(Buffer.from(request.clientDataJSON.slice(2), 'hex').toString('utf8')) as { challenge: string; type: string };
    expect(Buffer.from(clientData.challenge, 'base64url').toString('hex')).toBe(toHex(message));
    expect(clientData.type).toBe('webauthn.get');
    expect(verifyPasskey(wire(request.passkeyPublicKey), request.authenticatorData.slice(2), request.clientDataJSON.slice(2), request.signature.slice(2))).toBe(true);
    for (const r of requests) expect(r.userVerification).toBe('required');
    await session.context.close();
  });

  it('registers a setter on an authenticator without PRF', async () => {
    const session = await openSession(browser);
    // A second virtual authenticator replaces the PRF-capable one, so only it can answer.
    await session.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: session.authenticatorId });
    await session.cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true,
        hasPrf: false, automaticPresenceSimulation: true, ...DEVICE_BOUND,
      },
    });
    const holder = await session.ps('register', 'x', 'holder', toHex(challenge), toHex(inviteSecret));
    expect(holder).toMatchObject({ ok: false, code: 'prf_unavailable' });

    const { request } = ok(await session.ps('register', null, 'setter', toHex(challenge), toHex(inviteSecret)));
    expect(request.derivedPublicKey).toBe('0x');
    expect(request.owner).toBe(setterOwner(wire(request.passkeyPublicKey)));
    const message = hashMessage('registration', { derivedPublicKey: new Uint8Array(), holderId: utf8ToBytes(request.owner), challenge, inviteTag: wire(request.inviteTag) });
    const clientData = JSON.parse(Buffer.from(request.clientDataJSON.slice(2), 'hex').toString('utf8')) as { challenge: string };
    expect(Buffer.from(clientData.challenge, 'base64url').toString('hex')).toBe(toHex(message));
    expect(verifyPasskey(wire(request.passkeyPublicKey), request.authenticatorData.slice(2), request.clientDataJSON.slice(2), request.signature.slice(2))).toBe(true);
    await session.context.close();
  });

  it('openKeyPriv opens a centre K_priv sealed with the keyPriv purpose, and nothing else', async () => {
    const session = await openSession(browser);
    const { credentialId, request } = ok(await session.ps('register', 'centre-01', 'holder', toHex(challenge), toHex(inviteSecret)));
    const kPriv = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealFor(wire(request.derivedPublicKey), kPriv, 'keyPriv');
    expect(ok(await session.ps('openKeyPriv', credentialId, toHex(EXAM_ID), toHex(sealed)))).toBe(toHex(kPriv));
    expect((await session.ps('openKeyPriv', credentialId, toHex(new Uint8Array(32)), toHex(sealed))).ok).toBe(false);
    const share = await sealFor(wire(request.derivedPublicKey), kPriv, 'share');
    expect((await session.ps('openKeyPriv', credentialId, toHex(EXAM_ID), toHex(share))).ok).toBe(false);
    await session.context.close();
  });
});

describe('empirical findings the demo depends on', () => {
  it('does a credential survive a new browser context in the same browser?', async () => {
    const first = await openSession(browser);
    const key = ok(await first.ps('generateKey', USER.id, USER.name));
    const publicKey = ok(await first.ps('getPublicKey', key.credentialId));

    // A new context gets a fresh virtual authenticator, because they are per-session and in-memory.
    const second = await openSession(browser);
    const result = await second.ps('getPublicKey', key.credentialId);
    log('new context, new authenticator, same credential', result);
    expect(result.ok).toBe(false);

    // The same-origin page in the same context shares no authenticator either unless one is added.
    const exported = await first.cdp.send('WebAuthn.getCredentials', { authenticatorId: first.authenticatorId });
    log('exported credential fields', exported.credentials.map((c) => Object.keys(c)));

    // Re-importing the exported credential into the new authenticator.
    for (const credential of exported.credentials) {
      await second.cdp.send('WebAuthn.addCredential', { authenticatorId: second.authenticatorId, credential });
    }
    const imported = await second.ps('getPublicKey', key.credentialId);
    log('after addCredential into new authenticator, same PRF key?', imported.ok ? imported.value === publicKey : imported);
    // The exported credential has no PRF secret, so the copy signs in but derives nothing.
    expect(imported).toMatchObject({ ok: false, code: 'prf_unavailable' });
    expect(publicKey).toHaveLength(130);
    await first.context.close();
    await second.context.close();
  });

  it('does a credential survive a browser restart?', async () => {
    const first = await openSession(browser);
    const key = ok(await first.ps('generateKey', USER.id, USER.name));
    const publicKey = ok(await first.ps('getPublicKey', key.credentialId));
    const exported = await first.cdp.send('WebAuthn.getCredentials', { authenticatorId: first.authenticatorId });
    await first.context.close();

    const restarted = await launch();
    try {
      const second = await openSession(restarted);
      const result = await second.ps('getPublicKey', key.credentialId);
      log('after browser restart with a new authenticator', result);
      expect(result.ok).toBe(false);

      for (const credential of exported.credentials) {
        await second.cdp.send('WebAuthn.addCredential', { authenticatorId: second.authenticatorId, credential });
      }
      const imported = await second.ps('getPublicKey', key.credentialId);
      log('after browser restart and addCredential, same PRF key?', imported.ok ? imported.value === publicKey : imported);
      expect(imported).toMatchObject({ ok: false, code: 'prf_unavailable' });
      expect(publicKey).toHaveLength(130);
    } finally {
      await restarted.close();
    }
  });

  it('fails when the authenticator has isUserVerified false', async () => {
    const session = await openSession(browser, { ...DEVICE_BOUND, isUserVerified: false });
    const result = await session.ps('generateKey', USER.id, USER.name);
    log('isUserVerified false, generateKey', result);
    expect(result.ok).toBe(false);
    await session.context.close();
  });

  it('reports backup flags clear by default, and assertDeviceBound accepts them', async () => {
    const session = await openSession(browser);
    const key = ok(await session.ps('generateKey', USER.id, USER.name));
    const flags = ok(await session.ps('rawBackupFlags', key.credentialId));
    log('default backup flags', flags);
    expect(flags).toMatchObject({ backupEligible: false, backedUp: false });
    await session.context.close();
  });

  it('rejects a backup-eligible authenticator as a synced passkey', async () => {
    const session = await openSession(browser, { ...DEVICE_BOUND, defaultBackupEligibility: true, defaultBackupState: true });
    const result = await session.ps('generateKey', USER.id, USER.name);
    log('BE and BS set, generateKey', result);
    expect(result).toMatchObject({ ok: false, code: 'synced_passkey' });
    await session.context.close();
  });
});
