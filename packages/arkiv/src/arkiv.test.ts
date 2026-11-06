import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { MAX_ENTITY_BYTES } from '@arkiv-network/sdk/schema';
import { custom, getAddress, sha256, stringToBytes, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  arkiv,
  arkivChain,
  createArkivReader,
  createArkivWriter,
  MirrorInputError,
  relayHeartbeatSchema,
  releaseLogSchema,
  releaseTokenSchema,
} from './index';

const examId: Hex = `0x${'ab'.repeat(32)}`;
const registry: Address = '0x00000000000000000000000000000000000000aa';
const otherRegistry: Address = '0x00000000000000000000000000000000000000bb';
const writerA: Address = '0x1111111111111111111111111111111111111111';
const writerB: Address = '0x2222222222222222222222222222222222222222';
const entriesHash: Hex = `0x${'cd'.repeat(32)}`;
const instancePublicKey: Hex = `0x04${'05'.repeat(64)}`;
const jwt = stringToBytes('aGVhZA.Ym9keQ.c2ln');
const keyOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

type QueryOptions = { limit?: Hex; offset?: Hex };
interface RpcAttribute {
  name: string;
  type: string;
  value: unknown;
}

/** An EIP-1193 stub that records every request and answers `arkiv_query` with `query`. */
function stubRpc(query: (text: string, options: QueryOptions) => unknown[] = () => []) {
  const calls: { method: string; params: unknown }[] = [];
  const transport = custom({
    request: ({ method, params }: { method: string; params: unknown }) => {
      calls.push({ method, params });
      if (method === 'arkiv_query') {
        const [text, options] = params as [string, QueryOptions];
        return Promise.resolve({ data: query(text, options), blockNumber: '0x64' });
      }
      if (method === 'arkiv_getBlockTiming') {
        return Promise.resolve({ current_block: 1234, current_block_time: 1_700_000_000, duration: 2 });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  });
  const queries = () =>
    calls
      .filter((call) => call.method === 'arkiv_query')
      .map((call) => {
        const [text, options] = call.params as [string, QueryOptions];
        return { text, options };
      });
  return { calls, transport, queries };
}

const str = (name: string, value: string): RpcAttribute => ({ name, type: 'str', value });

/** A release-log entity as the node returns it, with the schema tag the SDK asks for. */
function logEntity(n: number, creator: Address, drop?: string) {
  const attributes = [
    str('arkiv.schema', arkiv.schemas.releaseLog),
    str('examId', examId),
    { name: 'registry', type: 'addr', value: registry },
    str('entriesHash', entriesHash),
    { name: 'body', type: 'bytes', value: '0x7b7d' },
  ];
  return {
    key: keyOf(n),
    creator,
    createdAt: '0x10',
    attributes: attributes.filter((attribute) => attribute.name !== drop),
  };
}

/** A relay-heartbeat entity as the node returns it. */
function heartbeatEntity(n: number, creator: Address, rowRegistry: Address = registry) {
  return {
    key: keyOf(n),
    creator,
    createdAt: '0x20',
    attributes: [
      str('arkiv.schema', arkiv.schemas.relayHeartbeat),
      str('examId', examId),
      { name: 'registry', type: 'addr', value: rowRegistry },
      str('entriesHash', ''),
      str('stage', 'unlocking'),
    ],
  };
}

/** A row found by the writer's dedupe query, which selects only `$key`. */
const existingRow = (key: Hex, schema: string) => ({ key, attributes: [str('arkiv.schema', schema)] });

// First, so nothing earlier in this file has made the SDK print its once-only warning.
describe('arkivChain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints no warning without an access key, and uses the public RPC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chain = arkivChain();
    expect(arkivChain('').rpcUrls).toEqual(chain.rpcUrls);
    expect(chain.id).toBe(arkiv.network.chainId);
    expect(chain.rpcUrls).toEqual({ default: { http: [arkiv.network.rpcUrl] } });
    expect(chain.blockExplorers?.default.url).toBe(arkiv.network.explorer);
    const reader = createArkivReader({ transport: stubRpc().transport });
    await reader.releaseRows(examId, [writerA]);
    createArkivWriter({ account: writerA, transport: stubRpc().transport });
    expect(warn).not.toHaveBeenCalled();
    // The SDK warns only once per process, so check it hadn't already: this assertion would be empty otherwise.
    rabdi({ accessKey: '' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses the SDK's chain, with the key in its URL, given an access key", () => {
    const chain = arkivChain('sdk_test');
    expect(chain.id).toBe(arkiv.network.chainId);
    expect(chain.rpcUrls.default.http).toEqual([`${arkiv.network.rpcUrl}/sdk_test`]);
  });
});

describe('schemas', () => {
  /** The column tables of spec/arkiv.md, keyed by schema name, as [column, type, indexed]. */
  function specTables(): Map<string, [string, string, boolean][]> {
    const text = readFileSync(resolve(import.meta.dirname, '../../../spec/arkiv.md'), 'utf8');
    const tables = new Map<string, [string, string, boolean][]>();
    for (const [, name = '', table = ''] of text.matchAll(/^`([\w.-]+)` (?:holds|says)[^\n]*\n\n((?:\|[^\n]*\n)+)/gm)) {
      const rows = table.trim().split('\n').slice(2);
      tables.set(
        name,
        rows.map((row) => {
          const [column = '', type = '', indexed = ''] = row
            .split('|')
            .slice(1, 4)
            .map((cell) => cell.trim().replaceAll('`', ''));
          return [column, type, indexed === 'Yes'];
        }),
      );
    }
    return tables;
  }

  it('match the spec tables column for column', () => {
    const tables = specTables();
    expect([...tables.keys()]).toEqual([
      arkiv.schemas.releaseLog,
      arkiv.schemas.releaseToken,
      arkiv.schemas.relayHeartbeat,
    ]);
    for (const schema of [releaseLogSchema, releaseTokenSchema, relayHeartbeatSchema]) {
      const columns = Object.entries(schema.columns).map(([name, column]) => [
        name,
        column.type,
        column.isIndexed,
      ]);
      expect(columns).toEqual(tables.get(schema.name ?? ''));
      for (const column of Object.values(schema.columns)) expect(column.isOptional).toBe(false);
    }
  });
});

describe('createArkivReader', () => {
  it('reads nothing without writers', async () => {
    const rpc = stubRpc();
    const reader = createArkivReader({ transport: rpc.transport });
    expect(await reader.releaseRows(examId, [])).toEqual({ logs: [], tokens: [], heartbeats: [] });
    expect(await reader.releaseRows(examId, [], { registry })).toEqual({ logs: [], tokens: [], heartbeats: [] });
    expect(rpc.calls).toEqual([]);
  });

  it('filters by schema, lowercase examId and creator', async () => {
    const rpc = stubRpc();
    const reader = createArkivReader({ transport: rpc.transport });
    const upper: Hex = `0x${'AB'.repeat(32)}`;
    await reader.releaseRows(upper, [writerA, writerB, writerA]);
    const texts = rpc.queries().map(({ text }) => text);
    expect(texts).toHaveLength(3);
    [arkiv.schemas.releaseLog, arkiv.schemas.releaseToken, arkiv.schemas.relayHeartbeat].forEach((schema, index) => {
      const text = texts[index] ?? '';
      expect(text).toContain(`arkiv.schema = str('${schema}')`);
      expect(text).toContain(`examId = str('${examId}')`);
      expect(text.toLowerCase()).toContain(`$creator = addr(${writerA}) or $creator = addr(${writerB})`);
      expect(text).toContain('ORDER BY $key');
      expect(text).not.toContain('registry');
    });
  });

  it('filters every query by registry when given one', async () => {
    const rpc = stubRpc();
    const reader = createArkivReader({ transport: rpc.transport });
    await reader.releaseRows(examId, [writerA], { registry });
    const texts = rpc.queries().map(({ text }) => text.toLowerCase());
    expect(texts).toHaveLength(3);
    for (const text of texts) expect(text).toContain(`registry = addr(${registry})`);
  });

  it('returns heartbeats, and drops rows for another registry when given one', async () => {
    const rpc = stubRpc((text) =>
      text.includes(arkiv.schemas.relayHeartbeat)
        ? [heartbeatEntity(1, writerA), heartbeatEntity(2, writerA, otherRegistry)]
        : text.includes(arkiv.schemas.releaseLog)
          ? [logEntity(3, writerA)]
          : [],
    );
    const reader = createArkivReader({ transport: rpc.transport });
    const heartbeat = {
      entityKey: keyOf(1),
      creator: getAddress(writerA),
      createdAtBlock: 32n,
      examId,
      registry: getAddress(registry),
      entriesHash: '',
      stage: 'unlocking',
    };
    const all = await reader.releaseRows(examId, [writerA]);
    expect(all.heartbeats).toEqual([heartbeat, { ...heartbeat, entityKey: keyOf(2), registry: getAddress(otherRegistry) }]);
    expect(all.logs).toHaveLength(1);
    // A node that ignores the registry filter can't add rows for another registry.
    expect((await reader.releaseRows(examId, [writerA], { registry })).heartbeats).toEqual([heartbeat]);
    expect((await reader.releaseRows(examId, [writerA], { registry: otherRegistry })).logs).toEqual([]);
  });

  it('pages past skipped rows until a short page, and keeps the creator', async () => {
    const rpc = stubRpc((text, { offset }) => {
      if (!text.includes(arkiv.schemas.releaseLog)) return [];
      // 99 good rows and one missing its entriesHash, which the SDK skips but the offset counts.
      if (offset === undefined || offset === '0x0') {
        return [...Array.from({ length: 99 }, (_, i) => logEntity(i + 1, writerA)), logEntity(999, writerB, 'entriesHash')];
      }
      if (offset === '0x64') return [logEntity(500, writerB)];
      throw new Error(`unexpected offset ${offset}`);
    });
    const reader = createArkivReader({ transport: rpc.transport });
    const { logs, tokens } = await reader.releaseRows(examId, [writerA, writerB]);
    expect(tokens).toEqual([]);
    expect(logs).toHaveLength(100);
    const logQueries = rpc.queries().filter(({ text }) => text.includes(arkiv.schemas.releaseLog));
    expect(logQueries.map(({ options }) => options.offset ?? '0x0')).toEqual(['0x0', '0x64']);
    for (const { options } of rpc.queries()) expect(options.limit).toBe('0x64');
    expect(logs.at(-1)).toEqual({
      entityKey: keyOf(500),
      creator: getAddress(writerB),
      createdAtBlock: 16n,
      examId,
      registry: getAddress(registry),
      entriesHash,
      body: stringToBytes('{}'),
    });
  });

  it('drops rows from creators it did not ask for', async () => {
    const rpc = stubRpc((text) =>
      text.includes(arkiv.schemas.releaseLog)
        ? [logEntity(1, writerB)]
        : text.includes(arkiv.schemas.relayHeartbeat)
          ? [heartbeatEntity(2, writerB)]
          : [],
    );
    const reader = createArkivReader({ transport: rpc.transport });
    const { logs, heartbeats } = await reader.releaseRows(examId, [writerA]);
    expect(logs).toEqual([]);
    expect(heartbeats).toEqual([]);
  });

  it('reports the latest block', async () => {
    const reader = createArkivReader({ transport: stubRpc().transport });
    expect(await reader.latestBlock()).toEqual({ number: 1234n, time: 1_700_000_000 });
  });
});

describe('createArkivWriter', () => {
  const log = (overrides: Record<string, unknown> = {}) =>
    stringToBytes(
      JSON.stringify({ examId, entries: [{}, {}, {}], entriesHash, teeSignature: '0x', instancePublicKey, ...overrides }),
    );
  const input = { examId, registry, chainId: 11155111, body: log() };
  const created = { entityKey: keyOf(0xee), txHash: keyOf(0xff), expiresAt: 1n };

  function setup(existing: unknown[] = []) {
    const rpc = stubRpc(() => existing);
    const createEntity = vi.fn((..._args: unknown[]) => Promise.resolve(created));
    const writer = createArkivWriter({ account: writerA, transport: rpc.transport, walletClient: { createEntity } });
    const createCall = (): [unknown, Record<string, unknown>, unknown] => {
      const [schema, values, options] = createEntity.mock.calls[0] ?? [];
      return [schema, values as Record<string, unknown>, options];
    };
    return { rpc, createEntity, createCall, writer };
  }

  it('skips a log this writer already mirrored', async () => {
    const { rpc, createEntity, writer } = setup([existingRow(keyOf(1), arkiv.schemas.releaseLog)]);
    expect(await writer.mirrorReleaseLog(input)).toEqual({ written: false, entityKey: keyOf(1) });
    expect(createEntity).not.toHaveBeenCalled();
    const [query] = rpc.queries();
    expect(query?.text).toContain(`examId = str('${examId}')`);
    expect(query?.text).toContain(`entriesHash = str('${entriesHash}')`);
    expect(query?.text.toLowerCase()).toContain(`$creator = addr(${writerA})`);
    expect(query?.options.limit).toBe('0x1');
  });

  it('creates a readonly, publicly extendable log row', async () => {
    const { createEntity, createCall, writer } = setup();
    const body = log({ entriesHash: `0x${'CD'.repeat(32)}` });
    expect(await writer.mirrorReleaseLog({ ...input, body })).toEqual({
      written: true,
      entityKey: created.entityKey,
      txHash: created.txHash,
    });
    expect(createEntity).toHaveBeenCalledTimes(1);
    const [schema, values, options] = createCall();
    expect(schema).toBe(releaseLogSchema);
    expect(values).toMatchObject({ examId, entriesHash, released: 3, body });
    expect(values.registry).toMatchObject({ value: getAddress(registry) });
    expect(values.chainId).toMatchObject({ value: 11155111n });
    expect(options).toEqual({
      expiration: ExpirationTime.fromDays(arkiv.lifetimeDays),
      flags: { readonly: true, permissionlessExtension: true },
    });
  });

  it('refuses a log for another exam', async () => {
    const { rpc, createEntity, writer } = setup();
    const body = log({ examId: keyOf(0) });
    await expect(writer.mirrorReleaseLog({ ...input, body })).rejects.toThrow(MirrorInputError);
    expect(rpc.calls).toEqual([]);
    expect(createEntity).not.toHaveBeenCalled();
  });

  it('refuses an oversized body before sending anything', async () => {
    const { rpc, createEntity, writer } = setup();
    const body = new Uint8Array(MAX_ENTITY_BYTES + 1);
    await expect(writer.mirrorReleaseLog({ ...input, body })).rejects.toThrow(/over Arkiv's 131072-byte limit/);
    await expect(writer.mirrorReleaseToken({ ...input, body, instancePublicKey })).rejects.toThrow(MirrorInputError);
    expect(rpc.calls).toEqual([]);
    expect(createEntity).not.toHaveBeenCalled();
  });

  it('dedupes tokens by the SHA-256 of the instance key', async () => {
    const { rpc, createEntity, writer } = setup([existingRow(keyOf(2), arkiv.schemas.releaseToken)]);
    const result = await writer.mirrorReleaseToken({ ...input, body: jwt, instancePublicKey });
    expect(result).toEqual({ written: false, entityKey: keyOf(2) });
    expect(createEntity).not.toHaveBeenCalled();
    expect(rpc.queries()[0]?.text).toContain(`instanceKeyHash = str('${sha256(instancePublicKey)}')`);
  });

  it('creates a token row', async () => {
    const { createCall, writer } = setup();
    await writer.mirrorReleaseToken({ ...input, body: jwt, instancePublicKey });
    const [schema, values, options] = createCall();
    expect(schema).toBe(releaseTokenSchema);
    expect(values).toMatchObject({ examId, instanceKeyHash: sha256(instancePublicKey), body: jwt });
    expect(options).toMatchObject({ flags: { readonly: true, permissionlessExtension: true } });
  });

  it('writes a heartbeat every time, readonly, not extendable, for heartbeatLifetimeHours', async () => {
    const { rpc, createEntity, writer } = setup([existingRow(keyOf(1), arkiv.schemas.relayHeartbeat)]);
    const beat = { examId: `0x${'AB'.repeat(32)}` as Hex, registry, chainId: 11155111, entriesHash: `0x${'CD'.repeat(32)}`, stage: 'unlocking' };
    expect(await writer.heartbeat(beat)).toEqual({ entityKey: created.entityKey, txHash: created.txHash });
    await writer.heartbeat(beat);
    expect(createEntity).toHaveBeenCalledTimes(2);
    expect(rpc.queries()).toEqual([]);
    const [schema, values, options] = createEntity.mock.calls[0] ?? [];
    expect(schema).toBe(relayHeartbeatSchema);
    expect(values).toMatchObject({ examId, entriesHash, stage: 'unlocking' });
    expect(Object.keys(values as object).sort()).toEqual(['entriesHash', 'examId', 'registry', 'stage']);
    expect((values as Record<string, unknown>).registry).toMatchObject({ value: getAddress(registry) });
    expect(options).toEqual({
      expiration: ExpirationTime.fromHours(arkiv.heartbeatLifetimeHours),
      flags: { readonly: true, permissionlessExtension: false },
    });
  });

  it('writes empty strings for a heartbeat that has seen no log or stage', async () => {
    const { createEntity, writer } = setup();
    await writer.heartbeat({ examId, registry, entriesHash: null, stage: null });
    expect(createEntity.mock.calls[0]?.[1]).toMatchObject({ entriesHash: '', stage: '' });
    await expect(writer.heartbeat({ examId, registry, entriesHash: '0x12', stage: null })).rejects.toThrow(MirrorInputError);
    expect(createEntity).toHaveBeenCalledTimes(1);
  });

  it('refuses a token that is not a compact JWT, or a bad instance key', async () => {
    const { writer } = setup();
    await expect(writer.mirrorReleaseToken({ ...input, body: log(), instancePublicKey })).rejects.toThrow(/compact JWT/);
    const compressed: Hex = `0x02${'05'.repeat(32)}`;
    await expect(writer.mirrorReleaseToken({ ...input, body: jwt, instancePublicKey: compressed })).rejects.toThrow(/P-256/);
  });
});
