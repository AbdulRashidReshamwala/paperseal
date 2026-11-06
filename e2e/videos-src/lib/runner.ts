import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import type { Locator } from 'playwright-core';

import { linkInstalledFfmpeg } from '../../ffmpegLink';
import { freePort, httpOk, recentLog, spawnManaged, stop, stopAll, waitFor } from '../../src/procs';
import { repoRoot } from '../../src/chain';
import { launchUiChrome, openActor, proxyGithubIfLimited, type Actor } from '../../ui/kit';
import { cut, keptRanges, probe } from './cut';
import type { Stage, Video } from './script';
import { liveWorld, mockWorld, type World } from './world';

/*
 * Runs one video file: starts the app on a spare port, opens one real Chrome window, plays the steps,
 * and on success cuts the recording into e2e/videos/<name>.mp4. A step that fails ends the run with an
 * error and no finished video.
 *
 *   pnpm video --list
 *   pnpm video <name>          the real thing, on Sepolia
 *   pnpm video <name> --dry    the real system, stopping before anything is sent
 *   pnpm video <name> --mock   a local chain and a mock machine, end to end, for free
 */

const SOURCES = resolve(import.meta.dirname, '..');
const VIDEOS = resolve(SOURCES, '../videos');
const WORK = resolve(VIDEOS, '.work');
const TYPE_DELAY = 22;

/** A soft pointer, because a recording shows no mouse, and a viewer needs to see what is being pressed. */
const pointerScript = `(() => {
  const ID = '__ps_pointer';
  const dot = () => {
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ID;
      el.style.cssText = 'position:fixed;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;background:rgba(56,189,248,.45);border:2px solid #0284c7;z-index:2147483646;pointer-events:none;transition:transform .28s ease-out';
      document.documentElement.appendChild(el);
    }
    return el;
  };
  addEventListener('mousemove', (e) => { dot().style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
})();`;

const stamp = (d = new Date()) => {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};

const listVideos = () =>
  readdirSync(SOURCES)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => basename(file, '.ts'))
    .sort();

/** One dev server of the web app, on a spare port, stopped by its own process group. */
async function startWeb(world: World) {
  const port = await freePort();
  const server = spawnManaged('pnpm', ['exec', 'vite', '--config', resolve(SOURCES, 'lib/app.vite.config.ts'), '--host', 'localhost', '--port', String(port), '--strictPort', '--mode', world.mode], {
    cwd: resolve(repoRoot, 'apps/web'),
    env: world.env,
    label: 'the web app',
  });
  const url = `http://localhost:${String(port)}`;
  await waitFor('the web app', httpOk(url), 90_000, server);
  return { url, stop: () => stop(server), log: () => recentLog(server) };
}

