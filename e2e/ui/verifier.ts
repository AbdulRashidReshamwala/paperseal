import { describe, expect, it } from 'vitest';

import { listWith, postBuildDirect, postListDirect, publishDirect, timings, type Timing } from './chainkit';
import { openActor, type Actor } from './kit';
import type { Lab } from './lab';
import { stepStates, verifierText } from './selectors';
import { startApp } from '../src/chain';

/*
 * The public verifier, one chain-of-custody page. Local exams are real data on anvil. The Build posted
 * for the "bad input" cases carries made-up bytes, which the verifier must catch, so those are failures
 * on purpose. The finished-exam case reads a REAL exam on Sepolia and its real public bucket, with no
 * stub; it needs the network and is skipped, and said to be skipped, if the bucket no longer has it.
 */

const REAL_EXAM = process.env.UI_REAL_EXAM ?? '0xb59aac823a36e24a348cbef2dadc9e3a0f772939e583b500a25f8c861f3eece2';
const REAL_REGISTRY = process.env.LIVE_REGISTRY ?? '0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8';
const REAL_RPC = process.env.LIVE_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const REAL_BUCKET = process.env.LIVE_STORAGE_URL ?? 'https://storage.googleapis.com/paperseal-demo-paperseal-exams';

export const verifierResults: { name: string; states: { label: string; state: string }[] }[] = [];

export function verifierTests(lab: () => Lab): void {
  describe('verifier', () => {
    let v: Actor;
    const open = async (id: string | null, shot: string, wait = 'li[data-state]') => {
      await v.page.goto(`${lab().verifier.url}/#/${id ? `exam/${id}` : ''}`);
      await v.page.reload();
      if (wait) await v.page.locator(wait).first().waitFor({ timeout: 40_000 }).catch(() => undefined);
      // The checks read the chain and storage, so give them time to settle.
      await v.page.waitForTimeout(4000);
      const states = await stepStates(v.page);
      verifierResults.push({ name: shot, states });
      await v.shot(shot);
      return states;
    };

    it('no exam, bad input and an exam that was never published', async () => {
      v = await openActor(lab().browser, 'verifier', null, { role: 'verifier' });
      await v.flow('bad input', async () => {
        await open(null, '01-no-exam', '');
        expect(await v.text()).toMatch(/Choose an exam/);
        await v.page.getByRole('textbox', { name: /^Exam ID/ }).fill('not-an-id');
        await v.page.getByRole('button', { name: verifierText.openExam }).click();
        await v.see(verifierText.pickerError);
        await v.shot('02-picker-bad-id');
        await v.page.goto(`${lab().verifier.url}/#/exam/0xnothex`);
        await v.page.reload();
        await v.see(verifierText.invalidLink, 8000).catch(async () => {
          throw new Error(`invalid link page: ${(await v.text()).slice(0, 500)}`);
        });
        await v.shot('03-invalid-link');
        const states = await open(`0x${'34'.repeat(32)}`, '04-unknown-exam');
        // Nothing may pass for an exam that does not exist.
        expect(states.every((s) => s.state !== 'done')).toBe(true);
      });
    });

    const prepare = async (name: string, timing: Timing, how: 'exam' | 'list' | 'build') => {
      const { chain } = lab();
      const exam = await publishDirect(chain, name, timing);
      if (how !== 'exam') await postListDirect(chain, exam.examId, listWith());
      if (how === 'build') await postBuildDirect(chain, exam.examId, exam.criteriaHash);
      return exam;
    };

    it('a live exam at each point of its life (local anvil)', async () => {
      await v.flow('live states', async () => {
        const published = await prepare('Verifier live published', timings.future, 'exam');
        const s1 = await open(published.examId, '10-published-only');
        expect(s1.some((s) => s.state === 'done')).toBe(true);
        const listed = await prepare('Verifier live listed', timings.future, 'list');
        const s2 = await open(listed.examId, '11-list-posted');
        expect(s2.filter((s) => s.state === 'done').length).toBeGreaterThanOrEqual(s1.filter((s) => s.state === 'done').length);
        const locked = await prepare('Verifier live locked', timings.locked, 'list');
        await open(locked.examId, '12-locked-no-build');
        const unlocked = await prepare('Verifier live unlocked', timings.unlocked, 'list');
        await open(unlocked.examId, '13-unlocked-no-build');
      });
    });

    it('a Build the verifier must not accept (made-up bytes on anvil)', async () => {
      await v.flow('bad build', async () => {
        const bad = await prepare('Verifier bad build', timings.unlocked, 'build');
        // First the Build alone: its files cannot be read, so the verifier must not say they pass.
        const before = await open(bad.examId, '20-build-files-missing');
        expect(before.some((s) => s.state === 'failed')).toBe(false);
        // Then a manifest that is not the one the Build commits to, served from the stub bucket.
        lab().storage.files.set(`${bad.examId}/manifest.json`, new TextEncoder().encode('{"not":"the manifest"}'));
        const states = await open(bad.examId, '21-build-wrong-manifest');
        expect(states.some((s) => s.state === 'failed')).toBe(true);
        expect(await v.page.locator('[role="alert"]').count()).toBeGreaterThan(0);
        const over = await prepare('Verifier bad build over', timings.over, 'build');
        lab().storage.files.set(`${over.examId}/manifest.json`, new TextEncoder().encode('{"not":"the manifest"}'));
        await open(over.examId, '22-over-bad-build');
      });
    });

    it('a finished exam: real Sepolia and the real bucket, no stub', async () => {
      const ok = await fetch(`${REAL_BUCKET}/${REAL_EXAM}/manifest.json`).then((r) => r.ok, () => false);
      if (!ok) {
        console.log(`SKIPPED finished exam: ${REAL_EXAM} is not in the bucket any more`);
        return;
      }
      const real = await startApp('apps/verifier', { VITE_RPC_URL: REAL_RPC, VITE_REGISTRY_ADDRESS: REAL_REGISTRY, VITE_STORAGE_URL: REAL_BUCKET }, { host: 'localhost' });
      try {
        await v.flow('finished exam', async () => {
          await v.page.goto(`${real.url}/#/exam/${REAL_EXAM}`);
          await v.page.reload();
          await v.page.locator('li[data-state]').first().waitFor({ timeout: 60_000 });
          await v.page.waitForTimeout(25_000);
          const states = await stepStates(v.page);
          verifierResults.push({ name: 'finished-real', states });
          await v.shot('30-finished-real');
          expect(states.length).toBeGreaterThan(5);
        });
      } finally {
        await real.stop();
      }
    });
  });
}
