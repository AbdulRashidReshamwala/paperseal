import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

import type { Browser } from 'playwright-core';

import { Recording } from './recorder';

/*
 * Runs a real command and streams its real stdout and stderr, as they arrive, into a plain
 * terminal-style page that Playwright records. The command starts when the page asks for the
 * stream, nothing is replayed, and the page ends with the command's real exit code.
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const EXIT_MARK = '@@PAPERSEAL-EXIT:';

const html = (title: string) => `<!doctype html><meta charset="utf-8"><title>terminal</title><style>
  body{margin:0;background:#0b0f14;color:#d6e2ee;font:14px/1.35 ui-monospace,Menlo,monospace}
  #head{position:sticky;top:0;background:#16202b;padding:10px 16px;border-bottom:1px solid #2a3a4a;color:#7dd3fc;font-weight:700}
  pre{margin:0;padding:10px 16px 90px;white-space:pre-wrap;word-break:break-all}
  .exit{font-weight:700;font-size:18px;margin-top:14px} .ok{color:#4ade80} .bad{color:#f87171}
</style><div id="head">$ ${title}</div><pre id="out"></pre><script>
  const out = document.getElementById('out');
  window.__done = false;
  (async () => {
    const response = await fetch('/stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let tail = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      tail += decoder.decode(value, { stream: true });
      const at = tail.indexOf('${EXIT_MARK}');
      const shown = at === -1 ? tail : tail.slice(0, at);
      if (at === -1) { out.append(shown); tail = ''; window.scrollTo(0, document.body.scrollHeight); continue; }
      out.append(shown);
      const code = Number(tail.slice(at + ${EXIT_MARK.length}).trim());
      const line = document.createElement('div');
      line.className = 'exit ' + (code === 0 ? 'ok' : 'bad');
      line.textContent = 'exit code ' + code;
      out.appendChild(line);
      window.scrollTo(0, document.body.scrollHeight);
      window.__done = true;
      break;
    }
  })();
</script>`;

export interface SuiteSpec {
  name: string;
  title: string;
  /** Shown in the terminal header. */
  display: string;
  cwd: string;
  command: string;
  args: string[];
  /** Extra checks on the real output. Each returns a detail string or throws. */
  outputChecks?: { label: string; run: (output: string) => string }[];
}

export async function recordSuite(browser: Browser, spec: SuiteSpec): Promise<void> {
  const rec = new Recording(spec.name, { title: spec.title });
  let output = '';
  let exitCode: number | null = null;
  let server: Server | null = null;
  try {
    const finished = new Promise<void>((resolveDone) => {
      server = createServer((request, response) => {
        if (request.url !== '/stream') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(html(spec.display));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
        const child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const forward = (chunk: Buffer) => {
          const text = chunk.toString('utf8').replace(ANSI, '').replace(/\u0000/g, '');
          output += text;
          response.write(text);
        };
        child.stdout.on('data', forward);
        child.stderr.on('data', forward);
        child.once('error', (error) => {
          forward(Buffer.from(`could not start ${spec.command}: ${error.message}\n`));
          exitCode = 127;
          response.end(`${EXIT_MARK}127`);
          resolveDone();
        });
        child.once('close', (code) => {
          exitCode = code ?? 1;
          response.end(`${EXIT_MARK}${String(exitCode)}`);
          resolveDone();
        });
      });
      server.listen(0, '127.0.0.1');
    });
    await new Promise((r) => setTimeout(r, 100));
    const address = (server as Server | null)?.address();
    if (!address || typeof address === 'string') throw new Error('terminal server has no port');

    const page = await rec.open(browser);
    await page.goto(`http://127.0.0.1:${String(address.port)}/`);
    await rec.say(`Live: ${spec.display}  (real command, real output, nothing replayed)`);
    await finished;
    await page.waitForFunction(() => (window as unknown as { __done: boolean }).__done, undefined, { timeout: 30_000 });
    await rec.say(`Finished: exit code ${String(exitCode)}`);
    await rec.pause(5000);

    await rec.check(`\`${spec.display}\` exits with code 0`, () => {
      if (exitCode !== 0) throw new Error(`exit code ${String(exitCode)}`);
      return 'exit code 0';
    });
    for (const check of spec.outputChecks ?? []) await rec.check(check.label, () => check.run(output));
  } catch (error) {
    rec.fail('Suite run completed', error);
  } finally {
    (server as Server | null)?.close();
    await rec.finish();
  }
}
