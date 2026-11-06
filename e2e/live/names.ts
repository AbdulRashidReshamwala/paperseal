import type { KeyCard } from '@paperseal/protocol';
import { examRegistryAbi } from '@paperseal/chain';
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

/** Sends every record at once with consecutive nonces, so they land in a block or two, then waits for them all. */
export async function writeNameRecords(cards: readonly { name: string; card: Pick<KeyCard, 'passkey' | 'credentialId'> }[], say: (line: string) => void): Promise<void> {
  const client = createPublicClient({ chain: sepolia, transport: http(deployed.rpcUrl), ccipRead: false });
  const resolver = (await client.getEnsResolver({ name: partyParent })) as Address;
  const board = await client.readContract({ address: deployed.registry, abi: examRegistryAbi, functionName: 'board' });
  const calls = nameRecordCalls(cards);
  let nonce = await client.getTransactionCount({ address: board, blockTag: 'pending' });
  say(`sending ${String(calls.length)} records from nonce ${String(nonce)}`);
  const hashes: Hex[] = [];
  for (const { data } of calls) {
    hashes.push(await castSend(data, resolver, 60_000, ['--async', '--nonce', String(nonce)]));
    nonce += 1;
  }
  const receipts = await Promise.all(hashes.map((hash) => client.waitForTransactionReceipt({ hash, timeout: 180_000 })));
  const reverted = receipts.findIndex((r) => r.status !== 'success');
  if (reverted >= 0) throw new Error(`${calls[reverted]?.what ?? 'a record'} reverted`);
  const blocks = new Set(receipts.map((r) => r.blockNumber));
  say(`${String(receipts.length)} records mined in ${String(blocks.size)} block(s)`);
}
