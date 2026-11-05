/**
 * On-demand check of the public RPC behaviour the registry reads rely on. Not part of
 * `pnpm test`, because it needs the network. Run it with `pnpm --filter @paperseal/chain test:live`.
 */
import { describe, expect, it } from 'vitest';

const rpcUrl = 'https://ethereum-sepolia-rpc.publicnode.com';

async function rpc(
  method: string,
  params: unknown[],
): Promise<{ result?: unknown; error?: { message: string } }> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()) as { result?: unknown; error?: { message: string } };
}

describe('PublicNode Sepolia eth_getLogs', () => {
  it('answers a single-block query', async () => {
    const head = (await rpc('eth_blockNumber', [])).result as string;
    const reply = await rpc('eth_getLogs', [{ fromBlock: head, toBlock: head }]);
    expect(reply.error).toBeUndefined();
    expect(Array.isArray(reply.result)).toBe(true);
  }, 30_000);

  it('refuses a query from earliest', async () => {
    const reply = await rpc('eth_getLogs', [{ fromBlock: 'earliest', toBlock: 'latest' }]);
    expect(reply.error?.message).toBeTruthy();
    expect(reply.result).toBeUndefined();
  }, 30_000);
});
