import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';

/*
 * One Recording is one video. It owns the browser context (Playwright's own recordVideo at
 * 1280x800), a caption overlay naming each step, and the closing result screen. The result
 * screen is built only from assertions the test actually ran: each `check` records PASS or FAIL
 * from what its function did, and a thrown flow error is recorded as a FAIL too.
 */

export const VIDEO_DIR = resolve(import.meta.dirname, '../videos');
const WORK_DIR = resolve(VIDEO_DIR, '.work');
const RESULTS_DIR = resolve(VIDEO_DIR, 'results');
export const SIZE = { width: 1280, height: 800 };

/** Slows every Playwright action so a person can follow it. */
export const SLOW_MO = 150;
/** Milliseconds between typed characters. */
export const TYPE_DELAY = 45;

export function launchChrome(): Promise<Browser> {
  return chromium.launch({ channel: 'chrome', headless: true, slowMo: SLOW_MO }).catch((error: unknown) => {
    throw new Error(`Could not start the installed Chrome (channel "chrome"). Is Google Chrome installed? ${String(error)}`, { cause: error });
  });
}

export interface Assertion {
  label: string;
  ok: boolean;
  detail: string;
}

export interface RecordingResult {
  name: string;
  result: 'PASS' | 'FAIL';
  durationMs: number;
  file: string;
  format: 'mp4' | 'webm';
  assertions: Assertion[];
}

