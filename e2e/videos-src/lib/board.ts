import { resolveExamName } from '@paperseal/chain';
import { examIdFromName, threshold } from '@paperseal/protocol';

import { partyParent } from '../../live/roster';
import { button, field, fold, text, unfold } from '../../ui/selectors';
import type { Stage } from './script';
import { retry } from './world';

/*
 * What the board does, for any video. On camera these run at a viewer's pace. A video that starts later
 * in an exam's life runs them in the board's own window, off camera, against the same real pages.
 */

const nameStrip = (s: Stage) => s.page.locator('.board-exam-name');

/** What the public record says, read straight from it and not from the page. */
export async function readExam(s: Stage) {
  return retry('reading the exam from the public record', async () => {
    const exam = await s.world.registry.getExam(examIdFromName(s.label));
    if (!exam) throw new Error('the exam is not there');
    return exam;
  });
}

/** Ticks the names in the list on the page, trying again if the list could not be read. */
export async function tick(s: Stage, names: readonly string[], pace = 100) {
  const first = s.page.getByLabel(`Include ${names[0] ?? ''}`);
  await retry('reading the list of names', async () => {
    if (await first.isVisible()) return;
    const again = s.page.getByRole('button', { name: button.tryAgain });
    if (await again.isVisible()) await again.click();
    throw new Error('the names are not on the page yet');
  }, 30, 1000);
  for (const name of names) {
    const box = s.page.getByLabel(`Include ${name}`);
    await s.show(box);
    await box.hover();
    await s.hold(pace);
    await box.check();
  }
}

export const centres = [1, 2, 3, 4, 5, 6, 7].slice(0, threshold.centres).map((n) => `centre-${String(n)}.${partyParent}`);
export const neutrals = [1, 2, 3].slice(0, threshold.neutrals).map((n) => `neutral-${String(n)}.${partyParent}`);

/**
 * Presses Publish until it has gone out. A read the public RPC refused sends nothing, and the button
 * comes back, so pressing again is safe. If it went out and only the reading back failed, a fresh look
 * at the draft finds the exam.
 */
