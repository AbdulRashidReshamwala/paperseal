import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/*
 * Films a real Claude Code run. `runAgent` runs `claude -p` on the exact prompt, in an empty folder, and
 * keeps every event it prints, with its time. `terminalPage` is a small local page that plays those
 * events back as a terminal would show them, faster than they arrived. Nothing in it is typed or written
 * by hand. The pass rule reads the checker's own report from the run, and a run that isn't verified-test
 * with every claim passed throws, so there is no video of it.
 *
 * `-p` and not the interactive screen, because that screen first asks to trust the folder, and answering
 * would change the owner's settings. Long tool output is shortened on screen, as Claude Code does.
 */

/** Only what the prompt needs. Anything else is neither offered nor allowed. */
const TOOLS = 'Bash,WebFetch,Read';
const FLAGS = ['--tools', TOOLS, '--allowedTools', TOOLS, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '-p'];
const CLAIMS = ['published', 'people', 'attested', 'locked', 'sealed', 'unlock', 'open'];
const WHOLE_RUN_MS = 12 * 60_000;
const OUTPUT_LINES = 3;

/** One thing the terminal shows, and when it was printed, in milliseconds from the prompt being sent. */
export interface Line {
  t: number;
  kind: 'text' | 'tool' | 'output' | 'reply';
  text: string;
}

export interface AgentRun {
  /** The command as it ran, up to where the prompt goes. */
  command: string;
  prompt: string;
  lines: Line[];
  /** Milliseconds from sending the prompt to the final reply. */
  seconds: number;
  overall: string;
  passed: number;
  claims: number;
  /** Where the report was read from. */
  source: 'tool output' | 'final reply';
}

interface Report {
  overall: string;
  method: string;
  exam: { examId: string };
  claims: { id: string; status: string }[];
}

interface Event {
  type?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: unknown };
}

type Part = { type: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown };

/** Every JSON object in the text that looks like a report: `{` then `"version"`, read to its closing brace. */
function reportsIn(text: string): Report[] {
  const found: Report[] = [];
  for (const start of text.matchAll(/\{\s*"version"\s*:/g)) {
    let depth = 0;
    let quoted = false;
    for (let at = start.index; at < text.length; at += 1) {
      const c = text[at];
      if (quoted) {
        if (c === '\\') at += 1;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth += 1;
      else if (c === '}' && (depth -= 1) === 0) {
        try {
          const value = JSON.parse(text.slice(start.index, at + 1)) as Partial<Report>;
          if (value.overall && Array.isArray(value.claims)) found.push(value as Report);
        } catch {
          // Not JSON after all, so not a report.
        }
        break;
      }
    }
  }
  return found;
}

/** The checker's report from the run, held to the pass rule. Throws on anything less. */
function judge(outputs: readonly string[], reply: string, examId: string): Pick<AgentRun, 'overall' | 'passed' | 'claims' | 'source'> {
  const fromTools = outputs.flatMap(reportsIn).filter((report) => report.exam?.examId === examId);
  const fromReply = reportsIn(reply).filter((report) => report.exam?.examId === examId);
  const report = fromTools.at(-1) ?? fromReply.at(-1);
  const end = reply.replace(/\s+/g, ' ').slice(0, 700);
  if (!report) throw new Error(`the agent's run has no report for ${examId}. Its reply: ${end}`);
  const passed = report.claims.filter(({ status }) => status === 'pass').length;
  const names = report.claims.map(({ id }) => id).join(',');
  const failing = report.claims.filter(({ status }) => status !== 'pass').map(({ id, status }) => `${id}: ${status}`);
  if (report.overall !== 'verified-test' || report.method !== 'checker' || passed !== CLAIMS.length || names !== CLAIMS.join(',')) {
    throw new Error(`the report says overall ${report.overall}, method ${report.method}, ${String(passed)} of ${String(report.claims.length)} claims passed. ${failing.join('; ')}. Its reply: ${end}`);
  }
  if (!reply.includes('Verified, on a test network')) throw new Error(`the checker passed but the agent's reply doesn't say so: ${end}`);
  return { overall: report.overall, passed, claims: report.claims.length, source: fromTools.length > 0 ? 'tool output' : 'final reply' };
}

/** This machine's environment, without this process's own Claude session. */
function terminalEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC)/.test(name))) as Record<string, string>;
  return { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
}

const outputOf = (part: Part) => (typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? (part.content as { text?: string }[]).map((piece) => piece.text ?? '').join('') : '');

function shortened(output: string) {
  const lines = output.trimEnd().split('\n');
  const shown = lines.slice(0, OUTPUT_LINES).join('\n');
  return lines.length > OUTPUT_LINES ? `${shown}\n… +${String(lines.length - OUTPUT_LINES)} lines` : shown;
}