function stageFor(board: Actor, world: World, label: string, notes: Record<string, string>): Stage {
  const { page } = board;
  const show = async (target: Locator) => {
    await target.first().evaluate((el) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    await page.waitForTimeout(200);
  };
  return {
    page,
    board,
    world,
    label,
    notes,
    show,
    top: async () => {
      await page.evaluate(() => {
        scrollTo({ top: 0, behavior: 'smooth' });
      });
      await page.waitForTimeout(350);
    },
    hold: (ms) => page.waitForTimeout(ms),
    click: async (target) => {
      await target.waitFor({ state: 'visible', timeout: 60_000 });
      await show(target);
      await target.hover();
      await page.waitForTimeout(220);
      await target.click();
    },
    type: async (target, text) => {
      await target.waitFor({ state: 'visible', timeout: 60_000 });
      await target.hover();
      await page.waitForTimeout(150);
      await target.click();
      await target.fill('');
      await target.pressSequentially(text, { delay: TYPE_DELAY });
    },
  };
}

async function play(name: string, video: Video, world: World, dry: boolean): Promise<void> {
  const label = `${video.prefix}-${stamp()}`;
  const notes: Record<string, string> = { label };
  const web = await startWeb(world);
  const browser = await launchUiChrome();
  try {
    // Vite prepares the app on first use, and that must not happen in front of the camera.
    const warm = await browser.newPage();
    await warm.goto(`${web.url}${video.open}`);
    await warm.waitForLoadState('load');
    await warm.waitForTimeout(3000);
    await warm.close();

    const rawDir = resolve(WORK, name);
    rmSync(rawDir, { recursive: true, force: true });
    mkdirSync(rawDir, { recursive: true });
    const board = await openActor(browser, 'board', null, { role: 'board', videoDir: rawDir, wallet: world.walletScript, bindings: world.bindings });
    await board.person.context.addInitScript(pointerScript);
    await proxyGithubIfLimited(board.person.context);
    const { page } = board;
    const stage = stageFor(board, world, label, notes);
    const waits: [number, number][] = [];
    let current = 'opening the page';
    try {
      await page.goto(`${web.url}${video.open}`);
      await video.ready(stage);
      const firstFrame = Date.now();
      for (const one of video.steps) {
        if (dry && one.spends) {
          console.log('--dry: stopping before the first step that sends anything.');
          break;
        }
        current = typeof one.say === 'string' ? one.say : one.say(stage);
        console.log(`  ${current}`);
        await board.say(current);
        const started = Date.now();
        if (!one.wait) await page.waitForTimeout(300);
        await one.run(stage);
        if (one.wait) waits.push([started, Date.now()]);
        await page.waitForTimeout(one.hold);
      }
      const recording = page.video();
      const closedAt = Date.now();
      await board.person.context.close();
      const raw = await recording?.path();
      if (!raw) throw new Error('Playwright produced no video');

      // The recording starts a moment before `videoStartedAt`, by however much it runs longer than the clock.
      const media = probe(raw);
      const shift = Math.max(0, media.seconds - (closedAt - board.videoStartedAt) / 1000);
      const at = (ms: number) => (ms - board.videoStartedAt) / 1000 + shift;
      const out = resolve(VIDEOS, `${name}${world.kind === 'mock' ? '.mock' : ''}${dry ? '.dry' : ''}.mp4`);
      mkdirSync(dirname(out), { recursive: true });
      cut(raw, out, keptRanges(at(firstFrame), media.seconds, waits.map(([a, b]) => [at(a), at(b)])));
      rmSync(rawDir, { recursive: true, force: true });
      const final = probe(out);
      if (final.width !== 1280 || final.height !== 800) throw new Error(`the video is ${String(final.width)}x${String(final.height)}, not 1280x800`);
      Object.assign(notes, { video: out, seconds: final.seconds.toFixed(1) });
      writeFileSync(resolve(WORK, `${name}.result.json`), `${JSON.stringify(notes, null, 2)}\n`);
      console.log(`\nDone. ${JSON.stringify(notes, null, 2)}`);
      if (final.seconds > 90) console.log(`Note: ${final.seconds.toFixed(0)} seconds is over the 90 second target.`);
    } catch (error) {
      const shot = resolve(WORK, `${name}.failed.png`);
      await page.screenshot({ path: shot }).catch(() => undefined);
      const seen = await page.evaluate(() => document.body.innerText).catch(() => '');
      throw new Error(`while "${current}": ${error instanceof Error ? error.message : String(error)}\nScreenshot: ${shot}\nPage: ${seen.replace(/\s+/g, ' ').slice(0, 800)}\nNotes: ${JSON.stringify(notes)}`, { cause: error });
    }
  } finally {
    await browser.close().catch(() => undefined);
    await web.stop();
  }
}

export async function main(argv: string[], load: (path: string) => Promise<Record<string, unknown>>): Promise<void> {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const [name, ...rest] = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = [...flags].filter((flag) => !['--list', '--dry', '--mock'].includes(flag));
  const names = listVideos();
  if (unknown.length > 0 || rest.length > 0 || (!name && !flags.has('--list'))) {
    throw new Error(`usage: pnpm video --list, or pnpm video <name> [--dry] [--mock]. Videos: ${names.join(', ')}`);
  }
  if (flags.has('--list')) {
    for (const each of names) console.log(`${each.padEnd(24)} ${((await load(`/${each}.ts`)).default as Video).title}`);
    return;
  }
  if (!name || !names.includes(name)) throw new Error(`there is no video "${String(name)}". Videos: ${names.join(', ')}`);
  linkInstalledFfmpeg();
  const video = (await load(`/${name}.ts`)).default as Video;
  const world = flags.has('--mock') ? await mockWorld() : await liveWorld();
  try {
    await play(name, video, world, flags.has('--dry'));
  } finally {
    await world.stop();
    await stopAll();
  }
}
