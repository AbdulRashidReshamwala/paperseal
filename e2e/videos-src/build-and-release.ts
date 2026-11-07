import { plantedKey } from '@paperseal/keys/demo';
import { examIdFromName, roundTimeSeconds, toHex } from '@paperseal/protocol';

import { partyParent } from '../live/roster';
import { button, text } from '../ui/selectors';
import { become, inviteSetters, pressPanel, publishAndMoveMachine, registerAllAndPostList } from './lib/board';
import { defineVideo, step, wait, type Stage } from './lib/script';
import { retry, sleep } from './lib/world';

/*
 * The board posts the paper's record, and at the unlock time a key holder releases its part. The whole
 * exam runs for real, in one tab that changes person with the demo bar: off camera the board publishes,
 * the machine moves to the exam, everyone registers, the list goes up and the question bank fills.
 * `pnpm video build-and-release` spends a little Sepolia ETH and one VM reset, and takes about 15 minutes.
 *
 * Timing, from the real steps. Publish, name, VM and list take about 3 minutes and the bank about 1, so
 * questions close 10 minutes out. The paper is built in under a minute, so unlock is 2 minutes after
 * that. The exam runs an hour, because a share is refused after the end and centres open the paper next.
 */

const RELEASE = 'v0.8.2';
const IMAGE_DIGEST = 'sha256:217b22fb23b7da6ef2bb1a7aa10faa7e1e859b448f9746014463f44a6f8a5c91';
const KEY_HOLDER = 'neutral-1';

interface TeeStatus {
  stage: string;
  examId?: string;
  questionCount: number;
  release: { released: string[]; required: number };
}

const teeStatus = (s: Stage) =>
  retry('reading the machine', async () => {
    const response = await fetch(`${s.world.teeUrl}/v1/status`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`the machine answered ${String(response.status)}`);
    return (await response.json()) as TeeStatus;
  }, 6, 1000);

/** The image digest in the machine's own attestation token. */
async function digestOfVm(s: Stage): Promise<string> {
  const response = await fetch(`${s.world.teeUrl}/v1/attestation`);
  if (!response.ok) throw new Error(`the machine answered ${String(response.status)}`);
  const { token } = (await response.json()) as { token: string };
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { submods?: { container?: { image_digest?: string } } };
  return claims.submods?.container?.image_digest ?? 'none in the token';
}

/** The chain's schedule for this exam, in milliseconds. */
async function times(s: Stage) {
  const exam = await s.world.registry.getExam(examIdFromName(s.label));
  if (!exam) throw new Error('the exam is not on the public record');
  return { lock: roundTimeSeconds(Number(exam.settings.lockRound)) * 1000, unlock: roundTimeSeconds(Number(exam.settings.unlockRound)) * 1000 };
}

/** Off camera: everything up to the paper being ready. It watches the machine, and stops if it fails. */
async function setup(s: Stage) {
  await publishAndMoveMachine(s, { closeInMinutes: s.world.kind === 'mock' ? 4 : 10, startAfterClose: 3, lengthMinutes: 60, release: RELEASE });
  if (s.world.kind === 'live') {
    const digest = await digestOfVm(s);
    s.notes.vmImageDigest = digest;
    if (digest !== IMAGE_DIGEST) throw new Error(`the VM runs ${digest}, not ${IMAGE_DIGEST} of ${RELEASE}. Stopping.`);
  }
  await inviteSetters(s);
  await registerAllAndPostList(s);
  console.log('  everyone is registered and the list is posted.');
  await s.page.getByRole('region', { name: 'Everyone else' }).getByRole('button', { name: 'Add questions for everyone else' }).waitFor({ timeout: 120_000 });
  await pressPanel(s, 'Add questions for everyone else', 180_000);
  const { lock } = await times(s);
  const filled = await teeStatus(s);
  console.log(`  the machine holds ${String(filled.questionCount)} questions, ${String(Math.round((lock - Date.now()) / 1000))}s before questions close.`);
  if (filled.questionCount < 8) throw new Error(`the machine holds ${String(filled.questionCount)} questions, and the bank needs 8`);
  s.notes.teeQuestionCount = String(filled.questionCount);
  await waitForPaper(s);
}

/** A read that fails is only a read: the deadline decides, so a network blip never ends a run. */
const stageOf = (s: Stage) => teeStatus(s).then(({ stage }) => stage, () => 'unread');

/** Watches the machine until the paper is built. A deadline stops the run instead of waiting for ever. */
async function waitForPaper(s: Stage) {
  const { lock } = await times(s);
  const deadline = lock + 5 * 60_000;
  for (;;) {
    const stage = await stageOf(s);
    if (stage === 'failed') throw new Error('the machine reports stage failed');
    if (['distribute', 'unlock', 'released'].includes(stage)) break;
    if (Date.now() > deadline) throw new Error(`the machine is at stage ${stage}, 5 minutes after questions closed. Stopping.`);
    await sleep(2000);
  }
  console.log(`  the paper is built, ${String(Math.round((Date.now() - lock) / 1000))}s after questions closed.`);
}

