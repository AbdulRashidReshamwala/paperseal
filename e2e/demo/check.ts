import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { build } from 'vite';
import { chromium, type Page } from 'playwright-core';

import { DEFAULT_URL, openPerson, parseArgs, type Person } from './people';

/*
 * `pnpm demo:check`: proves, in real Chrome against the running app, that the demo's keys do what the
 * system needs. Uses the real packages/keys code (bundled with Vite and loaded into each page) plus a
 * raw PRF read. Nothing here prints a key; only short SHA-256 fingerprints.
 */

const packages = resolve(import.meta.dirname, '../../packages');

async function keysBundle(): Promise<string> {
  const alias = Object.fromEntries(
    ['protocol', 'crypto', 'keys'].map((name) => [`@paperseal/${name}`, resolve(packages, name, 'src/index.ts')]),
  );
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias },
    build: {
      write: false,
      minify: false,
      target: 'es2023',
      lib: { entry: resolve(packages, 'keys/src/index.ts'), formats: ['iife'], name: 'PSKeys' },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  for (const o of outputs) if ('output' in o) for (const chunk of o.output) if (chunk.type === 'chunk') return chunk.code;
  throw new Error('Could not bundle packages/keys.');
}

const fingerprint = (hex: string) => createHash('sha256').update(hex).digest('hex').slice(0, 12);

interface Reading {
  /** The derived public key from packages/keys (it comes from the PRF output). */
  derived: string;
  /** The raw PRF output for a fixed salt, as hex. Never printed, only fingerprinted. */
  rawPrf: string;
}

async function load(page: Page, bundle: string): Promise<void> {
  await page.addScriptTag({ content: bundle });
}

async function create(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const { createWebAuthnKeys } = (window as unknown as { PSKeys: { createWebAuthnKeys: (o: object) => { generateKey: (u: object) => Promise<{ credentialId: Uint8Array }> } } }).PSKeys;
    const keys = createWebAuthnKeys({ rpId: location.hostname, rpName: 'Paper Seal demo check' });
    const made = await keys.generateKey({ id: crypto.getRandomValues(new Uint8Array(16)), name: 'check' });
    return hex(made.credentialId);
  });
}

async function read(page: Page, credentialId: string): Promise<Reading> {
  return page.evaluate(async (id) => {
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const bytes = Uint8Array.from(id.match(/../g) ?? [], (h) => parseInt(h, 16));
    const { createWebAuthnKeys } = (window as unknown as { PSKeys: { createWebAuthnKeys: (o: object) => { getPublicKey: (id: Uint8Array) => Promise<Uint8Array> } } }).PSKeys;
    const keys = createWebAuthnKeys({ rpId: location.hostname, rpName: 'Paper Seal demo check' });
    const derived = hex(await keys.getPublicKey(bytes));
    const assertion = (await navigator.credentials.get({
      publicKey: {
        rpId: location.hostname,
        challenge: new Uint8Array(32),
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: bytes }],
        extensions: { prf: { eval: { first: new Uint8Array(32).fill(7) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
    const prf = (assertion.getClientExtensionResults() as { prf?: { results?: { first: ArrayBuffer } } }).prf;
    if (!prf?.results) throw new Error('The authenticator returned no PRF result.');
    return { derived, rawPrf: hex(new Uint8Array(prf.results.first)) };
  }, credentialId);
}

let failures = 0;
function expect(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures += 1;
}

export async function main(argv: string[]): Promise<void> {
  const { url } = parseArgs(argv);
  const reachable = await fetch(url).then((r) => r.ok, () => false);
  if (!reachable) throw new Error(`Nothing is answering at ${url}. Start the app first (${DEFAULT_URL} by default) or pass --url.`);

  console.log(`Bundling packages/keys and launching headless Chrome against ${url}`);
  const bundle = await keysBundle();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const notes: string[] = [];
  try {
    const a = await openPerson(browser, 'check-a', url, 0, (m) => notes.push(m));
    const b = await openPerson(browser, 'check-b', url, 1, (m) => notes.push(m));
    const people: Person[] = [a, b];

    const first: Record<string, Reading & { id: string }> = {};
    for (const p of people) {
      console.log(`\n${p.name}`);
      await load(p.page, bundle);
      const id = await create(p.page);
      expect(id.length > 0, 'created a passkey with PRF through packages/keys');
      const r = await read(p.page, id);
      first[p.name] = { ...r, id };
      expect(r.rawPrf.length === 64, `got a 32-byte PRF result (fingerprint ${fingerprint(r.rawPrf)})`);
      expect(r.derived.length > 0, `derived public key ${fingerprint(r.derived)}`);

      await p.page.reload();
      await load(p.page, bundle);
      const afterReload = await read(p.page, id);
      expect(afterReload.rawPrf === r.rawPrf && afterReload.derived === r.derived, 'after a reload: same PRF result and derived key');

      // In-app style navigation: client-side route change, then a full navigation away and back.
      await p.page.evaluate(() => history.pushState({}, '', '/demo-check-route'));
      const afterRoute = await read(p.page, id).catch(() => undefined);
      expect(afterRoute !== undefined, 'after a client-side route change: key still answers') ;
      await p.page.goto('about:blank');
      await p.page.goto(url);
      await load(p.page, bundle);
      const afterNav = await read(p.page, id);
      expect(afterNav.rawPrf === r.rawPrf, 'after leaving the site and coming back: same PRF result');

      // A new tab or popup: it must not be left alive without a key; it is closed and its address moves to this tab.
      const before = notes.length;
      const popupTarget = new URL('/popup-check', url).toString();
      await p.page.evaluate((u) => { window.open(u, '_blank'); }, popupTarget);
      for (let i = 0; i < 50 && notes.length === before; i++) await new Promise((r2) => setTimeout(r2, 100));
      await p.page.waitForURL(popupTarget, { timeout: 5000 }).catch(() => undefined);
      expect(p.context.pages().length === 1, 'a popup is closed at once; the person keeps exactly one tab');
      expect(p.page.url() === popupTarget, 'the popup address was opened in the person\'s own tab');
      await load(p.page, bundle);
      const afterPopup = await read(p.page, id);
      expect(afterPopup.rawPrf === r.rawPrf && afterPopup.derived === r.derived, 'after the popup redirect: same PRF result and derived key');
    }

    console.log('\nTwo people');
    const x = first['check-a'];
    const y = first['check-b'];
    if (!x || !y) throw new Error('Missing a reading.');
    expect(x.rawPrf !== y.rawPrf, 'different PRF results (separate keys)');
    expect(x.derived !== y.derived, 'different derived public keys');
    expect(x.id !== y.id, 'different credential ids');
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? '\nOK  all checks passed' : `\nFAILED  ${String(failures)} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}
