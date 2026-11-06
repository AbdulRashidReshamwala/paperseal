import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';

import { openPerson, type OpenOptions, type Person } from '../demo/people';
import { captionScript } from '../src/recorder';

/*
 * The browser kit of the UI suite. A person is one window with one tab and one virtual security key
 * (demo/people.ts, so the same key setup as `pnpm demo`). What is counted here is counted inside the
 * page, from the events a user would cause, and not from the test's own calls:
 *
 *   clicks         pointerdown on the page (one per click or tap, whatever the target)
 *   typedFields    distinct text fields that received input in a page load
 *   keyTouches     calls to navigator.credentials.create or .get, which is one touch of a real key each
 *   walletSignatures  eth_sendTransaction, personal_sign and eth_signTypedData requests to the wallet
 *   loads          full page loads (the first open, a reload, an opened link)
 *   routeChanges   moves inside the app that did not reload the page
 *
 * A select changed with selectOption counts as one click, because choosing from a list is at least one.
 */

export const UI_DIR = resolve(import.meta.dirname, '../.ui');
export const SCREENS_DIR = resolve(UI_DIR, 'screens');
export const CLICKS_PATH = resolve(UI_DIR, 'clicks.json');

export const WIDE = { width: 1280, height: 800 } as const;
export const NARROW = { width: 375, height: 812 } as const;

export interface Counts {
  clicks: number;
  typedFields: number;
  keyTouches: number;
  walletSignatures: number;
  loads: number;
  routeChanges: number;
}

const zero = (): Counts => ({ clicks: 0, typedFields: 0, keyTouches: 0, walletSignatures: 0, loads: 0, routeChanges: 0 });

export interface FlowRecord extends Counts {
  flow: string;
  ms: number;
}

export interface Overflow {
  actor: string;
  state: string;
  scrollWidth: number;
  innerWidth: number;
  culprits: string[];
}

/** Everything one run measured. Written to e2e/.ui/clicks.json by `writeReport`. */
export const report = {
  actors: new Map<string, { role: string; totals: Counts; flows: FlowRecord[]; actor: Actor }>(),
  overflow: [] as Overflow[],
  screens: [] as string[],
};

const meterScript = `(() => {
  const send = (kind) => { try { window.__psMeter && window.__psMeter(kind); } catch (e) {} };
  addEventListener('pointerdown', (e) => { if (e.isTrusted) send('click'); }, true);
  const seen = new WeakSet();
  addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    if (t.type === 'radio' || t.type === 'checkbox') return;
    if (seen.has(t)) return;
    seen.add(t);
    send('field');
  }, true);
  addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement) send('click');
  }, true);
  const credentials = navigator.credentials;
  if (credentials) {
    for (const name of ['create', 'get']) {
      const original = credentials[name].bind(credentials);
      credentials[name] = (options) => { if (options && options.publicKey) send('touch'); return original(options); };
    }
  }
})();`;

/** Wraps window.ethereum, which a wallet script must have set already, to count what it is asked to sign. */
const walletMeterScript = `(() => {
  const eth = window.ethereum;
  if (!eth || eth.__metered) return;
  const original = eth.request.bind(eth);
  eth.request = (args) => {
    if (['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'eth_sign'].includes(args.method)) {
      try { window.__psMeter && window.__psMeter('sign'); } catch (e) {}
    }
    return original(args);
  };
  eth.__metered = true;
})();`;

export interface ActorOptions extends Omit<OpenOptions, 'setup' | 'viewport'> {
  /** An init script that installs window.ethereum. The meter wraps it. */
  wallet?: string;
  /** Extra bindings the wallet script needs, by name. */
  bindings?: Record<string, (...args: never[]) => unknown>;
  /** Business role for the table: board, setter, key holder, centre, verifier. */
  role: string;
  /** Record this person's window to a video in this folder, with a caption bar naming each step. */
  videoDir?: string;
}

export class Actor {
  readonly name: string;
  readonly role: string;
  person!: Person;
  readonly counts: Counts = zero();
  readonly flows: FlowRecord[] = [];
  /** Set when this person's window is being recorded. */
  videoDir: string | null = null;
  /** When the recording began, to place `marks` in the video. */
  videoStartedAt = 0;
  /** Slow typing and pauses, for the parts of a recording a viewer must follow. */
  paced = false;
  readonly marks: { name: string; at: number }[] = [];
  /** Main-frame navigations of any kind. `routeChanges` is this minus the full loads. */
  navigations = 0;

