import {
  encodeApprovedList,
  fromHex,
  toHex,
  type ApprovedListEntry,
  type ExamSettings,
  type Hex,
} from '@paperseal/protocol';
import { createWalletClient, http, type Address } from 'viem';
import { sepolia } from 'viem/chains';

import { liveCriteria, plan, questionText } from '../live/schedule';
import type { Chain } from '../src/chain';
import { firstRoundAtOrAfter, roundTimeSeconds } from '@paperseal/protocol';

/*
 * Writes to the local anvil ExamRegistry from Node, as the board account. This is for the states the
 * screens are tested in, not for the board's own screens: where a board screen can write, the test
 * clicks it. Everything written is real registry data on a throwaway chain.
 */

// The real release v0.1.0 of the repository, as the board test already uses.
export const COMMIT = '0x00b6fd1d0e9862677e316f58f772668624d034c1' as Hex;
export const DIGEST = '0x83b4623539655ed0df9b640f3f2a7e55997ec5966fafb882fc3483b1e6172842' as Hex;

export interface Timing {
  /** Seconds from now to each moment. Negative is in the past. */
  lock: number;
  unlock: number;
  start: number;
  end: number;
}

export interface PublishedHere {
  name: string;
  examId: Hex;
  settings: ExamSettings;
  criteriaHash: Hex;
}

export const timings = {
  /** Everything is days away: registration and the list are open. */
  future: { lock: 86_400 * 2, unlock: 86_400 * 3, start: 86_400 * 3 + 600, end: 86_400 * 3 + 600 + 3 * 3600 } as Timing,
  /** Lock has passed, unlock is a minute away. */
  locked: { lock: -600, unlock: 600, start: 700, end: 700 + 3600 } as Timing,
  /** Unlock has come and the end is an hour off. */
  unlocked: { lock: -3600, unlock: -300, start: -200, end: 3600 } as Timing,
  /** The exam is over. */
  over: { lock: -86_400, unlock: -7200, start: -7000, end: -3600 } as Timing,
};

export async function publishDirect(chain: Chain, name: string, timing: Timing, rpcHost = 'sepolia.example.org'): Promise<PublishedHere> {
  const now = Math.floor(Date.now() / 1000);
  const lockRound = firstRoundAtOrAfter(now + timing.lock);
  const delta = timing.start - timing.unlock;
  const unlockRound = firstRoundAtOrAfter(now + timing.start - delta);
  const endRound = firstRoundAtOrAfter(now + timing.end);
  const base = plan(name, {
    createdAtUnix: now,
    examStart: now + timing.start,
    delta,
    lockRound: String(lockRound),
    unlockRound: String(unlockRound),
    endRound: String(endRound),
    lockAtUnix: roundTimeSeconds(lockRound),
    unlockAtUnix: roundTimeSeconds(unlockRound),
    endAtUnix: roundTimeSeconds(endRound),
  }, chain.registry);
  const settings = { ...base.settings, rpcHost };
  const wallet = createWalletClient({ account: chain.board, chain: sepolia, transport: http(chain.rpcUrl) });
  const hash = await wallet.writeContract({
    address: chain.registry,
    abi: chain.abi,
    functionName: 'createExam',
    args: [
      COMMIT,
      DIGEST,
      {
        examId: settings.examId,
        examStart: BigInt(settings.examStart),
        delta: BigInt(settings.delta),
        lockRound: BigInt(settings.lockRound),
        unlockRound: BigInt(settings.unlockRound),
        endRound: BigInt(settings.endRound),
        criteriaHash: settings.criteriaHash,
        rpcHost,
      },
      base.criteriaEncoded,
    ],
  });
  await waitMined(chain, hash);
  return { name, examId: base.examId, settings, criteriaHash: base.criteriaHash };
}

