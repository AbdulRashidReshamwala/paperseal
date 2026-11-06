import { examNameResolverAbi, examRegistryRuntime, type EnsLookup, type ExamRegistry } from '@paperseal/chain';
import { ens, type Hex } from '@paperseal/protocol';
import { decodeFunctionData, HttpRequestError, type Address, type EIP1193Provider, type PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { readExamName, setExamName } from './nameFlow';
import { examNameValues, verifierNameUrl } from './plan';
import type { PublishEnvironment } from './publishFlow';

const board: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const registry: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const resolver: Address = '0xeF882e399948Da185884f363167E2a105e502A79';
const parent = 'paperseal-demo.eth';
const label = 'mumbai-demo';
const name = `${label}.${parent}`;
const hash = `0x${'ab'.repeat(32)}` as Hex;
const noWait = { wait: () => Promise.resolve() };
const values = { teeUrl: 'https://tee.example.org', storageUrl: 'https://storage.example.org', bucket: 'exam-bucket', arkivWriters: '0x1111111111111111111111111111111111111111' };

function registryCode(forBoard: Address): Hex {
  let code: string = examRegistryRuntime.bytecode;
  const word = forBoard.slice(2).toLowerCase().padStart(64, '0');
  for (const offset of examRegistryRuntime.boardOffsets) {
    code = code.slice(0, 2 + offset * 2) + word + code.slice(2 + offset * 2 + 64);
  }
  return code as Hex;
}

interface Options {
  primary?: string | null;
  /** The name already holds its records. */
  set?: boolean;
  /** The wallet says no. */
  reject?: boolean;
  /** The dry run reverts. */
  simulate?: () => Promise<unknown>;
  status?: 'success' | 'reverted';
  /** Mined, but the records never show. */
  neverShows?: boolean;
  /** Reads that come back empty before the records show. */
  lag?: number;
  primaryName?: EnsLookup['primaryName'];
}

/** The chain as the name flow sees it: a wallet, an RPC and ENS, where a sent transaction writes the records. */
function chain(options: Options = {}) {
  const records = new Map<string, string>();
  let address: Address | null = null;
  const sent: { to: Address; data: Hex }[] = [];
  const write = () => {
    address = registry;
    for (const [key, value] of [
      [ens.records.tee, values.teeUrl],
      [ens.records.storage, values.storageUrl],
      [ens.records.bucket, values.bucket],
      [ens.records.arkivWriters, values.arkivWriters],
    ] as const) {
      records.set(key, value);
    }
  };
  if (options.set) write();
  let lag = options.lag ?? 0;
  const provider = {
    request: ({ method, params }: { method: string; params?: [{ to: Address; data: Hex }] }) => {
      if (method === 'eth_chainId') return Promise.resolve('0xaa36a7');
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return Promise.resolve([board]);
      if (method === 'eth_sendTransaction') {
        if (options.reject) return Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
        const tx = params?.[0] as { to: Address; data: Hex };
        sent.push({ to: tx.to, data: tx.data });
        if (!options.neverShows && options.status !== 'reverted') write();
        return Promise.resolve(hash);
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  } as unknown as EIP1193Provider;
  const lookup: EnsLookup = {
    address: (asked) => {
      if (asked === parent) return Promise.resolve(board);
      if (lag > 0) {
        lag -= 1;
        return Promise.resolve(null);
      }
      return Promise.resolve(address);
    },
    primaryName: options.primaryName ?? (() => Promise.resolve(options.primary === undefined ? parent : options.primary)),
    text: (_asked, key) => Promise.resolve(records.get(key) ?? null),
    code: () => Promise.resolve(registryCode(board)),
    board: () => Promise.resolve(board),
    resolver: () => Promise.resolve(resolver),
  };
  const call = vi.fn(options.simulate ?? (() => Promise.resolve({ data: '0x' })));
  const environment: PublishEnvironment = {
    registryAddress: registry,
    getProvider: () => provider,
    publicClient: {
      getChainId: () => Promise.resolve(11155111),
      call,
      waitForTransactionReceipt: () => Promise.resolve({ status: options.status ?? 'success', blockNumber: 1n }),
    } as unknown as PublicClient,
    createRegistry: () => ({ board: () => Promise.resolve(board) }) as unknown as ExamRegistry,
    ensLookup: lookup,
    examNameValues: values,
  };
  return { environment, sent, call };
}

describe('setExamName', () => {
  it('sends one multicall to the resolver from the chain, and reads the name back', async () => {
    const { environment, sent, call } = chain();
    const stages: string[] = [];
    expect(await setExamName(environment, label, (stage) => stages.push(stage), noWait)).toEqual({ state: 'set', name });
    expect(stages).toEqual(['checking', 'simulating', 'wallet', 'mining', 'reading']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to.toLowerCase()).toBe(resolver.toLowerCase());
    const outer = decodeFunctionData({ abi: examNameResolverAbi, data: sent[0]?.data as Hex });
    expect(outer.functionName).toBe('multicall');
    const inner = (outer.args as readonly [readonly Hex[]])[0].map((data) => decodeFunctionData({ abi: examNameResolverAbi, data }));
    expect(inner.map((c) => c.functionName)).toEqual(['setAddress', 'setText', 'setText', 'setText', 'setText']);
    expect(inner.slice(1).map((c) => (c.args as readonly string[])[1])).toEqual([ens.records.tee, ens.records.storage, ens.records.bucket, ens.records.arkivWriters]);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ to: resolver, data: sent[0]?.data }));
  });

  it('retries the read while the RPC lags', async () => {
    const { environment } = chain({ lag: 4 });
    expect(await setExamName(environment, label, undefined, noWait)).toEqual({ state: 'set', name });
  });

  it('sends nothing for a name already set', async () => {
    const { environment, sent } = chain({ set: true });
    expect(await setExamName(environment, label, undefined, noWait)).toEqual({ state: 'set', name });
    expect(sent).toHaveLength(0);
  });

  it('says the name is not set when the wallet declines', async () => {
    const outcome = await setExamName(chain({ reject: true }).environment, label, undefined, noWait);
    expect(outcome).toMatchObject({ state: 'failed', message: expect.stringMatching(/^You declined in your wallet, so the exam name is not set\./) as string });
  });

  it('says the name is not set when the transaction fails', async () => {
    const outcome = await setExamName(chain({ status: 'reverted' }).environment, label, undefined, noWait);
    expect(outcome).toMatchObject({ state: 'failed', message: expect.stringMatching(/^The public record refused the exam name/) as string });
  });

  it('stops before the wallet when the dry run reverts', async () => {
    const { environment, sent } = chain({ simulate: () => Promise.reject(new Error('execution reverted')) });
    expect(await setExamName(environment, label, undefined, noWait)).toMatchObject({ state: 'failed' });
    expect(sent).toHaveLength(0);
  });

  it('sends nothing without a primary name', async () => {
    const { environment, sent } = chain({ primary: null });
    expect(await setExamName(environment, label, undefined, noWait)).toMatchObject({ state: 'no-primary-name' });
    expect(sent).toHaveLength(0);
  });

  it('never calls the name set when the read-back fails', async () => {
    const outcome = await setExamName(chain({ neverShows: true }).environment, label, undefined, noWait);
    expect(outcome).toMatchObject({ state: 'unconfirmed', name, message: expect.stringMatching(/^The exam name was sent, but it does not check out yet\./) as string });
  });

  it('does not count a name that points to another registry as set', async () => {
    const { environment } = chain({ set: true });
    expect(await readExamName({ ...environment, registryAddress: '0x00000000000000000000000000000000000000cc' }, label)).toEqual({ state: 'unset', name });
  });

  it('counts a value this app does not have as nothing to write', async () => {
    const { environment } = chain({ set: true });
    expect(await readExamName({ ...environment, examNameValues: { teeUrl: values.teeUrl } }, label)).toEqual({ state: 'set', name });
  });

  it('does nothing where ENS can not be read', async () => {
    expect(await readExamName({ ...chain().environment, ensLookup: null }, label)).toEqual({ state: 'off' });
  });

  it('reports an RPC that can not answer, and sends nothing', async () => {
    const down = () => Promise.reject(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 }));
    const { environment, sent } = chain({ primaryName: down });
    expect(await setExamName(environment, label, undefined, noWait)).toMatchObject({ state: 'failed' });
    expect(sent).toHaveLength(0);
  });

  it('takes its values from the settings, without a trailing slash', () => {
    expect(
      examNameValues({ VITE_TEE_URL: 'https://tee.example.org/', VITE_STORAGE_URL: ' https://storage.example.org ', VITE_TEE_STORAGE_BUCKET: 'b', VITE_ARKIV_WRITERS: ' 0x11 ' }),
    ).toEqual({ teeUrl: 'https://tee.example.org', storageUrl: 'https://storage.example.org', bucket: 'b', arkivWriters: '0x11' });
    expect(examNameValues({})).toEqual({ teeUrl: null, storageUrl: null, bucket: null, arkivWriters: null });
    expect(verifierNameUrl('https://verify.example.org/', name)).toBe(`https://verify.example.org/#/name/${name}`);
  });
});
