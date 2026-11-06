/**
 * On-demand read-only check of the SDK wiring against Rabdi's public RPC. Not part of `pnpm test`,
 * because it needs the network. Run it with `pnpm --filter @paperseal/arkiv test:live`.
 */
import { bytesToHex } from 'viem';
import { describe, expect, it } from 'vitest';

import { createArkivReader } from './index';

const reader = createArkivReader({ accessKey: process.env.ARKIV_ACCESS_KEY });

describe('Rabdi', () => {
  it('finds no rows or heartbeats for a random exam', async () => {
    const examId = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const writer = bytesToHex(crypto.getRandomValues(new Uint8Array(20)));
    const registry = bytesToHex(crypto.getRandomValues(new Uint8Array(20)));
    const empty = { logs: [], tokens: [], heartbeats: [] };
    expect(await reader.releaseRows(examId, [writer])).toEqual(empty);
    expect(await reader.releaseRows(examId, [writer], { registry })).toEqual(empty);
  }, 30_000);

  it('finds no exam or participant rows for a random registry and writer', async () => {
    const writer = bytesToHex(crypto.getRandomValues(new Uint8Array(20)));
    const registry = bytesToHex(crypto.getRandomValues(new Uint8Array(20)));
    const passkeyKeyHash = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    expect(await reader.examRows(registry, [writer])).toEqual([]);
    expect(await reader.participantRows({ owner: 'nobody.example' }, [writer])).toEqual([]);
    expect(await reader.participantRows({ registry, passkeyKeyHash }, [writer])).toEqual([]);
  }, 30_000);

  it('reports a recent latest block', async () => {
    const { number, time } = await reader.latestBlock();
    expect(number).toBeGreaterThan(0n);
    expect(Math.abs(time - Date.now() / 1000)).toBeLessThan(600);
  }, 30_000);
});
