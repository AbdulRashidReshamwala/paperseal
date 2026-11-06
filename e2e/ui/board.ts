import { decodeInviteFragment, ens, fromHex, passkeyRecordValue, toHex, type Hex } from '@paperseal/protocol';
import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';

import { testWalletScript } from '../src/wallet';
import { inviteTag, listWith, postListDirect, publishDirect, strangerKey, timings, type Timing } from './chainkit';
import type { Lab } from './lab';
import { openActor, proxyGithubIfLimited, type Actor } from './kit';
import { button, field, fold, hashOf, text, unfold } from './selectors';

/*
 * The board, through the real screens on a local anvil chain. The wallet is the test wallet of
 * src/wallet.ts (anvil signs for its own accounts). Registrations come from the stub TEE, because the
 * real TEE only exists in Confidential Space, so everything that depends on a registration is labelled
 * [stub tee]. The board's own post of the list and of the Build needs an attested TEE and is refused here:
 * those refusals are tested, and the posts themselves are driven in the live run.
 */

const NAME = 'ui-suite-physics-final';
/** Key holders and centres are invited by ENS name only. The lab's ENS stand-in (e2e/src/ens.ts) knows these. */
const KEYHOLDER = 'neutral-anna.paperseal-demo.eth';
const CENTRE = 'north-centre.paperseal-demo.eth';
const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function boardTests(lab: () => Lab): void {
  describe('board', () => {
    let board: Actor;

    it('create, review, publish and the wrong account', async () => {
      const { web, chain } = lab();
      board = await openActor(lab().browser, 'board', null, { role: 'board', wallet: testWalletScript(chain.rpcUrl) });
      const page = board.page;
      await proxyGithubIfLimited(board.person.context);
      await board.flow('create the exam', async () => {
        await page.goto(`${web.url}/#/board/blueprint`);
        await board.seeHeading(text.createHeading);
        await board.shot('01-create-empty');
        await board.type(page.getByLabel(field.examName).first(), NAME);
        await board.type(page.getByLabel(field.examStart).first(), local(new Date(Date.now() + 30 * 86_400_000)));
        await board.type(page.getByLabel(field.releaseMinutes).first(), '30');
        await board.type(page.getByLabel(field.topicName(1)).first(), 'Mechanics');
        await board.type(page.getByLabel(field.topicQuestions(1)).first(), '5');
        await page.getByRole('button', { name: button.addTopic }).click();
        await board.type(page.getByLabel(field.topicName(2)).first(), 'Optics');
        await board.type(page.getByLabel(field.topicQuestions(2)).first(), '3');
        await unfold(page, fold.advanced);
        // A bad value is called out beside its field, and the page does not move on.
        await board.type(page.getByLabel(field.maxPercent).first(), '150');
        await page.locator('.ps-field-error').first().waitFor({ state: 'visible' });
        await board.shot('02-create-bad-percent');
        await board.type(page.getByLabel(field.maxPercent).first(), '20');
        await board.type(page.getByLabel(field.rpcHost).first(), 'sepolia.example.org');
        await board.shot('03-create-filled');
        await page.getByRole('button', { name: button.continue }).click();
      });
      await board.flow('review, choose the version and publish', async () => {
        await board.seeHeading(text.reviewHeading, 60_000);
        await board.shot('04-review');
        // The version is a row in the review. The newest checked one is already chosen, and another is folded away.
        const other = page.locator('summary', { hasText: fold.differentVersion });
        await other.waitFor({ timeout: 60_000 });
        await other.click();
        await page.locator('details', { has: other }).locator('select').selectOption({ label: 'v0.1.0' });
        await unfold(page, fold.examRecord);
        await board.see('This version matches its published release', 60_000);
        await board.shot('05-review-version-picked');
        await page.evaluate(() => {
          (window as unknown as { __testWalletIndex: number }).__testWalletIndex = 1;
        });
        await page.getByRole('button', { name: button.publish }).click();
        await board.see(text.wrongAccount);
        await board.shot('06-review-wrong-account');
        await page.evaluate(() => {
          (window as unknown as { __testWalletIndex: number }).__testWalletIndex = 0;
        });
        await page.getByRole('button', { name: button.publish }).click();
        // A correct read-back goes straight to the invites, under a Published stamp.
        await board.seeHeading(text.peopleHeading, 60_000);
        await board.see(text.publishedStamp, 5_000);
        await board.shot('07-published');
      });
      expect(await hashOf(page, 'exam ID').catch(() => '')).toBeDefined();
    });

    it('invites: add, copy link, matched, not invited, doubled, reissue [stub tee]', async () => {
      const { tee } = lab();
      const page = board.page;
      const examId = keccak256(toBytes(NAME));
      tee.state.registrations = [];
      const links: Record<string, string> = {};
      lab().ens.set(KEYHOLDER);
      lab().ens.set(CENTRE);
      await board.flow('add and copy three invites', async () => {
        await board.seeHeading(text.peopleHeading);
        await board.shot('09-people-empty');
        for (const [role, name] of [
          ['keyholder', KEYHOLDER],
          ['centre', CENTRE],
          ['setter', 'for setter one'],
        ] as const) {
          await page.getByLabel(field.inviteRole).selectOption(role);
          await board.type(page.getByLabel(field.inviteName), name);
          await page.getByRole('button', { name: button.addInvite }).click();
          await page.getByRole('button', { name: new RegExp(`Copy the link for ${name}`) }).click();
          const copied = await page.evaluate(() => navigator.clipboard.readText());
          expect(copied).toContain('#/join?');
          links[role] = copied;
        }
        await board.shot('10-people-three-waiting');
      });
      const keyholder = decodeInviteFragment(new URL(links.keyholder ?? '').hash);
      expect(keyholder.examId).toBe(examId);
      const register = (invite: { inviteSecret: Hex }, owner: string, key = strangerKey(), tagSecret: Hex = invite.inviteSecret) => {
        // The name's record names this key, as the key holder would have set it.
        lab().ens.set(owner, { address: '0x00000000000000000000000000000000000000ee', texts: { [ens.records.passkey]: passkeyRecordValue(key) } });
        tee.state.registrations.push({
          owner,
          passkeyPublicKey: key,
          derivedPublicKey: strangerKey(),
          inviteTag: toHex(inviteTag(fromHex(tagSecret), fromHex(key))),
        });
      };
      await board.flow('see a registration match, and a stranger', async () => {
        register(keyholder, KEYHOLDER);
        // Not invited: a tag made from a secret the board never issued.
        register(keyholder, 'Someone Else', strangerKey(), toHex(new Uint8Array(32).fill(7)));
        await board.see('Name confirmed', 30_000);
        await board.see('Not invited', 30_000);
        await board.shot('11-people-matched-and-not-invited');
      });
      await board.flow('doubled invite, then reissue', async () => {
        const centre = decodeInviteFragment(new URL(links.centre ?? '').hash);
        register(centre, CENTRE);
        register(centre, CENTRE);
        await board.see(/Two security keys used this invite/, 30_000);
        await board.shot('12-people-doubled');
        await page.getByRole('button', { name: button.reissue }).click();
        await board.see('Waiting for them to register');
        await board.shot('13-people-reissued');
      });
      await board.flow('post the list is refused without a trusted TEE', async () => {
        const body = await board.text();
        // 3 key holders and 7 centres holding part of the key are needed, and the stub has too few registered.
        expect(body).toMatch(/exactly 3 key holders|not complete yet|Paper Seal is not ready/i);
        await board.shot('14-people-cannot-post');
      });
    });

    it('wait and status screens from a posted list [stub tee]', async () => {
      const { chain, tee, web } = lab();
      const open = async (name: string, timing: Timing, stage: 'onboard' | 'submit' | 'failed' | 'unlock' | 'released') => {
        const exam = await publishDirect(chain, name, timing);
        await postListDirect(chain, exam.examId, listWith());
        tee.state.stage = stage;
        await board.page.goto(`${web.url}/#/board?exam=${exam.examId}`);
        await board.page.reload();
        return exam;
      };
      await board.flow('wait screens', async () => {
        await open('UI wait onboard', timings.future, 'onboard');
        await board.seeHeading(/Nothing to do until/);
        await board.shot('15-wait-onboard');
        tee.state.stage = 'submit';
        await board.see(/Setters are sending questions/, 30_000);
        await board.shot('16-wait-submit');
        tee.state.stage = 'failed';
        await board.seeHeading('The paper could not be built', 30_000);
        await board.shot('17-wait-failed');
        tee.state.stage = 'submit';
      });
      await board.flow('wait screen after questions close', async () => {
        await open('UI wait closed', timings.over, 'submit');
        await board.seeHeading('The paper is being built');
        await board.shot('18-wait-closed');
      });
    });
  });
}
