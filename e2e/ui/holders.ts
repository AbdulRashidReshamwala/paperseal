import { encodeInviteLink, fromHex, newInviteSecret, toHex, type Hex, type Invite, type InviteRole } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { inviteTag, listWith, postBuildDirect, postListDirect, publishDirect, timings, type PublishedHere, type Timing } from './chainkit';
import { openActor, type Actor } from './kit';
import type { Lab } from './lab';
import { button, text } from './selectors';

/*
 * Join and Register from an invite link, then the setter, key holder and centre screens in every state
 * the exam can put them in. Real Chrome with a virtual security key does the registration (a real
 * passkey and PRF key are made in the page). The TEE is the stub [stub tee], so a registration is accepted
 * without the real TEE's checks, and every screen that needs a TRUSTED TEE shows the app's refusal.
 * What the exam is doing (list posted, Build posted, rounds) is real data on the local anvil chain.
 */

interface Enrolled {
  passkeyPublicKey: Hex;
  derivedPublicKey: Hex;
  owner: string;
}

export function holderTests(lab: () => Lab): void {
  describe('join, register and the holder screens', () => {
    const actors: Record<string, Actor> = {};
    let n = 0;
    const exam = (timing: Timing) => publishDirect(lab().chain, `UI holders ${String(++n)} ${String(Date.now())}`, timing);
    const link = (examId: Hex, role: InviteRole, owner?: string) => {
      const invite: Invite = { examId, role, ...(role === 'setter' ? {} : { owner: owner ?? 'Holder' }), inviteSecret: newInviteSecret() };
      return { invite, url: encodeInviteLink(`${lab().web.url}/`, invite) };
    };
    const actor = async (name: string, role: string) => (actors[name] ??= await openActor(lab().browser, name, null, { role }));

    /** Opens the link as the person would, clicks the one button, and returns what the TEE was sent. */
    const enroll = async (a: Actor, published: PublishedHere, role: InviteRole, owner?: string): Promise<Enrolled> => {
      const { invite, url } = link(published.examId, role, owner);
      await a.page.goto(url);
      await a.page.getByRole('button', { name: button.register }).click();
      const tag = (key: Hex) => toHex(inviteTag(fromHex(invite.inviteSecret), fromHex(key)));
      let found = lab().tee.state.registrations.find((r) => r.inviteTag === tag(r.passkeyPublicKey));
      for (let i = 0; i < 100 && !found; i++) {
        await a.page.waitForTimeout(300);
        found = lab().tee.state.registrations.find((r) => r.inviteTag === tag(r.passkeyPublicKey));
      }
      if (!found) throw new Error(`the stub TEE did not receive the registration. Page: ${(await a.text()).slice(0, 400)}`);
      return { passkeyPublicKey: found.passkeyPublicKey, derivedPublicKey: found.derivedPublicKey, owner: found.owner };
    };

    it('join: no link, damaged links and a missing secret', async () => {
      const a = await actor('visitor', 'join');
      await a.flow('open bad links', async () => {
        await a.page.goto(`${lab().web.url}/#/join`);
        await a.seeHeading(text.openLinkHeading);
        await a.shot('01-no-link');
        const published = await exam(timings.future);
        const good = new URL(link(published.examId, 'keyholder', 'X').url).hash;
        await a.page.goto(`${lab().web.url}/${good.replace(/&secret=0x[0-9a-f]+/, '')}`);
        await a.seeHeading(text.linkProblemHeading);
        await a.shot('02-missing-secret');
        const damaged = good.replace(/secret=0x[0-9a-f]{8}/, 'secret=0xzzzzzzzz');
        await a.page.goto(`${lab().web.url}/${damaged}`);
        await a.seeHeading(text.linkProblemHeading, 8000).catch(async () => {
          throw new Error(`damaged link ${damaged.slice(0, 200)} gave: ${(await a.text()).slice(0, 300)} at ${a.page.url().slice(0, 200)}`);
        });
        await a.shot('03-damaged-secret');
        await a.page.goto(`${lab().web.url}/#/join?exam=0x1234&role=keyholder`);
        await a.seeHeading(text.linkProblemHeading);
        await a.shot('04-damaged-exam');
      });
    });

    it('register from a link: setter, key holder and centre [stub tee]', async () => {
      const published = await exam(timings.future);
      for (const [name, role, uiRole] of [
        ['setter-1', 'setter', 'setter'],
        ['keyholder-1', 'keyholder', 'key holder'],
        ['centre-1', 'centre', 'centre'],
      ] as const) {
        const a = await actor(name, uiRole);
        await a.flow('register', async () => {
          const { url } = link(published.examId, role, role === 'setter' ? undefined : `${name} owner`);
          await a.page.goto(url);
          await a.page.getByRole('button', { name: button.register }).waitFor();
          await a.shot(`10-${role}-register`);
          await a.page.getByRole('button', { name: button.register }).click();
          await a.see(/security key is registered|You are registered|Waiting for your exam board/, 30_000).catch(async (e) => {
            throw new Error(`${role} after register: ${(await a.text()).slice(0, 400)} ${String(e).slice(0, 80)}`);
          });
          await a.shot(`11-${role}-registered`);
          // A reload comes back to the same place, from the stored credential.
          await a.page.reload();
          await a.see(/security key is registered|You are registered|Waiting for your exam board/, 30_000);
        });
      }
      expect(lab().tee.state.registrations.length).toBeGreaterThanOrEqual(3);
    });

    it('registration refused by the TEE shows a plain failure [stub tee]', async () => {
      const a = await actor('keyholder-1', 'key holder');
      const published = await exam(timings.future);
      lab().tee.state.registerMode = 'refuse';
      await a.flow('refused', async () => {
        await a.page.goto(link(published.examId, 'keyholder', 'Refused Person').url);
        await a.page.getByRole('button', { name: button.register }).click();
        await a.see(/refused|Something went wrong/i);
        await a.shot('12-register-refused');
      });
      lab().tee.state.registerMode = 'accept';
    });

    it('no registration is offered after the exam ends', async () => {
      const over = await exam(timings.over);
      for (const [name, role, area] of [
        ['keyholder-1', 'keyholder', 'keyholder'],
        ['centre-1', 'centre', 'centre'],
      ] as const) {
        const a = actor(name, role);
        const who = await a;
        await who.flow('ended', async () => {
          lab().tee.state.stage = 'released';
          await who.page.goto(link(over.examId, role, 'Late Person').url);
          await who.seeHeading(text.endedHeading, 30_000);
          expect(await who.page.getByRole('button', { name: button.register }).count()).toBe(0);
          await who.shot(`13-${area}-ended`);
        });
      }
      lab().tee.state.stage = 'onboard';
    });

    it('key holder: every state around the one touch [stub tee]', async () => {
      const kh = await actor('keyholder-1', 'key holder');
      const { chain, tee } = lab();
      const prep = async (timing: Timing, stage: typeof tee.state.stage, post: 'none' | 'list-with-me' | 'list-without-me') => {
        const published = await exam(timing);
        tee.state.stage = stage;
        tee.state.released = [];
        tee.state.mode = 'ok';
        const me = await enroll(kh, published, 'keyholder', 'Neutral Kim');
        if (post !== 'none') await postListDirect(chain, published.examId, listWith(post === 'list-with-me' ? { neutral: me } : {}));
        return { published, me };
      };
      await kh.flow('waiting before release', async () => {
        await prep(timings.future, 'submit', 'list-with-me');
        await kh.seeHeading(/Nothing to do yet/, 30_000);
        await kh.shot('20-waiting');
      });
      await kh.flow('registered, list not posted', async () => {
        await prep(timings.future, 'onboard', 'none');
        await kh.seeHeading(/You are registered/, 30_000);
        await kh.shot('21-awaiting-list');
      });
      await kh.flow('key not on the list', async () => {
        await prep(timings.future, 'submit', 'list-without-me');
        await kh.seeHeading(/not on the approved list/, 30_000);
        await kh.shot('22-not-on-list');
      });
      await kh.flow('release is refused without a trusted machine', async () => {
        await prep(timings.unlocked, 'unlock', 'list-with-me');
        tee.state.releaseOpen = true;
        await kh.seeHeading(text.releaseHeading, 30_000);
        await kh.shot('23-release');
        await kh.page.getByRole('button', { name: button.release }).click();
        await kh.seeHeading(text.releaseFailedHeading, 30_000);
        expect(await kh.text()).not.toMatch(/Released\b/);
        await kh.shot('24-release-refused');
        tee.state.releaseOpen = false;
      });
      await kh.flow('machine states', async () => {
        const { me } = await prep(timings.unlocked, 'submit', 'list-with-me');
        await kh.seeHeading(/Waiting for the sealed machine/, 30_000);
        await kh.shot('25-machine-waiting');
        tee.state.stage = 'failed';
        await kh.seeHeading(/sealed machine has stopped/, 30_000);
        await kh.shot('26-machine-failed');
        tee.state.stage = 'unlock';
        tee.state.mode = 'down';
        await kh.page.reload();
        await kh.see(/can't be reached|Waiting for the sealed machine|Checking the exam/, 30_000);
        tee.state.mode = 'drop';
        await kh.page.reload();
        await kh.seeHeading(/can't be reached/, 40_000);
        await kh.shot('27-machine-unreachable');
        tee.state.mode = 'ok';
        tee.state.stage = 'unlock';
        tee.state.released = [me.passkeyPublicKey];
        await kh.page.reload();
        await kh.seeHeading(/Done/, 30_000);
        await kh.shot('28-done-released');
        tee.state.released = [];
        tee.state.stage = 'released';
        await kh.page.reload();
        await kh.seeHeading(/Done/, 30_000);
        await kh.see(/not needed/);
        await kh.shot('29-not-needed');
      });
      await kh.flow('no exam published', async () => {
        await kh.page.goto(`${lab().web.url}/#/keyholder?exam=0x${'12'.repeat(32)}`);
        await kh.page.reload();
        await kh.see(/Register|invitation link|not been published/i, 30_000);
        await kh.shot('30-unknown-exam');
      });
    });

    it('centre: every state, with and without a share [stub tee]', async () => {
      const c = await actor('centre-1', 'centre');
      const { chain, tee } = lab();
      const prep = async (timing: Timing, stage: typeof tee.state.stage, share: boolean, build: boolean) => {
        const published = await exam(timing);
        tee.state.stage = stage;
        tee.state.released = [];
        tee.state.mode = 'ok';
        const me = await enroll(c, published, 'centre', 'North Centre');
        await postListDirect(chain, published.examId, listWith(share ? { centreHolder: me } : { centre: me }));
        if (build) await postBuildDirect(chain, published.examId, published.criteriaHash);
        return { published, me };
      };
      await c.flow('no paper yet', async () => {
        await prep(timings.future, 'submit', true, false);
        await c.seeHeading(/The paper has not been sealed yet/, 30_000);
        await c.shot('40-awaiting-build');
      });
      await c.flow('download that cannot be checked', async () => {
        await prep(timings.future, 'submit', true, true);
        await c.seeHeading(/Getting the sealed paper|sealed paper failed its check/, 30_000);
        await c.see(/can't be downloaded yet|failed its check|Download check/, 30_000);
        await c.shot('41-files-unavailable');
      });
      await c.flow('release for a centre with a share is refused without a trusted machine', async () => {
        await prep(timings.unlocked, 'unlock', true, true);
        tee.state.releaseOpen = true;
        await c.seeHeading(text.releaseHeading, 30_000);
        await c.shot('42-release');
        await c.page.getByRole('button', { name: button.release }).click();
        await c.seeHeading(text.releaseFailedHeading, 30_000);
        await c.shot('43-release-refused');
        tee.state.releaseOpen = false;
      });
      await c.flow('centre without a share waits for key holders', async () => {
        await prep(timings.unlocked, 'unlock', false, true);
        await c.seeHeading(/Waiting for key holders/, 30_000);
        await c.shot('44-no-share-holders');
        tee.state.stage = 'submit';
        await c.seeHeading(/Waiting for the sealed machine/, 30_000);
        await c.shot('45-machine-waiting');
        tee.state.stage = 'failed';
        await c.seeHeading(/sealed machine has stopped/, 30_000);
        await c.shot('46-machine-failed');
        tee.state.stage = 'released';
        await c.see(/Getting the sealed paper|Open the paper/, 30_000);
        await c.shot('47-released-files-pending');
      });
    });

    it('setter: the states before and after writing [stub tee]', async () => {
      const s = await actor('setter-1', 'setter');
      const { chain, tee } = lab();
      await s.flow('states', async () => {
        const open = await exam(timings.future);
        tee.state.stage = 'publish';
        tee.state.mode = 'ok';
        await s.page.goto(`${lab().web.url}/#/setter?exam=${open.examId}`);
        await s.page.reload();
        await s.seeHeading(/Registration hasn.t opened yet/, 30_000);
        await s.shot('50-not-open');
        tee.state.stage = 'onboard';
        const reg = await enroll(s, open, 'setter');
        await s.page.goto(`${lab().web.url}/#/setter?exam=${open.examId}`);
        await s.page.reload();
        await s.seeHeading(/Waiting for your exam board/, 30_000);
        await s.shot('51-waiting');
        await postListDirect(chain, open.examId, listWith({ setter: reg }));
        tee.state.stage = 'submit';
        await s.seeHeading(text.composerBlockedHeading, 45_000);
        expect(await s.page.getByRole('button', { name: button.seal }).count()).toBe(0);
        await s.shot('52-write-refused-untrusted-machine');
        tee.state.mode = 'down';
        await s.page.reload();
        await s.see(/Can.t reach the sealed system|Opening your exam/, 30_000);
        await s.shot('53-unreachable');
        tee.state.mode = 'ok';
        await postBuildDirect(chain, open.examId, open.criteriaHash);
        await s.page.reload();
        await s.seeHeading(/Questions have closed/, 30_000);
        await s.shot('54-closed-nothing-sealed');
        tee.state.stage = 'failed';
        await s.page.reload();
        await s.seeHeading(/Questions have closed|can.t go ahead/, 30_000);
      });
    });
  });
}