/** Runs the agent on the prompt and returns what it printed. Throws unless the pass rule holds. */
export async function runAgent(prompt: string, examId: string, log: (line: string) => void = () => undefined): Promise<AgentRun> {
  const cwd = mkdtempSync(join(tmpdir(), 'paperseal-agent-check-'));
  const child = spawn('claude', [...FLAGS, prompt], { cwd, env: terminalEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const sent = Date.now();
  const lines: Line[] = [];
  const outputs: string[] = [];
  let reply: string | undefined;
  let failed = false;
  let stderr = '';
  let partial = '';
  const read = (raw: string) => {
    if (!raw.trim()) return;
    const event = JSON.parse(raw) as Event;
    const t = Date.now() - sent;
    if (event.type === 'result') {
      reply = event.result ?? '';
      failed = event.is_error === true;
      return;
    }
    const parts = event.message?.content;
    if (!Array.isArray(parts)) return;
    for (const part of parts as Part[]) {
      if (part.type === 'text' && part.text?.trim()) lines.push({ t, kind: 'text', text: part.text.trim() });
      if (part.type === 'tool_use') {
        const input = String(part.input?.command ?? part.input?.url ?? part.input?.file_path ?? JSON.stringify(part.input));
        lines.push({ t, kind: 'tool', text: shortened(`${part.name ?? 'Tool'}(${input})`) });
        log(`${part.name ?? 'Tool'}: ${input.slice(0, 120)}`);
      }
      if (part.type === 'tool_result') {
        outputs.push(outputOf(part));
        lines.push({ t, kind: 'output', text: shortened(outputOf(part)) });
      }
    }
  };
  child.stdout.setEncoding('utf8').on('data', (data: string) => {
    const whole = (partial + data).split('\n');
    partial = whole.pop() ?? '';
    whole.forEach(read);
  });
  child.stderr.setEncoding('utf8').on('data', (data: string) => {
    stderr += data;
  });
  const deadline = setTimeout(() => child.kill('SIGTERM'), WHOLE_RUN_MS);
  const code = await new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }).finally(() => {
    clearTimeout(deadline);
  });
  read(partial);
  const seconds = Math.round((Date.now() - sent) / 1000);
  if (reply === undefined || failed || code !== 0) throw new Error(`claude ended with code ${String(code)} after ${String(seconds)} s and no good reply. ${String(reply ?? '').slice(0, 400)} ${stderr.slice(-400)}`);
  log(`the agent finished after ${String(seconds)} s`);
  // The reply is usually the last text event too, and it is shown once.
  const body = lines.filter((line) => !(line.kind === 'text' && line.text === reply?.trim()));
  body.push({ t: Date.now() - sent, kind: 'reply', text: reply });
  return { command: `claude ${FLAGS.join(' ')} "`, prompt, lines: body, seconds, ...judge(outputs, reply, examId) };
}

const pageHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Terminal</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0f14; overflow: hidden; }
  #bar { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #1b2129; color: #9aa7b4; font: 13px system-ui, sans-serif; }
  #bar i { width: 12px; height: 12px; border-radius: 50%; background: #3a444f; }
  #bar span { margin-left: 8px; }
  #term { position: fixed; top: 34px; left: 0; right: 0; height: 606px; box-sizing: border-box; padding: 10px 20px; overflow: hidden; color: #e6edf3; font: 16px/1.3 Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .shell { color: #e6edf3; } .prompt { color: #7ee787; }
  .text { color: #e6edf3; margin-top: 10px; }
  .tool { color: #e6edf3; margin-top: 10px; font-weight: 700; } .tool::before { content: '⏺ '; color: #3fb950; }
  .output { color: #8b98a5; padding-left: 28px; }
  .reply { color: #e6edf3; margin-top: 12px; }
  .good { color: #3fb950; font-weight: 700; }
  .clock { color: #d29922; margin-top: 10px; }
</style>
</head>
<body>
<div id="bar"><i></i><i></i><i></i><span>Terminal</span></div>
<div id="term"></div>
<script>
  const term = document.getElementById('term');
  const lines = window.__lines = { list: [], next: 0 };
  const safe = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const add = (kind, html) => {
    const el = document.createElement('div');
    el.className = kind;
    el.innerHTML = html;
    term.insertBefore(el, clock.parentNode ? clock : null);
    term.scrollTop = term.scrollHeight;
    return el;
  };
  const clock = document.createElement('div');
  clock.className = 'clock';
  const elapsed = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };
  window.__load = async () => {
    const run = await (await fetch('/run')).json();
    lines.list = run.lines;
    lines.prompt = run.prompt;
    add('shell', '<span class="prompt">$</span> ' + safe(run.command));
  };
  window.__paste = () => add('shell', safe(lines.prompt) + '"');
  /* Prints every line, keeping their spacing, \`speed\` times faster than they arrived, with the run's real clock under them. */
  window.__play = async (speed) => {
    term.appendChild(clock);
    const began = performance.now();
    for (const line of lines.list) {
      for (;;) {
        const now = (performance.now() - began) * speed;
        clock.textContent = '✻ Working, ' + elapsed(Math.min(now, line.t)) + ' of real time';
        if (now >= line.t) break;
        await new Promise((done) => setTimeout(done, 40));
      }
      add(line.kind, line.kind === 'reply' ? safe(line.text).replace(/Verified, on a test network|\\bpass\\b/g, '<span class="good">$&</span>') : safe(line.text));
    }
    clock.remove();
    term.scrollTop = term.scrollHeight;
  };
  /* Scrolls back to the start of the reply, as a person would to read it. Says what is then in view. */
  window.__scrollToReply = async () => {
    const reply = term.querySelector('.reply');
    const target = reply.offsetTop - 10;
    const from = term.scrollTop;
    const began = performance.now();
    await new Promise((done) => {
      const frame = (now) => {
        const part = Math.min((now - began) / 500, 1);
        term.scrollTop = from + (target - from) * part;
        if (part < 1) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    });
    return reply.textContent.split('\\n').slice(0, Math.floor((term.clientHeight - 20) / 21)).join('\\n');
  };
</script>
</body>
</html>`;

/** A small local page that plays a run back. */
export async function terminalPage(run: AgentRun): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const data = request.url === '/run';
    response.writeHead(data || request.url === '/' ? 200 : 404, { 'content-type': data ? 'application/json' : 'text/html; charset=utf-8' });
    response.end(data ? JSON.stringify(run) : pageHtml);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    stop: () =>
      new Promise((done) => {
        server.close(() => {
          done();
        });
        server.closeAllConnections();
      }),
  };
}
