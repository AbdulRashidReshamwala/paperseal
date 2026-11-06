import { arkiv } from '@paperseal/arkiv';
import {
  bucketDepth,
  formatBzz,
  minAmount,
  stampCost,
  type Addresses,
  type ChainState,
  type Health,
  type PostageBatch,
  type SwarmClient,
  type Wallet,
} from '@paperseal/swarm';
import { formatEther } from 'viem';

import { recommendedBatch, type SwarmApi } from './args';
import { ttlText } from './backup';
import { errorText } from './output';

/*
 * `swarm-status` (read-only) and `buy-stamp`. Batch prices come from @paperseal/swarm's
 * `stampCost` and `minAmount`. A batch's balance drains by `currentPrice` PLUR per chunk per block
 * of the chain its postage contract is on, so how long an amount lasts depends on that chain's
 * block time.
 */

/** The chains Bee's postage contract runs on, by `swarm.network` in spec/arkiv.json. */
export const swarmNetworks = {
  sepolia: { chainId: 11_155_111, blockSeconds: 12, bzz: 'sBZZ', native: 'ETH' },
  mainnet: { chainId: 100, blockSeconds: 5, bzz: 'xBZZ', native: 'xDAI' },
} as const;

export type SwarmNetwork = (typeof swarmNetworks)[keyof typeof swarmNetworks];

/** The network of a wallet's chain, else of `swarm.network` in spec/arkiv.json. */
export function networkFor(chainId: number | undefined): { name: string; network: SwarmNetwork } {
  for (const [name, network] of Object.entries(swarmNetworks)) {
    if (network.chainId === chainId) return { name, network };
  }
  const name = arkiv.swarm.network as keyof typeof swarmNetworks;
  return { name, network: swarmNetworks[name] };
}

export interface BatchQuote {
  depth: number;
  days: number;
  blockSeconds: number;
  /** Blocks in `days`, rounded up. */
  blocks: bigint;
  /** PLUR per chunk: enough for `days`, and never below Bee's `minAmount`. */
  amount: bigint;
  /** Bee's own minimum, `minAmount(chainState)`. */
  minAmount: bigint;
  /** `days` alone would have been below Bee's minimum. */
  raised: boolean;
  plur: bigint;
  bzz: string;
}

/** What a batch of `depth` lasting `days` costs at the current price. */
export function batchQuote(chain: ChainState, depth: number, days: number, network: SwarmNetwork): BatchQuote {
  if (chain.currentPrice <= 0n) throw new Error('Bee reports no postage price yet (currentPrice 0): it has not synced the postage contract');
  const seconds = BigInt(days) * 86_400n;
  const step = BigInt(network.blockSeconds);
  const blocks = (seconds + step - 1n) / step;
  const floor = minAmount(chain);
  const forDays = chain.currentPrice * blocks;
  const amount = forDays > floor ? forDays : floor;
  const { plur, bzz } = stampCost({ amount, depth });
  return { depth, days, blockSeconds: network.blockSeconds, blocks, amount, minAmount: floor, raised: forDays < floor, plur, bzz };
}

export function quoteLines(quote: BatchQuote, network: SwarmNetwork): string[] {
  const chunks = 1n << BigInt(quote.depth);
  return [
    `  depth     ${String(quote.depth)}: ${chunks.toString()} chunks of ${String(arkiv.swarm.chunkBytes)} bytes, at most; fewer fill in practice (see the Swarm docs' effective volume table)`,
    `  amount    ${quote.amount.toString()} PLUR per chunk: ${quote.blocks.toString()} blocks of ${String(quote.blockSeconds)}s for ${String(quote.days)} days${quote.raised ? ', raised to Bee\'s minimum' : ''} (Bee's minimum ${quote.minAmount.toString()})`,
    `  cost      ${quote.plur.toString()} PLUR = ${quote.bzz} ${network.bzz}`,
  ];
}

