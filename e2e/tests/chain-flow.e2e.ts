import { afterAll, beforeAll, describe, it } from 'vitest';
import { keccak256, toBytes, type Hex } from 'viem';
import type { Browser, Page } from 'playwright-core';

import { cast, publicClientFor, rpcCall, startApp, startChain, type Chain } from '../src/chain';
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

const EXAM_NAME = 'Paper Seal e2e Physics Final';
const COMMIT = '1234567890abcdef1234567890abcdef12345678';
const DIGEST = 'ab'.repeat(32);
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
  await warm.goto(`${web.url}/board/publish`);
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

describe('exam on a local anvil chain', () => {
  it('board-publish', async () => {
    const rec = new Recording('board-publish', {
      title: 'Board publishes an exam to ExamRegistry (anvil, chain 11155111)',
      subtitle: 'Test wallet on local chain, not MetaMask',
    });
    const page = await rec.open(browser, [testWalletScript(chain.rpcUrl)]);
    const client = publicClientFor(chain);
    try {
      await page.goto(`${web.url}/board/blueprint`);
      await rec.say('Real apps/web at /board/blueprint. ExamRegistry deployed from contracts/out, board = anvil account 0');
      await rec.pause(2500);

      await rec.say('Blueprint: typing the exam name');
      await rec.type(value(page, 'Exam name'), EXAM_NAME);
      await rec.say('Blueprint: first topic, Mechanics, 5 questions');
      await rec.type(value(page, 'Topic 1 name'), 'Mechanics');
      await rec.type(value(page, 'Topic 1 questions'), '5');
      await rec.say('Blueprint: adding a second topic, Optics, 3 questions');
      await page.getByRole('button', { name: 'Add topic' }).click();
      await rec.type(value(page, 'Topic 2 name'), 'Optics');
      await rec.type(value(page, 'Topic 2 questions'), '3');
      await rec.say('Blueprint: setter limits');
      await rec.type(value(page, 'maxSetterPercent'), '20');
      await rec.type(value(page, 'minBankMultiple'), '4');
      await page.getByText('Criteria accepted').scrollIntoViewIfNeeded();
      await rec.say('Blueprint: criteria accepted by the app');
      await rec.pause(2000);
      await rec.check('Blueprint accepts the criteria (8 questions selected)', async () => {
        await page.getByText('Criteria accepted').waitFor({ timeout: 5000 });
        const text = await page.locator('li').filter({ hasText: 'selectedCount' }).first().innerText();
        if (!/\b8\b/.test(text)) throw new Error(`selectedCount row: ${text}`);
        return text.replace(/\s+/g, ' ');
      });
      await rec.check('The exam ID shown equals keccak256 of the name, computed independently', async () => {
        const shown = (await page.locator('li').filter({ hasText: 'Exam ID' }).first().innerText()).toLowerCase();
        if (!shown.includes(examId)) throw new Error(`UI shows ${shown}, expected ${examId}`);
        return examId;
      });

      await page.getByRole('link', { name: 'Schedule' }).click();
      await rec.say('Schedule: exam start 30 days ahead at 09:30, local time');
      const day = stamp(dayOffset(30));
      const lockDay = stamp(dayOffset(29));
      await rec.type(value(page, 'Exam start'), `${day} 09:30`);
      await rec.type(value(page, 'Δ'), '30');
      await rec.say('Schedule: lock the bank the day before, 12:00');
      await rec.type(value(page, 'Lock time'), `${lockDay} 12:00`);
      await rec.say('Schedule: exam ends 12:30');
      await rec.type(value(page, 'End time'), `${day} 12:30`);
      await page.getByText('Schedule accepted').scrollIntoViewIfNeeded();
      await rec.pause(2000);
      await rec.check('Schedule accepted, with drand rounds derived', async () => {
        await page.getByText('Schedule accepted').waitFor({ timeout: 5000 });
        const text = await page.locator('li').filter({ hasText: 'Unlock round' }).first().innerText();
        if (!/round \d+/.test(text)) throw new Error(`no round shown: ${text}`);
        return text.replace(/\s+/g, ' ');
      });

      await page.getByRole('link', { name: 'Publish' }).click();
      await rec.say('Publish: commit hash of the tagged TEE build');
      await rec.type(value(page, 'Commit hash'), COMMIT, 25);
      await rec.say('Publish: image digest');
      await rec.type(value(page, 'Image digest'), DIGEST, 20);
      await rec.say('Publish: RPC operator host');
      await rec.type(value(page, 'RPC operator host'), RPC_HOST);
      await rec.pause(1500);

      // Rejected case first: a wallet account that is not the board.
      await rec.say('Rejected case: test wallet switched to anvil account 1, which is not the board');
      await page.evaluate(() => {
        (window as unknown as { __testWalletIndex: number }).__testWalletIndex = 1;
      });
      await page.getByRole('button', { name: 'Connect wallet' }).click();
      await page.getByText('Board wallet').scrollIntoViewIfNeeded();
      await rec.pause(2500);
      const blockBefore = (await rpcCall(chain.rpcUrl, 'eth_blockNumber')) as string;
      await rec.check('The app shows the connected account is not the board', async () => {
        const text = await page.locator('li').filter({ hasText: 'Account is the board' }).first().innerText();
        if (!/No/.test(text)) throw new Error(text);
        return `account ${chain.accounts[1] ?? ''} vs board ${chain.board}`;
      });
      await rec.say('Rejected case: Confirm and publish with the wrong account');
      await page.getByRole('button', { name: 'Confirm and publish' }).click();
      await page.getByText('Not published').first().waitFor({ timeout: 20_000 });
      await rec.pause(3500);
      await rec.check('Publishing as the wrong account is refused before anything is sent', async () => {
        const panel = await page.locator('section, div').filter({ has: page.getByRole('heading', { name: 'Not published' }) }).last().innerText().catch(() => '');
        const body = await page.locator('body').innerText();
        if (!/not the board address/i.test(body)) throw new Error(`no refusal message in page text. Panel: ${panel}`);
        const blockAfter = (await rpcCall(chain.rpcUrl, 'eth_blockNumber')) as string;
        if (blockAfter !== blockBefore) throw new Error(`chain advanced from ${blockBefore} to ${blockAfter}`);
        const onChain = await client.readContract({ address: chain.registry, abi: chain.abi, functionName: 'getExam', args: [examId] });
        if ((onChain as { createdAt: bigint }).createdAt !== 0n) throw new Error('the exam exists on-chain');
        return `refused, anvil still at block ${blockAfter}, exam not on-chain`;
      });

      await rec.say('Test wallet switched back to anvil account 0, the board');
      await page.evaluate(() => {
        (window as unknown as { __testWalletIndex: number }).__testWalletIndex = 0;
      });
      await page.getByRole('button', { name: 'Refresh wallet' }).click();
      await page.getByText('Board wallet').scrollIntoViewIfNeeded();
      await rec.pause(2500);
      await rec.check('The app shows the connected account is the board', async () => {
        const text = await page.locator('li').filter({ hasText: 'Account is the board' }).first().innerText();
        if (!/Yes/.test(text)) throw new Error(text);
        return chain.board;
      });

      await rec.say('Publish: Confirm and publish. The app dry-runs, sends createExam, mines, then reads back');
      await page.getByRole('button', { name: 'Confirm and publish' }).click();
      await page.getByText('Published and verified').waitFor({ timeout: 60_000 }).catch(() => undefined);
      await page.getByText(/Published and verified|read-back differs/).first().scrollIntoViewIfNeeded();
      await rec.say('The read-back screen: each row compares what ExamRegistry holds with what was entered');
      await rec.pause(4000);
      let txHash = '';
      await rec.check('Read-back screen says "Published and verified" with every row matching', async () => {
        const body = await page.locator('body').innerText();
        if (!body.includes('Published and verified')) throw new Error('the read-back did not say Published and verified');
        if (/Differs/.test(body)) throw new Error('a read-back row says Differs');
        const matches = (body.match(/Matches/g) ?? []).length;
        if (matches < 5) throw new Error(`only ${String(matches)} Matches rows`);
        txHash = (await page.locator('li').filter({ hasText: 'Transaction' }).first().innerText()).match(/0x[0-9a-fA-F]{64}/)?.[0] ?? '';
        return `${String(matches)} rows match, transaction ${txHash}`;
      });
      published = true;

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
        if (exam.commitHash !== `0x${COMMIT}`) throw new Error(`commit ${exam.commitHash}`);
        if (exam.imageDigest !== `0x${DIGEST}`) throw new Error(`digest ${exam.imageDigest}`);
        if (exam.settings.rpcHost !== RPC_HOST) throw new Error(`host ${exam.settings.rpcHost}`);
        if (exam.settings.delta !== 1800n) throw new Error(`delta ${String(exam.settings.delta)}`);
        const start = new Date(dayOffset(30).getFullYear(), dayOffset(30).getMonth(), dayOffset(30).getDate(), 9, 30).getTime() / 1000;
        if (Number(exam.settings.examStart) !== start) throw new Error(`examStart ${String(exam.settings.examStart)} vs ${String(start)}`);
        const logs = await client.getContractEvents({ address: chain.registry, abi: chain.abi, eventName: 'ExamCreated', fromBlock: 0n });
        const criteria = (logs.find((l) => (l.args as { examId?: Hex }).examId === examId)?.args as { criteria?: Hex } | undefined)?.criteria;
        const text = Buffer.from((criteria ?? '0x').slice(2), 'hex').toString('latin1');
        if (!text.includes('Mechanics') || !text.includes('Optics')) throw new Error('criteria event lacks the topics');
        const shown = (await page.locator('li').filter({ hasText: 'criteriaHash' }).first().innerText()).toLowerCase();
        if (!shown.includes(exam.settings.criteriaHash.toLowerCase())) throw new Error(`UI criteriaHash differs from chain ${exam.settings.criteriaHash}`);
        return `criteriaHash ${exam.settings.criteriaHash}`;
      });
      await rec.check('cast call: board() is the anvil account and getExam holds this exam', async () => {
        const boardOut = cast(chain, 'board()(address)');
        if (boardOut.toLowerCase() !== chain.board.toLowerCase()) throw new Error(`board() = ${boardOut}`);
        const exam = cast(chain, 'getExam(bytes32)((bytes20,bytes32,uint64,(bytes32,uint64,uint64,uint64,uint64,uint64,bytes32,string)))', examId);
        if (!exam.toLowerCase().includes(examId) || !exam.includes(RPC_HOST)) throw new Error(exam);
        return `board() = ${boardOut}`;
      });

      await page.getByRole('link', { name: 'overview' }).click();
      await rec.say('The app overview now reads the exam back from ExamRegistry');
      await page.getByText('Exam ID').first().waitFor({ timeout: 15_000 });
      await rec.pause(3500);
      await rec.check('The app overview shows the published exam', async () => {
        const body = await page.locator('body').innerText();
        if (!body.toLowerCase().includes(examId) || !body.includes('Mechanics')) throw new Error('overview lacks the exam');
        return 'overview lists exam ID, Mechanics and Optics';
      });
    } catch (error) {
      rec.fail('Board flow completed', error);
    } finally {
      await rec.finish();
    }
  });

  it('verifier-checks', async () => {
    const rec = new Recording('verifier-checks', { title: 'Public verifier checks the same exam, no TEE URL' });
    const wrongName = 'Some other exam nobody published';
    const wrongId = keccak256(toBytes(wrongName));
    const tampered = `${examId.slice(0, -1)}${examId.endsWith('0') ? '1' : '0'}` as Hex;
    try {
      if (!published) throw new Error('board-publish did not publish the exam, so there is nothing to verify');
      verifier = await startApp('apps/verifier', { VITE_RPC_URL: chain.rpcUrl, VITE_REGISTRY_ADDRESS: chain.registry });
      const warm = await browser.newPage();
      await warm.goto(`${verifier.url}/settings`);
      await warm.waitForLoadState('networkidle');
      await warm.close();

      const page = await rec.open(browser);
      await page.goto(`${verifier.url}/`);
      await rec.say('Real apps/verifier. RPC URL and registry address are set, no TEE URL, no exam ID yet');
      await rec.pause(2500);
      await rec.check('With no exam ID the verifier shows not connected instead of passing', async () => {
        const body = await page.locator('body').innerText();
        if (!/not connected/i.test(body)) throw new Error(body.slice(0, 300));
        if (/\bPass\b/.test(body)) throw new Error('a Pass appeared with no exam ID');
        return 'Chain checks: not connected';
      });

      const setExam = async (id: string, caption: string) => {
        await page.getByRole('link', { name: 'Connection' }).click();
        await rec.say(caption);
        const field = value(page, 'Exam ID');
        await field.fill('');
        await rec.type(field, id, 15);
        await page.getByRole('button', { name: 'Save' }).click();
        await rec.pause(800);
      };

      await setExam(examId, 'Connection: typing the exam ID the board published, then Save');
      await page.getByRole('link', { name: 'Overview' }).click();
      await rec.say('Overview: chain checks read ExamRegistry through the RPC URL');
      await page.getByText('Exam published').waitFor({ timeout: 20_000 });
      await rec.pause(4000);
      await rec.check('Overview: exam published and criteria hash matches the exam, both Pass', async () => {
        const published = await page.locator('li').filter({ hasText: 'Exam published' }).first().innerText();
        const crit = await page.locator('li').filter({ hasText: 'Criteria hash matches the exam' }).first().innerText();
        if (!/Published/.test(published) || /Not published/.test(published)) throw new Error(published);
        if (!/Pass/.test(crit)) throw new Error(crit);
        return `${published.replace(/\s+/g, ' ')} | ${crit.replace(/\s+/g, ' ')}`;
      });
      await rec.check('Overview: TEE is optional, in neutral wording and not a failure', async () => {
        const body = await page.locator('body').innerText();
        if (!body.includes('Live TEE status: optional')) throw new Error('no optional TEE panel');
        if (!body.includes('Every chain check works without it')) throw new Error('no neutral TEE wording');
        if (/\bFail\b/.test(body)) throw new Error('a Fail badge is on the overview');
        return 'Live TEE status: optional, no Fail anywhere';
      });
      await rec.check('Overview: approved list and Build are not posted yet, shown neutral and not as Pass', async () => {
        const list = await page.locator('li').filter({ hasText: 'Approved list hash matches the chain' }).first().innerText();
        const build = await page.locator('li').filter({ hasText: /^Build/ }).first().innerText();
        if (/Pass/.test(list) || !/Not posted/.test(list)) throw new Error(list);
        if (!/No Build yet/.test(build)) throw new Error(build);
        return 'nothing posted on-chain for these, and the page does not claim otherwise';
      });

      await page.getByRole('link', { name: 'Commitments' }).click();
      await rec.say('Commitments: settings and selection criteria decoded from the on-chain event');
      await page.getByText('Topic: Mechanics').waitFor({ timeout: 20_000 });
      await rec.pause(4500);
      await rec.check('Commitments: decoded criteria and the hash check Pass', async () => {
        const body = await page.locator('body').innerText();
        if (!/Topic: Mechanics\s*5 questions/.test(body) || !/Topic: Optics\s*3 questions/.test(body)) throw new Error('topics not decoded');
        if (!/20%/.test(body) || !/4x/.test(body)) throw new Error('limits not decoded');
        const crit = await page.locator('li').filter({ hasText: 'Criteria hash matches the exam' }).first().innerText();
        if (!/Pass/.test(crit)) throw new Error(crit);
        return 'Mechanics 5, Optics 3, 20%, 4x, hash Pass';
      });

      await setExam(tampered, `Tampered exam ID: last hex digit changed to ${tampered.slice(-1)}`);
      await page.getByRole('link', { name: 'Overview' }).click();
      await rec.say('Overview for the tampered exam ID');
      await page.getByText('Exam published').waitFor({ timeout: 20_000 });
      await rec.pause(3500);
      await rec.check('A tampered exam ID is not published and nothing passes', async () => {
        const published = await page.locator('li').filter({ hasText: 'Exam published' }).first().innerText();
        const body = await page.locator('body').innerText();
        if (!/Not published/.test(published)) throw new Error(published);
        if (/\bPass\b/.test(body)) throw new Error('a Pass appeared for a tampered ID');
        return published.replace(/\s+/g, ' ');
      });

      await setExam(wrongId, 'A different exam: the ID of an exam that was never published');
      await page.getByRole('link', { name: 'Commitments' }).click();
      await rec.say('Commitments for the wrong exam');
      await page.getByText('Exam settings').waitFor({ timeout: 20_000 });
      await rec.pause(3500);
      await rec.check('A wrong exam shows Not posted and nothing passes', async () => {
        const body = await page.locator('body').innerText();
        const settings = await page.locator('li').filter({ hasText: 'Exam settings' }).first().innerText();
        if (!/Not posted/.test(settings)) throw new Error(settings);
        if (/\bPass\b/.test(body)) throw new Error('a Pass appeared for a wrong exam');
        return settings.replace(/\s+/g, ' ');
      });
    } catch (error) {
      rec.fail('Verifier flow completed', error);
    } finally {
      await rec.finish();
    }
  });
});
