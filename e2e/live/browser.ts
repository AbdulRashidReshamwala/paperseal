import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';

import type { Hex } from '@paperseal/protocol';

import type { Attempt, PageApi } from './page/page';
import { liveDir } from './config';
import { freePort } from '../src/procs';

/*
 * Real installed Chrome, one isolated browser context per participant, each with its own CDP
 * virtual authenticator (CTAP2.1, PRF, user verification). A virtual passkey lives only as long as
 * its browser, so nothing here closes a context until the whole run is done.
 */

export interface Participant {
  name: string;
  kind: 'setter' | 'neutral' | 'centre-holder' | 'centre';
  /** Approved-list role from the spec: 1 setter, 2 neutral, 3 centre key holder, 4 centre without a share. */
  role: 1 | 2 | 3 | 4;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId: string;
  /** Set by registration. */
  credentialId?: Hex;
  passkeyPublicKey?: Hex;
  derivedPublicKey?: Hex;
  /** What the TEE and the list call this participant. For a setter it is the commitment. */
  owner?: string;
  /** Setters only: the board's secret salt for the commitment. */
  salt?: Hex;
}

export interface Lab {
  browser: Browser;
  origin: string;
  server: ViteDevServer;
}

export async function startLab(): Promise<Lab> {
  const port = await freePort();
  const server = await createServer({
    root: `${liveDir}page`,
    configFile: false,
    logLevel: 'warn',
    // WebAuthn needs a secure context, and http://localhost counts as one.
    server: { host: 'localhost', port, strictPort: true },
    build: { target: 'es2023' },
  });
  await server.listen();
  const headless = process.env.LIVE_HEADED !== '1';
  const browser = await chromium.launch({ channel: 'chrome', headless }).catch((error: unknown) => {
    throw new Error(`Could not start the installed Chrome (channel "chrome"). Is Google Chrome installed? ${String(error)}`, { cause: error });
  });
  return { browser, origin: `http://localhost:${String(port)}`, server };
}

export async function addParticipant(
  lab: Pick<Lab, 'browser' | 'origin'>,
  spec: Pick<Participant, 'name' | 'kind' | 'role'>,
): Promise<Participant> {
  const context = await lab.browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified: true,
      // A touch is approved at once, because nobody is there to press the key.
      automaticPresenceSimulation: true,
      defaultBackupEligibility: false,
      defaultBackupState: false,
    },
  });
  await page.goto(`${lab.origin}/`);
  await page.waitForFunction(() => 'ps' in window);
  const participant: Participant = { ...spec, context, page, cdp, authenticatorId };
  await call(participant, 'label', spec.name);
  return participant;
}

type Methods = keyof PageApi;
type Value<K extends Methods> = Awaited<ReturnType<PageApi[K]>> extends Attempt<infer T> ? T : Awaited<ReturnType<PageApi[K]>>;

/** Calls the real packages/keys code in the participant's own Chrome. A failure there is thrown here with its code. */
export async function call<K extends Methods>(p: Participant, method: K, ...args: Parameters<PageApi[K]>): Promise<Value<K>> {
  const result = (await p.page.evaluate(
    ([m, a]) => (window as unknown as { ps: Record<string, (...x: unknown[]) => unknown> }).ps[m as string]?.(...(a as unknown[])),
    [method, args] as const,
  )) as unknown;
  const attempted = result as Partial<Attempt<unknown>> | undefined;
  if (attempted && typeof attempted === 'object' && 'ok' in attempted) {
    if (!attempted.ok) {
      const bad = attempted as { name: string; code: string | null; message: string };
      throw new Error(`${p.name}: ${bad.name} (${bad.code ?? 'no code'}) in Chrome: ${bad.message}`);
    }
    return (attempted as { value: Value<K> }).value;
  }
  return result as Value<K>;
}
