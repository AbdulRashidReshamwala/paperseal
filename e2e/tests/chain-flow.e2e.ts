import { afterAll, beforeAll, describe, it } from 'vitest';
import { keccak256, toBytes, type Hex } from 'viem';
import type { Browser, Page } from 'playwright-core';

import { cast, castSignature, publicClientFor, rpcCall, startApp, startChain, type Chain } from '../src/chain';
import { stopAll } from '../src/procs';
import { launchChrome, Recording } from '../src/recorder';
import { testWalletScript } from '../src/wallet';

/*
 * board-publish and verifier-checks share one anvil chain and one ExamRegistry, so the verifier
 * reads the exam the board just published through the real UI. They run in this order in one file.
 */

let chain: Chain;
let browser: Browser;
let web: { url: string; stop: () => Promise<void> };
let verifier: { url: string; stop: () => Promise<void> } | null = null;

const EXAM_NAME = 'paperseal-e2e-physics-final';
// The real release v0.1.0 of AbdulRashidReshamwala/paperseal on GitHub. The app fetches it live.
const TAG = 'v0.1.0';
const COMMIT = '0x00b6fd1d0e9862677e316f58f772668624d034c1';
const DIGEST = '0x83b4623539655ed0df9b640f3f2a7e55997ec5966fafb882fc3483b1e6172842';
const RPC_HOST = 'sepolia.example.org';
const examId = keccak256(toBytes(EXAM_NAME));
let published = false;

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000);

beforeAll(async () => {
  chain = await startChain();
  web = await startApp('apps/web', { VITE_RPC_URL: chain.rpcUrl, VITE_REGISTRY_ADDRESS: chain.registry });
  browser = await launchChrome();
  // Warm Vite's dependency optimiser with an unrecorded visit, so a mid-recording reload cannot happen.
  const warm = await browser.newPage();
  await warm.goto(`${web.url}/#/board/blueprint`);
  await warm.waitForLoadState('networkidle');
  await warm.close();
});

afterAll(async () => {
  await browser?.close();
  await verifier?.stop();
  await web?.stop();
  await chain?.stop();
  await stopAll();
});

const value = (page: Page, label: string) => page.getByLabel(label).first();
/** Opens a folded section. Evidence such as hashes lives there, out of the primary screen. */
const unfold = async (page: Page, summary: string) => {
  const fold = page.locator('summary', { hasText: summary }).first();
  if ((await fold.locator('xpath=..').getAttribute('open')) === null) await fold.click();
};
/** A `Hash` shows a shortened value, and carries the whole value in its title. */
const hashOf = async (page: Page, label: string) => (await page.getByRole('button', { name: `Copy ${label}: ` }).first().getAttribute('title')) ?? '';

