import { createExamRegistry } from '@paperseal/chain';
import { ens, examNameProblem, roundTimeSeconds, type Hex } from '@paperseal/protocol';
import { keccak256, toBytes } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';

import { plantedCards } from '../demo/cards';
import { startMockTee } from '../mock/mockTee';
import { makeMockPki } from '../mock/pki';
import { liveCriteria, liveQuestion, questionsPerSetterPerTopic } from '../live/schedule';
import { partyParent } from '../live/roster';
import { startApp, startChain } from '../src/chain';
import { startEnsRpc } from '../src/ens';
import { stopAll } from '../src/procs';
import { testWalletScript } from '../src/wallet';
import { launchUiChrome, openActor, proxyGithubIfLimited } from './kit';
import { startStorage } from './lab';
import { button, centre, composer, field, fold, radio, text, unfold } from './selectors';

/*
 * A whole exam in ONE tab, the way `pnpm demo:keys` is used: the bar at the top picks who is acting, and
 * every person's key is planted. Run with: pnpm --filter @paperseal/e2e ui:demo
 *
 * This is the mock world of examRun.ts, so its machine does not check WebAuthn signatures. The Go test
 * tee/internal/webauthn/demokeys_internal_test.go gives the planted keys' output to the real verifier.
 * The tab has one virtual authenticator, which stands in for the physical key the touch for show asks.
 */

const RELEASE = 'v0.6.0';
// Everyone takes turns in one tab here, so this is slower than the mock run with its many windows.
const MINUTES_TO_LOCK = 8;
const UNLOCK_AFTER_LOCK = 2;
const DELTA = 1;
const DURATION = 8;

const setters = ['Setter 1', 'Setter 2'];
const keyHolders = ['Key holder 1', 'Key holder 2', 'Key holder 3'];
const centres = ['Centre 1', 'Centre 2', 'Centre 3', 'Centre 4', 'Centre 5', 'Centre 6', 'Centre 7', 'Centre 8'];

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

