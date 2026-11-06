/**
 * On-demand read-only check against a running Bee node, `SWARM_API_URL` or the spec's
 * `defaultApiUrl`. Not part of `pnpm test`, because it needs the node. It never buys a stamp or
 * uploads anything. Run it with `pnpm --filter @paperseal/swarm test:live`.
 */
import { describe, expect, it } from 'vitest';

import { createSwarmClient, formatBzz, SwarmApiError } from './index';

const client = createSwarmClient({ apiUrl: process.env.SWARM_API_URL });

describe('Bee node', () => {
  it('is healthy', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    console.info(`bee ${health.version}, API ${health.apiVersion}`);
  });

  it('reports its addresses', async () => {
    const addresses = await client.addresses();
    expect(addresses.overlay).toMatch(/^[0-9a-f]{64}$/);
    expect(addresses.ethereum).toMatch(/^0x[0-9a-fA-F]{40}$/);
    console.info(`overlay ${addresses.overlay}, wallet ${addresses.ethereum}`);
  });

  // Bee answers /wallet with 503 until it has synced the postage contract, so that counts too.
  it('reports its wallet, or that it is still syncing', async () => {
    try {
      const wallet = await client.wallet();
      expect(wallet.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      console.info(
        `chain ${wallet.chainId}: ${formatBzz(wallet.bzzBalance)} BZZ, ${wallet.nativeTokenBalance} wei native`,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(SwarmApiError);
      expect((error as SwarmApiError).status).toBe(503);
      console.info(`wallet unavailable: ${(error as Error).message}`);
    }
  });
});
