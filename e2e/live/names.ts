import type { KeyCard } from '@paperseal/protocol';
import { createPublicClient, http, type Address } from 'viem';
import { sepolia } from 'viem/chains';

import { directoryCall, partyCalls, type RecordCall } from '../../deploy/ens/records.mjs';
import { castSend } from './cast';
import { deployed } from './config';
import { partyParent } from './roster';

/*
 * The demo directory for one run. Virtual keys die with the browser, so every run enrols new keys and
 * writes their records again, with the same commands `deploy/ens/records.mjs` prints, sent from the
 * board keystore, which owns the demo directory.
 */

/** The calls for these cards, then the directory that lists them. Pure, so the dry check can inspect it offline. */
export function nameRecordCalls(cards: readonly { name: string; card: Pick<KeyCard, 'passkey' | 'credentialId'> }[]): RecordCall[] {
  return [...cards.flatMap(({ name, card }) => partyCalls(name, card)), directoryCall(partyParent, cards.map(({ name }) => name))];
}

/** Sends every record, one transaction at a time, because they share one nonce. */
export async function writeNameRecords(cards: readonly { name: string; card: KeyCard }[], say: (line: string) => void): Promise<void> {
  const client = createPublicClient({ chain: sepolia, transport: http(deployed.rpcUrl), ccipRead: false });
  const resolver = (await client.getEnsResolver({ name: partyParent })) as Address;
  for (const { what, data } of nameRecordCalls(cards)) {
    say(`writing ${what}`);
    await castSend(data, resolver);
  }
}
