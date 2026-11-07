import { plantedKey } from '@paperseal/keys/demo';
import { decodeCriteria, examIdFromName, fromHex, selectedCount, toHex } from '@paperseal/protocol';

import { plantedCards } from '../demo/cards';
import { partyParent } from '../live/roster';
import { centre } from '../ui/selectors';
import { defineVideo, step, wait, type Stage } from './lib/script';
import { retry } from './lib/world';

/*
 * A centre opens the paper and hands it out. It needs an exam already released, so it runs only on one:
 * `pnpm video centre-handout --resume=<exam name>`. Nothing is sent on chain. Handing out is the page's
 * own demonstration, so nothing reaches a room and the captions say so.
 */

const PERSONA = 'centre-1';
const CENTRE = `${PERSONA}.${partyParent}`;
const nameOf = (s: Stage) => `${s.label}.${partyParent}`;

/** Fails the run unless the page shows the paper that passed its check, with every question the Build selected. */
async function confirmOpened(s: Stage) {
  await s.page.getByText('It passed its check against the public record.').waitFor({ timeout: 15_000 });
  const encoded = await retry('reading the topics', () => s.world.registry.getCriteria(examIdFromName(s.label)));
  if (!encoded) throw new Error('the exam has no topics on the public record');
  const expected = selectedCount(decodeCriteria(fromHex(encoded)));
  const shown = await s.page.locator('.paper-sheet li[data-block]').count();
  if (shown !== expected) throw new Error(`the paper shows ${String(shown)} questions, and the exam selects ${String(expected)}`);
  Object.assign(s.notes, {
    viewerTitle: await s.page.locator('.paper-page-head').first().innerText(),
    viewerPages: await s.page.locator('.paper-count').innerText(),
    viewerQuestions: String(shown),
    viewerOptionLists: String(await s.page.locator('.paper-options').count()),
    viewerTallPages: String(await s.page.locator('.paper-frame[data-tall]').count()),
    firstQuestion: (await s.page.locator('.paper-sheet li[data-block]').first().innerText()).slice(0, 90),
  });
}

/** The hand out's real end state: every room marked, and the button says so. */
async function confirmSent(s: Stage) {
  const rows = await s.page.getByText(centre.sentInDemo).count();
  if (rows !== 3) throw new Error(`${String(rows)} rooms show as sent, not 3`);
  await s.page.getByRole('button', { name: 'Sent to all rooms (demo)' }).waitFor({ timeout: 5000 });
  s.notes.handOut = `${String(rows)} rooms marked as sent (demo)`;
}

/**
 * Registration has closed on a released exam, so a new browser can't learn the centre's key the usual way.
 * This writes what the app itself keeps once a centre has registered: its name, credential ID and public
 * key, all public. It gives no access by itself. Opening the paper still takes the planted key.
 */
async function rememberCentre(s: Stage) {
  const card = (await plantedCards()).find(({ name }) => name === CENTRE)?.card;
  if (!card) throw new Error(`no planted card for ${CENTRE}`);
  const credential = { owner: CENTRE, credentialId: card.credentialId.toLowerCase(), passkeyPublicKey: toHex((await plantedKey(PERSONA)).publicKey).toLowerCase() };
  const examId = examIdFromName(s.label).toLowerCase();
  await s.page.evaluate(
    ([id, person, stored]) => {
      for (const role of ['centre', 'keyholder']) localStorage.setItem(`paperseal-demo.of.${person as string}.paperseal.credential.${id as string}.${role}`, JSON.stringify({ ...JSON.parse(stored as string), role }));
    },
    [examId, PERSONA, JSON.stringify(credential)],
  );
  await s.page.reload();
}

export default defineVideo({
  title: 'A centre opens the paper and hands it out',
  prefix: 'class-12-physics',
  persona: PERSONA,
  setup: () => Promise.reject(new Error('this video runs on an exam already released: use --resume=<exam name>')),
  resume: (s) => {
    Object.assign(s.notes, { examId: examIdFromName(s.label), name: nameOf(s), resumed: 'yes' });
    return Promise.resolve();
  },
  open: (s) => `/#/centre/${nameOf(s)}`,
  ready: async (s) => {
    await rememberCentre(s);
    const open = s.page.getByRole('button', { name: centre.openPaper });
    await open.waitFor({ timeout: 180_000 });
    await s.page.getByText(`${s.label}.`).first().waitFor({ timeout: 60_000 });
    await s.hold(300);
  },
  steps: [
    step('The key is out. The centre opens the paper', async (s) => {
      await s.hold(1500);
      await s.click(s.page.getByRole('button', { name: centre.openPaper }));
    }),
    wait('Checking it against the public record', async (s) => {
      await s.page.locator('.paper-sheet .paper-page').first().waitFor({ timeout: 120_000 });
      await s.actor.seeHeading(centre.paperOpenHeading, 30_000);
    }),
    step('The paper is open. It passed its check', async (s) => {
      await confirmOpened(s);
      await s.hold(1800);
    }),
    step('It reads like a printed paper, on A4 pages', async (s) => {
      // A short scroll of the page, up to the viewer's toolbar, so every question shows. The wheel would move
      // the sheet inside the viewer instead, and past the questions that sheet is blank.
      await s.page.locator('.paper-toolbar').evaluate((el) => {
        scrollBy({ top: el.getBoundingClientRect().top - 44, behavior: 'smooth' });
      });
      await s.hold(2400);
    }),
    step('The raw data is one click away', async (s) => {
      await s.click(s.page.getByRole('button', { name: 'Raw data' }));
      await s.hold(1500);
      await s.click(s.page.getByRole('button', { name: 'Paper', exact: true }));
      await s.hold(900);
    }),
    step('Now hand out the paper. This step is a demo', async (s) => {
      await s.hold(900);
      await s.click(s.page.getByRole('button', { name: centre.handOut }));
      await s.actor.seeHeading(centre.handOutHeading, 15_000);
    }),
    step('Set the copies for each room', async (s) => {
      await s.type(s.page.getByLabel(centre.copiesFor('Room 1')), '35');
      await s.type(s.page.getByLabel(centre.copiesFor('Room 2')), '32');
      await s.type(s.page.getByLabel(centre.copiesFor('Room 3')), '28');
      await s.hold(500);
    }),
    step('Send them. Nothing really goes to any room', async (s) => {
      await s.click(s.page.getByRole('button', { name: centre.sendToRooms }));
      await s.page.getByText(centre.sentInDemo).nth(2).waitFor({ timeout: 30_000 });
    }),
    step('Marked as sent, in this demo only', async (s) => {
      await s.show(s.page.getByRole('button', { name: 'Sent to all rooms (demo)' }));
      await s.page.mouse.move(1180, 300);
      await s.hold(800);
      await s.endHere();
    }),
    // Off camera. This fails the run if the page did not reach its sent state.
    wait('Checking the hand out finished', confirmSent),
  ],
});
