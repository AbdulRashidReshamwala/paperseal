import { createExamRegistry } from '@paperseal/chain';
import { ens, examNameProblem, roundTimeSeconds, type Criteria, type Hex } from '@paperseal/protocol';
import { keccak256, toBytes } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';

import { plantedCards } from '../demo/cards';
import { startMockTee } from '../mock/mockTee';
import { makeMockPki } from '../mock/pki';
import { partyParent } from '../live/roster';
import { startApp, startChain } from '../src/chain';
import { startEnsRpc } from '../src/ens';
import { stopAll } from '../src/procs';
import { testWalletScript } from '../src/wallet';
import { launchUiChrome, openActor, proxyGithubIfLimited } from './kit';
import { startStorage } from './lab';
import { button, centre, composer, field, fold, radio, text, unfold } from './selectors';

/*
 * How `pnpm demo:keys` is presented: one setter and one centre by hand, and the buttons on the board's
 * exam page for everyone else. The limit here is 20 percent, the tightest five setters can meet, so every
 * setter must end up with the same share, the one done by hand included.
 *
 * The mock machine does not check WebAuthn signatures. tee/internal/webauthn/demokeys_internal_test.go
 * gives what these planted keys sign to the real verifier.
 */

const RELEASE = 'v0.6.0';
const MINUTES_TO_LOCK = 6;
const UNLOCK_AFTER_LOCK = 2;
const DELTA = 1;
const DURATION = 8;
const criteria: Criteria = {
  maxSetterPercent: 20,
  minBankMultiple: 2,
  topics: [
    { name: 'Mathematics', questions: 3 },
    { name: 'Physics', questions: 3 },
  ],
};
/** At 20 percent, a bank of 6 cannot be shared by five setters, so each topic's bank is 10. */
const sealedPerSetter = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const until = async (unix: number) => {
  while (Date.now() / 1000 < unix) await sleep(500);
};
const log = (line: string) => {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);
};

const stoppers: (() => Promise<void> | void)[] = [];