describe('exam on a local anvil chain', () => {
  it('board-publish', async () => {
    const rec = new Recording('board-publish', {
      title: 'Board publishes an exam to ExamRegistry (anvil, chain 11155111)',
      subtitle: 'Test wallet on local chain, not MetaMask',
    });
    const page = await rec.open(browser, [testWalletScript(chain.rpcUrl)]);
    const client = publicClientFor(chain);
    try {
      await page.goto(`${web.url}/#/board/blueprint`);
      await rec.say('Real apps/web, the guided board flow. ExamRegistry deployed from contracts/out, board = anvil account 0');
      await page.getByRole('heading', { name: 'Create the exam' }).waitFor({ timeout: 15_000 });
      await rec.pause(2500);

      await rec.say('Step 1: the exam name, its time and its length');
      await rec.type(value(page, 'Exam name'), EXAM_NAME);
      await value(page, 'Date and time of the exam').fill(`${stamp(dayOffset(30))}T09:30`);
      await value(page, 'Length, in minutes').fill('180');
      await rec.say('Step 1: released to centres 30 minutes before');
      await value(page, 'Minutes before the exam to release the paper to centres').fill('30');
      await rec.say('Step 1: first topic, Mechanics, 5 questions');
      await rec.type(value(page, 'Topic 1 name'), 'Mechanics');
      await rec.type(value(page, 'Topic 1 questions'), '5');
      await rec.say('Step 1: adding a second topic, Optics, 3 questions');
      await page.getByRole('button', { name: 'Add topic' }).click();
      await rec.type(value(page, 'Topic 2 name'), 'Optics');
      await rec.type(value(page, 'Topic 2 questions'), '3');
      await rec.say('Step 1: Advanced holds the setter limits and the public record provider');
      await unfold(page, 'Advanced');
      await value(page, 'Most of a topic one setter can write, in percent').fill('20');
      await value(page, 'Question bank size, as a multiple of the questions used').fill('4');
      await value(page, 'Public record provider').fill(RPC_HOST);
      await rec.pause(2000);
      await rec.check('Create step works out the rest: 8 questions at a multiple of 4 and 20 percent need 32 questions from 5 setters', async () => {
        const note = (await page.locator('.board-note').first().innerText()).replace(/\s+/g, ' ');
        if (!note.includes('at least 32 questions from at least 5 setters')) throw new Error(note);
        if (!note.includes('Questions close')) throw new Error(`no closing time: ${note}`);
        return note;
      });

      await page.getByRole('button', { name: 'Continue' }).click();
      await rec.say('Step 2: the sealed machine version list is fetched live from GitHub releases');
      await page.getByRole('heading', { name: 'Choose what the sealed machine runs' }).waitFor({ timeout: 15_000 });
      const other = page.locator('summary', { hasText: 'Use a different version' });
      const versions = page.locator('details', { has: other }).locator('select');
      await other.waitFor({ timeout: 60_000 }).catch(() => undefined);
      const githubOk = await rec.check('The version list appeared from the live GitHub releases', async () => {
        await other.waitFor({ timeout: 5000 }).catch(async () => {
          const body = await rec.bodyText();
          const limited = /limiting requests/.test(body);
          throw new Error(limited ? 'GitHub rate-limited this run, so the versions could not be listed' : `no version list: ${body.slice(0, 200)}`);
        });
        await other.click();
        return `options: ${(await versions.locator('option').allTextContents()).join(', ')}`;
      });
      if (!githubOk) throw new Error('cannot publish without the live GitHub release list');
      await rec.say(`Step 2: choosing ${TAG}, an older version with a known commit and digest`);
      await versions.selectOption({ label: TAG });
      const useVersion = page.getByRole('button', { name: `Use ${TAG}` });
      await useVersion.waitFor({ timeout: 30_000 }).catch(() => undefined);
      await rec.pause(2500);
      await rec.check(`The app says the tag ${TAG} points at this commit, with the real commit and digest in the record`, async () => {
        await unfold(page, 'Exam record');
        const body = await rec.bodyText();
        if (!body.includes('The tag points at this commit')) throw new Error(/limiting requests/.test(body) ? 'GitHub rate-limited this run' : `no verified-tag message: ${body.slice(0, 300)}`);
        const [commit, digest] = [await hashOf(page, 'commit'), await hashOf(page, 'image digest')];
        if (commit.toLowerCase() !== COMMIT || digest.toLowerCase() !== DIGEST) throw new Error(`the record shows ${commit} and ${digest}`);
        return `${commit} / ${digest}`;
      });
      await useVersion.click();

      await rec.say('Step 3: one summary of everything, before anything is written');
      await page.getByRole('heading', { name: 'Review and publish' }).waitFor({ timeout: 15_000 });
      await rec.pause(2500);
      await rec.check('The review shows the topics, the bank and the version, and warns that it is final', async () => {
        const body = await rec.bodyText();
        for (const part of ['cannot be changed afterwards', 'Topic: Mechanics', 'Topic: Optics', 'At least 32 questions', TAG]) {
          if (!body.includes(part)) throw new Error(`no "${part}" on the review`);
        }
        return 'topics, bank and version shown';
      });
      await unfold(page, 'Exam record');
      await rec.pause(2000);
      await rec.check('The exam ID in the record equals keccak256 of the name, computed independently', async () => {
        const shown = await hashOf(page, 'exam ID');
        if (shown.toLowerCase() !== examId) throw new Error(`UI shows ${shown}, expected ${examId}`);
        return examId;
      });
      await rec.check('The record shows the rounds derived from the times', async () => {
        const body = await rec.bodyText();
        if (!/Unlock round\s*\d+/.test(body) || !/End round\s*\d+/.test(body)) throw new Error('no rounds in the record');
        return (body.match(/Unlock round\s*\d+/)?.[0] ?? '').replace(/\s+/g, ' ');
      });

      // Rejected case first: a wallet account that is not the board.
      await rec.say('Rejected case: test wallet switched to anvil account 1, which is not the board');
      await page.evaluate(() => {
        (window as unknown as { __testWalletIndex: number }).__testWalletIndex = 1;
      });
      const blockBefore = (await rpcCall(chain.rpcUrl, 'eth_blockNumber')) as string;
      await rec.say('Rejected case: Publish the exam with the wrong account');
      const publishButton = page.getByRole('button', { name: 'Publish the exam' });
      await publishButton.click();
      await page.getByText(/not the board address/i).first().waitFor({ timeout: 20_000 });
      await rec.pause(3500);
      await rec.check('Publishing as the wrong account is refused before anything is sent', async () => {
        const body = await rec.bodyText();
        if (!/not the board address/i.test(body)) throw new Error('no refusal message in page text');
        const blockAfter = (await rpcCall(chain.rpcUrl, 'eth_blockNumber')) as string;
        if (blockAfter !== blockBefore) throw new Error(`chain advanced from ${blockBefore} to ${blockAfter}`);
        const onChain = await client.readContract({ address: chain.registry, abi: chain.abi, functionName: 'getExam', args: [examId] });
        if ((onChain as { createdAt: bigint }).createdAt !== 0n) throw new Error('the exam exists on-chain');
        return `refused for ${chain.accounts[1] ?? ''}, anvil still at block ${blockAfter}, exam not on-chain`;
      });

      await rec.say('Test wallet switched back to anvil account 0, the board');
      await page.evaluate(() => {
        (window as unknown as { __testWalletIndex: number }).__testWalletIndex = 0;
      });
      await rec.pause(1500);

      await rec.say('Publish the exam. The app dry-runs, sends createExam, mines, then reads back');
      await publishButton.click();
      await page.getByRole('heading', { name: /The exam is published|the read-back differs/ }).waitFor({ timeout: 60_000 });
      await unfold(page, 'Exam record').catch(() => undefined);
      await rec.say('The receipt: each row compares what ExamRegistry holds with what was entered');
      await rec.pause(4000);
      await rec.check('The receipt says the exam is published, with every row matching', async () => {
        const body = await rec.bodyText();
        if (!body.includes('The exam is published')) throw new Error('the read-back did not match');
        if (/Expected .* read /.test(body)) throw new Error('a read-back row differs');
        const matches = (body.match(/Matches/g) ?? []).length;
        if (matches < 5) throw new Error(`only ${String(matches)} Matches rows`);
        return `${String(matches)} rows match`;
      });
      published = true;

      await page.getByRole('button', { name: 'Bring people in' }).click();
      await rec.say('Step 4: the board moves on by itself, and the record now reads from ExamRegistry');
      await page.getByRole('heading', { name: 'Bring people in' }).waitFor({ timeout: 15_000 });
      await unfold(page, 'Exam record');
      await page.getByRole('button', { name: 'Copy transaction: ' }).first().waitFor({ timeout: 15_000 });
      await rec.pause(2500);
      const txHash = await hashOf(page, 'transaction');

      await rec.say('Independent check: reading ExamRegistry with viem and cast, not through the app');
      await rec.check('The transaction on anvil succeeded, sent from the board to ExamRegistry', async () => {
        const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
        if (receipt.status !== 'success') throw new Error(`status ${receipt.status}`);
        if (receipt.from.toLowerCase() !== chain.board.toLowerCase()) throw new Error(`from ${receipt.from}`);
        if (receipt.to?.toLowerCase() !== chain.registry.toLowerCase()) throw new Error(`to ${receipt.to ?? 'none'}`);
        return `block ${String(receipt.blockNumber)}, from ${receipt.from}`;
      });
      await rec.check('viem getExam on ExamRegistry holds the same commit, digest, host and Δ', async () => {
        const exam = (await client.readContract({ address: chain.registry, abi: chain.abi, functionName: 'getExam', args: [examId] })) as {
          commitHash: Hex;
          imageDigest: Hex;
          createdAt: bigint;
          settings: { examId: Hex; examStart: bigint; delta: bigint; criteriaHash: Hex; rpcHost: string; unlockRound: bigint };
        };
        if (exam.createdAt === 0n) throw new Error('the exam is not on-chain');
        if (exam.settings.examId !== examId) throw new Error('examId differs');
        if (exam.commitHash.toLowerCase() !== COMMIT) throw new Error(`commit ${exam.commitHash}`);
        if (exam.imageDigest.toLowerCase() !== DIGEST) throw new Error(`digest ${exam.imageDigest}`);
        if (exam.settings.rpcHost !== RPC_HOST) throw new Error(`host ${exam.settings.rpcHost}`);
        if (exam.settings.delta !== 1800n) throw new Error(`delta ${String(exam.settings.delta)}`);
        const start = new Date(dayOffset(30).getFullYear(), dayOffset(30).getMonth(), dayOffset(30).getDate(), 9, 30).getTime() / 1000;
        if (Number(exam.settings.examStart) !== start) throw new Error(`examStart ${String(exam.settings.examStart)} vs ${String(start)}`);
        const logs = await client.getContractEvents({ address: chain.registry, abi: chain.abi, eventName: 'ExamCreated', fromBlock: 0n });
        const criteria = (logs.find((l) => (l.args as { examId?: Hex }).examId === examId)?.args as { criteria?: Hex } | undefined)?.criteria;
        const text = Buffer.from((criteria ?? '0x').slice(2), 'hex').toString('latin1');
        if (!text.includes('Mechanics') || !text.includes('Optics')) throw new Error('criteria event lacks the topics');
        const shown = await hashOf(page, 'criteria hash');
        if (shown.toLowerCase() !== exam.settings.criteriaHash.toLowerCase()) throw new Error(`UI criteria hash ${shown} differs from chain ${exam.settings.criteriaHash}`);
        return `criteriaHash ${exam.settings.criteriaHash}`;
      });
      await rec.check('cast call: board() is the anvil account and getExam holds this exam', async () => {
        const boardOut = cast(chain, 'board()(address)');
        if (boardOut.toLowerCase() !== chain.board.toLowerCase()) throw new Error(`board() = ${boardOut}`);
        const exam = cast(chain, castSignature(chain, 'getExam'), examId);
        const lower = exam.toLowerCase();
        if (!lower.includes(examId) || !exam.includes(RPC_HOST)) throw new Error(exam);
        if (!lower.includes(COMMIT) || !lower.includes(DIGEST)) throw new Error(`cast getExam lacks the release values: ${exam}`);
        return `board() = ${boardOut}; getExam holds the v0.1.0 commit and digest`;
      });

      await rec.check(`Source of the commit and digest: the live GitHub release ${TAG} of AbdulRashidReshamwala/paperseal, fetched by the app, not stubbed`, () => {
        if (!githubOk || rec.assertions.some((a) => !a.ok)) throw new Error('an earlier assertion failed, so the values are not confirmed');
        return `on-chain commit ${COMMIT}, image digest ${DIGEST}`;
      });
      await rec.check('The exam record shows the published exam, read from ExamRegistry', async () => {
        const body = await rec.bodyText();
        const shown = await hashOf(page, 'exam ID');
        if (shown.toLowerCase() !== examId || !body.includes('Topic: Mechanics') || !body.includes('Topic: Optics')) throw new Error('the record lacks the exam');
        return 'the record lists the exam ID, Mechanics and Optics';
      });
    } catch (error) {
      rec.fail('Board flow completed', error);
    } finally {
      await rec.finish();
    }
  });

  it('verifier-checks', async () => {
    const rec = new Recording('verifier-checks', { title: 'Public verifier checks the same exam, no TEE URL' });
    const wrongId = keccak256(toBytes('Some other exam nobody published'));
    const tampered = `${examId.slice(0, -1)}${examId.endsWith('0') ? '1' : '0'}` as Hex;
    try {
      if (!published) throw new Error('board-publish did not publish the exam, so there is nothing to verify');
      const verifierApp = (verifier = await startApp('apps/verifier', { VITE_RPC_URL: chain.rpcUrl, VITE_REGISTRY_ADDRESS: chain.registry }));
      const warm = await browser.newPage();
      await warm.goto(`${verifierApp.url}/#/settings`);
      await warm.waitForLoadState('networkidle');
      await warm.close();

      const page = await rec.open(browser);
      await page.goto(`${verifierApp.url}/#/`);
      await rec.say('Real apps/verifier, one chain-of-custody page. RPC URL and registry address are set, no TEE URL, no exam ID yet');
      await rec.pause(2500);
      await rec.check('With no exam ID the page asks for one and nothing is checked', async () => {
        const body = await rec.bodyText();
        if (!/Choose an exam/.test(body)) throw new Error(body.slice(0, 300));
        if (await page.locator('li[data-state="done"]').count()) throw new Error('a step is done with no exam ID');
        return 'Choose an exam, no step done';
      });

      /** Each step of the chain, as the page shows it: its label and its state attribute. */
      const steps = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('li[data-state]')).map((li) => ({
            label: (li.querySelector('[class$="step-label"]')?.textContent ?? '').trim(),
            state: li.getAttribute('data-state') ?? '',
          })),
        );
      const open = async (id: string, caption: string) => {
        await page.goto(`${verifierApp.url}/#/exam/${id}`);
        await page.reload();
        await rec.say(caption);
        await page.locator('li[data-state]').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await rec.pause(5000);
      };

      await open(examId, 'The exam ID the board published, opened as a link');
      await rec.check('The published exam shows step 1 done, and every later step not done', async () => {
        const list = await steps();
        if (list.length < 7) throw new Error(`only ${String(list.length)} steps`);
        if (list[0]?.state !== 'done') throw new Error(`step 1 is ${list[0]?.state ?? 'missing'}`);
        const later = list.slice(1).filter((s) => s.state === 'done' || s.state === 'failed');
        if (later.length > 0) throw new Error(`later steps are ${later.map((s) => `${s.label}: ${s.state}`).join(', ')}`);
        return list.map((s) => `${s.label}=${s.state}`).join(' | ');
      });
      await rec.check('The page says the exam is on track and that the people list and Build are not there yet', async () => {
        const body = await rec.bodyText();
        if (/A check failed|checks failed/.test(body)) throw new Error('an alarm is on the page');
        if (!/Nothing has failed so far/.test(body)) throw new Error(body.slice(0, 400));
        return 'on track, nothing failed';
      });
      await rec.check('Evidence is folded under each step, and the exam ID shown is the published one', async () => {
        const folds = await page.locator('li[data-state] details').count();
        if (folds < 3) throw new Error(`only ${String(folds)} folds`);
        await page.locator('li[data-state] summary').first().click();
        await rec.pause(1000);
        const shown = await hashOf(page, 'exam ID').catch(() => '');
        if (shown && shown.toLowerCase() !== examId) throw new Error(`the page shows ${shown}`);
        return `${String(folds)} folds`;
      });

      await open(tampered, `Tampered exam ID: last hex digit changed to ${tampered.slice(-1)}`);
      await rec.check('A tampered exam ID is not published and no step is done', async () => {
        const list = await steps();
        if (list.some((s) => s.state === 'done')) throw new Error(list.map((s) => `${s.label}=${s.state}`).join(', '));
        return `no step done among ${String(list.length)}`;
      });

      await open(wrongId, 'A different exam: the ID of an exam that was never published');
      await rec.check('A wrong exam has no step done and no failure alarm for something that was never posted', async () => {
        const list = await steps();
        if (list.some((s) => s.state === 'done')) throw new Error('a step is done for an exam nobody published');
        return `no step done among ${String(list.length)}`;
      });

      await page.goto(`${verifierApp.url}/#/exam/0xnothex`);
      await page.reload();
      await rec.say('A link that holds no valid exam ID');
      await rec.pause(2500);
      await rec.check('An invalid link says so and checks nothing', async () => {
        const body = await rec.bodyText();
        if (!body.includes('The link did not hold a valid exam ID.')) throw new Error(body.slice(0, 300));
        if (await page.locator('li[data-state="done"]').count()) throw new Error('a step is done for an invalid link');
        return 'invalid link refused';
      });
    } catch (error) {
      rec.fail('Verifier flow completed', error);
    } finally {
      await rec.finish();
    }
  });
});
