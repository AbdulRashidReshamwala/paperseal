/**
 * On-demand read-only check of the SDK wiring against Rabdi's public RPC. Not part of `pnpm test`,
 * because it needs the network. Run it with `pnpm --filter @paperseal/arkiv test:live`.
 */
import { bytesToHex } from 'viem';
import { describe, expect, it } from 'vitest';

import { createArkivReader } from './index';

const reader = createArkivReader({ accessKey: process.env.ARKIV_ACCESS_KEY });

describe('Rabdi', () => {
  it('finds no rows for a random exam', async () => {
    const examId = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const writer = bytesToHex(crypto.getRandomValues(new Uint8Array(20)));
    expect(await reader.releaseRows(examId, [writer])).toEqual({ logs: [], tokens: [] });
  }, 30_000);

  it('reports a recent latest block', async () => {
    const { number, time } = await reader.latestBlock();
    expect(number).toBeGreaterThan(0n);
    expect(Math.abs(time - Date.now() / 1000)).toBeLessThan(600);
  }, 30_000);
});