describe('demo keys, one tab', () => {
  afterAll(async () => {
    for (const stop of stoppers.splice(0)) await Promise.resolve(stop()).catch(() => undefined);
    await stopAll();
  });

  it('runs a whole exam by switching who is acting', async () => {
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

    // The fixed cards go on the names once, as `node e2e/demo/cli.mjs names write` does on Sepolia.
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

    /** Picks a person in the bar, and waits for the reload that makes them that person. */
    const become = async (label: string, path: string) => {
      log(`acting as ${label}`);
      await Promise.all([page.waitForEvent('load'), acting.selectOption({ label })]);
      await acting.waitFor();
      expect(await acting.locator('option:checked').innerText()).toBe(label);
      expect(page.url()).toContain(`#${path}`);
    };
    /** A real touch asked of the plugged-in key, counted at the page's `navigator.credentials`. */
    const touches = () => actor.counts.keyTouches;

    // ---------------------------------------------------------------- the bar
    await page.goto(web.url);
    await page.getByLabel('Acting as').waitFor();
    expect(await acting.locator('option').allInnerTexts()).toEqual(['Exam board', ...setters, ...keyHolders, ...centres]);
    await actor.shot('demo-00-bar');

    // ---------------------------------------------------------------- the board publishes, with its wallet
    const now = Math.floor(Date.now() / 1000);
    const lockAt = Math.ceil((now + MINUTES_TO_LOCK * 60) / 60) * 60;
    const examStart = lockAt + (UNLOCK_AFTER_LOCK + DELTA) * 60;
    const name = `paperseal-ui-demo-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase()}`;
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
    await page.getByLabel(field.topicName(1)).first().fill(liveCriteria.topics[0]?.name ?? '');
    await page.getByLabel(field.topicQuestions(1)).first().fill(String(liveCriteria.topics[0]?.questions));
    await page.getByRole('button', { name: button.addTopic }).click();
    await page.getByLabel(field.topicName(2)).first().fill(liveCriteria.topics[1]?.name ?? '');
    await page.getByLabel(field.topicQuestions(2)).first().fill(String(liveCriteria.topics[1]?.questions));
    await unfold(page, fold.advanced);
    await page.getByLabel(field.maxPercent).first().fill(String(liveCriteria.maxSetterPercent));
    await page.getByLabel(field.bankMultiple).first().fill(String(liveCriteria.minBankMultiple));
    await page.getByRole('button', { name: button.continue }).click();
    const owners = cards.map((card) => card.name);
    // The directory lists everyone, so they are ticked, as a person would.
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
    for (const label of ['setter 1', 'setter 2']) {
      await page.getByLabel(field.inviteNote).fill(label);
      await page.getByRole('button', { name: button.addInvite }).click();
      await page.getByRole('button', { name: `Copy the link for ${label}` }).click();
      links.push(await page.evaluate(() => navigator.clipboard.readText()));
    }

    // ---------------------------------------------------------------- setters register from their links
    for (const [index, label] of setters.entries()) {
      await become(label, '/setter');
      await page.goto(links[index] ?? '');
      const before = touches();
      await page.getByRole('button', { name: button.register }).click({ timeout: 60_000 });
      await actor.see(/security key is registered|Nothing to do yet/, 60_000);
      // A create and a get, on one click.
      expect(touches() - before).toBe(1);
    }
    await actor.shot('demo-10-setter-registered');

    // ---------------------------------------------------------------- key holders and centres register, each as themselves
    for (const [label, path] of [...keyHolders.map((l) => [l, '/keyholder'] as const), ...centres.map((l) => [l, '/centre'] as const)]) {
      await become(label, path);
      // Their name is filled in, and nothing of the last person's registration is here.
      await actor.seeHeading('Register for this exam', 60_000);
      expect(await page.getByLabel(field.partyName).inputValue()).toBe(`${label.toLowerCase().replace('key holder', 'neutral').replace(' ', '-')}.${partyParent}`);
      const before = touches();
      await page.getByRole('button', { name: button.registerByName }).click();
      await page.getByRole('button', { name: button.registerByName }).waitFor({ state: 'hidden', timeout: 60_000 });
      // Two ceremonies, one touch.
      expect(touches() - before).toBe(1);
    }
    await actor.shot('demo-11-party-registered');

    // Back to someone who already registered: their own state is back.
    await become('Centre 1', '/centre');
    await actor.see(/Nothing to do yet|You are registered|list of people/, 60_000);
    await page.waitForTimeout(3000);
    expect(await page.getByRole('button', { name: button.registerByName }).count()).toBe(0);

    // ---------------------------------------------------------------- the board's drafts are still the board's: post the list
    await become('Exam board', '/board');
    await page.goto(`${web.url}/#/board?exam=${examId}`);
    await page.getByText(name).first().waitFor({ timeout: 60_000 });
    await page.getByText(name).first().click().catch(() => undefined);
    await actor.seeHeading(text.peopleHeading, 60_000);
    await page.waitForFunction((want) => document.body.innerText.split('Name confirmed').length - 1 >= want, owners.length, { timeout: 90_000 });
    await page.getByRole('button', { name: button.postList }).click({ timeout: 120_000 });
    await actor.seeHeading(/Nothing to do until|The paper is being built/, 240_000);
    log('list posted');

    // ---------------------------------------------------------------- setters write and seal
    for (const [index, label] of setters.entries()) {
      await become(label, '/setter');
      await actor.seeHeading(text.writeHeading, 180_000);
      let sealed = 0;
      for (const topic of liveCriteria.topics) {
        for (let k = 1; k <= questionsPerSetterPerTopic; k++) {
          const question = liveQuestion(topic.name, index * questionsPerSetterPerTopic + k);
          await page.getByRole('radio', { name: composer.topicRadio(topic.name) }).check();
          await page.getByRole('radio', { name: question.options ? radio.multipleChoice : radio.written }).check();
          await page.getByLabel(composer.question).fill(question.text);
          for (const [i, option] of (question.options ?? []).entries()) {
            const letter = String.fromCharCode(65 + i);
            if (i >= 2) await page.getByRole('button', { name: button.addOption, exact: true }).click();
            await page.getByRole('textbox', { name: field.option(letter), exact: true }).fill(option);
          }
          const before = touches();
          await page.getByRole('button', { name: button.seal }).click();
          sealed += 1;
          await page.getByText(composer.sealedSoFar(sealed)).first().waitFor({ timeout: 90_000 });
          expect(touches() - before).toBe(1);
        }
      }
      log(`${label} sealed ${String(sealed)}`);
    }
    await actor.shot('demo-20-sealed');

    // The touch can be turned off, and that is remembered across people and reloads.
    const toggle = page.getByLabel('Ask for a touch');
    await toggle.uncheck();

    // ---------------------------------------------------------------- the board posts the paper's record
    await become('Exam board', '/board');
    expect(await toggle.isChecked()).toBe(false);
    await page.goto(`${web.url}/#/board?exam=${examId}`);
    await page.getByText(name).first().click().catch(() => undefined);
    await actor.seeHeading(text.recordBuildHeading, Math.max(60_000, (lockUnix + 300 - Date.now() / 1000) * 1000));
    await page.getByRole('button', { name: button.postBuild }).click();
    await actor.seeHeading(/Sealed\. Nothing to do until|Key holders are releasing/, 240_000);
    log('build posted');

    // ---------------------------------------------------------------- unlock: holders release, turn by turn
    await until(unlockUnix + 2);
    const noTouch = touches();
    const holders = [...keyHolders.map((l) => [l, '/keyholder'] as const), ...centres.slice(0, 7).map((l) => [l, '/centre'] as const)];
    for (const [label, path] of holders) {
      await become(label, path);
      const release = page.getByRole('button', { name: button.release });
      const over = page.getByText(/was not needed/).or(page.getByRole('button', { name: centre.openPaper }));
      await release.or(over).first().waitFor({ timeout: 120_000 });
      if (!(await release.isVisible())) continue;
      await release.click();
      await actor.see(/Done\. You can close this tab|parts of the key released|Waiting for key holders|Open the paper/, 120_000);
      log(`${label} released`);
    }
    expect(touches()).toBe(noTouch);

    // With the touch back on and no key in reach, the person is held up a moment and not stopped.
    await toggle.check();
    await actor.person.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: actor.person.authenticatorId });

    // ---------------------------------------------------------------- every centre opens the paper
    for (const [index, label] of centres.entries()) {
      await become(label, '/centre');
      const open = page.getByRole('button', { name: centre.openPaper });
      await open.waitFor({ timeout: 240_000 });
      const started = Date.now();
      await open.click();
      await actor.seeHeading(centre.paperOpenHeading, 120_000);
      log(`${label} opened the paper in ${String(Math.round((Date.now() - started) / 1000))}s`);
      if (index === 0) {
        await actor.shot('demo-30-paper-open');
        await toggle.uncheck();
      }
    }
    await browser.close();
  });
});