const captionScript = `(() => {
  const ID = '__ps_caption';
  const build = () => {
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ID;
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 18px;background:rgba(15,23,42,.94);color:#fff;font:600 19px/1.35 system-ui,sans-serif;pointer-events:none;border-top:3px solid #38bdf8';
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  };
  const render = () => {
    const el = build();
    el.replaceChildren();
    const main = document.createElement('div');
    main.textContent = window.__captionText || '';
    el.appendChild(main);
    if (window.__captionSub) {
      const sub = document.createElement('div');
      sub.style.cssText = 'font-weight:500;font-size:14px;color:#fbbf24;margin-top:2px';
      sub.textContent = window.__captionSub;
      el.appendChild(sub);
    }
  };
  window.__caption = (text, sub) => { window.__captionText = text; window.__captionSub = sub || ''; render(); };
  new MutationObserver(() => {
    if (window.__captionText && !document.getElementById(ID)) render();
  }).observe(document, { childList: true, subtree: true });
})();`;

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export class Recording {
  readonly assertions: Assertion[] = [];
  private readonly started = Date.now();
  private context: BrowserContext | null = null;
  private page_: Page | null = null;

  readonly name: string;
  private readonly options: { title: string; subtitle?: string };

  constructor(name: string, options: { title: string; subtitle?: string }) {
    this.name = name;
    this.options = options;
  }

  get page(): Page {
    if (!this.page_) throw new Error('the recording has no page yet');
    return this.page_;
  }

  /** Opens a context that records video, with the caption overlay installed on every page. */
  async open(browser: Browser, initScripts: string[] = []): Promise<Page> {
    rmSync(resolve(WORK_DIR, this.name), { recursive: true, force: true });
    mkdirSync(resolve(WORK_DIR, this.name), { recursive: true });
    this.context = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: resolve(WORK_DIR, this.name), size: SIZE },
    });
    await this.context.addInitScript(captionScript);
    for (const script of initScripts) await this.context.addInitScript(script);
    this.page_ = await this.context.newPage();
    return this.page_;
  }

  /** Names the step on screen. Call again after a full page load, because navigation clears it. */
  async say(text: string): Promise<void> {
    await this.page.evaluate(([t, s]) => (window as unknown as { __caption?: (a: string, b: string) => void }).__caption?.(t as string, s as string), [text, this.options.subtitle ?? ''] as const);
  }

  async pause(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** Real typing: click the field, then one key press at a time. */
  async type(field: Locator, text: string, delay = TYPE_DELAY): Promise<void> {
    await field.click();
    await field.pressSequentially(text, { delay });
  }

  /** Runs one assertion. Failure is recorded and shown, and the recording carries on. */
  async check(label: string, run: () => Promise<string | void> | string | void): Promise<boolean> {
    try {
      const detail = (await run()) ?? '';
      this.assertions.push({ label, ok: true, detail });
      return true;
    } catch (error) {
      this.assertions.push({ label, ok: false, detail: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /** Records that the flow itself broke, which can only be a FAIL. */
  fail(label: string, error: unknown): void {
    this.assertions.push({ label, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  private resultHtml(passed: boolean): string {
    const rows = this.assertions
      .map(
        (a) => `<li class="${a.ok ? 'ok' : 'bad'}"><b>${a.ok ? 'PASS' : 'FAIL'}</b><div><div>${escapeHtml(a.label)}</div>${a.detail ? `<small>${escapeHtml(a.detail.slice(0, 400))}</small>` : ''}</div></li>`,
      )
      .join('');
    return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(this.name)} result</title><style>
      body{margin:0;background:#0f172a;color:#e2e8f0;font:16px/1.4 system-ui,sans-serif;padding:28px 44px;height:100vh;box-sizing:border-box;overflow:hidden}
      h1{margin:0 0 4px;font-size:26px} .sub{color:#94a3b8;margin-bottom:14px}
      .verdict{display:inline-block;font-size:46px;font-weight:800;padding:4px 26px;border-radius:12px;margin:6px 0 14px;color:#0f172a;background:${passed ? '#4ade80' : '#f87171'}}
      ul{list-style:none;margin:0;padding:0;display:grid;gap:6px} li{display:flex;gap:14px;background:#1e293b;border-radius:8px;padding:7px 12px;align-items:flex-start}
      li b{min-width:48px;font-family:ui-monospace,monospace} li.ok b{color:#4ade80} li.bad b{color:#f87171} li.bad{outline:2px solid #f87171}
      small{display:block;color:#94a3b8;font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}
    </style><h1>${escapeHtml(this.options.title)}</h1><div class="sub">Result of the assertions that ran in this recording, ${this.assertions.length} in all</div>
    <div class="verdict">${passed ? 'PASS' : 'FAIL'}</div><ul>${rows}</ul>`;
  }

  /**
   * Shows the result screen, closes the video, converts it and writes the result file. Throws when
   * anything failed, so the vitest test fails too.
   */
  async finish(): Promise<RecordingResult> {
    const passed = this.assertions.length > 0 && this.assertions.every((a) => a.ok);
    if (this.assertions.length === 0) this.fail('No assertion ran', 'the flow ended before any check');
    try {
      if (this.page_ && !this.page_.isClosed()) {
        await this.page_.setContent(this.resultHtml(passed));
        await this.page_.waitForTimeout(7000);
      }
    } catch (error) {
      this.fail('Showing the result screen', error);
    }
    const video = this.page_?.video();
    await this.context?.close();
    const raw = video ? await video.path() : null;

    mkdirSync(VIDEO_DIR, { recursive: true });
    mkdirSync(RESULTS_DIR, { recursive: true });
    let file = resolve(VIDEO_DIR, `${this.name}.webm`);
    let format: 'mp4' | 'webm' = 'webm';
    rmSync(resolve(VIDEO_DIR, `${this.name}.mp4`), { force: true });
    rmSync(file, { force: true });
    if (raw) {
      const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
      const mp4 = resolve(VIDEO_DIR, `${this.name}.mp4`);
      if (
        hasFfmpeg &&
        spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' }).status === 0
      ) {
        file = mp4;
        format = 'mp4';
      } else {
        renameSync(raw, file);
      }
    } else {
      this.fail('Video file', 'Playwright produced no video');
    }
    rmSync(resolve(WORK_DIR, this.name), { recursive: true, force: true });

    const allOk = this.assertions.every((a) => a.ok);
    const result: RecordingResult = {
      name: this.name,
      result: allOk ? 'PASS' : 'FAIL',
      durationMs: Date.now() - this.started,
      file,
      format,
      assertions: this.assertions,
    };
    writeFileSync(resolve(RESULTS_DIR, `${this.name}.json`), JSON.stringify(result, null, 2));
    if (!allOk) {
      const failed = this.assertions.filter((a) => !a.ok).map((a) => `${a.label}: ${a.detail}`);
      throw new Error(`${this.name} FAILED (video: ${file})\n${failed.join('\n')}`);
    }
    return result;
  }
}