describe('demo keys, the board does everyone else', () => {
  afterAll(async () => {
    for (const stop of stoppers.splice(0)) await Promise.resolve(stop()).catch(() => undefined);
    await stopAll();
  });

  it('runs a whole exam with one setter and one centre by hand', async () => {
    const chain = await startChain();
    stoppers.push(chain.stop);
    const names = await startEnsRpc(chain.rpcUrl);
    stoppers.push(names.stop);
    const pki = makeMockPki();
    stoppers.push(pki.stop);
    const storage = await startStorage();
    stoppers.push(storage.stop);
    const registry = createExamRegistry({ address: chain.registry, rpcUrl: chain.rpcUrl });
    const tee = await startMockTee({ pki, registry, storage: storage.files, bucket: 'mock-bucket', log });
    stoppers.push(tee.stop);

    const cards = await plantedCards();
    for (const { name, card } of cards) {
      names.set(name, { address: '0x000000000000000000000000000000000000dEaD', texts: { [ens.records.passkey]: card.passkey, [ens.records.credential]: card.credentialId } });
    }
    names.set(partyParent, { texts: { [ens.records.directory]: JSON.stringify(cards.map(({ name }) => name)) } });

    const web = await startApp(
      'apps/web',
      {
        VITE_DEMO_KEYS: '1',
        VITE_RPC_URL: names.rpcUrl,
        VITE_REGISTRY_ADDRESS: chain.registry,
        VITE_TEE_URL: tee.url,
        VITE_STORAGE_URL: storage.url,
        VITE_TEE_STORAGE_BUCKET: 'mock-bucket',
        VITE_MOCK_TRUST_ROOT: Buffer.from(pki.rootDer).toString('base64'),
      },
      { host: 'localhost', mode: 'mock' },
    );
    stoppers.push(web.stop);
    const browser = await launchUiChrome();
    stoppers.push(() => browser.close());

    const actor = await openActor(browser, 'demo', null, { role: 'demo', wallet: testWalletScript(chain.rpcUrl) });
    const page = actor.page;
    await proxyGithubIfLimited(actor.person.context);
    const acting = page.getByLabel('Acting as');
    const panel = page.getByRole('region', { name: 'Everyone else' });

    const become = async (label: string, path: string) => {
      log(`acting as ${label}`);
      await Promise.all([page.waitForEvent('load'), acting.selectOption({ label })]);
      await acting.waitFor();
      expect(page.url()).toContain(`#${path}`);
    };
    const backToBoard = async (name: string, heading: string | RegExp) => {
      await become('Exam board', '/board');
      await page.goto(`${web.url}/#/board?exam=${keccak256(toBytes(name))}`);
      await actor.seeHeading(heading, 120_000);
    };

    // ---------------------------------------------------------------- the board publishes, with its wallet
    await page.goto(web.url);
    await acting.waitFor();
    const now = Math.floor(Date.now() / 1000);
    const lockAt = Math.ceil((now + MINUTES_TO_LOCK * 60) / 60) * 60;
    const examStart = lockAt + (UNLOCK_AFTER_LOCK + DELTA) * 60;
    const name = `paperseal-ui-panel-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase()}`;
    expect(examNameProblem(name)).toBeNull();

    await page.goto(`${web.url}/#/board/blueprint`);
    await page.getByRole('button', { name: button.connectWallet }).click({ timeout: 60_000 });
    await actor.seeHeading(text.createHeading);
    await page.getByLabel(field.examName).first().fill(name);
    await page.getByLabel(field.examStart).first().fill(localInput(examStart));
    await page.getByLabel(field.length).first().fill(String(DURATION));
    await page.getByLabel(field.releaseMinutes).first().fill(String(DELTA));
    await unfold(page, fold.advanced);
    await page.getByLabel(field.questionsClose).first().fill(localInput(lockAt));
    await page.getByLabel(field.rpcHost).first().fill('sepolia.example.org');
    await page.getByRole('button', { name: button.continue }).click();
    await page.getByLabel(field.topicName(1)).first().fill(criteria.topics[0]?.name ?? '');
    await page.getByLabel(field.topicQuestions(1)).first().fill(String(criteria.topics[0]?.questions));
    await page.getByRole('button', { name: button.addTopic }).click();
    await page.getByLabel(field.topicName(2)).first().fill(criteria.topics[1]?.name ?? '');
    await page.getByLabel(field.topicQuestions(2)).first().fill(String(criteria.topics[1]?.questions));
    await unfold(page, fold.advanced);
    await page.getByLabel(field.maxPercent).first().fill(String(criteria.maxSetterPercent));
    await page.getByLabel(field.bankMultiple).first().fill(String(criteria.minBankMultiple));
    await page.getByRole('button', { name: button.continue }).click();
    const owners = cards.map((card) => card.name);
    for (const owner of owners.filter((owner) => owner.startsWith('centre-') && !owner.startsWith('centre-8.'))) await page.getByLabel(`Include ${owner}`).check();
    await page.getByRole('button', { name: button.continue }).click();
    for (const owner of owners.filter((owner) => owner.startsWith('neutral-'))) await page.getByLabel(`Include ${owner}`).check();
    await page.getByRole('button', { name: button.continue }).click();
    await actor.seeHeading(text.reviewHeading, 60_000);
    const other = page.locator('summary', { hasText: fold.differentVersion });
    await other.waitFor({ timeout: 60_000 });
    await other.click();
    await page.locator('details', { has: other }).locator('select').selectOption({ label: RELEASE });
    await page.getByText(new RegExp(`^${RELEASE.replace(/\./g, '\\.')}, your choice, verified`)).first().waitFor({ timeout: 90_000 });
    await page.getByRole('button', { name: button.publish }).click();
    await actor.seeHeading(text.peopleHeading, 180_000);
    log('published');

    const examId = keccak256(toBytes(name)) as Hex;
    await tee.init(examId);
    const exam = await registry.getExam(examId);
    if (!exam) throw new Error('the exam is not on the chain');
    const lockUnix = roundTimeSeconds(Number(exam.settings.lockRound));
    const unlockUnix = roundTimeSeconds(Number(exam.settings.unlockRound));

    await unfold(page, 'Centres and neutral parties');
    for (const owner of owners) await page.getByLabel(`Include ${owner}`).check({ timeout: 60_000 });
    await page.getByLabel(`Role for centre-8.${partyParent}`).selectOption({ label: 'Centre getting the key at unlock' });
    const links: string[] = [];
    for (const label of ['setter 1', 'setter 2', 'setter 3', 'setter 4', 'setter 5']) {
      await page.getByLabel(field.inviteNote).fill(label);
      await page.getByRole('button', { name: button.addInvite }).click();
      await page.getByRole('button', { name: `Copy the link for ${label}` }).click();
      links.push(await page.evaluate(() => navigator.clipboard.readText()));
    }

    // ---------------------------------------------------------------- one setter and one centre, by hand
    await become('Setter 1', '/setter');
    await page.goto(links[2] ?? '');
    await page.getByRole('button', { name: button.register }).click({ timeout: 60_000 });
    await actor.see(/security key is registered|Nothing to do yet/, 60_000);
    await become('Centre 1', '/centre');
    await actor.seeHeading('Register for this exam', 60_000);
    await page.getByRole('button', { name: button.registerByName }).click();
    await page.getByRole('button', { name: button.registerByName }).waitFor({ state: 'hidden', timeout: 60_000 });

    // ---------------------------------------------------------------- the board registers everyone else
    await backToBoard(name, text.peopleHeading);
    await panel.waitFor({ timeout: 60_000 });
    await panel.getByText('Already done').first().waitFor({ timeout: 30_000 });
    const started = Date.now();
    await actor.shot('panel-00-register');
    await panel.getByRole('button', { name: 'Register everyone else' }).click();
    await panel.getByRole('button', { name: 'Register everyone else' }).waitFor({ state: 'hidden', timeout: 120_000 });
    log(`registered everyone else in ${String(Math.round((Date.now() - started) / 1000))}s`);
    expect(await panel.getByText('Already done').count()).toBe(2);
    expect(await panel.getByText(/^Done$/).count()).toBe(4 + 10);
    await actor.shot('panel-01-registered');
    await page.waitForFunction((want) => document.body.innerText.split('Name confirmed').length - 1 >= want, owners.length, { timeout: 90_000 });
    await page.getByRole('button', { name: button.postList }).click({ timeout: 120_000 });
    await actor.seeHeading(/Nothing to do until|The paper is being built/, 240_000);
    log('list posted');

    // ---------------------------------------------------------------- one question by hand, the board does the rest
    await become('Setter 1', '/setter');
    await actor.seeHeading(text.writeHeading, 180_000);
    await page.getByRole('radio', { name: composer.topicRadio('Mathematics') }).check();
    await page.getByRole('radio', { name: radio.written }).check();
    await page.getByLabel(composer.question).fill('Mathematics question by hand: explain a result and show the working.');
    await page.getByRole('button', { name: button.seal }).click();
    await page.getByText(composer.sealedSoFar(1)).first().waitFor({ timeout: 90_000 });

    await backToBoard(name, /Nothing to do until|Setters are sending/);
    await panel.getByRole('button', { name: 'Add questions for everyone else' }).click({ timeout: 60_000 });
    await panel.getByRole('button', { name: 'Add questions for everyone else' }).waitFor({ state: 'hidden', timeout: 180_000 });
    expect(await panel.getByText('Done', { exact: true }).count()).toBe(5);
    await actor.shot('panel-02-questions');
    const held = await page.evaluate(
      (id) => [1, 2, 3, 4, 5].map((n) => (JSON.parse(localStorage.getItem(`paperseal-demo.of.setter-${String(n)}.paperseal.receipts.${id}`) ?? '[]') as unknown[]).length),
      examId,
    );
    expect(held).toEqual([sealedPerSetter, sealedPerSetter, sealedPerSetter, sealedPerSetter, sealedPerSetter]);
    log('questions added');

    // Setter 3 finds their receipts on their own page.
    await become('Setter 3', '/setter');
    await actor.seeHeading(text.writeHeading, 60_000);
    await page.getByText(composer.sealedSoFar(sealedPerSetter)).first().waitFor({ timeout: 60_000 }).catch(() => undefined);
    await actor.shot('panel-03-setter-3');

    // ---------------------------------------------------------------- the paper's record
    await backToBoard(name, text.recordBuildHeading).catch(async () => {
      await actor.seeHeading(text.recordBuildHeading, Math.max(60_000, (lockUnix + 300 - Date.now() / 1000) * 1000));
    });
    await page.getByRole('button', { name: button.postBuild }).click();
    await actor.seeHeading(/Sealed\. Nothing to do until|Key holders are releasing/, 240_000);
    log('build posted');

    // ---------------------------------------------------------------- one release by hand, the board does the rest
    await until(unlockUnix + 2);
    await become('Centre 1', '/centre');
    const release = page.getByRole('button', { name: button.release });
    await release.click({ timeout: 120_000 });
    await actor.see(/parts of the key released|Waiting for key holders/, 120_000);

    await backToBoard(name, /Key holders are releasing/);
    await panel.getByRole('button', { name: 'Release the rest' }).click({ timeout: 60_000 });
    await panel.getByRole('button', { name: 'Release the rest' }).waitFor({ state: 'hidden', timeout: 120_000 });
    await panel.getByText('Not needed').first().waitFor({ timeout: 30_000 });
    expect(await panel.getByText(/^Done$/).count()).toBe(7);
    expect(await panel.getByText('Already done').count()).toBe(1);
    expect(await panel.getByText('Not needed').count()).toBe(2);
    await page.getByText('8 of 8 needed').waitFor({ timeout: 30_000 });
    await actor.shot('panel-04-released');
    log('released');

    // ---------------------------------------------------------------- the centres open the paper on their own pages
    for (const label of ['Centre 1', 'Centre 4', 'Centre 8']) {
      await become(label, '/centre');
      await page.getByRole('button', { name: centre.openPaper }).click({ timeout: 240_000 });
      await actor.seeHeading(centre.paperOpenHeading, 120_000);
      log(`${label} opened the paper`);
    }
    await actor.shot('panel-05-paper-open');
    await browser.close();
  });
});
