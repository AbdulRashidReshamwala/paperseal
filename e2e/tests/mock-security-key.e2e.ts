import { createHash, createPublicKey, verify } from 'node:crypto';
import { resolve } from 'node:path';

import { hpkeContext, hpkeSeal } from '@paperseal/crypto';
import { prfInput, utf8ToBytes, webauthn } from '@paperseal/protocol';
import type { Browser, CDPSession } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { freePort } from '../src/procs';
import { launchChrome, Recording } from '../src/recorder';
import type { PageApi } from '../keys-page/page';

const examId = new Uint8Array(createHash('sha256').update('exam-1').digest());

/*
 * The real packages/keys code in the installed Chrome, against Chrome's own virtual authenticator
 * added over CDP, as packages/keys/e2e does. The authenticator is software, so this is the mock
 * security key from README "Dev and demo mode", and the video says so.
 */

let server: ViteDevServer;
let browser: Browser;
let origin: string;

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

beforeAll(async () => {
  const port = await freePort();
  server = await createServer({
    root: resolve(import.meta.dirname, '../keys-page'),
    configFile: false,
    logLevel: 'warn',
    // WebAuthn needs a secure context, and http://localhost counts as one.
    server: { host: 'localhost', port, strictPort: true },
    build: { target: 'es2023' },
  });
  await server.listen();
  origin = `http://localhost:${String(port)}`;
  browser = await launchChrome();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type Attempt<T> = { ok: true; value: T } | { ok: false; name: string; code: string | null; message: string };
const ok = <T>(result: Attempt<T>): T => {
  if (!result.ok) throw new Error(`${result.name} (${result.code ?? 'no code'}): ${result.message}`);
  return result.value;
};

describe('packages/keys on a virtual authenticator', () => {
  it('mock-security-key', async () => {
    const rec = new Recording('mock-security-key', {
      title: 'packages/keys: passkey, PRF-derived key and one-touch releaseShare',
      subtitle: 'Mock security key: Chrome virtual authenticator (software), not hardware',
    });
    const page = await rec.open(browser);
    try {
      const ps = ((method: string, ...args: unknown[]) =>
        page.evaluate(([m, a]) => (window as unknown as { ps: Record<string, (...x: unknown[]) => unknown> }).ps[m as string]?.(...(a as unknown[])), [method, args] as const)) as <
        K extends keyof PageApi,
      >(method: K, ...args: Parameters<PageApi[K]>) => Promise<Awaited<ReturnType<PageApi[K]>>>;
      const say = (text: string, tone: 'step' | 'ok' | 'bad' | 'dim' | '' = '') => page.evaluate(([t, k]) => (window as unknown as { ps: PageApi }).ps.print(t as string, k as 'step'), [text, tone] as const);

      const cdp: CDPSession = await page.context().newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await page.goto(`${origin}/`);
      await page.waitForFunction(() => 'ps' in window);
      await rec.say('Step 0: adding a Chrome virtual authenticator over CDP: CTAP2.1, PRF, user verification, resident key');
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          ctap2Version: 'ctap2_1',
          transport: 'usb',
          hasResidentKey: true,
          hasUserVerification: true,
          hasPrf: true,
          isUserVerified: true,
          // A touch is approved at once, so the recording never waits for a person.
          automaticPresenceSimulation: true,
          defaultBackupEligibility: false,
          defaultBackupState: false,
        },
      });
      await say('step 0  virtual authenticator added: ctap2.1, PRF, UV, resident key, not backup eligible', 'step');
      await rec.pause(2500);

      await rec.say('Step 1: registering a passkey with the real generateKey');
      await say('step 1  generateKey(holder-1) ...', 'step');
      const userId = toHex(utf8ToBytes('holder-1'));
      const generated = await ps('generateKey', userId, 'holder-1@example.test');
      let credentialId = '';
      let passkeyPublicKey = '';
      await rec.check('generateKey registers a device-bound passkey with a 65-byte P-256 key', async () => {
        const key = ok(generated);
        credentialId = key.credentialId;
        passkeyPublicKey = key.passkeyPublicKey;
        const point = fromHex(key.passkeyPublicKey);
        if (point.length !== 65 || point[0] !== 4) throw new Error(`public key is ${String(point.length)} bytes`);
        const requests = await ps('requests');
        const [create] = requests;
        if (requests.length !== 1 || create?.kind !== 'create' || create.userVerification !== 'required') throw new Error(JSON.stringify(requests));
        const stored = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
        if (stored.credentials.length !== 1 || !stored.credentials[0]?.isResidentCredential) throw new Error('the authenticator holds no resident credential');
        await say(`        credential id   ${key.credentialId}`, 'ok');
        await say(`        passkey pubkey  ${key.passkeyPublicKey}`, 'ok');
        await say('        PASS  one create request, userVerification "required"; the authenticator stores 1 resident credential', 'ok');
        return `credential ${key.credentialId.slice(0, 16)}...`;
      });
      await rec.pause(2500);

      await rec.say('Step 2: deriving the key with the PRF salt from spec/constants.json');
      await say('step 2  getPublicKey(credential) ...', 'step');
      await ps('clearRequests');
      let derived = '';
      await rec.check('getPublicKey derives a 65-byte key, with the spec salt and user verification required', async () => {
        derived = ok(await ps('getPublicKey', credentialId, toHex(examId)));
        const bytes = fromHex(derived);
        if (bytes.length !== 65 || bytes[0] !== 4) throw new Error(`derived key is ${String(bytes.length)} bytes`);
        const [req, ...rest] = await ps('requests');
        if (rest.length !== 0 || req?.kind !== 'get') throw new Error('expected exactly one get request');
        if (req.userVerification !== webauthn.userVerification || req.userVerification !== 'required') throw new Error(`uv ${String(req.userVerification)}`);
        if (req.prfSaltHex !== toHex(prfInput(examId))) throw new Error(`salt ${String(req.prfSaltHex)}`);
        await say(`        derived pubkey  ${derived}`, 'ok');
        await say('        PASS  PRF input is prfInput of this exam', 'ok');
        return `derived ${derived.slice(0, 16)}...`;
      });
      await rec.pause(2500);

      await rec.say('Step 3: reloading the page, then deriving again');
      await say('step 3  reloading the page (nothing is kept in the page: the private key is never stored)', 'step');
      await rec.pause(1500);
      await page.reload();
      await page.waitForFunction(() => 'ps' in window);
      await rec.say('Step 3: page reloaded, same passkey, deriving again');
      await say('step 3  page reloaded; getPublicKey(credential) again ...', 'step');
      await rec.check('The same derived key comes back after the reload', async () => {
        const again = ok(await ps('getPublicKey', credentialId, toHex(examId)));
        if (again !== derived) throw new Error(`before ${derived}, after ${again}`);
        await say(`        derived pubkey  ${again}`, 'ok');
        await say('        PASS  identical to the key derived before the reload', 'ok');
        return 'identical';
      });
      await rec.pause(2500);

      await rec.say('Step 4: one-touch releaseShare. A share is sealed to the derived key, then released');
      await say('step 4  sealing a 33-byte share to the derived public key with hpkeSeal (packages/crypto) ...', 'step');
      const share = crypto.getRandomValues(new Uint8Array(33));
      const sealed = await hpkeSeal(fromHex(derived), share, hpkeContext('share', examId));
      await say(`        sealed share    ${toHex(sealed).slice(0, 96)}... (${String(sealed.length)} bytes)`, 'dim');
      await ps('clearRequests');
      const message = utf8ToBytes('exam-1|tee-challenge');
      await say('        releaseShare(credential, examId, "exam-1|tee-challenge", sealed) ...', 'step');
      const released = await ps('releaseShare', credentialId, toHex(examId), toHex(message), toHex(sealed));
      await rec.check('releaseShare made exactly one authenticator request (one touch)', async () => {
        ok(released);
        const requests = await ps('requests');
        const [only] = requests;
        if (requests.length !== 1) throw new Error(`${String(requests.length)} requests`);
        if (only?.kind !== 'get' || only.userVerification !== 'required' || only.prfSaltHex !== toHex(prfInput(examId))) throw new Error(JSON.stringify(only));
        await say(`        PASS  requests made: ${String(requests.length)} (get, userVerification "required", PRF salt present)`, 'ok');
        return '1 request';
      });
      await rec.check('The share opened and equals the one that was sealed', async () => {
        const r = ok(released);
        if (r.share !== toHex(share)) throw new Error(`opened ${r.share}`);
        await say(`        share opened    ${r.share}`, 'ok');
        await say('        PASS  opened share equals the sealed share', 'ok');
        return 'equal';
      });
      await rec.check('The passkey signature verifies (ES256) over the message, with the UV flag set', async () => {
        const r = ok(released);
        const clientData = JSON.parse(Buffer.from(r.clientDataJSON, 'hex').toString('utf8')) as { challenge: string; type: string; origin: string };
        if (Buffer.from(clientData.challenge, 'base64url').toString('hex') !== toHex(message)) throw new Error('challenge is not the message');
        if (clientData.type !== 'webauthn.get' || clientData.origin !== origin) throw new Error(`clientData ${JSON.stringify(clientData)}`);
        const point = fromHex(passkeyPublicKey);
        const key = createPublicKey({
          key: { kty: 'EC', crv: 'P-256', x: Buffer.from(point.slice(1, 33)).toString('base64url'), y: Buffer.from(point.slice(33)).toString('base64url') },
          format: 'jwk',
        });
        const signed = Buffer.concat([fromHex(r.authenticatorData), createHash('sha256').update(fromHex(r.clientDataJSON)).digest()]);
        if (!verify('sha256', signed, key, fromHex(r.signature))) throw new Error('the signature does not verify');
        if (((fromHex(r.authenticatorData)[32] ?? 0) & 0x04) !== 0x04) throw new Error('UV flag not set');
        await say(`        signature       ${r.signature}`, 'ok');
        await say('        PASS  signature verified by node:crypto under the passkey public key; UV flag set', 'ok');
        return 'verified';
      });
      await rec.pause(4000);
    } catch (error) {
      rec.fail('Security key flow completed', error);
    } finally {
      await rec.finish();
    }
  });
});