async function waitMined(chain: Chain, hash: Hex): Promise<void> {
  const { createPublicClient } = await import('viem');
  const client = createPublicClient({ chain: sepolia, transport: http(chain.rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
}

export async function postListDirect(chain: Chain, examId: Hex, entries: readonly ApprovedListEntry[]): Promise<Hex> {
  const wallet = createWalletClient({ account: chain.board, chain: sepolia, transport: http(chain.rpcUrl) });
  const hash = await wallet.writeContract({
    address: chain.registry,
    abi: chain.abi,
    functionName: 'postApprovedList',
    args: [examId, toHex(encodeApprovedList(entries))],
  });
  await waitMined(chain, hash);
  return hash;
}

export type { Address };
export { fromHex, liveCriteria, questionText };

/* ------------------------------------------------------------- Synthetic keys */

import { createECDH } from 'node:crypto';

import { inviteTag, roles, setterOwner } from '@paperseal/protocol';

/** A P-256 public key nobody holds the private half of: a stand-in for a person who is not in a window. */
export function strangerKey(): Hex {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return `0x${ecdh.getPublicKey().toString('hex')}` as Hex;
}

export { inviteTag };

/**
 * A list that passes `checkApprovedList`: 1 setter, 3 neutral parties, 7 centres with a share and 1
 * without. `real` replaces entries by role slot with keys that live in a window. Everyone else is a
 * stranger key, so the list is valid but only the replaced slots can ever act.
 */
export function listWith(real: Partial<Record<'setter' | 'neutral' | 'centreHolder' | 'centre', { owner?: string; passkeyPublicKey: Hex; derivedPublicKey?: Hex }>> = {}): ApprovedListEntry[] {
  const entry = (role: number, owner: string, passkey?: Hex, derived?: Hex): ApprovedListEntry => {
    const pk = passkey ?? strangerKey();
    return {
      role,
      passkeyPublicKey: fromHex(pk),
      derivedPublicKey: role === roles.setter ? new Uint8Array() : fromHex(derived ?? strangerKey()),
      owner: role === roles.setter ? setterOwner(fromHex(pk)) : owner,
    };
  };
  const out: ApprovedListEntry[] = [];
  out.push(entry(roles.setter, '', real.setter?.passkeyPublicKey));
  for (let i = 1; i <= 3; i++) out.push(i === 1 && real.neutral ? entry(roles.neutral, real.neutral.owner ?? 'Neutral 1', real.neutral.passkeyPublicKey, real.neutral.derivedPublicKey) : entry(roles.neutral, `Neutral ${String(i)}`));
  for (let i = 1; i <= 7; i++) out.push(i === 1 && real.centreHolder ? entry(roles.centreKeyHolder, real.centreHolder.owner ?? 'Centre 1', real.centreHolder.passkeyPublicKey, real.centreHolder.derivedPublicKey) : entry(roles.centreKeyHolder, `Centre ${String(i)}`));
  out.push(real.centre ? entry(roles.centre, real.centre.owner ?? 'Centre 8', real.centre.passkeyPublicKey, real.centre.derivedPublicKey) : entry(roles.centre, 'Centre 8'));
  return out;
}

/** Posts a Build with made-up bytes: the registry only checks shapes. The apps must catch what it carries. */
export async function postBuildDirect(chain: Chain, examId: Hex, criteriaHash: Hex): Promise<Hex> {
  const { createPublicClient } = await import('viem');
  const client = createPublicClient({ chain: sepolia, transport: http(chain.rpcUrl) });
  const list = (await client.readContract({ address: chain.registry, abi: chain.abi, functionName: 'getApprovedList', args: [examId] })) as { listHash: Hex };
  const filler = (n: number): Hex => `0x${'ab'.repeat(n)}`;
  const wallet = createWalletClient({ account: chain.board, chain: sepolia, transport: http(chain.rpcUrl) });
  const hash = await wallet.writeContract({
    address: chain.registry,
    abi: chain.abi,
    functionName: 'postBuild',
    args: [examId, list.listHash, filler(32), filler(32), filler(32), 6, 24, criteriaHash, filler(64), `0x04${'cd'.repeat(64)}`],
  });
  await waitMined(chain, hash);
  return hash;
}
