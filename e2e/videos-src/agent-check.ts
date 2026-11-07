import { runAgent, terminalPage, type AgentRun } from './lib/agent-terminal';
import { defineVideo, step, wait, type Stage } from './lib/script';

/*
 * A finished exam on the public page, then a real Claude Code run on the exact prompt the page copied.
 * It reads the verifier already running on this machine and sends nothing. The agent runs off camera, in
 * an empty folder, and only then is the terminal filmed: what it printed, faster, under a caption that
 * says so. The run fails unless the checker's own report is verified-test with all 7 claims passed.
 */

const VERIFIER = 'http://localhost:5172/#/name/time-q.paperseal-demo.eth';
const RESULT = 'Verified, on a test network';
/** How long the agent's work lasts on camera before the 1.5x cut, in milliseconds. */
const FAST_FORWARD_MS = 14_000;

let agent: AgentRun | undefined;

const ran = () => {
  if (!agent) throw new Error('the agent has not run');
  return agent;
};

/** Scrolls at an even, gentle pace, whatever the page's own scroll behaviour. */
const glide = (s: Stage, top: number, ms: number) =>
  s.page.evaluate(
    ([to, duration]) =>
      new Promise<void>((done) => {
        const from = scrollY;
        const began = performance.now();
        const frame = (now: number) => {
          const part = Math.min((now - began) / (duration ?? 1), 1);
          const eased = part < 0.5 ? 2 * part * part : 1 - (-2 * part + 2) ** 2 / 2;
          scrollTo(0, from + ((to ?? 0) - from) * eased);
          if (part < 1) requestAnimationFrame(frame);
          else done();
        };
        requestAnimationFrame(frame);
      }),
    [top, ms],
  );

const button = (s: Stage) => s.page.getByRole('button', { name: 'Check with your own AI' });

export default defineVideo({
  title: 'Check an exam with your own AI',
  speed: 1.5,
  prefix: 'agent-check',
  persona: 'visitor',
  // The runner opens its own app first. This path isn't the app, so that costs no Arkiv reads.
  open: '/@vite/client',
  ready: async (s) => {
    await s.page.goto(VERIFIER);
  },
  steps: [
    wait(
      'A finished exam on its public page',
      async (s) => {
        await s.page.getByText('Every step has been checked. Nothing failed.').waitFor({ timeout: 120_000 });
        await s.page.waitForFunction(() => document.body.innerText.includes('Verified on Sepolia'), null, { timeout: 30_000 });
      },
      { hold: 1800 },
    ),
    step(
      'Every step of the exam is on the record',
      async (s) => {
        const bottom = await s.page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        await glide(s, bottom, 3000);
        await s.hold(300);
        const top = await button(s).evaluate((el) => el.getBoundingClientRect().top + scrollY - 260);
        await glide(s, top, 1400);
      },
      { hold: 300 },
    ),
    step(
      'Copy the check for your own AI',
      async (s) => {
        await s.click(button(s));
        await s.page.getByText('Copied. Paste it into any AI agent.').first().waitFor({ timeout: 5000 });
        const copied = await s.page.evaluate(() => navigator.clipboard.readText());
        const shown = await s.page.locator('.vf-agent-text pre').textContent();
        if (!copied || copied !== shown) throw new Error('the clipboard does not hold the text the page shows');
        s.memo.prompt = copied;
      },
      { hold: 1300 },
    ),
    wait(
      'Claude Code runs it',
      async (s) => {
        const prompt = s.memo.prompt ?? '';
        const examId = /^Exam ID: (0x[0-9a-f]{64})$/m.exec(prompt)?.[1];
        if (!examId) throw new Error('the prompt has no exam ID');
        agent = await runAgent(prompt, examId, (line) => {
          console.log(`  ${line}`);
        });
        Object.assign(s.notes, { overall: agent.overall, claimsPassed: `${String(agent.passed)} of ${String(agent.claims)}`, reportFrom: agent.source, agentSeconds: String(agent.seconds) });
        const terminal = await terminalPage(agent);
        await s.page.goto(terminal.url);
        await s.page.evaluate(() => (window as unknown as { __load: () => Promise<void> }).__load());
        await terminal.stop();
      },
      { keep: [0, 0] },
    ),
    step(
      'Paste the prompt into Claude Code and send it',
      async (s) => {
        await s.hold(900);
        await s.page.evaluate(() => {
          (window as unknown as { __paste: () => void }).__paste();
        });
      },
      { hold: 2200 },
    ),
    step(
      'Fast forward: the agent runs the checker itself',
      async (s) => {
        const speed = Math.max((ran().seconds * 1000) / FAST_FORWARD_MS, 1);
        await s.page.evaluate((rate) => (window as unknown as { __play: (speed: number) => Promise<void> }).__play(rate), speed);
      },
    ),
    step(
      () => `The agent's real result: ${String(ran().passed)} of ${String(ran().claims)} claims passed`,
      async (s) => {
        const view = await s.page.evaluate(() => (window as unknown as { __scrollToReply: () => Promise<string> }).__scrollToReply());
        if (!view.includes(RESULT)) throw new Error(`"${RESULT}" is not in view: ${view.slice(0, 400)}`);
        s.notes.resultLine = view.split('\n').find((line) => line.includes(RESULT)) ?? '';
      },
      { hold: 3200 },
    ),
  ],
});