  constructor(name: string, role: string) {
    this.name = name;
    this.role = role;
  }

  get page(): Page {
    return this.person.page;
  }

  /** Runs one named flow and records exactly what a person did in it. */
  async flow<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.settle();
    const before = { ...this.counts };
    const started = Date.now();
    try {
      return await run();
    } finally {
      this.settle();
      const delta = zero();
      for (const key of Object.keys(delta) as (keyof Counts)[]) delta[key] = this.counts[key] - before[key];
      this.flows.push({ flow: name, ms: Date.now() - started, ...delta });
    }
  }

  /** Brings routeChanges up to date. */
  settle(): void {
    this.counts.routeChanges = Math.max(0, this.navigations - this.counts.loads);
  }

  async type(locator: Locator, text: string): Promise<void> {
    if (this.paced && text !== '') {
      await locator.click();
      await locator.fill('');
      await locator.pressSequentially(text, { delay: 40 });
      return;
    }
    await locator.fill(text);
  }

  /** Notes a moment, so a recording can be cut around it. */
  mark(name: string): void {
    this.marks.push({ name, at: Date.now() });
  }

  /** Names the step in the caption bar of a recorded window. Call again after a page load. */
  async say(text: string): Promise<void> {
    if (!this.videoDir) return;
    await this.page.evaluate((t) => (window as unknown as { __caption?: (a: string, b: string) => void }).__caption?.(t, ''), text).catch(() => undefined);
  }

  /** A pause a viewer can follow. Does nothing outside a recording. */
  async beat(ms = 1500): Promise<void> {
    if (this.videoDir) await this.page.waitForTimeout(ms);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
  }

  /** Screenshots at 1280 and at 375 wide, and records any sideways scroll at 375. */
  async shot(state: string): Promise<void> {
    mkdirSync(SCREENS_DIR, { recursive: true });
    const base = `${this.role.replace(/\s+/g, '-')}-${state}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const page = this.page;
    if (this.videoDir) {
      // A recorded window never changes size, or the video would flash a phone-sized page.
      await page.screenshot({ path: resolve(SCREENS_DIR, `${base}-1280.png`), fullPage: true }).catch(() => undefined);
      return;
    }
    try {
      await page.setViewportSize(WIDE);
      await page.waitForTimeout(250);
      await page.screenshot({ path: resolve(SCREENS_DIR, `${base}-1280.png`), fullPage: true });
      await page.setViewportSize(NARROW);
      await page.waitForTimeout(350);
      const measured = await page.evaluate(() => {
        const inner = window.innerWidth;
        const scroll = document.documentElement.scrollWidth;
        const culprits: string[] = [];
        if (scroll > inner) {
          for (const el of Array.from(document.body.querySelectorAll('*'))) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.right > inner + 1) {
              const tag = el.tagName.toLowerCase();
              const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}` : '';
              culprits.push(`${tag}${cls} right=${String(Math.round(rect.right))}`);
              if (culprits.length >= 4) break;
            }
          }
        }
        return { inner, scroll, culprits };
      });
      if (measured.scroll > measured.inner) {
        report.overflow.push({ actor: this.name, state: base, scrollWidth: measured.scroll, innerWidth: measured.inner, culprits: measured.culprits });
      }
      await page.screenshot({ path: resolve(SCREENS_DIR, `${base}-375.png`), fullPage: true });
      report.screens.push(base);
    } finally {
      await page.setViewportSize(WIDE).catch(() => undefined);
    }
  }

  /** Waits for visible text anywhere on the page. */
  async see(text: string | RegExp, timeout = 20_000): Promise<void> {
    await this.page.getByText(text).first().waitFor({ state: 'visible', timeout });
  }

  async seeHeading(name: string | RegExp, timeout = 20_000): Promise<void> {
    await this.page.getByRole('heading', { name }).first().waitFor({ state: 'visible', timeout });
  }

  async bodyText(): Promise<string> {
    return this.page.evaluate(() => document.body.innerText);
  }

  /** The plain text of the page, with whitespace squeezed. */
  async text(): Promise<string> {
    return (await this.bodyText()).replace(/\s+/g, ' ');
  }
}

