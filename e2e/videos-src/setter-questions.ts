
import { button, composer, field, radio, text } from '../ui/selectors';
import { inviteSetters, publishAndMoveMachine, registerAllAndPostList } from './lib/board';
import { defineVideo, step, wait, type Stage } from './lib/script';
import { retry } from './lib/world';

/*
 * A setter registers, writes questions and seals them, on the real system. Off camera the board publishes
 * a new exam and moves the sealed machine to it, and `pnpm video setter-questions` spends a little Sepolia
 * ETH and one VM reset. The run passes only if the machine reports the questions it took.
 */

const CLOSE_IN_MINUTES = 30;
const SEALED = 2;

/** Off camera: a new exam, the machine on it, and the setter's invite. */
async function setup(s: Stage) {
  await publishAndMoveMachine(s.office, { closeInMinutes: CLOSE_IN_MINUTES });
  s.memo.invite = await inviteSetters(s.office);
}

const pick = async (s: Stage, name: string | RegExp) => {
  await s.hold(250);
  await s.page.getByRole('radio', { name }).check();
};

const question = (s: Stage) => s.page.getByLabel(composer.question);

async function seal(s: Stage, sealed: number) {
  await s.click(s.page.getByRole('button', { name: button.seal }));
  await s.page.getByText(composer.sealedSoFar(sealed)).first().waitFor({ timeout: 90_000 });
}

interface TeeStatus {
  stage: string;
  questionCount: number;
}

/** Fails the run unless the machine reports these questions and the page holds a receipt for each. */
async function confirmAccepted(s: Stage) {
  const status = await retry('reading the machine', async () => {
    const response = await fetch(`${s.world.teeUrl}/v1/status`);
    if (!response.ok) throw new Error(`the machine answered ${String(response.status)}`);
    return (await response.json()) as TeeStatus;
  });
  if (status.stage !== 'submit') throw new Error(`the machine is at stage ${status.stage}, not taking questions`);
  if (status.questionCount !== SEALED) throw new Error(`the machine holds ${String(status.questionCount)} questions, not ${String(SEALED)}`);
  const receipts = await s.page.getByText(/Sealed at/).count();
  if (receipts !== SEALED) throw new Error(`the page shows ${String(receipts)} confirmed receipts, not ${String(SEALED)}`);
  Object.assign(s.notes, { teeStage: status.stage, teeQuestionCount: String(status.questionCount), confirmedReceipts: String(receipts) });
}

export default defineVideo({
  title: 'A setter registers and seals questions',
  prefix: 'class-12-physics',
  persona: 'setter-1',
  setup,
  // The invite link says which exam this is, and the page moves to the exam's name in its address.
  open: (s) => new URL(s.memo.invite ?? '').hash.replace(/^#/, '/#'),
  ready: async (s) => {
    await s.page.getByRole('heading', { name: 'Register your security key' }).waitFor({ timeout: 90_000 });
    await s.page.getByText(`${s.label}.`).first().waitFor({ timeout: 60_000 });
    await s.hold(300);
  },
  steps: [
    step('Setter 1 registers with a security key', async (s) => {
      await s.hold(900);
      await s.click(s.page.getByRole('button', { name: button.register }));
      await s.actor.seeHeading(text.keyRegisteredHeading, 60_000);
    }),
    step('Registered. The security key is set for this exam', (s) => s.hold(1300)),
    wait('Waiting for the exam board to send the list', async (s) => {
      await registerAllAndPostList(s.office);
      await s.actor.seeHeading(text.writeHeading, 240_000);
    }),
    step('Write a maths question', async (s) => {
      await s.page.getByText('Getting ready for your questions…').waitFor({ state: 'hidden', timeout: 120_000 });
      await pick(s, composer.topicRadio('Mathematics'));
      await pick(s, radio.written);
      await s.type(question(s), 'Evaluate the integral of x sin x from 0 to π, showing each step of integration by parts.');
      await s.hold(500);
    }),
    wait('Seal it. Only the sealed machine can read it', (s) => seal(s, 1), { hold: 700 }),
    step('Now a physics question, multiple choice', async (s) => {
      await s.top();
      await pick(s, composer.topicRadio('Physics'));
      await pick(s, radio.multipleChoice);
      await s.type(question(s), 'A ball is thrown straight up at 20 m/s. Taking g as 10 m/s², how long until it returns to the thrower?');
    }),
    step('Add the answer options', async (s) => {
      const option = (letter: string) => s.page.getByRole('textbox', { name: field.option(letter), exact: true });
      const add = s.page.getByRole('button', { name: button.addOption, exact: true });
      await s.type(option('A'), '2 s');
      await s.type(option('B'), '4 s');
      await s.click(add);
      await s.type(option('C'), '10 s');
      await s.click(add);
      await s.type(option('D'), '20 s');
      await s.hold(500);
    }),
    wait('Seal it too', (s) => seal(s, 2)),
    step('Sealed. A receipt is kept for each question', async (s) => {
      await s.show(s.page.getByText(/Sealed at/).last());
      await s.page.getByText(/Sealed at/).nth(SEALED - 1).waitFor({ timeout: 30_000 });
      await s.hold(700);
      await s.endHere();
    }),
    // Off camera. This fails the run if the machine does not report the questions.
    wait('Checking what the machine took', confirmAccepted),
  ],
});
