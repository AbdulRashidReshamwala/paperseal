import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createExamRegistry } from '@paperseal/chain';
import { decodeInviteFragment, firstRoundAtOrAfter, roundTimeSeconds, startupArgs, type Hex } from '@paperseal/protocol';
import { keccak256, toBytes } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';

import { startApp } from '../src/chain';
import { stopAll } from '../src/procs';
import { castSend } from '../live/cast';
import { deployed, rpcHost } from '../live/config';
import { liveCriteria, liveQuestion, questionsPerSetterPerTopic } from '../live/schedule';
import { castWalletScript } from './castWallet';
import { Actor, launchUiChrome, openActor, proxyGithubIfLimited, report, UI_DIR, writeReport } from './kit';
import { button, centre as centreText, composer, field, fold, hashOf, radio, stepStates, text, unfold } from './selectors';

/*
 * THE REAL RUN, through the screens. The deployed TEE (tee.abdulrashid.dev, a Confidential Space VM),
 * Sepolia and the real public bucket. Nothing is stubbed. The apps are the local Vite dev servers,
 * configured with the deployed addresses. Every person has one window, one tab and one virtual key.
 *
 *   board      in the UI. Its wallet is a page script whose signing goes to `cast send` with the Foundry keystore
 *              (the key and its password are never read), so each wallet signature is counted as such.
 *   setters    two windows, writing and sealing questions.
 *   neutrals   three key holder windows.
 *   centres    seven with a share and one without.
 *   verifier   the public page, looked at through the whole life of the exam.
 *
 * The TEE VM is started by this driver with deploy/gcp/run-tee.sh --reset and the arguments read back
 * from the chain, which is the same flow as `e2e/live/cli.mjs publish` printing them.
 *
 * Run with: UI_LIVE=1 pnpm --filter @paperseal/e2e ui:live   (LIVE_STORAGE_BUCKET is the default bucket).
 */

const RESUME = process.env.UI_LIVE_RESUME ?? '';
const RELEASE = process.env.UI_LIVE_RELEASE ?? 'v0.5.0';
const BOARD_ADDRESS = process.env.UI_LIVE_BOARD ?? '0xC3808daC38cA53a709F981Fb663814DbaaAB7420';
const MINUTES_TO_LOCK = Number(process.env.UI_LIVE_LOCK_MINUTES ?? 10);
const UNLOCK_AFTER_LOCK = 4; // minutes: Build, post it, centre downloads
const DELTA = 1; // minutes
const DURATION = 4; // minutes of exam: the shares and every centre open within this

// Videos: each window of the people worth watching is recorded, then cut by e2e/scripts/cut-videos.mjs.
const RECORD = process.env.UI_RECORD !== '0';
const RECORDED = new Set(['board', 'setter-1', 'neutral-1', 'centre-1', 'centre-8', 'verifier']);
const VIDEO_RAW = resolve(UI_DIR, 'video-raw');
const videoDirFor = (who: string) => (RECORD && RECORDED.has(who) ? resolve(VIDEO_RAW, who) : undefined);

const repo = resolve(import.meta.dirname, '../..');
const logFile = resolve(UI_DIR, 'live-run.log');
const results: { step: string; ok: boolean; detail: string; at: string }[] = [];
const notDrivenInUi: string[] = [];
const bugs: string[] = [];

