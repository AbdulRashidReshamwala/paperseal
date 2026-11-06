import { button, field, text } from '../ui/selectors';
import { centres, confirmOnChain, neutrals, publish, tick, waitForName } from './lib/board';
import { defineVideo, step, wait } from './lib/script';

/*
 * The exam board creates an exam on the real system. The video runs from its home page to pressing
 * Publish. The publish, the exam's name and the read-back from the chain then finish off camera, and
 * any failure there fails the run. Run it with `pnpm video create-exam`. It spends a little Sepolia ETH.
 */

export default defineVideo({
  title: 'Create an exam',
  prefix: 'class-12-physics',
  open: '/#/board',
  ready: async (s) => {
    await s.page.getByRole('button', { name: button.connectWallet }).click({ timeout: 60_000 });
    await s.page.getByRole('heading', { name: 'Your exams' }).waitFor({ timeout: 60_000 });
    await s.hold(500);
  },
  steps: [
    step('This is the board’s home page. Start a new exam', async (s) => {
      await s.click(s.page.getByRole('button', { name: 'Create an exam' }));
      await s.actor.seeHeading(text.createHeading);
    }),
    step('Give the exam a name', async (s) => {
      await s.type(s.page.getByLabel(field.examName).first(), s.label);
    }),
    step('Fill in the exam details', async (s) => {
      await s.show(s.page.getByLabel(field.examStart).first());
      await s.hold(700);
      await s.click(s.page.getByRole('button', { name: button.continue, exact: true }));
      await s.actor.seeHeading('Add the topics');
    }),
    step('Add what the paper covers', async (s) => {
      await s.hold(1500);
      await s.click(s.page.getByRole('button', { name: 'Add 2 topics with 2 questions' }));
      await s.hold(3200);
      await s.click(s.page.getByRole('button', { name: button.continue, exact: true }));
      await s.actor.seeHeading('Choose the centres');
    }),
    step('Choose the centres that will open the paper', async (s) => {
      await tick(s, centres);
      await s.hold(500);
      await s.click(s.page.getByRole('button', { name: button.continue, exact: true }));
      await s.actor.seeHeading('Choose the neutral parties');
    }),
    step('Choose the neutral key holders', async (s) => {
      await s.hold(1500);
      await tick(s, neutrals, 350);
      await s.hold(800);
      await s.click(s.page.getByRole('button', { name: button.continue, exact: true }));
      await s.actor.seeHeading(text.reviewHeading, 60_000);
    }),
    step('Check everything once more', async (s) => {
      await s.page.getByText(/the latest verified release|your choice, verified/).first().waitFor({ timeout: 90_000 });
      await s.show(s.page.getByText('Topic: Mathematics'));
      await s.hold(1200);
      await s.show(s.page.getByRole('button', { name: button.publish }));
      await s.hold(800);
    }),
    wait('Publish the exam', publish, { spends: true }),
    wait('Setting the exam name', waitForName, { spends: true }),
    // Off camera, like the name above. This fails the run if the record disagrees.
    wait('Reading the exam back from Sepolia', confirmOnChain, { hold: 0, spends: true }),
  ],
});
