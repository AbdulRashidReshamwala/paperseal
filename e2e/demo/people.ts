import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';

/*
 * One person = one isolated browser context = one window = one CDP virtual authenticator.
 *
 * What was measured in real Chrome: a virtual authenticator belongs to the page (CDP target) it was
 * added on. A new tab or popup in the same context has none, so a WebAuthn call there waits forever for
 * a key. Copying the credential into a second tab's authenticator does not help either: the PRF secret
 * is not part of the copied credential, so the new tab reports no PRF result, and a different PRF
 * result would mean a different derived key. So a person gets exactly ONE tab. Any other tab or popup
 * in that context is closed at once, and its address is opened in the person's own tab instead.
 */

export const DEFAULT_URL = 'http://localhost:5171';
export const DEFAULT_PEOPLE = ['board', 'setter-1', 'setter-2', 'keyholder-1', 'keyholder-2', 'centre-1'];

export interface Args {
  url: string;
  people: string[];
}

export function parseArgs(argv: string[]): Args {
  let url = DEFAULT_URL;
  let people = DEFAULT_PEOPLE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
    const value = () => inline ?? argv[++i] ?? '';
    if (flag === '--url') url = value();
    else if (flag === '--people' || flag === '--names') people = value().split(',').map((n) => n.trim()).filter(Boolean);
    else if (arg === '--') continue;
    else throw new Error(`Unknown argument "${arg}". Use --url <address> and --people a,b,c.`);
  }
  if (people.length === 0) throw new Error('--people needs at least one name.');
  if (new Set(people).size !== people.length) throw new Error('--people has a repeated name; every person needs a different key.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('--url must be an http or https address.');
  return { url: parsed.toString(), people };
}

/** The same options as e2e/live/browser.ts: CTAP2.1, PRF, user verification, every touch approved at once. */
export const AUTHENTICATOR = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'usb',
  hasResidentKey: true,
  hasUserVerification: true,
  hasPrf: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
  defaultBackupEligibility: false,
  defaultBackupState: false,
} as const;

export interface Person {
  name: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId: string;
  /** Set when the person's tab went away, and with it the key. */
  lost: boolean;
}

/** A small corner label and a title prefix. It sits in a shadow root and takes no clicks, so the app does not see it. */
function labelScript(name: string): string {
  return `(() => {
  const name = ${JSON.stringify(name)};
  const tag = ' | ' + name;
  const retitle = () => { if (!document.title.endsWith(tag)) document.title = document.title.replace(/ \\| [^|]*$/, '') + tag; };
  const mount = () => {
    if (document.getElementById('ps-demo-who')) return;
    const host = document.createElement('div');
    host.id = 'ps-demo-who';
    host.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const chip = document.createElement('div');
    chip.textContent = name;
    chip.style.cssText = 'font:600 11px/1 system-ui,sans-serif;padding:4px 7px;border-radius:4px;background:#111;color:#fff;opacity:.75;';
    root.append(chip);
    document.documentElement.append(host);
  };
  const start = () => {
    mount(); retitle();
    new MutationObserver(retitle).observe(document.head, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;
}

export interface OpenOptions {
  /** A fixed page size, for automated runs. Without it the window sets its own size (the visible demo). */
  viewport?: { width: number; height: number };
  /** Context permissions, such as the clipboard. */
  permissions?: string[];
  /** Runs after the key exists and before the first page load, so a counter or a wallet sees every load. */
  setup?: (person: Person) => Promise<void> | void;
  /** Hide the corner label. Screenshots then show the app and nothing else. */
  noLabel?: boolean;
}

export async function openPerson(
  browser: Browser,
  name: string,
  url: string | null,
  index: number,
  onNote: (message: string) => void,
  options: OpenOptions = {},
): Promise<Person> {
  // viewport null lets the window itself set the size; each person is a separate window.
  const context = await browser.newContext({
    viewport: options.viewport ?? null,
    ...(options.permissions ? { permissions: options.permissions } : {}),
  });
  if (!options.noLabel) await context.addInitScript(labelScript(name));

  let ready = false;
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR });
  const person: Person = { name, context, page, cdp, authenticatorId, lost: false };

  // A cascade of windows, so they do not all sit on top of one another.
  if (!options.viewport) try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget' as never) as { windowId: number };
    await cdp.send('Browser.setWindowBounds' as never, { windowId, bounds: { left: 30 + index * 40, top: 40 + index * 32, width: 1100, height: 780, windowState: 'normal' } } as never);
  } catch {
    // Cosmetic only.
  }

  context.on('page', (extra) => {
    if (!ready || extra === page) return;
    void foreign(person, extra, onNote);
  });
  page.on('close', () => {
    if (!ready) return;
    person.lost = true;
    onNote(`${name}: the window was closed, so ${name}'s key is gone. Restart \`pnpm demo\` to get it back (a new key, not the old one).`);
  });

  await options.setup?.(person);
  if (url !== null) await page.goto(url);
  ready = true;
  return person;
}

/** A second tab or popup has no authenticator. Never let it try: close it and bring its address to the person's tab. */
async function foreign(person: Person, extra: Page, onNote: (message: string) => void): Promise<void> {
  let target = extra.url();
  if (target === 'about:blank' || target === '') {
    await extra.waitForEvent('framenavigated', { timeout: 2500 }).catch(() => undefined);
    target = extra.url();
  }
  await extra.close({ runBeforeUnload: false }).catch(() => undefined);
  const web = /^https?:/.test(target);
  onNote(
    `${person.name}: a second tab has no security key, so it was closed${web ? ` and ${target} opened in ${person.name}'s own tab` : ''}. One tab per person keeps one key.`,
  );
  if (person.lost) return;
  if (web) await person.page.goto(target).catch(() => undefined);
  await person.page.bringToFront().catch(() => undefined);
}
