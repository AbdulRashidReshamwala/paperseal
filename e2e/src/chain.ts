import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';

import { freePort, httpOk, spawnManaged, stop, waitFor } from './procs';

/** The real compiled ExamRegistry from `forge build`. */
const artifactPath = resolve(import.meta.dirname, '../../contracts/out/ExamRegistry.sol/ExamRegistry.json');
export const repoRoot = resolve(import.meta.dirname, '../..');

export interface Chain {
  rpcUrl: string;
  accounts: Address[];
  board: Address;
  registry: Address;
  abi: Abi;
  stop: () => Promise<void>;
}

export const rpcCall = async (rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
};

/**
 * Starts `anvil --chain-id 11155111` and deploys the real ExamRegistry with BOARD set to anvil's
 * first unlocked account. No key is used anywhere: anvil signs for its own accounts.
 */
export async function startChain(): Promise<Chain> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${String(port)}`;
  const anvil = spawnManaged('anvil', ['--chain-id', '11155111', '--port', String(port), '--silent'], { label: 'anvil' });
  await waitFor('anvil', async () => (await rpcCall(rpcUrl, 'eth_chainId')) === '0xaa36a7', 30_000, anvil);

  const accounts = (await rpcCall(rpcUrl, 'eth_accounts')) as Address[];
  const board = accounts[0];
  if (!board) throw new Error('anvil exposes no accounts');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const wallet = createWalletClient({ account: board, chain: sepolia, transport: http(rpcUrl) });
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [board] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress || receipt.status !== 'success') throw new Error('ExamRegistry was not deployed');
  return {
    rpcUrl,
    accounts,
    board,
    registry: receipt.contractAddress,
    abi: artifact.abi,
    stop: () => stop(anvil),
  };
}

export function publicClientFor(chain: Chain) {
  return createPublicClient({ chain: sepolia, transport: http(chain.rpcUrl) });
}

/** `cast call`, the Foundry CLI, as a second reader that shares no code with the app. */
export function cast(chain: Chain, signature: string, ...args: string[]): string {
  const run = spawnSync('cast', ['call', chain.registry, signature, ...args, '--rpc-url', chain.rpcUrl], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`cast call failed: ${run.stderr || run.stdout}`);
  return run.stdout.trim();
}

/** Starts a Vite dev server of one app on its own port, with the given VITE_ variables. */
export async function startApp(dir: string, env: Record<string, string>): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const cwd = resolve(repoRoot, dir);
  // vite.config.ts sets strictPort on 5171/5172, which may be taken, so the CLI overrides the port.
  const server = spawnManaged('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd,
    env,
    label: `vite ${dir}`,
  });
  const url = `http://127.0.0.1:${String(port)}`;
  await waitFor(`${dir} dev server`, httpOk(url), 90_000, server);
  return {
    url,
    stop: () => stop(server),
  };
}
