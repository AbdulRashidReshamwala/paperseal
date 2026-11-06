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
  sha256,
  zeroAddress,
  type Hex,
} from 'viem';
import { approvedListHash, criteriaHash, drand, fromHex, toHex } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { createExamRegistry, examRegistryAbi, NoWalletError, OnChainBytesError } from './index';

const script = resolve(import.meta.dirname, '../scripts/sync-abi.mjs');
const address = '0x00000000000000000000000000000000000000aa';
const examId: Hex = `0x${'11'.repeat(32)}`;
const hash32: Hex = `0x${'22'.repeat(32)}`;
const zero32: Hex = `0x${'00'.repeat(32)}`;
const listHashOf = (entries: Hex): Hex => toHex(approvedListHash(fromHex(examId), fromHex(entries)));
const criteriaHashOf = (criteria: Hex): Hex => toHex(criteriaHash(fromHex(criteria)));

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
        () => ({ listHash: listHashOf(entries), postedAt: 9n, postedBlock: 77n }),
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

  const listLog = (entries: Hex) => ({
    address,
    topics: encodeEventTopics({ abi: examRegistryAbi, eventName: 'ApprovedListPosted', args: { examId } }),
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], [hash32, entries]),
    blockNumber: '0x1',
    blockHash: hash32,
    transactionHash: hash32,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  });

  it('rejects approved-list bytes that do not hash to the on-chain listHash', async () => {
    const registry = createExamRegistry({
      address,
      transport: chainStub(
        () => ({ listHash: listHashOf('0x1234abcd'), postedAt: 9n, postedBlock: 77n }),
        () => [listLog('0x1234abce')],
      ),
    });
    await expect(registry.getApprovedListEntries(examId)).rejects.toMatchObject({
      name: 'OnChainBytesError',
      what: 'approvedList',
      kind: 'mismatch',
    });
  });

  it('says so when a posted list has no event, instead of returning null', async () => {
    const registry = createExamRegistry({
      address,
      transport: chainStub(
        () => ({ listHash: listHashOf('0x1234abcd'), postedAt: 9n, postedBlock: 77n }),
        () => [],
      ),
    });
    const error: unknown = await registry.getApprovedListEntries(examId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OnChainBytesError);
    expect(error).toMatchObject({ kind: 'missing' });
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
        () => ({ ...exam, settings: { ...exam.settings, criteriaHash: criteriaHashOf(criteria) }, createdAt: 9n, createdBlock: 55n }),
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

  it('rejects criteria bytes that do not hash to settings.criteriaHash, and a missing event', async () => {
    const criteria: Hex = '0xc0ffee';
    const topics = encodeEventTopics({ abi: examRegistryAbi, eventName: 'ExamCreated', args: { examId } });
    const log = (bytes: Hex) => ({
      address,
      topics,
      data: encodeAbiParameters(
        [
          { type: 'bytes20' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' },
          { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'string' }, { type: 'bytes' },
        ],
        [`0x${'01'.repeat(20)}`, hash32, 1n, 2n, 3n, 4n, 5n, hash32, 'rpc.example.org', bytes],
      ),
      blockNumber: '0x1',
      blockHash: hash32,
      transactionHash: hash32,
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    });
    const record = () => ({ ...exam, settings: { ...exam.settings, criteriaHash: criteriaHashOf(criteria) }, createdAt: 9n, createdBlock: 55n });
    const tampered = createExamRegistry({ address, transport: chainStub(record, () => [log('0xc0ffef')]) });
    await expect(tampered.getCriteria(examId)).rejects.toMatchObject({ what: 'criteria', kind: 'mismatch' });
    const missing = createExamRegistry({ address, transport: chainStub(record, () => []) });
    await expect(missing.getCriteria(examId)).rejects.toMatchObject({ what: 'criteria', kind: 'missing' });

    // A reorg marks a log removed. It isn't on the chain any more, so it must not count.
    const removed = createExamRegistry({ address, transport: chainStub(record, () => [{ ...log(criteria), removed: true }]) });
    await expect(removed.getCriteria(examId)).rejects.toMatchObject({ what: 'criteria', kind: 'missing' });
    const beside = createExamRegistry({ address, transport: chainStub(record, () => [{ ...log('0xc0ffef'), removed: true }, log(criteria)]) });
    expect(await beside.getCriteria(examId)).toBe(criteria);
  });

  it('skips removed ApprovedListPosted logs too', async () => {
    const entries: Hex = '0xabcd';
    const posted = { listHash: toHex(approvedListHash(fromHex(examId), fromHex(entries))), postedAt: 7n, postedBlock: 42n };
    const log = (bytes: Hex, removed: boolean) => ({
      address,
      topics: encodeEventTopics({ abi: examRegistryAbi, eventName: 'ApprovedListPosted', args: { examId } }),
      data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], [posted.listHash, bytes]),
      blockNumber: '0x2a',
      blockHash: hash32,
      transactionHash: hash32,
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed,
    });
    const reading = (logs: unknown[]) => createExamRegistry({ address, transport: chainStub((name) => (name === 'getApprovedList' ? posted : exam), () => logs) });
    await expect(reading([log(entries, true)]).getApprovedListEntries(examId)).rejects.toMatchObject({ what: 'approvedList', kind: 'missing' });
    expect(await reading([log('0xdead', true), log(entries, false)]).getApprovedListEntries(examId)).toBe(entries);
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
  const pin = join(dir, 'registry.json');

  it('fails clearly when the artifact is missing', () => {
    const run = spawnSync('node', [script, join(dir, 'missing.json'), output, pin], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('forge build');
  });

  it('fails clearly when the artifact has no ABI', () => {
    const artifact = join(dir, 'empty.json');
    writeFileSync(artifact, '{}');
    const run = spawnSync('node', [script, artifact, output, pin], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no abi array');
  });

  const abi = [{ type: 'event', name: 'X', inputs: [] }];
  /** 76 bytes of code, the last 6 metadata, with one immutable used at bytes 2 and 38, each one word long. */
  const code = `0x6080${'00'.repeat(32)}aabb${'00'.repeat(32)}CCDDa1a2a3a40004`;
  const deployedBytecode = (immutableReferences: unknown, object = code) => ({ object, immutableReferences });
  const runWith = (file: string, contents: unknown) => {
    const artifact = join(dir, file);
    writeFileSync(artifact, JSON.stringify(contents));
    return spawnSync('node', [script, artifact, output, pin], { encoding: 'utf8' });
  };

  it('fails clearly unless the code has exactly one immutable, each use one word long', () => {
    expect(runWith('no-code.json', { abi }).stderr).toContain('no deployedBytecode.object');
    const cases: [unknown, string][] = [
      [{}, '0 immutables'],
      [{ 1: [{ start: 2, length: 32 }], 2: [{ start: 38, length: 32 }] }, '2 immutables'],
      [{ 1: [{ start: 2, length: 20 }] }, '20 bytes long'],
      [{ 1: [{ start: 60, length: 32 }] }, 'outside the 76-byte code'],
      [{ 1: [{ start: 40, length: 32 }] }, 'in the metadata after byte 70'],
    ];
    for (const [references, message] of cases) {
      const run = runWith('bad-code.json', { abi, deployedBytecode: deployedBytecode(references) });
      expect(run.status, message).toBe(1);
      expect(run.stderr).toContain(message);
    }
    const references = { 1: [{ start: 2, length: 32 }] };
    for (const [object, message] of [
      [`0x6080${'00'.repeat(32)}0045`, '71 bytes of metadata in 36 bytes of code'],
      ['0xaa', 'too short to end in metadata'],
    ]) {
      const run = runWith('bad-metadata.json', { abi, deployedBytecode: deployedBytecode(references, object) });
      expect(run.status, message).toBe(1);
      expect(run.stderr).toContain(message);
    }
  });

  it('writes the artifact ABI, runtime code and board offsets', () => {
    const references = { 7: [{ start: 38, length: 32 }, { start: 2, length: 32 }] };
    const run = runWith('ok.json', { abi, deployedBytecode: deployedBytecode(references) });
    expect(run.status).toBe(0);
    const source = readFileSync(output, 'utf8');
    expect(source).toContain('Do not edit by hand');
    expect(source).toContain('export const examRegistryAbi');
    expect(source).toContain(`bytecode: '${code.toLowerCase()}'`);
    expect(source).toContain('boardOffsets: [2, 38]');
  });

  it('writes a sample of matching code when given a path for it', () => {
    const artifact = join(dir, 'sample.json');
    const sample = join(dir, 'sample-code.json');
    writeFileSync(artifact, JSON.stringify({ abi, deployedBytecode: deployedBytecode({ 7: [{ start: 2, length: 32 }] }) }));
    expect(spawnSync('node', [script, artifact, output, pin, sample], { encoding: 'utf8' }).status).toBe(0);
    const { board, code: filled } = JSON.parse(readFileSync(sample, 'utf8')) as { board: string; code: string };
    expect(filled.slice(6, 70)).toBe(board.slice(2).padStart(64, '0'));
    expect(filled.length).toBe(code.length);
  });

  it('writes the pin over the executable code only, with the board words zeroed', () => {
    const references = { 7: [{ start: 38, length: 32 }, { start: 2, length: 32 }] };
    const hashed = (object: string) => {
      expect(runWith('pin.json', { abi, deployedBytecode: deployedBytecode(references, object) }).status).toBe(0);
      return JSON.parse(readFileSync(pin, 'utf8')) as { runtimeCodeHash: string; executableBytes: number; boardOffsets: number[] };
    };
    const written = hashed(code);
    expect(written.executableBytes).toBe(70);
    expect(written.boardOffsets).toEqual([2, 38]);
    expect(written.runtimeCodeHash).toBe(sha256(`0x6080${'00'.repeat(32)}aabb${'00'.repeat(34)}`));
    // A comment edit changes only the metadata, so the pin stays.
    expect(hashed(`${code.slice(0, -12)}b1b2b3b40004`).runtimeCodeHash).toBe(written.runtimeCodeHash);
    expect(hashed(code.replace('aabb', 'aabc')).runtimeCodeHash).not.toBe(written.runtimeCodeHash);
  });
});