export async function publish(s: Stage) {
  const target = s.page.getByRole('button', { name: button.publish });
  const problem = s.page.getByRole('alert').first();
  const published = () => s.world.registry.getExam(examIdFromName(s.label)).catch(() => null);
  const before = s.world.sent();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt === 0) await s.hold(700);
    await s.click(target);
    // The video ends here, with the button showing it is working. The rest happens off camera.
    await s.hold(400);
    await s.endHere();
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
export async function waitForName(s: Stage) {
  const deadline = Date.now() + 240_000;
  const set = nameStrip(s).filter({ hasText: s.label });
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
export async function confirmOnChain(s: Stage) {
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


const two = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
const continueButton = (s: Stage) => s.page.getByRole('button', { name: button.continue, exact: true });

export interface ExamPlan {
  /** Minutes from now until questions close. */
  closeInMinutes: number;
  /** Minutes from questions closing to the exam's start. The paper is released a minute before it. */
  startAfterClose?: number;
  /** The exam's length in minutes. Left out, the page's own default. */
  lengthMinutes?: number;
  /** Refuses to publish if the page offers any other version. Checked on the real system only. */
  release?: string;
}

/**
 * Publishes an exam through the board's own pages, for a video that starts later in an exam's life,
 * with a schedule that leaves room to finish.
 */
export async function publishForVideo(s: Stage, plan: ExamPlan) {
  const { closeInMinutes, startAfterClose = 2 } = plan;
  const { page } = s;
  await page.goto(`${s.memo.web ?? ''}/#/board/new`);
  await page.getByRole('button', { name: button.connectWallet }).click({ timeout: 60_000 });
  await s.actor.seeHeading(text.createHeading);
  const close = new Date(Math.ceil((Date.now() + closeInMinutes * 60_000) / 60_000) * 60_000);
  await page.getByLabel(field.examName).first().fill(s.label);
  await page.getByLabel(field.examStart).first().fill(localInput(new Date(close.getTime() + startAfterClose * 60_000)));
  if (plan.lengthMinutes !== undefined) await page.getByLabel(field.length).first().fill(String(plan.lengthMinutes));
  await unfold(page, fold.advanced);
  await page.getByLabel(field.questionsClose).first().fill(localInput(close));
  await continueButton(s).click();
  await s.actor.seeHeading('Add the topics');
  await page.getByRole('button', { name: 'Add 2 topics with 2 questions' }).click();
  await continueButton(s).click();
  await s.actor.seeHeading('Choose the centres');
  await tick(s, centres, 0);
  await continueButton(s).click();
  await s.actor.seeHeading('Choose the neutral parties');
  await tick(s, neutrals, 0);
  await continueButton(s).click();
  await s.actor.seeHeading(text.reviewHeading, 60_000);
  const offered = page.getByText(/the latest verified release|your choice, verified/).first();
  await offered.waitFor({ timeout: 90_000 });
  const version = await offered.innerText();
  s.notes.release = version;
  if (plan.release && s.world.kind === 'live' && !version.startsWith(`${plan.release},`)) throw new Error(`the page offers "${version}", not ${plan.release}. Nothing was published.`);
  await publish(s);
  await waitForName(s);
  await confirmOnChain(s);
}

/** Waits for the machine to pass its check for this exam. The page asks again only when told to. */
export async function waitForMachine(s: Stage, minutes = 9) {
  const deadline = Date.now() + minutes * 60_000;
  const people = s.page.getByRole('heading', { name: text.peopleHeading });
  const again = s.page.getByRole('button', { name: button.checkAgain });
  while (Date.now() < deadline) {
    if (await people.isVisible()) return;
    if (await again.isVisible()) await again.click();
    await s.hold(15_000);
  }
  const words = await s.page.locator('.board-machine-text').innerText().catch(() => 'nothing');
  throw new Error(`the machine did not pass its check in ${String(minutes)} minutes. It said: ${words.replace(/\s+/g, ' ')}`);
}

/** Off camera: a new exam, and the sealed machine moved onto it and passing its check. */
export async function publishAndMoveMachine(s: Stage, plan: ExamPlan) {
  await publishForVideo(s, plan);
  const examId = s.notes.examId;
  if (!examId) throw new Error('the exam has no ID');
  console.log(`  published ${s.label}. Moving the machine to it.`);
  await s.world.startMachine(s.label, examId as `0x${string}`);
  await waitForMachine(s);
  console.log('  the machine passed its check.');
}

/** Becomes someone else in the bar across the top, which reloads the tab. */
export async function become(s: Stage, label: string) {
  await Promise.all([s.page.waitForEvent('load'), s.page.getByLabel('Acting as').selectOption({ label })]);
  await s.page.getByLabel('Acting as').waitFor();
}

/** Presses one of the demo panel's buttons and waits until everyone has had their turn. */
export async function pressPanel(s: Stage, name: string, timeout: number) {
  const panel = s.page.getByRole('region', { name: 'Everyone else' });
  const action = panel.getByRole('button', { name });
  await action.click({ timeout: 120_000 });
  await panel.locator('.ps-primary[data-status="busy"]').waitFor({ state: 'hidden', timeout });
  await action.waitFor({ state: 'hidden', timeout: 30_000 }).catch(async () => {
    throw new Error(`"${name}" did not finish for everyone: ${(await panel.innerText()).replace(/\s+/g, ' ').slice(0, 500)}`);
  });
}

/** Makes the setters' invites, and returns the link for the first one. */
export async function inviteSetters(s: Stage) {
  await s.page.getByRole('button', { name: 'Add invites for all 5 setters' }).click({ timeout: 60_000 });
  await s.page.getByRole('button', { name: 'Copy the link for Setter 1' }).click({ timeout: 30_000 });
  return s.page.evaluate(() => navigator.clipboard.readText());
}

/** The board's demo panel registers everyone else, then the board posts the list. Every check is the machine's own. */
export async function registerAllAndPostList(s: Stage) {
  await pressPanel(s, 'Register everyone else', 240_000);
  const post = s.page.getByRole('button', { name: button.postList });
  const posted = s.page.getByRole('heading', { name: /Nothing to do until|Setters are sending|The paper is being built/ });
  const problem = s.page.getByRole('alert').first();
  const before = s.world.sent();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await post.click({ timeout: 300_000 });
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (await posted.isVisible()) return;
      if ((await problem.isVisible()) && (await post.isVisible())) break;
      await s.hold(500);
    }
    if (s.world.sent() > before) break;
    await s.hold(4000);
  }
  throw new Error(`the list was not posted: ${(await s.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 500)}`);
}
