import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  custom,
  HttpRequestError,
  type Address,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { ens } from '@paperseal/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnsLookup, examRegistryAbi, resolveExamName, type EnsLookup } from './index';

const name = 'jee-main-2026.paperseal-mumbai.eth';
const parent = 'paperseal-mumbai.eth';
const examId: Hex = '0xa8ec8fb4eda3d90b6190127d877227895bcd634a849e7f3a355311ed10637556';
const registry: Address = '0x00000000000000000000000000000000000000aa';
const board: Address = '0x00000000000000000000000000000000000000bB';
const records: Record<string, string> = {
  [ens.records.tee]: 'https://tee.example.org',
  [ens.records.storage]: 'https://storage.example.org/jee',
  [ens.records.bucket]: 'paperseal-jee',
};

/** A fake of the four reads, for a correctly set up name. Each test overrides the one it breaks. */
function lookup(overrides: Partial<EnsLookup> = {}): EnsLookup {
  return {
    address: (n) => Promise.resolve(n === name ? registry : n === parent ? board.toLowerCase() as Address : null),
    primaryName: (a) => Promise.resolve(a === board ? parent : null),
    text: (n, key) => Promise.resolve(n === name ? (records[key] ?? null) : null),
    board: (r) => Promise.resolve(r === registry ? board : '0x0000000000000000000000000000000000000000'),
    ...overrides,
  };
}

const reverted = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: examRegistryAbi, functionName: 'board', message: 'execution reverted' }),
    { abi: examRegistryAbi, functionName: 'board', contractAddress: registry },
  );

describe('resolveExamName', () => {
  it('returns every field for a name that checks out', async () => {
    expect(await resolveExamName(name, { lookup: lookup() })).toEqual({
      ok: true,
      value: {
        name,
        label: 'jee-main-2026',
        parent,
        examId,
        registry,
        board,
        teeUrl: 'https://tee.example.org',
        storageUrl: 'https://storage.example.org/jee',
        bucket: 'paperseal-jee',
      },
    });
  });

  it('fails name on a label that is not an exam name', async () => {
    const result = await resolveExamName('Maths 2026.x.eth', { lookup: lookup() });
    expect(result).toMatchObject({ ok: false, failed: 'name', partial: { label: 'Maths 2026', parent: 'x.eth' } });
    expect(result.ok || result.partial.examId).toBeUndefined();
  });

  it('fails name on a name that is not normalised', async () => {
    expect(await resolveExamName('JEE-MAIN-2026.PAPERSEAL-MUMBAI.ETH', { lookup: lookup() })).toMatchObject({
      ok: false,
      failed: 'name',
    });
    // The label is fine, so the examId is known, but the parent isn't normalised.
    expect(await resolveExamName('jee-main-2026.Paperseal-Mumbai.eth', { lookup: lookup() })).toMatchObject({
      ok: false,
      failed: 'name',
      reason: expect.stringContaining('paperseal-mumbai.eth') as string,
      partial: { examId },
    });
    for (const bad of ['', 'jee-main-2026', 'jee-main-2026.']) {
      expect(await resolveExamName(bad, { lookup: lookup() }), bad).toMatchObject({ ok: false, failed: 'name' });
    }
  });

  it('fails registry when the name has no address', async () => {
    const result = await resolveExamName(name, { lookup: lookup({ address: () => Promise.resolve(null) }) });
    expect(result).toMatchObject({ ok: false, failed: 'registry', partial: { examId } });
    expect(result.ok || result.partial.registry).toBeUndefined();
  });

  it('fails registry when board() reverts', async () => {
    const result = await resolveExamName(name, { lookup: lookup({ board: () => Promise.reject(reverted()) }) });
    expect(result).toMatchObject({ ok: false, failed: 'registry', partial: { registry } });
  });

  it('fails primaryName on a look-alike parent', async () => {
    const result = await resolveExamName(name, {
      lookup: lookup({ primaryName: () => Promise.resolve('paperseal-mumbaí.eth') }),
    });
    expect(result).toMatchObject({ ok: false, failed: 'primaryName', partial: { registry, board } });
    expect(
      await resolveExamName(name, { lookup: lookup({ primaryName: () => Promise.resolve(null) }) }),
    ).toMatchObject({ ok: false, failed: 'primaryName' });
  });

  it('fails forward when the parent points elsewhere', async () => {
    const elsewhere = lookup({
      address: (n) => Promise.resolve(n === name ? registry : '0x00000000000000000000000000000000000000cc'),
    });
    expect(await resolveExamName(name, { lookup: elsewhere })).toMatchObject({
      ok: false,
      failed: 'forward',
      partial: { board },
    });
    const unset = lookup({ address: (n) => Promise.resolve(n === name ? registry : null) });
    expect(await resolveExamName(name, { lookup: unset })).toMatchObject({ ok: false, failed: 'forward' });
  });

  it('reports an RPC failure as unreadable, not a mismatch', async () => {
    const down = () => Promise.reject(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 }));
    expect(await resolveExamName(name, { lookup: lookup({ address: down }) })).toMatchObject({
      ok: false,
      failed: 'unreadable',
    });
    expect(await resolveExamName(name, { lookup: lookup({ board: down }) })).toMatchObject({
      ok: false,
      failed: 'unreadable',
      partial: { registry },
    });
    expect(await resolveExamName(name, { lookup: lookup({ primaryName: down }) })).toMatchObject({
      ok: false,
      failed: 'unreadable',
      partial: { board },
    });
  });

  it('gives null for unset text records', async () => {
    const result = await resolveExamName(name, {
      lookup: lookup({ text: (_, key) => Promise.resolve(key === ens.records.tee ? '' : null) }),
    });
    expect(result).toMatchObject({ ok: true, value: { teeUrl: null, storageUrl: null, bucket: null } });
  });
});

describe('createEnsLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the sepolia universal resolver on chain, and no gateway', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const targets: string[] = [];
    const transport = custom({
      request: ({ method, params }: { method: string; params: [{ to: Hex }] }) => {
        if (method === 'eth_chainId') return Promise.resolve('0xaa36a7');
        if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
        targets.push(params[0].to.toLowerCase());
        // An empty result: the name has no resolver.
        return Promise.resolve('0x');
      },
    });
    const ensLookup = createEnsLookup({ transport });
    await ensLookup.address(name).catch(() => null);
    await ensLookup.primaryName(board).catch(() => null);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toBe(sepolia.contracts.ensUniversalResolver.address.toLowerCase());
    expect(fetch).not.toHaveBeenCalled();
  });
});
