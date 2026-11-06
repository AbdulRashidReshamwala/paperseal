import type { KeyCard } from '@paperseal/protocol';
import { createPublicClient, http, type Address, type Hex } from 'viem';
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
    await sendRecord(data, resolver);
  }
}

/** A public RPC is several nodes, and the next one asked can be a block behind. A record is safe to write twice. */
async function sendRecord(data: Hex, resolver: Address): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await castSend(data, resolver);
      return;
    } catch (error) {
      const stale = /nonce too low|already known|underpriced/i.test(String(error));
      if (!stale || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
  }
}