export function launchUiChrome(): Promise<Browser> {
  return chromium.launch({ channel: 'chrome', headless: process.env.UI_HEADED !== '1' }).catch((error: unknown) => {
    throw new Error(`Could not start the installed Chrome (channel "chrome"). Is Google Chrome installed? ${String(error)}`, { cause: error });
  });
}

let windowIndex = 0;

/** Opens one person with a key, the meter and, if given, a wallet. Loads `url` last. */
export async function openActor(browser: Browser, name: string, url: string | null, options: ActorOptions): Promise<Actor> {
  const actor = new Actor(name, options.role);
  const notes: string[] = [];
  actor.person = await openPerson(browser, name, url, windowIndex++, (m) => notes.push(m), {
    viewport: WIDE,
    noLabel: true,
    ...(options.videoDir ? { recordVideo: { dir: options.videoDir, size: { ...WIDE } } } : {}),
    permissions: options.permissions ?? ['clipboard-read', 'clipboard-write'],
    setup: async (person) => {
      actor.person = person;
      const count = (kind: string) => {
        if (kind === 'click') actor.counts.clicks += 1;
        else if (kind === 'field') actor.counts.typedFields += 1;
        else if (kind === 'touch') actor.counts.keyTouches += 1;
        else if (kind === 'sign') actor.counts.walletSignatures += 1;
      };
      await person.context.exposeBinding('__psMeter', (_source, kind: string) => {
        count(kind);
      });
      for (const [bindingName, fn] of Object.entries(options.bindings ?? {})) {
        await person.context.exposeBinding(bindingName, (_source, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args));
      }
      await person.context.addInitScript(meterScript);
      if (options.videoDir) {
        actor.videoDir = options.videoDir;
        actor.videoStartedAt = Date.now();
        await person.context.addInitScript(captionScript);
      }
      if (options.wallet) {
        await person.context.addInitScript(options.wallet);
        await person.context.addInitScript(walletMeterScript);
      }
      person.page.on('load', () => {
        actor.counts.loads += 1;
      });
      person.page.on('framenavigated', (frame) => {
        // Every full load also fires this, so route changes are what is left after the loads (see `settle`).
        if (frame === person.page.mainFrame()) actor.navigations += 1;
      });
    },
  });
  report.actors.set(name, { role: options.role, totals: actor.counts, flows: actor.flows, actor });
  return actor;
}

/** Merges this run's numbers into e2e/.ui/clicks.json under `section`. */
export function writeReport(section: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(UI_DIR, { recursive: true });
  const previous = existsSync(CLICKS_PATH) ? (JSON.parse(readFileSync(CLICKS_PATH, 'utf8')) as Record<string, unknown>) : {};
  const actors: Record<string, unknown> = {};
  for (const [name, entry] of report.actors) {
    entry.actor.settle();
    const total = { ...entry.totals };
    actors[name] = { role: entry.role, totals: total, elapsedMs: entry.flows.reduce((sum, f) => sum + f.ms, 0), flows: entry.flows };
  }
  previous[section] = { writtenAt: new Date().toISOString(), actors, overflowAt375: report.overflow, screens: report.screens, ...extra };
  writeFileSync(CLICKS_PATH, `${JSON.stringify(previous, null, 2)}\n`);
}

/**
 * GitHub's unauthenticated quota is 60 requests an hour per address, and a run of this suite spends
 * it. When it is nearly used up, the browser's calls to api.github.com are answered with the same
 * real data, fetched with the GitHub CLI's own login (the token is never read or printed here). The
 * response is GitHub's, unchanged. Returns true when the proxy was installed.
 */
export async function proxyGithubIfLimited(context: import('playwright-core').BrowserContext): Promise<boolean> {
  const left = await fetch('https://api.github.com/rate_limit')
    .then((r) => r.json() as Promise<{ resources: { core: { remaining: number } } }>)
    .then((j) => j.resources.core.remaining, () => 0);
  if (left > 25 && process.env.UI_GH_PROXY !== '1') return false;
  const { execFile } = await import('node:child_process');
  await context.route('https://api.github.com/**', (route) => {
    const url = new URL(route.request().url());
    execFile('gh', ['api', `${url.pathname}${url.search}`], { maxBuffer: 20_000_000 }, (error, stdout) => {
      if (error) {
        void route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: '{"message":"gh failed"}' });
        return;
      }
      void route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: stdout });
    });
  });
  return true;
}
