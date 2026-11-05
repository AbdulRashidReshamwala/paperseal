import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  zeroAddress,
  type Hex,
} from 'viem';
import { drand } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { createExamRegistry, examRegistryAbi, NoWalletError } from './index';

const script = resolve(import.meta.dirname, '../scripts/sync-abi.mjs');
const address = '0x00000000000000000000000000000000000000aa';
const examId: Hex = `0x${'11'.repeat(32)}`;
const hash32: Hex = `0x${'22'.repeat(32)}`;
const zero32: Hex = `0x${'00'.repeat(32)}`;

/**
 * A local EIP-1193 stub that answers eth_call and eth_getLogs. Like a public RPC, it rejects any
 * eth_getLogs that spans more than one block, so a wide range can't come back.
 */
function chainStub(
  call: (name: string) => unknown,
  logs: (filter: { topics: unknown[]; fromBlock: bigint }) => unknown[],
) {
  type Params = [{ data?: Hex; topics?: unknown[]; fromBlock?: Hex; toBlock?: Hex }];
  return custom({
    request: ({ method, params }: { method: string; params: Params }) => {
      if (method === 'eth_chainId') return Promise.resolve('0xaa36a7');
      if (method === 'eth_call') {
        const { functionName } = decodeFunctionData({
          abi: examRegistryAbi,
          data: params[0].data as Hex,
        });
        return Promise.resolve(
          encodeFunctionResult({
            abi: examRegistryAbi,
            functionName,
            result: call(functionName),
          } as never),
        );
      }
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
      const { fromBlock, toBlock, topics } = params[0];
      if (!/^0x[0-9a-f]+$/.test(fromBlock ?? '') || fromBlock !== toBlock) {
        throw new Error(`exceed maximum block range: from ${fromBlock} to ${toBlock}`);
      }
      return Promise.resolve(logs({ topics: topics ?? [], fromBlock: BigInt(fromBlock as Hex) }));
    },
  });
}

/** A local EIP-1193 stub for the RPC boundary: answers eth_call with ABI-encoded results. */
function rpc(answer: (name: string) => unknown) {
  return custom({
    request: ({ method, params }: { method: string; params: [{ data: Hex }] }) => {
      if (method === 'eth_chainId') return Promise.resolve('0xaa36a7');
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const { functionName } = decodeFunctionData({
        abi: examRegistryAbi,
        data: params[0].data,
      });
      return Promise.resolve(
        encodeFunctionResult({
          abi: examRegistryAbi,
          functionName,
          result: answer(functionName),
        } as never),
      );
    },
  });
}

const exam = {
  commitHash: `0x${'01'.repeat(20)}`,
  imageDigest: hash32,
  createdAt: 0n,
  createdBlock: 0n,
  settings: {
    examId,
    examStart: 1n,
    delta: 1n,
    lockRound: 1n,
    unlockRound: 2n,
    endRound: 3n,
    criteriaHash: hash32,
    rpcHost: 'rpc.example.org',
  },
};

const emptyBuild = {
  approvedListHash: zero32,
  paperHash: zero32,
  storageManifestHash: zero32,
  saltedPaperHash: zero32,
  selected: 0,
  bankSize: 0,
  postedAt: 0n,
  criteriaHash: zero32,
  teeSignature: '0x',
  instancePublicKey: '0x',
};

describe('ExamRegistry ABI', () => {
  it('is the synced contract ABI', () => {
    const names = examRegistryAbi.filter((e) => e.type === 'function').map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'createExam',
        'postApprovedList',
        'postBuild',
        'getExam',
        'getApprovedList',
        'getBuild',
        'QUICKNET_GENESIS_TIME',
        'QUICKNET_PERIOD_SECONDS',
      ]),
    );
    expect(names).not.toContain('postLock');
    expect(names).not.toContain('postSelection');
  });

  it('matches spec/constants.json drand timing in the contract constants', async () => {
    const registry = createExamRegistry({
      address,
      transport: rpc((name) =>
        name === 'QUICKNET_GENESIS_TIME' ? BigInt(drand.genesisTime) : BigInt(drand.periodSeconds),
      ),
    });
    expect(await registry.quicknetGenesisTime()).toBe(BigInt(drand.genesisTime));
    expect(await registry.quicknetPeriodSeconds()).toBe(BigInt(drand.periodSeconds));
  });
});

