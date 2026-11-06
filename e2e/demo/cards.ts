import ens from '../../spec/ens.json' with { type: 'json' };

import { plantedKey, plantedRecords } from '@paperseal/keys/demo';

import { ownerNameOf, roster } from '../live/roster';

/*
 * The planted keys as the directory needs them. They are fixed, so their records only need writing
 * once. Nothing here is secret or sends anything, and no keystore is involved.
 */

export interface PlantedCard {
  name: string;
  card: { passkey: `0x${string}`; credentialId: `0x${string}` };
}

/** Every key holder and centre on the roster, by ENS name. Setters have no name. */
export async function plantedCards(): Promise<PlantedCard[]> {
  const parties = roster.filter((entry) => entry.kind !== 'setter');
  return Promise.all(parties.map(async (entry) => ({ name: ownerNameOf(entry) as string, card: plantedRecords(await plantedKey(entry.name)) })));
}

/** The text records a name holds for a card, by record key. */
export const ensRecords = (card: PlantedCard['card']): Record<string, string> => ({
  [ens.records.passkey]: card.passkey,
  [ens.records.credential]: card.credentialId,
});
