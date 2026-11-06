import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import type { Locator } from 'playwright-core';

import { examIdFromName } from '@paperseal/protocol';

import { linkInstalledFfmpeg } from '../../ffmpegLink';
import { freePort, httpOk, recentLog, spawnManaged, stop, stopAll, waitFor } from '../../src/procs';
import { repoRoot } from '../../src/chain';
import { launchUiChrome, openActor, proxyGithubIfLimited, type Actor } from '../../ui/kit';
import { cut, keptRanges, probe } from './cut';
import type { Stage, Video } from './script';
import { liveWorld, mockWorld, retry, type World } from './world';

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

/** The caption as a pill at the bottom centre. It overrides the caption bar of src/recorder.ts for every video. */
const captionPillScript = `(() => {
  const style = document.createElement('style');
  style.textContent = '#__ps_caption{left:50%!important;right:auto!important;bottom:20px!important;transform:translateX(-50%);width:max-content;max-width:960px;box-sizing:border-box;padding:10px 26px!important;border:0!important;border-radius:999px;text-align:center;font:600 18px/1.3 system-ui,sans-serif!important;background:rgba(15,23,42,.92)!important;box-shadow:0 6px 20px rgba(15,23,42,.28)}';
  document.documentElement.appendChild(style);
})();`;

const stamp = (d = new Date()) => {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}${two(d.getMinutes())}`;
};

/** The prefix and the time, with a number added if an exam already has that name. */
async function freeLabel(prefix: string, world: World): Promise<string> {
  const base = `${prefix}-${stamp()}`;
  for (let n = 1; n < 100; n += 1) {
    const label = n === 1 ? base : `${base}-${String(n)}`;
    if (!(await retry('checking the exam name is free', () => world.registry.getExam(examIdFromName(label))))) return label;
  }
  throw new Error(`no free name after ${base}`);
}

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
    endWhen: (selector, text, caption) =>
      page.evaluate(
        ([where, what, say]) => {
          const shown = window as unknown as { __caption?: (a: string, b: string) => void; __psEndAt?: number };
          new MutationObserver((_, observer) => {
            if (!document.querySelector(where as string)?.textContent?.includes(what as string)) return;
            observer.disconnect();
            shown.__caption?.(say as string, '');
            shown.__psEndAt = Date.now();
          }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        },
        [selector, text, caption],
      ),
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
  const label = await freeLabel(video.prefix, world);
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
    await board.person.context.addInitScript(captionPillScript);
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
      const endAt = await page.evaluate(() => (window as unknown as { __psEndAt?: number }).__psEndAt ?? null);
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
      // A small margin past the end mark, so the frame that shows it is the last one kept.
      const lastFrame = endAt === null ? media.seconds : Math.min(media.seconds, at(endAt) + 0.1);
      const onCamera = waits.map(([a, b]) => [at(a), Math.min(at(b), lastFrame)] as const).filter(([a]) => a < lastFrame);
      cut(raw, out, keptRanges(at(firstFrame), lastFrame, onCamera));
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
