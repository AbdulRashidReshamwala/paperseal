import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { Actor, launchUiChrome, openActor, proxyGithubIfLimited, UI_DIR, writeReport } from './kit';
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

describe('real exam through the screens', () => {
  afterAll(async () => {
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
      wallet: castWalletScript(deployed.rpcUrl, BOARD_ADDRESS),
      bindings: { __castSend: (data: Hex, to: Hex) => castSend(data, to) },
    });
    const bp = board.page;
    const githubProxied = await proxyGithubIfLimited(board.person.context);
    if (githubProxied) notes.push('STUB (proxy): the board\'s calls to api.github.com were answered with real GitHub data fetched through the gh CLI, because the unauthenticated quota was used up.');

    // ---------------------------------------------------------------- board: create, version, review, publish
    if (!RESUME) await board.flow('create, choose version, publish', async () => {
      await bp.goto(`${web.url}/#/board/blueprint`);
      await board.seeHeading(text.createHeading);
      await board.type(bp.getByLabel(field.examName).first(), name);
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
      await bp.getByRole('button', { name: button.continue }).click();
      await board.seeHeading(text.versionHeading);
      const other = bp.locator('summary', { hasText: fold.differentVersion });
      await other.waitFor({ timeout: 60_000 }).catch(async () => {
        await board.shot('live-02-version-stuck');
        throw new Error(`version list did not load. Page: ${(await board.text()).slice(0, 500)}`);
      });
      await other.click();
      await bp.locator('details', { has: other }).locator('select').selectOption({ label: RELEASE });
      const use = bp.getByRole('button', { name: new RegExp(`^Use ${RELEASE}$`) });
      await use.waitFor({ timeout: 60_000 });
      await board.shot('live-02-version');
      await use.click();
      await board.seeHeading(text.reviewHeading);
      await board.shot('live-03-review');
      await bp.getByRole('button', { name: button.publish }).click();
      await bp
        .waitForFunction(() => /The exam is published|read-back differs/.test(document.body.innerText), undefined, { timeout: 180_000 })
        .catch(async () => {
          await board.shot('live-04-publish-stuck');
          throw new Error(`publish did not finish. Page: ${(await board.text()).slice(0, 500)}`);
        });
      await board.seeHeading(text.publishedHeading, 5_000).catch(async () => {
        throw new Error(`publish read-back: ${(await board.text()).slice(0, 600)}`);
      });
      await board.shot('live-04-published');
      await bp.getByRole('button', { name: button.bringPeople }).click();
    });
    if (!RESUME) record('board published the exam through the UI (wallet signature via cast)', true);

    // ---------------------------------------------------------------- start the TEE from what the chain holds
    const examId = RESUME
      ? (keccak256(toBytes(RESUME)) as Hex)
      : ((await bp.evaluate(() => localStorage.getItem('paperseal.examId'))) as Hex);
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
    await board.flow('invites: add and copy 13 links', async () => {
      await board.seeHeading(text.peopleHeading, 60_000);
      for (const person of roster) {
        await bp.getByLabel(field.inviteRole).selectOption(person.role);
        await board.type(bp.getByLabel(field.inviteName), person.label);
        await bp.getByRole('button', { name: button.addInvite }).click();
        await bp.getByRole('button', { name: new RegExp(`Copy the link for ${person.label} `) }).click();
        links[person.who] = await bp.evaluate(() => navigator.clipboard.readText());
      }
      await board.shot('live-05-invites-waiting');
    });
    record('board made 13 invites and copied each link', Object.keys(links).length === 13);

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
      people[who] = await openActor(browser, who, null, { role });
    };
    for (const p of roster) await open(p.who, p.role === 'keyholder' ? 'key holder' : p.role);
    people.verifier = await openActor(browser, 'verifier', null, { role: 'verifier' });
    const verifier = people.verifier;

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
            await a.see(/security key is registered|You are registered|Waiting for your exam board/, 60_000);
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
        // The eighth centre has no share. A default that already says so leaves this alone.
        const eighth = bp.getByLabel('Role for Centre 8');
        if (await eighth.count()) {
          const current = await eighth.inputValue();
          if (current !== '4') await eighth.selectOption({ label: 'Centre without a key' });
        }
        const post = bp.getByRole('button', { name: button.postList });
        await post.click({ timeout: 120_000 });
        await board.see(/The list is posted|posted/i, 180_000).catch(() => undefined);
        await board.shot('live-12-list-posted');
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
        await a.flow('wait for the composer', async () => {
          await page.goto(`${web.url}/#/setter`);
          await a.seeHeading(text.writeHeading, 10 * 60_000);
        });
        if (index === 0) {
          await a.flow('option validation (nothing sealed)', async () => {
            await page.getByRole('radio', { name: radio.multipleChoice }).check();
            await a.shot('live-20-composer-choice');
            await a.type(page.getByLabel(composer.question), 'A draft with a blank and a repeated option');
            await a.type(page.getByRole('textbox', { name: field.option('A') }), 'Same');
            await a.type(page.getByRole('textbox', { name: field.option('B') }), 'Same');
            await page.getByRole('textbox', { name: field.option('A') }).focus();
            await page.locator(composer.optionError).first().waitFor({ timeout: 10_000 });
            const sealDisabled = await page.getByRole('button', { name: button.seal }).isDisabled();
            if (!sealDisabled) throw new Error('Seal stays open with a repeated option');
            await a.shot('live-21-composer-repeated-option');
            await a.type(page.getByRole('textbox', { name: field.option('B') }), '');
            await page.getByRole('textbox', { name: field.option('A') }).focus();
            await a.shot('live-22-composer-blank-option');
            for (const letter of ['C', 'D', 'E', 'F']) {
              await page.getByRole('button', { name: button.addOption }).click();
              await a.type(page.getByRole('textbox', { name: field.option(letter) }), `Option ${letter}`);
            }
            if (await page.getByRole('button', { name: button.addOption }).count()) throw new Error('more than six options are offered');
            await a.shot('live-23-composer-six-options');
            await page.getByRole('button', { name: button.removeOption('F') }).click();
            await page.getByRole('radio', { name: radio.written }).check();
            await a.type(page.getByLabel(composer.question), '');
          });
        }
        let sealed = 0;
        await a.flow('write and seal', async () => {
          for (const topic of liveCriteria.topics) {
            for (let k = 1; k <= questionsPerSetterPerTopic; k++) {
              const q = liveQuestion(topic.name, index * questionsPerSetterPerTopic + k);
              await page.getByRole('radio', { name: composer.topicRadio(topic.name) }).check();
              const wantChoice = Array.isArray(q.options);
              await page.getByRole('radio', { name: wantChoice ? radio.multipleChoice : radio.written }).check();
              await a.type(page.getByLabel(composer.question), q.text);
              if (q.options) {
                for (const [i, option] of q.options.entries()) {
                  const letter = String.fromCharCode(65 + i);
                  if (i >= 2) await page.getByRole('button', { name: button.addOption }).click();
                  await a.type(page.getByRole('textbox', { name: field.option(letter) }), option);
                }
              }
              await page.getByRole('button', { name: button.seal }).click();
              sealed += 1;
              await page.getByText(composer.sealedSoFar(sealed)).first().waitFor({ timeout: 90_000 });
              if (sealed === 1) await a.shot('live-24-first-receipt');
            }
          }
          await a.shot('live-25-all-sealed');
        });
        return `${String(sealed)} sealed`;
      }),
    );
    await Promise.all(setterTasks);

    // ---------------------------------------------------------------- board: wait, then post the Build
    await step('board posts the sealed paper record (UI, wallet signature via cast)', async () => {
      await board.flow('post the Build', async () => {
        await board.seeHeading(/Nothing to do until|building the paper/, 60_000).catch(() => undefined);
        await board.shot('live-30-wait');
        await board.seeHeading(text.recordBuildHeading, Math.max(60_000, (lockUnix + 240 - Date.now() / 1000) * 1000));
        await board.shot('live-31-record-build');
        await bp.getByRole('button', { name: button.postBuild }).click();
        await board.seeHeading(/Sealed\. Nothing to do until|Key holders are releasing/, 180_000).catch(async () => {
          await board.see(/posted|Posted/, 60_000);
        });
        await board.shot('live-32-status');
      });
    });

    // ---------------------------------------------------------------- verifier before unlock
    await step('verifier, live exam before unlock', async () => {
      await verifier.flow('before unlock', async () => {
        await verifier.page.goto(`${verifierApp.url}/#/exam/${examId}`);
        await verifier.page.locator('li[data-state]').first().waitFor({ timeout: 60_000 });
        await sleep(20_000);
        const states = await stepStates(verifier.page);
        await verifier.shot('live-40-verifier-before-unlock');
        return void notes.push(`verifier before unlock: ${states.map((s) => `${s.label}=${s.state}`).join(' | ')}`);
      });
    });

    // ---------------------------------------------------------------- unlock window: key holders release, centres open
    await untilUnix(unlockUnix + 2);
    const holders = [...['neutral-1', 'neutral-2', 'neutral-3'], ...['centre-1', 'centre-2', 'centre-3', 'centre-4', 'centre-5', 'centre-6', 'centre-7']];
    await Promise.all([
      ...holders.map((who) =>
        step(`${who} releases their share with one touch`, async () => {
          const a = people[who];
          if (!a) throw new Error('no window');
          await a.flow('release', async () => {
            if (who.startsWith('neutral')) await a.page.goto(`${web.url}/#/keyholder`);
            else await a.page.goto(`${web.url}/#/centre`);
            const releaseBtn = a.page.getByRole('button', { name: button.release });
            await releaseBtn.click({ timeout: 120_000 });
            if (who === 'neutral-1' || who === 'centre-1') await a.shot('live-50-release-sent');
            await a.see(/Done|Released|Waiting for key holders|Open the paper|0? ?of 8 released|of 8 released/, 120_000);
          });
        }),
      ),
    ]);
    await Promise.all(
      ['neutral-1', 'neutral-2', 'neutral-3'].map((who) =>
        step(`${who} sees Done`, async () => {
          const a = people[who];
          if (!a) throw new Error('no window');
          await a.seeHeading(/Done/, 60_000);
          if (who === 'neutral-1') await a.shot('live-51-keyholder-done');
        }),
      ),
    );
    await Promise.all(
      ['centre-1', 'centre-2', 'centre-3', 'centre-4', 'centre-5', 'centre-6', 'centre-7', 'centre-8'].map((who) =>
        step(`${who} opens the paper with one touch`, async () => {
          const a = people[who];
          if (!a) throw new Error('no window');
          await a.flow('open the paper', async () => {
            if (who === 'centre-8') {
              await a.page.goto(`${web.url}/#/centre`);
              await a.seeHeading(/Waiting for key holders|Open the paper/, 120_000);
              await a.shot('live-52-centre-without-share-waiting');
            }
            const openBtn = a.page.getByRole('button', { name: centreText.openPaper });
            await openBtn.click({ timeout: 4 * 60_000 });
            await a.seeHeading(centreText.paperOpenHeading, 120_000);
            if (who === 'centre-1' || who === 'centre-8') {
              await a.shot(`live-53-paper-open-${who}`);
              const sheet = await a.page.locator('ol[type="A"], .paper-sheet, .centre-paper').count();
              const body = await a.text();
              const lettered = /\bA\b[\s\S]*\bB\b/.test(body) && (await a.page.locator('ol[type="A"]').count()) > 0;
              record(`${who}: the paper shows lettered options`, lettered, `${String(sheet)} paper blocks`);
              const log = await a.page.getByText(/unlock log|Unlock log|released/i).count();
              record(`${who}: the unlock log is on the page`, log > 0);
            }
          });
        }),
      ),
    );

    // ---------------------------------------------------------------- after the end: the public proof
    await untilUnix(endUnix + 45);
    await step('verifier, finished exam with the full proof', async () => {
      await verifier.flow('after the end', async () => {
        await verifier.page.reload();
        await verifier.page.locator('li[data-state]').first().waitFor({ timeout: 60_000 });
        await sleep(40_000);
        const states = await stepStates(verifier.page);
        await verifier.shot('live-60-verifier-finished');
        notes.push(`verifier finished: ${states.map((s) => `${s.label}=${s.state}`).join(' | ')}`);
        if (states.some((s) => s.state === 'failed')) throw new Error(`a step failed: ${states.map((s) => `${s.label}=${s.state}`).join(', ')}`);
      });
    });
    await step('setter closed screen shows the receipts check', async () => {
      const a = people['setter-1'];
      if (!a) throw new Error('no window');
      await a.page.reload();
      await a.seeHeading(/Your questions are sealed/, 60_000);
      await a.shot('live-61-setter-closed');
      await a.see(/went to the sealed system that built the paper/, 60_000);
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
