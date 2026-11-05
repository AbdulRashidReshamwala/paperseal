import { createExamRegistry, examRegistryAbi, type ExamRegistry } from '@paperseal/chain';
import { chain, type Hex } from '@paperseal/protocol';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';

import { calldata, castSend, type RegistryWrite } from './cast';
import { deployed } from './config';
import { retryTransient } from './util';

export interface ChainIo {
  client: PublicClient;
  registry: ExamRegistry;
  /** Retries a read on transient RPC errors only. */
  read: <T>(run: () => Promise<T>) => Promise<T>;
}

export function connectChain(): ChainIo {
  const client = createPublicClient({ chain: sepolia, transport: http(deployed.rpcUrl, { retryCount: 2, timeout: 25_000 }) });
  const registry = createExamRegistry({ address: deployed.registry, rpcUrl: deployed.rpcUrl });
  return { client, registry, read: (run) => retryTransient(run) };
}

/** Checks the RPC is Sepolia and the registry address holds code. */
export async function checkDeployment(io: ChainIo): Promise<string> {
  const id = await io.read(() => io.client.getChainId());
  if (id !== chain.chainId) throw new Error(`the RPC is on chain ${String(id)}, not Sepolia ${String(chain.chainId)}`);
  const code = await io.read(() => io.client.getCode({ address: deployed.registry }));
  if (!code || code === '0x') throw new Error(`no contract at ${deployed.registry}`);
  const board = await io.read(() => io.registry.board());
  return `Sepolia, ExamRegistry ${deployed.registry}, board ${board}`;
}

/**
 * Dry-runs the call from the board address (an `eth_call`, free), signs and sends it with cast,
 * then waits for a successful receipt. Not retried after the send: a second send could duplicate
 * the transaction. Callers read the result back from the chain and re-check state instead.
 */
export async function boardSend(
  io: ChainIo,
  functionName: RegistryWrite,
  args: readonly unknown[],
): Promise<{ transactionHash: Hex; blockNumber: bigint }> {
  const board = await io.read(() => io.registry.board());
  await io.read(() =>
    io.client.simulateContract({
      address: deployed.registry as Address,
      abi: examRegistryAbi,
      functionName,
      args,
      account: board,
    } as Parameters<PublicClient['simulateContract']>[0]),
  );
  const transactionHash = await castSend(calldata(functionName, args));
  const receipt = await retryTransient(() => io.client.waitForTransactionReceipt({ hash: transactionHash, timeout: 10 * 60_000 }));
  if (receipt.status !== 'success') throw new Error(`transaction ${transactionHash} was mined but reverted`);
  return { transactionHash, blockNumber: receipt.blockNumber };
}