const log = (message: string) => {
  const line = `${new Date().toISOString().slice(11, 19)}  ${message}`;
  console.log(line);
  try {
    mkdirSync(UI_DIR, { recursive: true });
    appendFileSync(logFile, `${line}\n`);
  } catch {
    // The log is a convenience.
  }
};
const record = (step: string, ok: boolean, detail = '') => {
  results.push({ step, ok, detail, at: new Date().toISOString() });
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `: ${detail}` : ''}`);
};
/** Runs one step. A failure is recorded and returned, so one person's trouble never stops the others. */
async function step(name: string, run: () => Promise<string | void>): Promise<boolean> {
  try {
    record(name, true, (await run()) ?? '');
    return true;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error));
    return false;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function untilUnix(unix: number): Promise<void> {
  while (Date.now() / 1000 < unix) await sleep(500);
}

let videosFinished = false;
/** Closes every recorded window, so its video is complete, and writes where each video is and when things happened in it. */
async function finishVideos(): Promise<void> {
  if (videosFinished || !RECORD) return;
  videosFinished = true;
  const plan: { who: string; file: string | null; startedAt: number; marks: { name: string; at: number }[] }[] = [];
  for (const [who, entry] of report.actors) {
    const actor = entry.actor;
    if (!actor.videoDir) continue;
    const video = actor.page.video();
    await actor.person.context.close().catch(() => undefined);
    plan.push({ who, file: video ? await video.path().catch(() => null) : null, startedAt: actor.videoStartedAt, marks: actor.marks });
  }
  mkdirSync(UI_DIR, { recursive: true });
  writeFileSync(resolve(UI_DIR, 'video-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
}

describe('real exam through the screens', () => {
  afterAll(async () => {
    await finishVideos();
    writeReport('live', { results, notDrivenInUi, bugs });
    writeFileSync(resolve(UI_DIR, 'live-results.json'), `${JSON.stringify({ results, notDrivenInUi, bugs }, null, 2)}\n`);
    await stopAll();
  });

  it('board, 2 setters, 3 neutral key holders and 8 centres, one real exam', async () => {
    mkdirSync(UI_DIR, { recursive: true });
    const registry = createExamRegistry({ address: deployed.registry, rpcUrl: deployed.rpcUrl });
    const boardOnChain = await registry.board();
    expect(boardOnChain.toLowerCase()).toBe(BOARD_ADDRESS.toLowerCase());

    const env = {
      VITE_RPC_URL: deployed.rpcUrl,
      VITE_REGISTRY_ADDRESS: deployed.registry,
      VITE_TEE_URL: deployed.teeUrl,
      VITE_STORAGE_URL: deployed.storageUrl,
      VITE_TEE_STORAGE_BUCKET: deployed.storageBucket,
    };
    const verifierApp = await startApp('apps/verifier', { ...env }, { host: 'localhost' });
    const web = await startApp('apps/web', { ...env, VITE_VERIFIER_URL: verifierApp.url }, { host: 'localhost' });
    if (RECORD) rmSync(VIDEO_RAW, { recursive: true, force: true });
    const browser = await launchUiChrome();
    for (const base of [web.url, verifierApp.url]) {
      const warm = await browser.newPage();
      await warm.goto(base);
      await warm.waitForLoadState('networkidle');
      if (base === web.url) for (const a of ['board', 'setter', 'keyholder', 'centre', 'join']) await warm.goto(`${base}/#/${a}`).then(() => warm.waitForLoadState('networkidle'));
      await warm.close();
    }

    // ---------------------------------------------------------------- schedule (this run only)
    const now = Math.floor(Date.now() / 1000);
    const lockAt = Math.ceil((now + MINUTES_TO_LOCK * 60) / 60) * 60;
    const examStart = lockAt + (UNLOCK_AFTER_LOCK + DELTA) * 60;
    const endAt = examStart + DURATION * 60;
    const name = `Paper Seal UI live ${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
    log(`exam "${name}": lock ${localInput(lockAt)}, T ${localInput(examStart)}, delta ${String(DELTA)} min, end ${localInput(endAt)}`);

    const board = await openActor(browser, 'board', null, {
      role: 'board',
      ...(videoDirFor('board') ? { videoDir: videoDirFor('board') as string } : {}),
      wallet: castWalletScript(deployed.rpcUrl, BOARD_ADDRESS),
      bindings: { __castSend: (data: Hex, to: Hex) => castSend(data, to) },
    });
    const bp = board.page;
    const githubProxied = await proxyGithubIfLimited(board.person.context);
    if (githubProxied) notes.push('STUB (proxy): the board\'s calls to api.github.com were answered with real GitHub data fetched through the gh CLI, because the unauthenticated quota was used up.');

    // ---------------------------------------------------------------- board: create, version, review, publish
    const publishedOk = RESUME || (await step('board creates, reviews and publishes the exam (UI, wallet signature via cast)', () => board.flow('create, review, publish', async () => {
      board.paced = true;
      board.mark('create-start');
      await bp.goto(`${web.url}/#/board/blueprint`);
      await board.seeHeading(text.createHeading);
      await board.say('Exam board: create the exam');
      await board.type(bp.getByLabel(field.examName).first(), name);
      board.paced = false;
      await board.type(bp.getByLabel(field.examStart).first(), localInput(examStart));
      await board.type(bp.getByLabel(field.length).first(), String(DURATION));
      await board.type(bp.getByLabel(field.releaseMinutes).first(), String(DELTA));
      await board.type(bp.getByLabel(field.topicName(1)).first(), liveCriteria.topics[0]?.name ?? '');
      await board.type(bp.getByLabel(field.topicQuestions(1)).first(), String(liveCriteria.topics[0]?.questions));
      await bp.getByRole('button', { name: button.addTopic }).click();
      await board.type(bp.getByLabel(field.topicName(2)).first(), liveCriteria.topics[1]?.name ?? '');
      await board.type(bp.getByLabel(field.topicQuestions(2)).first(), String(liveCriteria.topics[1]?.questions));
      await unfold(bp, fold.advanced);
      await board.type(bp.getByLabel(field.maxPercent).first(), String(liveCriteria.maxSetterPercent));
      await board.type(bp.getByLabel(field.bankMultiple).first(), String(liveCriteria.minBankMultiple));
      await board.type(bp.getByLabel(field.questionsClose).first(), localInput(lockAt));
      await board.type(bp.getByLabel(field.rpcHost).first(), rpcHost);
      await board.shot('live-01-create');
      await board.beat(2500);
      await bp.getByRole('button', { name: button.continue }).click();
      await board.seeHeading(text.reviewHeading, 60_000);
      await board.say('Exam board: review, then publish');
      // The version is a row in the review. The newest checked one is already chosen.
      const other = bp.locator('summary', { hasText: fold.differentVersion });
      await other.waitFor({ timeout: 60_000 }).catch(async () => {
        await board.shot('live-02-version-stuck');
        throw new Error(`version list did not load. Page: ${(await board.text()).slice(0, 500)}`);
      });
      await other.click();
      await bp.locator('details', { has: other }).locator('select').selectOption({ label: RELEASE });
      await bp.getByText(new RegExp(`^${RELEASE.replace(/\./g, '\\.')}, the version you chose`)).first().waitFor({ timeout: 90_000 });
      await board.shot('live-03-review');
      await board.beat(3000);
      await bp.getByRole('button', { name: button.publish }).click();
      await board.seeHeading(text.peopleHeading, 180_000).catch(async () => {
        await board.shot('live-04-publish-stuck');
        throw new Error(`publish did not finish. Page: ${(await board.text()).slice(0, 600)}`);
      });
      await board.see(text.publishedStamp, 10_000);
      await board.say('Exam board: published, now invite people');
      await board.shot('live-04-published');
      await board.beat(2500);
      board.mark('published');
    })));
    // Nothing after this can work without a published exam, so this is the one place the run stops.
    if (!publishedOk) throw new Error('the exam was not published through the UI, so there is nothing more to run. See live-results.json.');

    // ---------------------------------------------------------------- start the TEE from what the chain holds
    // The exam ID is the hash of the name, the same rule the app uses, so it needs no reading from the page.
    const examId = keccak256(toBytes(RESUME || name)) as Hex;
    const exam = await registry.getExam(examId);
    if (!exam) throw new Error('the exam is not on the chain');
    const settings = {
      examId,
      examStart: Number(exam.settings.examStart),
      delta: Number(exam.settings.delta),
      lockRound: exam.settings.lockRound.toString(),
      unlockRound: exam.settings.unlockRound.toString(),
      endRound: exam.settings.endRound.toString(),
      criteriaHash: exam.settings.criteriaHash,
      rpcHost: exam.settings.rpcHost,
      registry: deployed.registry,
      chainId: 11155111,
    };
    const lockUnix = roundTimeSeconds(Number(exam.settings.lockRound));
    const unlockUnix = roundTimeSeconds(Number(exam.settings.unlockRound));
    const endUnix = roundTimeSeconds(Number(exam.settings.endRound));
    log(`rounds: lock ${new Date(lockUnix * 1000).toISOString()}, unlock ${new Date(unlockUnix * 1000).toISOString()}, end ${new Date(endUnix * 1000).toISOString()}`);
    expect(firstRoundAtOrAfter(lockUnix)).toBe(Number(exam.settings.lockRound));
    const args = [...startupArgs(settings), `--image-digest=sha256:${exam.imageDigest.slice(2)}`];
    const teeLog = resolve(UI_DIR, 'live-tee-deploy.log');
    const deploy = RESUME ? null : spawn(resolve(repo, 'deploy/gcp/run-tee.sh'), ['--reset', ...args], {
      env: { ...process.env, PROJECT_ID: 'paperseal-demo', REGION: 'asia-south2', ZONE: 'asia-south2-a', BUCKET: deployed.storageBucket },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let deployOut = '';
    if (deploy) {
      deploy.stdout.on('data', (c: Buffer) => (deployOut += c.toString()));
      deploy.stderr.on('data', (c: Buffer) => (deployOut += c.toString()));
      const deployed$ = new Promise<number>((r) => deploy.on('close', (code) => r(code ?? 1)));
      void deployed$.then((code) => {
        writeFileSync(teeLog, deployOut);
        log(`run-tee.sh finished with code ${String(code)}`);
      });
    }
    if (RESUME) {
      await bp.goto(`${web.url}/#/board?exam=${examId}`);
      await bp.reload();
    }

    // ---------------------------------------------------------------- the board makes invites while the VM boots
    const roster = [
      ...[1, 2].map((n) => ({ who: `setter-${String(n)}`, role: 'setter', label: `setter ${String(n)}` })),
      ...[1, 2, 3].map((n) => ({ who: `neutral-${String(n)}`, role: 'keyholder', label: `Neutral ${String(n)}` })),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ who: `centre-${String(n)}`, role: 'centre', label: `Centre ${String(n)}` })),
    ];
    const links: Record<string, string> = {};
    await step('board makes 13 invites and copies each link (UI)', () =>
      board.flow('invites: add and copy 13 links', async () => {
        await board.seeHeading(text.peopleHeading, 60_000);
        for (const person of roster) {
          await bp.getByLabel(field.inviteRole).selectOption(person.role);
          await board.type(bp.getByLabel(field.inviteName), person.label);
          await bp.getByRole('button', { name: button.addInvite }).click();
          await bp.getByRole('button', { name: new RegExp(`^Copy the link for ${person.label} \\(`) }).click();
          links[person.who] = await bp.evaluate(() => navigator.clipboard.readText());
        }
        await board.shot('live-05-invites-waiting');
        if (Object.keys(links).length !== 13) throw new Error(`only ${String(Object.keys(links).length)} links copied`);
        return '13 links';
      }),
    );

    // ---------------------------------------------------------------- wait until the TEE is up for this exam
    await step('the VM restarted and the TEE answers at Onboard', async () => {
      const deadline = Date.now() + 8 * 60_000;
      let seenDown = false;
      while (Date.now() < deadline) {
        const status = await fetch(`${deployed.teeUrl}/v1/status`).then((r) => (r.ok ? (r.json() as Promise<{ stage: string }>) : null), () => null);
        if (!status) seenDown = true;
        if (status && ['onboard', 'publish'].includes(status.stage) && (seenDown || Date.now() > deadline - 7 * 60_000)) return `stage ${status.stage}`;
        await sleep(3000);
      }
      throw new Error('the TEE did not come back');
    });

    // ---------------------------------------------------------------- everyone opens their link and registers
    const people: Record<string, Actor> = {};
    const open = async (who: string, role: string) => {
      const videoDir = videoDirFor(who);
      people[who] = await openActor(browser, who, null, { role, ...(videoDir ? { videoDir } : {}) });
    };
    for (const p of roster) await open(p.who, p.role === 'keyholder' ? 'key holder' : p.role);
    await open('verifier', 'verifier');
    const verifier = people.verifier;
    if (!verifier) throw new Error('no verifier window');

    await Promise.all(
      roster.map((p) =>
        step(`${p.who} registers from their link`, async () => {
          const a = people[p.who];
          if (!a) throw new Error('no window');
          await a.flow('register', async () => {
            const link = links[p.who] ?? '';
            const invite = decodeInviteFragment(new URL(link).hash);
            expect(invite.examId).toBe(examId);
            await a.page.goto(link.replace(/^https?:\/\/[^#]+/, `${web.url}/`));
            await a.page.getByRole('button', { name: button.register }).click({ timeout: 60_000 });
            await a.see(/security key is registered|You are registered|Nothing to do yet/, 60_000);
          });
          if (p.who === 'setter-1' || p.who === 'centre-1' || p.who === 'neutral-1') await a.shot('live-10-registered');
        }),
      ),
    );

    // ---------------------------------------------------------------- the board posts the list through the UI
    const listPosted = await step('board posts the approved list (UI, wallet signature via cast)', async () => {
      await board.flow('post the list', async () => {
        await bp.reload();
        await board.seeHeading(text.peopleHeading, 60_000);
        await board.see('Registered', 60_000);
        await board.shot('live-11-people-registered');
        // Seven centres hold part of the key and the eighth gets the key at unlock. The screen's default is not relied on.
        for (let n = 1; n <= 8; n++) {
          const pick = bp.getByLabel(`Role for Centre ${String(n)}`);
          await pick.waitFor({ timeout: 60_000 });
          await pick.selectOption({ label: n === 8 ? 'Centre getting the key at unlock' : 'Centre holding part of the key' });
        }
        await board.shot('live-11b-people-places');
        board.mark('post-list-start');
        await board.say('Exam board: post the list of people');
        await board.beat(2500);
        const post = bp.getByRole('button', { name: button.postList });
        await post.click({ timeout: 120_000 });
        // After the post the board has nothing to do until the questions close.
        await board.seeHeading(/Nothing to do until|The paper is being built/, 240_000);
        await board.shot('live-12-list-posted');
        await board.beat(2500);
        board.mark('list-posted');
      });
    });
    if (!listPosted) {
      bugs.push('The board could not post the list through the UI: see live-results.json.');
    }

    // ---------------------------------------------------------------- setters write and seal
    const setterTasks = ['setter-1', 'setter-2'].map((who, index) =>
      step(`${who} writes and seals ${String(questionsPerSetterPerTopic * 2)} questions`, async () => {
        const a = people[who];
        if (!a) throw new Error('no window');
        const page = a.page;
        let sealed = 0;
        try {
          await a.flow('wait for the composer', async () => {
            await page.goto(`${web.url}/#/setter`);
            await a.seeHeading(text.writeHeading, 10 * 60_000);
            a.mark('composer');
            await a.say('Setter: the page is ready for questions');
            await a.beat(2500);
          });
          if (index === 0) {
            await a.flow('option validation (nothing sealed)', async () => {
              a.paced = true;
              await a.say('Setter: a multiple choice question needs its options, each different');
              await page.getByRole('radio', { name: radio.multipleChoice }).check();
              await a.shot('live-20-composer-choice');
              await a.beat();
              await a.type(page.getByLabel(composer.question), 'A draft with a repeated option');
              await a.type(page.getByRole('textbox', { name: field.option('A'), exact: true }), 'Same');
              await a.type(page.getByRole('textbox', { name: field.option('B'), exact: true }), 'Same');
              await page.getByRole('textbox', { name: field.option('A'), exact: true }).focus();
              await page.locator(composer.optionError).first().waitFor({ timeout: 10_000 });
              const sealDisabled = await page.getByRole('button', { name: button.seal }).isDisabled();
              if (!sealDisabled) throw new Error('Seal stays open with a repeated option');
              await a.shot('live-21-composer-repeated-option');
              await a.beat(2500);
              await a.type(page.getByRole('textbox', { name: field.option('B'), exact: true }), '');
              await page.getByRole('textbox', { name: field.option('A'), exact: true }).focus();
              await a.shot('live-22-composer-blank-option');
              a.paced = false;
              for (const letter of ['C', 'D', 'E', 'F']) {
                await page.getByRole('button', { name: button.addOption, exact: true }).click();
                await a.type(page.getByRole('textbox', { name: field.option(letter), exact: true }), `Option ${letter}`);
              }
              if (await page.getByRole('button', { name: button.addOption, exact: true }).count()) throw new Error('more than six options are offered');
              await a.shot('live-23-composer-six-options');
              await page.getByRole('button', { name: button.removeOption('F'), exact: true }).click();
              await page.getByRole('radio', { name: radio.written }).check();
              await a.type(page.getByLabel(composer.question), '');
            });
          }
          await a.flow('write and seal', async () => {
            for (const topic of liveCriteria.topics) {
              for (let k = 1; k <= questionsPerSetterPerTopic; k++) {
                const q = liveQuestion(topic.name, index * questionsPerSetterPerTopic + k);
                // The first setter's first written and first multiple choice question are paced for the video.
                a.paced = index === 0 && topic === liveCriteria.topics[0] && (k === 1 || k === 3);
                await page.getByRole('radio', { name: composer.topicRadio(topic.name) }).check();
                const wantChoice = Array.isArray(q.options);
                await a.say(wantChoice ? 'Setter: a multiple choice question with lettered options' : 'Setter: a written question');
                await page.getByRole('radio', { name: wantChoice ? radio.multipleChoice : radio.written }).check();
                await a.type(page.getByLabel(composer.question), q.text);
                if (q.options) {
                  for (const [i, option] of q.options.entries()) {
                    const letter = String.fromCharCode(65 + i);
                    if (i >= 2) await page.getByRole('button', { name: button.addOption, exact: true }).click();
                    await a.type(page.getByRole('textbox', { name: field.option(letter), exact: true }), option);
                  }
                }
                if (a.paced) await a.beat(1500);
                await a.say('Setter: seal the question. It leaves this page and a receipt is kept');
                await page.getByRole('button', { name: button.seal }).click();
                sealed += 1;
                await page.getByText(composer.sealedSoFar(sealed)).first().waitFor({ timeout: 90_000 });
                if (sealed === 1) await a.shot('live-24-first-receipt');
                if (a.paced) await a.beat(3500);
                if (index === 0 && topic === liveCriteria.topics[0] && k === 3) a.mark('sealed-choice');
              }
            }
            a.paced = false;
            await a.shot('live-25-all-sealed');
            a.mark('all-sealed');
          });
        } catch (error) {
          await a.shot(`live-2x-${who}-failed`).catch(() => undefined);
          throw new Error(`${String(sealed)} sealed before it stopped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }
        return `${String(sealed)} sealed`;
      }),
    );
    await Promise.all(setterTasks);

    // ---------------------------------------------------------------- board: wait, then post the Build
    await step('board posts the paper’s record (UI, wallet signature via cast)', async () => {
      await board.flow('post the Build', async () => {
        await board.seeHeading(/Nothing to do until|The paper is being built/, 60_000).catch(() => undefined);
        await board.shot('live-30-wait');
        await board.seeHeading(text.recordBuildHeading, Math.max(60_000, (lockUnix + 300 - Date.now() / 1000) * 1000));
        board.mark('paper-ready');
        await board.say('Exam board: the paper is ready, post its record');
        await board.shot('live-31-record-build');
        await board.beat(3000);
        await bp.getByRole('button', { name: button.postBuild }).click();
        await board.seeHeading(/Sealed\. Nothing to do until|Key holders are releasing/, 240_000);
        await board.shot('live-32-status');
        await board.say('Exam board: sealed, nothing more to do until unlock');
        await board.beat(3000);
        board.mark('build-posted');
      });
    });

    // ---------------------------------------------------------------- verifier before unlock
    await step('verifier, live exam before unlock', async () => {
      await verifier.flow('before unlock', async () => {
        verifier.mark('before-unlock');
        await verifier.page.goto(`${verifierApp.url}/#/exam/${examId}`);
        await verifier.say('Public verifier: the exam so far');
        await verifier.page.locator('li[data-state]').first().waitFor({ timeout: 60_000 });
        await sleep(20_000);
        const states = await stepStates(verifier.page);
        await verifier.shot('live-40-verifier-before-unlock');
        notes.push(`verifier before unlock: ${states.map((s) => `${s.label}=${s.state}`).join(' | ')}`);
      });
    });

    // ---------------------------------------------------------------- everyone with a task at unlock gets to their page first
    const holders = ['neutral-1', 'centre-1', 'neutral-2', 'centre-2', 'neutral-3', 'centre-3', 'centre-4', 'centre-5', 'centre-6', 'centre-7'];
    const allCentres = ['centre-1', 'centre-2', 'centre-3', 'centre-4', 'centre-5', 'centre-6', 'centre-7', 'centre-8'];
    const onTheirPage = new Set<string>();
    await Promise.all(
      [...holders, 'centre-8'].map((who) =>
        step(`${who} is on their page before unlock`, async () => {
          const a = people[who];
          if (!a) throw new Error('no window');
          await a.page.goto(`${web.url}/#/${who.startsWith('neutral') ? 'keyholder' : 'centre'}`);
          await a.page.waitForLoadState('networkidle').catch(() => undefined);
          a.mark('waiting');
          await a.say(who.startsWith('neutral') ? 'Key holder: waiting for the unlock time' : 'Centre: waiting for the unlock time');
          if (who === 'centre-8') await a.shot('live-49-centre-waiting');
          onTheirPage.add(who);
        }),
      ),
    );

    // ---------------------------------------------------------------- unlock window: key holders release, centres open
    await untilUnix(unlockUnix + 2);
    await Promise.all(
      holders.map((who, order) =>
        step(`${who} releases their part of the key with one touch`, async () => {
          const a = people[who];
          if (!a) throw new Error('no window');
          if (!onTheirPage.has(who)) await a.page.goto(`${web.url}/#/${who.startsWith('neutral') ? 'keyholder' : 'centre'}`);
          await a.flow('release', async () => {
            // One after another, so the count on the waiting pages visibly goes up.
            await sleep(order * 2500);
            const releaseBtn = a.page.getByRole('button', { name: button.release });
            await releaseBtn.waitFor({ timeout: 120_000 });
            a.mark('release-visible');
            await a.say(who.startsWith('neutral') ? 'Key holder: release your part of the key' : 'Centre holding part of the key: release it');
            if (who === 'neutral-1' || who === 'centre-1') {
              await a.shot('live-50-release');
              await a.beat(3000);
            }
            await releaseBtn.click();
            a.mark('release-sent');
            await a.see(/Done\. You can close this tab|parts of the key released|Waiting for key holders|Open the paper/, 120_000);
            if (who === 'neutral-1') await a.shot('live-51-keyholder-done');
          });
        }),
      ),
    );
    await step('neutral-1 watches the count of released parts go up to eight', async () => {
      const a = people['neutral-1'];
      if (!a) throw new Error('no window');
      await a.say('Key holder: done. The count shows how many parts have been released');
      await a.page.getByText(/^(8|9|10) of 8 parts of the key released$/).waitFor({ timeout: 120_000 }).catch(async () => {
        throw new Error(`the count never read 8 of 8. Page: ${(await a.text()).slice(0, 300)}`);
      });
      await a.beat(4000);
      a.mark('count-8');
    });
    await Promise.all(
      ['neutral-2', 'neutral-3'].map((who) =>
        step(`${who} sees Done`, async () => {
          const a = people[who];
          if (!a) throw new Error('no window');
          await a.seeHeading(text.keyHolderDone, 60_000);
        }),
      ),
    );

    await Promise.all(
      allCentres.map((who) =>
        step(`${who} opens the paper with one touch`, async () => {
          const a = people[who];
          if (!a) throw new Error('no window');
          await a.flow('open the paper', async () => {
            if (who === 'centre-8') {
              await a.seeHeading(/Waiting for key holders|Open the paper/, 120_000);
              await a.shot('live-52-centre-without-share-waiting');
              a.mark('holders-waiting');
              await a.say('Centre: waiting while key holders release their parts. The count goes up');
              await a.page.getByText(/^(8|9|10) of 8 parts of the key released$/).waitFor({ timeout: 120_000 }).catch(() => undefined);
              await a.beat(3000);
            }
            const openBtn = a.page.getByRole('button', { name: centreText.openPaper });
            await openBtn.waitFor({ timeout: 4 * 60_000 });
            a.mark('open-visible');
            await a.say('Centre: open the paper with one touch of the security key');
            await a.beat(3000);
            await openBtn.click();
            await a.seeHeading(centreText.paperOpenHeading, 120_000);
            a.mark('paper-open');
            await a.say('Centre: the paper is open, with lettered options');
            if (who === 'centre-1' || who === 'centre-8') {
              await a.shot(`live-53-paper-open-${who}`);
              const options = await a.page.locator('ol[type="A"] li').count();
              record(`${who}: the paper shows lettered options`, options > 0, `${String(options)} option lines`);
              await a.page.locator('ol[type="A"]').first().scrollIntoViewIfNeeded().catch(() => undefined);
              await a.beat(5000);
              const log = a.page.locator('summary', { hasText: 'Unlock log' });
              record(`${who}: the unlock log is on the page`, (await log.count()) > 0);
              await a.page.evaluate(() => window.scrollTo(0, 0));
              a.mark('paper-shown');
            }
          });
        }),
      ),
    );

    // ---------------------------------------------------------------- the centre hands out the paper (simulated delivery)
    await Promise.all(
      ['centre-1', 'centre-8'].map((who) =>
        step(`${who} hands out the paper (demo delivery, nothing sent)`, async () => {
          const a = people[who];
          if (!a) throw new Error('no window');
          await a.flow('hand out', async () => {
            a.paced = true;
            a.mark('handout-start');
            await a.page.getByRole('button', { name: centreText.handOut }).click();
            await a.seeHeading(centreText.handOutHeading, 15_000);
            await a.say('Centre: hand out the paper. This is a demo, nothing is sent to any room');
            await a.see(centreText.demoLabel, 5_000);
            await a.shot(`live-54-handout-${who}`);
            await a.beat(3000);
            await a.type(a.page.getByLabel(centreText.copiesFor('Room 1')), '35');
            await a.beat(1000);
            await a.page.getByRole('button', { name: centreText.sendToRooms }).click();
            await a.page.getByText(centreText.sentInDemo).nth(2).waitFor({ timeout: 30_000 });
            await a.shot(`live-55-handed-out-${who}`);
            const body = await a.text();
            if (/delivered|received|arrived/i.test(body)) throw new Error('the hand out page claims a real delivery');
            await a.beat(4000);
            a.paced = false;
            a.mark('handout-end');
          });
        }),
      ),
    );

    // ---------------------------------------------------------------- after the end: the public proof
    await untilUnix(endUnix + 45);
    await step('verifier, finished exam with the full proof', async () => {
      await verifier.flow('after the end', async () => {
        verifier.mark('after-end');
        await verifier.page.reload();
        await verifier.say('Public verifier: the finished exam');
        await verifier.page.locator('li[data-state]').first().waitFor({ timeout: 60_000 });
        await sleep(40_000);
        const states = await stepStates(verifier.page);
        await verifier.shot('live-60-verifier-finished');
        notes.push(`verifier finished: ${states.map((s) => `${s.label}=${s.state}`).join(' | ')}`);
        if (states.some((s) => s.state === 'failed')) throw new Error(`a step failed: ${states.map((s) => `${s.label}=${s.state}`).join(', ')}`);
        verifier.mark('verifier-shown');
      });
    });
    await step('setter closed screen shows the receipts check', async () => {
      const a = people['setter-1'];
      if (!a) throw new Error('no window');
      await a.page.reload();
      await a.seeHeading(/Your questions are sealed/, 60_000);
      await a.shot('live-61-setter-closed');
      await a.see(/Your receipts match the paper that was built/, 60_000);
    });
    // Late registration offer: a finished exam offers none.
    await step('no registration is offered after the exam ends', async () => {
      const a = people['centre-8'];
      if (!a) throw new Error('no window');
      const late = await openActor(browser, 'late-centre', null, { role: 'centre' });
      await late.page.goto(links['centre-8']?.replace(/^https?:\/\/[^#]+/, `${web.url}/`) ?? '');
      await late.seeHeading(text.endedHeading, 60_000);
      if (await late.page.getByRole('button', { name: button.register }).count()) throw new Error('registration offered after the end');
      await late.shot('live-62-ended');
    });

    notDrivenInUi.push(
      'The board wallet signatures (createExam, postApprovedList, postBuild) are produced by `cast send` with the Foundry keystore, behind the injected wallet. The buttons were clicked in the UI.',
      'The TEE VM start (run-tee.sh --reset) is run by this driver, not by a screen.',
    );
    await finishVideos();
    await browser.close();
    await verifierApp.stop();
    await web.stop();
    const failed = results.filter((r) => !r.ok);
    writeFileSync(resolve(UI_DIR, 'live-notes.txt'), notes.join('\n'));
    expect(failed.map((f) => `${f.step}: ${f.detail}`)).toEqual([]);
  });
});

const notes: string[] = [];
void hashOf;
void logFile;
