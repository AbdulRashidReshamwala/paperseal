import { passkeyRecordMatches, passkeyRecordValue, type Hex } from '@paperseal/protocol';

import { plantedCards } from '../demo/cards';
import { partyParent } from '../live/roster';
import { button, field, text } from '../ui/selectors';
import { publishAndMoveMachine } from './lib/board';
import { defineVideo, step, wait, type Stage } from './lib/script';
import { retry } from './lib/world';

/*
 * An exam centre registers for an exam on the real system, by its name and its security key. Off camera
 * the board publishes a new exam and moves the sealed machine to it, and nobody else registers. The run
 * passes only if the machine lists this centre with the key on its name.
 */

const CLOSE_IN_MINUTES = 35;
const CENTRE = `centre-1.${partyParent}`;

/** Fails the run unless the machine holds this centre, under the key its name's record gives. */
async function confirmRegistered(s: Stage) {
  const card = (await plantedCards()).find(({ name }) => name === CENTRE)?.card;
  if (!card) throw new Error(`no planted card for ${CENTRE}`);
  const { registrations } = await retry('reading the machine', async () => {
    const response = await fetch(`${s.world.teeUrl}/v1/registrations`);
    if (!response.ok) throw new Error(`the machine answered ${String(response.status)}`);
    return (await response.json()) as { registrations: { owner: string; passkeyPublicKey: Hex }[] };
  });
  const entry = registrations.find(({ owner }) => owner === CENTRE);
  if (!entry) throw new Error(`the machine lists ${String(registrations.length)} registrations, and ${CENTRE} is not one of them`);
  if (!passkeyRecordMatches(card.passkey, passkeyRecordValue(entry.passkeyPublicKey))) throw new Error(`${CENTRE} is registered with a key that is not the one on its name`);
  Object.assign(s.notes, { teeRegistrations: String(registrations.length), teeOwner: entry.owner, teePasskey: entry.passkeyPublicKey });
}

export default defineVideo({
  title: 'An exam centre registers',
  prefix: 'class-12-physics',
  persona: 'centre-1',
  setup: (s) => publishAndMoveMachine(s.office, { closeInMinutes: CLOSE_IN_MINUTES }),
  open: (s) => `/#/centre/${s.label}.${partyParent}`,
  ready: async (s) => {
    await s.page.getByRole('heading', { name: 'Register for this exam' }).waitFor({ timeout: 90_000 });
    await s.page.getByText(`${s.label}.`).first().waitFor({ timeout: 60_000 });
    await s.hold(300);
  },
  steps: [
    step('This is the exam centre’s page for this exam', (s) => s.hold(2200)),
    step('The centre uses its public name', async (s) => {
      await s.page.getByLabel(field.partyName).hover();
      await s.hold(2200);
    }),
    step('The name is checked, then the security key signs', async (s) => {
      await s.hold(1300);
      await s.click(s.page.getByRole('button', { name: button.registerByName }));
      await s.actor.seeHeading(text.keyRegisteredHeading, 60_000);
    }),
    step('Registered for this exam', async (s) => {
      await s.page.mouse.move(1180, 300);
      await s.hold(900);
      await s.endHere();
    }),
    // Off camera. This fails the run if the machine does not list the centre.
    wait('Checking what the machine holds', confirmRegistered),
  ],
});