/**
 * Bee trails the chain tip by a few blocks even when it is in step, because it waits for
 * confirmations, so a gap this small isn't syncing. On Sepolia it is under 2 minutes.
 */
export const syncLagBlocks = 10;

/** Bee hasn't processed the postage contract up to near the chain tip, so its price may be stale. */
export const syncing = (chain: ChainState): boolean => chain.chainTip - chain.block > syncLagBlocks;
const syncNote = '          note: Bee is still syncing the postage contract, so this price may change and batches may be unavailable';

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SwarmSnapshot {
  api: SwarmApi;
  health: Settled<Health>;
  addresses: Settled<Addresses>;
  wallet: Settled<Wallet>;
  chainState: Settled<ChainState>;
  stamps: Settled<PostageBatch[]>;
}

async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** Every read-only endpoint, each on its own: Bee answers some with 503 until it has synced. */
export async function swarmSnapshot(api: SwarmApi, client: Pick<SwarmClient, 'health' | 'addresses' | 'wallet' | 'chainState' | 'stamps'>): Promise<SwarmSnapshot> {
  const [health, addresses, wallet, chainState, stamps] = await Promise.all([
    settle(() => client.health()),
    settle(() => client.addresses()),
    settle(() => client.wallet()),
    settle(() => client.chainState()),
    settle(() => client.stamps()),
  ]);
  return { api, health, addresses, wallet, chainState, stamps };
}

const sourceText = { '--swarm': 'from --swarm', RELAY_SWARM_API: 'from RELAY_SWARM_API', default: 'swarm.defaultApiUrl in spec/arkiv.json' } as const;

export const apiLine = (api: SwarmApi): string => `Bee API   ${api.url} (${sourceText[api.source]})`;

export function batchLine(batch: PostageBatch): string {
  const capacity = 2 ** (batch.depth - batch.bucketDepth);
  const percent = ((batch.utilization / capacity) * 100).toFixed(1);
  return `  ${batch.batchId}  depth ${String(batch.depth)}  ${batch.usable ? 'usable' : 'NOT usable'}  utilization ${String(batch.utilization)}/${String(capacity)} (${percent}%)  ttl ${ttlText(batch.ttlSeconds)}${batch.label ? `  label ${batch.label}` : ''}${batch.immutable ? '' : '  mutable'}`;
}

export function swarmStatusLines(snapshot: SwarmSnapshot): string[] {
  const lines = [apiLine(snapshot.api)];
  const { health, addresses, wallet, chainState, stamps } = snapshot;
  lines.push(health.ok ? `health    ${health.value.status}, Bee ${health.value.version}, API ${health.value.apiVersion}` : `health    unavailable: ${health.error}`);
  lines.push(addresses.ok ? `node      ${addresses.value.ethereum} (overlay ${addresses.value.overlay})` : `node      unavailable: ${addresses.error}`);

  const { name, network } = networkFor(wallet.ok ? wallet.value.chainId : undefined);
  if (wallet.ok) {
    const w = wallet.value;
    lines.push(`wallet    ${w.walletAddress} on chain ${String(w.chainId)}${w.chainId === network.chainId ? ` (${name})` : ''}`);
    lines.push(`          ${formatBzz(w.bzzBalance)} ${network.bzz} (${w.bzzBalance.toString()} PLUR), ${formatEther(w.nativeTokenBalance)} ${network.native}`);
    if (w.chainId !== swarmNetworks[arkiv.swarm.network as keyof typeof swarmNetworks].chainId) {
      lines.push(`          note: swarm.network in spec/arkiv.json is ${arkiv.swarm.network}, but this node is on chain ${String(w.chainId)}`);
    }
  } else {
    lines.push(`wallet    unavailable: ${wallet.error}`);
  }

  if (chainState.ok) {
    const c = chainState.value;
    lines.push(`price     ${c.currentPrice.toString()} PLUR per chunk per block; block ${String(c.block)} of tip ${String(c.chainTip)}${c.minimumValidityBlocks === undefined ? '' : `; minimum validity ${String(c.minimumValidityBlocks)} blocks`}`);
    if (syncing(c)) lines.push(syncNote);
  } else {
    lines.push(`price     unavailable: ${chainState.error}`);
  }

  if (stamps.ok) {
    lines.push(`batches   ${String(stamps.value.length)}${stamps.value.length === 0 ? ' (buy one with buy-stamp)' : ''}`);
    for (const batch of stamps.value) lines.push(batchLine(batch));
  } else {
    lines.push(`batches   unavailable: ${stamps.error}`);
  }

  lines.push(`recommended batch: depth ${String(recommendedBatch.depth)} for ${String(recommendedBatch.days)} days (bucket depth ${String(bucketDepth)}), not bought`);
  if (chainState.ok) {
    try {
      lines.push(...quoteLines(batchQuote(chainState.value, recommendedBatch.depth, recommendedBatch.days, network), network));
      lines.push(`  buy it:   node relay/cli.mjs buy-stamp --depth ${String(recommendedBatch.depth)} --days ${String(recommendedBatch.days)} --yes`);
    } catch (error) {
      lines.push(`  no quote: ${errorText(error)}`);
    }
  } else {
    lines.push('  no quote: the price is unavailable');
  }
  return lines;
}