/** Picks up an exam a stopped run left with its questions in. Its board and machine are as they were. */
async function resume(s: Stage) {
  Object.assign(s.notes, { examId: examIdFromName(s.label), name: `${s.label}.${partyParent}`, registry: s.world.registryAddress, resumed: 'yes', vmImageDigest: await digestOfVm(s) });
  await s.page.goto(`${s.memo.web ?? ''}/#/board`);
  await s.page.getByRole('button', { name: button.connectWallet }).click({ timeout: 60_000 });
  await s.page.getByRole('heading', { name: 'Your exams' }).waitFor({ timeout: 60_000 });
  await waitForPaper(s);
}

/** Waits for the unlock round, watching the machine rather than the clock. */
async function untilUnlock(s: Stage) {
  const deadline = (await times(s)).unlock + 3 * 60_000;
  for (;;) {
    const stage = await stageOf(s);
    if (stage === 'failed') throw new Error('the machine reports stage failed');
    if (stage === 'unlock' || stage === 'released') return;
    if (Date.now() > deadline) throw new Error(`the machine is still at stage ${stage}, 3 minutes after the unlock time. Stopping.`);
    await s.hold(1000);
  }
}

/** Key Holder 1's page. In a browser that has not met this exam it learns the key from the list, with no touch. */
async function openKeyHolder(s: Stage) {
  await become(s, 'Key holder 1');
  await s.page.goto(`${s.memo.web ?? ''}/#/keyholder/${s.label}.${partyParent}`);
  const learn = s.page.getByRole('button', { name: button.registerByName });
  const page = s.page.getByRole('button', { name: button.release }).or(s.page.getByRole('heading', { name: text.keyHolderDone }));
  await learn.or(page).first().waitFor({ timeout: 60_000 });
  if (await learn.isVisible()) await learn.click();
}

const released = (s: Stage) => s.page.getByRole('heading', { name: text.keyHolderDone });

/** Fails the run unless the Build is on chain and the machine took this key holder's part and enough others. */
async function confirmReleased(s: Stage) {
  const examId = examIdFromName(s.label);
  const build = await retry('reading the Build', async () => {
    const found = await s.world.registry.getBuild(examId);
    if (!found) throw new Error('no Build on the public record');
    return found;
  });
  const status = await teeStatus(s);
  const key = toHex((await plantedKey(KEY_HOLDER)).publicKey).toLowerCase();
  if (!status.release.released.some((one) => one.toLowerCase() === key)) throw new Error('the machine does not list the key holder’s release');
  if (status.release.released.length < status.release.required) throw new Error(`the machine has ${String(status.release.released.length)} of ${String(status.release.required)} parts`);
  const log = await fetch(`${s.world.teeUrl}/v1/release/log`).then((r) => (r.ok ? (r.json() as Promise<{ entries: unknown[] }>) : null), () => null);
  Object.assign(s.notes, {
    buildPosted: 'yes',
    buildInstanceKey: String(build.instancePublicKey),
    teeStage: status.stage,
    teeReleased: `${String(status.release.released.length)} of ${String(status.release.required)}`,
    releaseLogEntries: log ? String(log.entries.length) : 'not served',
  });
}

export default defineVideo({
  title: 'The board posts the paper, and key holders release',
  speed: 1.5,
  prefix: 'class-12-physics',
  setup,
  resume,
  open: (s) => `/#/board/exam/${s.label}.${partyParent}`,
  ready: async (s) => {
    await s.actor.seeHeading(text.recordBuildHeading, 120_000);
    await s.page.getByRole('button', { name: button.postBuild }).and(s.page.locator(':enabled')).waitFor({ timeout: 60_000 });
    await s.hold(300);
  },
  steps: [
    step('The paper is ready. The board posts its record', async (s) => {
      await s.hold(900);
      await s.click(s.page.getByRole('button', { name: button.postBuild }));
    }, { spends: true }),
    wait('Waiting for Sepolia to confirm it', async (s) => {
      await s.actor.seeHeading(/Sealed\. Nothing to do until/, 120_000);
    }),
    step('Sealed. The paper’s record is public', (s) => s.hold(1400)),
    wait('Then the unlock time comes', untilUnlock, { keep: [1.2, 0.2] }),
    // Removed from the video: changing person reloads the tab.
    wait('Key Holder 1 opens its page', async (s) => {
      await openKeyHolder(s);
      await s.page.getByRole('button', { name: button.release }).waitFor({ timeout: 90_000 });
      await s.hold(400);
    }, { keep: [0, 0.1] }),
    step('Key Holder 1 releases its part of the key', async (s) => {
      await s.hold(900);
      await s.click(s.page.getByRole('button', { name: button.release }));
      await released(s).waitFor({ timeout: 120_000 });
    }),
    step('Released. Its part of the key is in', (s) => s.hold(1300)),
    // Removed from the video: the board's demo panel sends the parts of the other key holders.
    wait('The other key holders release theirs', async (s) => {
      await become(s, 'Exam board');
      await s.page.goto(`${s.memo.web ?? ''}/#/board/exam/${s.label}.${partyParent}`);
      await pressPanel(s, 'Release the rest', 180_000);
      await openKeyHolder(s);
      await s.page.getByText(/^(8|9|10) of 8 parts of the key released$/).waitFor({ timeout: 90_000 });
      await s.hold(300);
    }, { keep: [0, 0.1] }),
    step('Enough parts are released. Centres can open the paper', async (s) => {
      await s.page.mouse.move(1180, 300);
      await s.hold(1000);
      await s.endHere();
    }),
    // Off camera. This fails the run if the chain or the machine disagrees.
    wait('Checking the public record and the machine', confirmReleased),
  ],
});
