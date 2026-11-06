import { resolveExamName } from '@paperseal/chain';
import { examIdFromName, threshold } from '@paperseal/protocol';

import { partyParent } from '../live/roster';
import { button, field, text } from '../ui/selectors';
import { defineVideo, step, wait, type Stage } from './lib/script';
import { retry } from './lib/world';

/*
 * The exam board creates an exam on the real system, from its home page to the published exam with
 * its name set. Run it with `pnpm video create-exam`. It spends a little Sepolia ETH.
 */

const namePage = (s: Stage) => s.page.locator('.board-exam-name');

/** What the public record says, read straight from it and not from the page. */
async function readExam(s: Stage) {
  return retry('reading the exam from the public record', async () => {
    const exam = await s.world.registry.getExam(examIdFromName(s.label));
    if (!exam) throw new Error('the exam is not there');
    return exam;
  });
}

/** Ticks the names in the list on the page, trying again if the list could not be read. */
async function tick(s: Stage, names: readonly string[], pace = 100) {
  const first = s.page.getByLabel(`Include ${names[0] ?? ''}`);
  await retry('reading the list of names', async () => {
    if (await first.isVisible()) return;
    const again = s.page.getByRole('button', { name: button.tryAgain });
    if (await again.isVisible()) await again.click();
    throw new Error('the names are not on the page yet');
  }, 30, 1000);
  for (const name of names) {
    const box = s.page.getByLabel(`Include ${name}`);
    await box.hover();
    await s.hold(pace);
    await box.check();
  }
}

const centres = [1, 2, 3, 4, 5, 6, 7].slice(0, threshold.centres).map((n) => `centre-${String(n)}.${partyParent}`);
const neutrals = [1, 2, 3].slice(0, threshold.neutrals).map((n) => `neutral-${String(n)}.${partyParent}`);

/**
 * Presses Publish until it has gone out. A read the public RPC refused sends nothing, and the button
 * comes back, so pressing again is safe. If it went out and only the reading back failed, a fresh look
 * at the draft finds the exam.
 */
async function publish(s: Stage) {
  const target = s.page.getByRole('button', { name: button.publish });
  const problem = s.page.getByRole('alert').first();
  const published = () => s.world.registry.getExam(examIdFromName(s.label)).catch(() => null);
  const before = s.world.sent();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await s.click(target);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && !(await problem.isVisible() && await target.isVisible())) {
      if (s.page.url().includes('#/board/exam/')) return;
      await s.hold(500);
    }
    if (Date.now() >= deadline) throw new Error('publishing did not finish');
    if (s.world.sent() > before || (await published())) {
      await readExam(s);
      await s.page.reload();
      await s.page.waitForURL(/#\/board\/exam\//, { timeout: 120_000 });
      return;
    }
    console.log(`  the page said: ${await problem.innerText()}`);
    await s.hold(4000);
  }
  throw new Error('the page would not publish');
}

/** Waits for the name to show as set. It asks the wallet by itself, and a failed attempt offers a button. */
async function waitForName(s: Stage) {
  await s.endWhen('.board-exam-name', s.label, 'Published. The exam name is set');
  await s.top();
  const deadline = Date.now() + 240_000;
  const set = namePage(s).filter({ hasText: s.label });
  while (Date.now() < deadline) {
    if (await set.isVisible()) return;
    for (const again of [s.page.getByRole('button', { name: 'Try again to set the exam name' }), s.page.getByRole('button', { name: 'Set the exam name', exact: true })]) {
      if (await again.isVisible()) {
        await s.hold(3000);
        if (await again.isVisible()) await again.click();
      }
    }
    await s.hold(1000);
  }
  throw new Error('the exam name did not show as set');
}

/** Fails the run unless the exam and its name are really on the public record. */
async function confirmOnChain(s: Stage) {
  const examId = examIdFromName(s.label);
  const name = `${s.label}.${partyParent}`;
  const exam = await readExam(s);
  if (exam.settings.examId.toLowerCase() !== examId.toLowerCase()) throw new Error(`the record holds exam ${exam.settings.examId}`);
  const criteria = await retry('reading the topics', () => s.world.registry.getCriteria(examId));
  if (!criteria) throw new Error('the exam has no topics on the public record');
  const resolved = await retry('checking the exam name', async () => {
    const result = await resolveExamName(name, { lookup: s.world.lookup });
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  });
  if (resolved.examId.toLowerCase() !== examId.toLowerCase()) throw new Error(`${name} points at exam ${resolved.examId}`);
  if (resolved.registry.toLowerCase() !== s.world.registryAddress.toLowerCase()) throw new Error(`${name} points at registry ${resolved.registry}`);
  Object.assign(s.notes, { examId, name, registry: s.world.registryAddress });
}

export default defineVideo({
  title: 'Create an exam',
  prefix: 'class-12-physics',
  open: '/#/board',
  ready: async (s) => {
    await s.page.getByRole('button', { name: button.connectWallet }).click({ timeout: 60_000 });
    await s.page.getByRole('heading', { name: 'Your exams' }).waitFor({ timeout: 60_000 });
    await s.hold(500);
  },
  steps: [
    step('This is the board’s home page. Start a new exam', async (s) => {
      await s.click(s.page.getByRole('button', { name: 'Create an exam' }));
      await s.board.seeHeading(text.createHeading);
    }, { hold: 300 }),
    step('Give the exam a name', async (s) => {
      await s.type(s.page.getByLabel(field.examName).first(), s.label);
    }),
    step('Fill in the exam details', async (s) => {
      await s.show(s.page.getByLabel(field.examStart).first());
      await s.hold(700);
      await s.click(s.page.getByRole('button', { name: button.continue, exact: true }));
      await s.board.seeHeading('Add the topics');
    }, { hold: 250 }),
    step('Add what the paper covers', async (s) => {
      await s.hold(1500);
      await s.click(s.page.getByRole('button', { name: 'Add 2 topics with 2 questions' }));
      await s.hold(3200);
      await s.click(s.page.getByRole('button', { name: button.continue, exact: true }));
      await s.board.seeHeading('Choose the centres');
    }, { hold: 250 }),
    step('Choose the centres that will open the paper', async (s) => {
      await tick(s, centres);
      await s.hold(500);
      await s.click(s.page.getByRole('button', { name: button.continue, exact: true }));
      await s.board.seeHeading('Choose the neutral parties');
    }, { hold: 250 }),
    step('Choose the neutral key holders', async (s) => {
      await s.hold(1500);
      await tick(s, neutrals, 900);
      await s.hold(2500);
      await s.click(s.page.getByRole('button', { name: button.continue, exact: true }));
      await s.board.seeHeading(text.reviewHeading, 60_000);
    }, { hold: 250 }),
    step('Check everything once more', async (s) => {
      await s.page.getByText(/the latest verified release|your choice, verified/).first().waitFor({ timeout: 90_000 });
      await s.show(s.page.getByText('Topic: Mathematics'));
      await s.hold(1200);
      await s.show(s.page.getByRole('button', { name: button.publish }));
      await s.hold(800);
    }, { hold: 100 }),
    wait('Publish the exam. Waiting for Sepolia to confirm it', publish, { hold: 300, spends: true }),
    wait('Now the exam gets its public name. Waiting for Sepolia', waitForName, { hold: 300, spends: true }),
    // Off camera. The video ends when the name shows, and this fails the run if the record disagrees.
    wait('Reading the exam back from Sepolia', confirmOnChain, { hold: 0, spends: true }),
  ],
});