export interface BuyRequest {
  api: SwarmApi;
  depth: number;
  days: number;
  label: string | undefined;
  yes: boolean;
}

export interface BuyOutcome {
  lines: string[];
  /** The new batch, only when bought. */
  batchId?: string;
  exitCode: number;
}

/** Quotes the batch. Without `yes` it stops there; with it, it buys. */
export async function buyStamp(request: BuyRequest, client: Pick<SwarmClient, 'chainState' | 'wallet' | 'buyStamp'>): Promise<BuyOutcome> {
  const lines = [apiLine(request.api)];
  const chain = await client.chainState();
  let wallet: Wallet | undefined;
  let walletError: string | undefined;
  try {
    wallet = await client.wallet();
  } catch (error) {
    walletError = errorText(error);
  }
  const { network } = networkFor(wallet?.chainId);
  const quote = batchQuote(chain, request.depth, request.days, network);
  lines.push(`postage batch quote (current price ${chain.currentPrice.toString()} PLUR per chunk per block):`, ...quoteLines(quote, network));
  if (syncing(chain)) lines.push(syncNote);

  if (wallet) {
    lines.push(`  wallet    ${formatBzz(wallet.bzzBalance)} ${network.bzz} on ${wallet.walletAddress}`);
    if (wallet.bzzBalance < quote.plur) {
      lines.push(`not bought: the wallet holds ${formatBzz(wallet.bzzBalance)} ${network.bzz}, less than the ${quote.bzz} ${network.bzz} this batch costs`);
      return { lines, exitCode: 1 };
    }
  } else {
    lines.push(`  wallet    unavailable: ${walletError ?? 'unknown'}`);
  }

  if (!request.yes) {
    lines.push(
      'not bought: nothing was spent.',
      `To buy it, run the same command with --yes: node relay/cli.mjs buy-stamp --depth ${String(request.depth)} --days ${String(request.days)}${request.label === undefined ? '' : ` --label ${JSON.stringify(request.label)}`} --yes`,
    );
    return { lines, exitCode: 0 };
  }

  if (syncing(chain)) {
    lines.push(`not bought: Bee has processed block ${String(chain.block)} of ${String(chain.chainTip)}, so the price may be stale and the batch could last less than ${String(request.days)} days. Try again once swarm-status shows no sync note.`);
    return { lines, exitCode: 1 };
  }

  const batchId = await client.buyStamp({ amount: quote.amount, depth: request.depth, ...(request.label === undefined ? {} : { label: request.label }) });
  lines.push(
    `bought    batch ${batchId} for ${quote.bzz} ${network.bzz}`,
    '          Bee waits for confirmations before the batch is usable; check swarm-status, then pass it to backup --batch.',
  );
  return { lines, batchId, exitCode: 0 };
}
