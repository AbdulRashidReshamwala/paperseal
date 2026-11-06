import { resolve } from 'node:path';

import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freePort } from '../src/procs';
import { openActor, writeReport, launchUiChrome, type Actor } from './kit';
import { centre } from './selectors';
import type { Browser } from 'playwright-core';

/*
 * The centre's "Hand out the paper" screen, driven in real Chrome. The paper on it is a fixture
 * (handout-page/main.tsx), because the real one only exists after a live unlock. What this checks is the
 * page itself: the demo label, the rooms, the sending and what it must never say.
 */

const web = resolve(import.meta.dirname, '../../apps/web');
const harness = resolve(import.meta.dirname, '../handout-page/main.tsx');
let server: ViteDevServer;
let browser: Browser;
let url: string;
let actor: Actor;

beforeAll(async () => {
  const port = await freePort();
  server = await createServer({
    root: web,
    configFile: resolve(web, 'vite.config.ts'),
    logLevel: 'warn',
    server: { host: 'localhost', port, strictPort: true, fs: { strict: false } },
    resolve: {
      alias: [
        { find: '@paperseal/ui/tokens.css', replacement: resolve(web, '../../packages/ui/src/tokens.css') },
        { find: /^@paperseal\/ui$/, replacement: resolve(web, '../../packages/ui/src/index.ts') },
        { find: /^react-dom(\/.*)?$/, replacement: `${resolve(web, 'node_modules/react-dom')}$1` },
        { find: /^react(\/.*)?$/, replacement: `${resolve(web, 'node_modules/react')}$1` },
      ],
    },
    plugins: [
      {
        name: 'handout-harness',
        configureServer(vite) {
          vite.middlewares.use('/handout.html', (_req, res) => {
            const html = `<!doctype html><html lang="en"><body><div id="root"></div><script type="module" src="/@fs${harness}"></script></body></html>`;
            void vite.transformIndexHtml('/handout.html', html).then((out) => {
              res.setHeader('content-type', 'text/html');
              res.end(out);
            });
          });
        },
      },
    ],
  });
  await server.listen();
  url = `http://localhost:${String(port)}/handout.html`;
  browser = await launchUiChrome();
  actor = await openActor(browser, 'centre-handout', null, { role: 'centre' });
  // Count calls to print instead of opening the print dialog.
  await actor.page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints += 1;
    };
  });
});

afterAll(async () => {
  writeReport('handout');
  await browser?.close();
  await server?.close();
});

describe('centre: hand out the paper', () => {
  it('opens from the open paper, sends room by room, and never says anything was delivered', async () => {
    const page = actor.page;
    await actor.flow('hand out', async () => {
      await page.goto(url);
      await actor.seeHeading(centre.paperOpenHeading, 60_000);
      await actor.shot('handout-0-open');
      expect(await page.locator('.ps-primary').count()).toBe(1);
      await page.getByRole('button', { name: centre.handOut }).click();
      await actor.seeHeading(centre.handOutHeading);
      await actor.see(centre.demoLabel);
      expect(await page.getByRole('article', { name: 'The examination paper' }).count()).toBe(1);
      expect(await page.locator('ol[type="A"] li').count()).toBe(3);
      expect(await page.getByText('Not sent').count()).toBe(3);
      await actor.shot('handout-1-rooms');

      // A bad number is called out and keeps sending shut.
      await page.getByLabel(centre.copiesFor('Room 2')).fill('many');
      await page.locator('.ps-field-error').first().waitFor({ state: 'visible' });
      expect(await page.getByRole('button', { name: centre.sendToRooms }).isDisabled()).toBe(true);
      await page.getByLabel(centre.copiesFor('Room 2')).fill('45');

      await page.getByRole('button', { name: centre.addRoom }).click();
      await page.getByLabel(centre.copiesFor('Room 4')).fill('12');
      await actor.see('4 rooms, 117 copies in all');

      await page.getByRole('button', { name: centre.sendToRooms }).click();
      await page.getByText('Sending').first().waitFor({ state: 'visible', timeout: 10_000 });
      await actor.shot('handout-2-sending');
      await page.getByText(centre.sentInDemo).nth(3).waitFor({ timeout: 30_000 });
      await actor.shot('handout-3-sent');
      const body = await actor.text();
      expect(body).toContain(centre.demoLabel);
      expect(body).not.toMatch(/delivered|received|arrived/i);

      await page.getByRole('button', { name: centre.printPaper }).click();
      expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
      // The paper is held in memory only: nothing was written to this browser's storage.
      expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    });
  });
});