describe('createExamRegistry', () => {
  it('returns a posted record', async () => {
    const build = { ...emptyBuild, selected: 30, bankSize: 300, postedAt: 5n };
    const registry = createExamRegistry({
      address,
      transport: rpc(() => build),
    });
    expect(await registry.getBuild(examId)).toMatchObject({
      selected: 30,
      bankSize: 300,
      postedAt: 5n,
    });
  });

  it('returns null for a record that was never written', async () => {
    const registry = createExamRegistry({
      address,
      transport: rpc((name) =>
        name === 'getApprovedList'
          ? { listHash: zero32, postedAt: 0n, postedBlock: 0n }
          : emptyBuild,
      ),
    });
    expect(await registry.getBuild(examId)).toBeNull();
    expect(await registry.getApprovedList(examId)).toBeNull();
  });

  it('reads the board address', async () => {
    const registry = createExamRegistry({
      address,
      transport: rpc(() => zeroAddress),
    });
    expect(await registry.board()).toBe(zeroAddress);
  });

  it('refuses to write without the board wallet', () => {
    const registry = createExamRegistry({
      address,
      transport: rpc(() => emptyBuild),
    });
    expect(() => registry.postApprovedList(examId, '0x')).toThrow(NoWalletError);
  });

  it('reads the full approved list from the ApprovedListPosted event', async () => {
    const entries: Hex = '0x1234abcd';
    const log = encodeEventTopics({
      abi: examRegistryAbi,
      eventName: 'ApprovedListPosted',
      args: { examId },
    });
    const registry = createExamRegistry({
      address,
      transport: chainStub(
        () => ({ listHash: hash32, postedAt: 9n, postedBlock: 77n }),
        (filter) => {
          expect(filter.fromBlock).toBe(77n);
          expect(filter.topics).toEqual(log);
          return [
            {
              address,
              topics: log,
              data: encodeAbiParameters(
                [{ type: 'bytes32' }, { type: 'bytes' }],
                [hash32, entries],
              ),
              blockNumber: '0x1',
              blockHash: hash32,
              transactionHash: hash32,
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: false,
            },
          ];
        },
      ),
    });
    expect(await registry.getApprovedListEntries(examId)).toBe(entries);
  });

  it('returns null when no approved list was posted', async () => {
    const registry = createExamRegistry({
      address,
      transport: chainStub(
        () => ({ listHash: zero32, postedAt: 0n, postedBlock: 0n }),
        () => {
          throw new Error('no log query for an unwritten record');
        },
      ),
    });
    expect(await registry.getApprovedListEntries(examId)).toBeNull();
  });

  it('reads the full criteria from the ExamCreated event', async () => {
    const criteria: Hex = '0xc0ffee';
    const topics = encodeEventTopics({
      abi: examRegistryAbi,
      eventName: 'ExamCreated',
      args: { examId },
    });
    const registry = createExamRegistry({
      address,
      transport: chainStub(
        () => ({ ...exam, createdAt: 9n, createdBlock: 55n }),
        (filter) => {
          expect(filter.fromBlock).toBe(55n);
          expect(filter.topics).toEqual(topics);
          return [
            {
              address,
              topics,
              data: encodeAbiParameters(
                [
                  { type: 'bytes20' },
                  { type: 'bytes32' },
                  { type: 'uint64' },
                  { type: 'uint64' },
                  { type: 'uint64' },
                  { type: 'uint64' },
                  { type: 'uint64' },
                  { type: 'bytes32' },
                  { type: 'string' },
                  { type: 'bytes' },
                ],
                [
                  `0x${'01'.repeat(20)}`,
                  hash32,
                  1n,
                  2n,
                  3n,
                  4n,
                  5n,
                  hash32,
                  'rpc.example.org',
                  criteria,
                ],
              ),
              blockNumber: '0x1',
              blockHash: hash32,
              transactionHash: hash32,
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: false,
            },
          ];
        },
      ),
    });
    expect(await registry.getCriteria(examId)).toBe(criteria);
  });

  it('returns null criteria before the exam exists', async () => {
    const registry = createExamRegistry({
      address,
      transport: chainStub(
        () => ({ ...exam, createdAt: 0n, createdBlock: 0n }),
        () => {
          throw new Error('no log query for an unwritten record');
        },
      ),
    });
    expect(await registry.getCriteria(examId)).toBeNull();
  });
});

describe('sync-abi.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-abi-'));
  const output = join(dir, 'abi.ts');

  it('fails clearly when the artifact is missing', () => {
    const run = spawnSync('node', [script, join(dir, 'missing.json'), output], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('forge build');
  });

  it('fails clearly when the artifact has no ABI', () => {
    const artifact = join(dir, 'empty.json');
    writeFileSync(artifact, '{}');
    const run = spawnSync('node', [script, artifact, output], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no abi array');
  });

  it('writes the artifact ABI', () => {
    const artifact = join(dir, 'ok.json');
    writeFileSync(artifact, JSON.stringify({ abi: [{ type: 'event', name: 'X', inputs: [] }] }));
    const run = spawnSync('node', [script, artifact, output], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('export const examRegistryAbi');
  });
});
