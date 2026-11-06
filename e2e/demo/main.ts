import { chromium } from 'playwright-core';

import { openPerson, parseArgs, type Person } from './people';

/*
 * `pnpm demo`: a visible, real Chrome with one window per person. Each person's window has its own
 * virtual security key (PRF included), so a key touch in the app succeeds with no prompt and nobody
 * opens DevTools. Runs until Ctrl-C.
 */
export async function main(argv: string[]): Promise<void> {
  const { url, people } = parseArgs(argv);

  const browser = await chromium.launch({ channel: 'chrome', headless: false, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }).catch((error: unknown) => {
    throw new Error(`Could not start the installed Chrome (channel "chrome"). Is Google Chrome installed? ${String(error)}`, { cause: error });
  });

  console.log(`
WARNING  The virtual security keys live only inside this running Chrome.
         Quit this command (or close the Chrome windows) and every key is gone, along with
         anything registered with it. Keep it running for the whole demo. Ctrl-C to stop.
         One tab per person: a second tab has no key, so it is closed and its address opens in
         the person's own tab. Closing a person's window loses that person's key.
`);

  const opened: Person[] = [];
  let stopping = false;
  const note = (message: string) => {
    if (!stopping) console.log(`  note  ${message}`);
  };
  for (const [index, name] of people.entries()) {
    opened.push(await openPerson(browser, name, url, index, note));
    console.log(`  ready ${name.padEnd(14)} ${url}`);
  }
  console.log(`\n${String(opened.length)} windows open. Use the app normally; security key touches succeed on their own.`);

  await new Promise<void>((resolve) => {
    const stop = (why: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${why}`);
      resolve();
    };
    process.once('SIGINT', () => { stop('Stopping: closing Chrome and every demo key.'); });
    process.once('SIGTERM', () => { stop('Stopping: closing Chrome and every demo key.'); });
    browser.once('disconnected', () => { stop('Chrome was closed; the demo keys are gone.'); });
  });
  await browser.close().catch(() => undefined);
}
