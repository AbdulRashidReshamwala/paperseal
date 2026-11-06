import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  custom,
  encodeErrorResult,
  getAddress,
  HttpRequestError,
  parseAbi,
  RpcRequestError,
  type Address,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { ens, registryCode as registryPin, passkeyRecordValue } from '@paperseal/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkPasskeyName,
  createEnsLookup,
  examRegistryAbi,
  checkRegistryCode,
  examRegistryBoard,
  examRegistryRuntime,
  isExamRegistryCode,
  parseArkivWriters,
  readDirectory,
  readPartyRecords,
  resolveExamName,
  type EnsLookup,
} from './index';

const name = 'jee-main-2026.paperseal-mumbai.eth';
const parent = 'paperseal-mumbai.eth';
const examId: Hex = '0xa8ec8fb4eda3d90b6190127d877227895bcd634a849e7f3a355311ed10637556';
import sampleCode from '../../../spec/fixtures/registry-code.json';

const registry: Address = '0x00000000000000000000000000000000000000aa';
const board: Address = '0x00000000000000000000000000000000000000bB';
const records: Record<string, string> = {
  [ens.records.tee]: 'https://tee.example.org',
  [ens.records.storage]: 'https://storage.example.org/jee',
  [ens.records.bucket]: 'paperseal-jee',
  [ens.records.arkivWriters]: ' 0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222 ',
};

/** ExamRegistry's deployed code with `forBoard` written into each `board` immutable, as its constructor does. */
function registryCode(forBoard: Address): Hex {
  let code: string = examRegistryRuntime.bytecode;
  const word = forBoard.slice(2).toLowerCase().padStart(64, '0');
  for (const offset of examRegistryRuntime.boardOffsets) {
    code = code.slice(0, 2 + offset * 2) + word + code.slice(2 + offset * 2 + 64);
  }
  return code as Hex;
}

/** A fake of the five reads, for a correctly set up name. Each test overrides the one it breaks. */
function lookup(overrides: Partial<EnsLookup> = {}): EnsLookup {
  return {
    address: (n) => Promise.resolve(n === name ? registry : n === parent ? board.toLowerCase() as Address : null),
    primaryName: (a) => Promise.resolve(a === board ? parent : null),
    text: (n, key) => Promise.resolve(n === name ? (records[key] ?? null) : null),
    code: (a) => Promise.resolve(a === registry ? registryCode(board) : undefined),
    board: (r) => Promise.resolve(r === registry ? board : '0x0000000000000000000000000000000000000000'),
    ...overrides,
  };
}

const reverted = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: examRegistryAbi, functionName: 'board', message: 'execution reverted' }),
    { abi: examRegistryAbi, functionName: 'board', contractAddress: registry },
  );

const universalResolver = sepolia.contracts.ensUniversalResolver.address;
/** What a resolver that wants a CCIP-Read gateway reverts with, through the Universal Resolver. */
const offchainLookup = encodeErrorResult({
  abi: parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']),
  errorName: 'OffchainLookup',
  args: [universalResolver, ['https://gateway.example.org/{sender}/{data}.json'], '0x1234', '0x12345678', '0x'],
});
/** The error viem throws for that revert with `ccipRead: false`. The UR's ABI has no OffchainLookup, so it stays raw. */
const needsGateway = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: [], data: offchainLookup, functionName: 'resolveWithGateways' }),
    { abi: [], functionName: 'resolveWithGateways', contractAddress: universalResolver },
  );

describe('the code pin in spec/registry.json', () => {
  const sample = sampleCode as { board: Address; code: Hex };
  const sampleBoard = getAddress(sample.board);

  it('matches the code `make abi` wrote, and ignores its metadata', () => {
    expect(examRegistryBoard(sample.code)).toBe(sampleBoard);
    expect(isExamRegistryCode(sample.code, sampleBoard)).toBe(true);
    expect(checkRegistryCode(sample.code)).toEqual({ state: 'match', board: sampleBoard });
    // A build from other comments differs only in the metadata's hash, near the end of the code.
    const flipped = `${sample.code.slice(0, -40)}${sample.code.slice(-40, -38) === '00' ? 'ff' : '00'}${sample.code.slice(-38)}` as Hex;
    expect(examRegistryBoard(flipped)).toBe(sampleBoard);
  });

  it('matches the code `make abi` generated, and any board', () => {
    expect(examRegistryBoard(registryCode(board))?.toLowerCase()).toBe(board.toLowerCase());
    expect(registryPin.boardOffsets).toEqual(examRegistryRuntime.boardOffsets);
  });

  it('tells no code from other code', () => {
    expect(checkRegistryCode(undefined)).toEqual({ state: 'none' });
    expect(checkRegistryCode('0x')).toEqual({ state: 'none' });
    expect(checkRegistryCode('0x6080')).toEqual({ state: 'different' });
    expect(checkRegistryCode(examRegistryRuntime.bytecode)).toEqual({ state: 'different' });
  });

  it('refuses code whose board words disagree, or do not hold an address', () => {
    const [first] = registryPin.boardOffsets;
    const at = 2 + (first ?? 0) * 2;
    const word = (digits: string) => (sample.code.slice(0, at) + digits + sample.code.slice(at + 64)) as Hex;
    expect(examRegistryBoard(word(`${'0'.repeat(24)}${'ab'.repeat(20)}`))).toBeNull();
    expect(examRegistryBoard(word('ff'.repeat(32)))).toBeNull();
    let dirty: string = sample.code;
    for (const offset of registryPin.boardOffsets) dirty = `${dirty.slice(0, 2 + offset * 2)}ff${dirty.slice(4 + offset * 2)}`;
    expect(examRegistryBoard(dirty as Hex)).toBeNull();
  });
});

describe('isExamRegistryCode', () => {
  // The live Sepolia registry 0x3Cb1AD8BCeB9bAeCE0000E6C4D5b9d7c283dc043 matches exactly with its board
  // 0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b (checked once with `cast code`; tests stay off the network).
  it('matches the deployed code for its own board only', () => {
    expect(isExamRegistryCode(registryCode(board), board)).toBe(true);
    expect(isExamRegistryCode(registryCode(board).toUpperCase().replace('0X', '0x') as Hex, board)).toBe(true);
    expect(isExamRegistryCode(registryCode(board), '0x00000000000000000000000000000000000000cc')).toBe(false);
    expect(isExamRegistryCode(examRegistryRuntime.bytecode, board)).toBe(false);
  });

  const code = registryCode(board);
  /** Bytes in the code, and where solc's CBOR metadata starts: its length is the last two bytes, plus those two. */
  const size = (code.length - 2) / 2;
  const executable = size - parseInt(code.slice(-4), 16) - 2;
  const flip = (hex: string, at: number) =>
    `${hex.slice(0, 2 + at * 2)}${hex.slice(2 + at * 2, 4 + at * 2) === 'ff' ? '00' : 'ff'}${hex.slice(4 + at * 2)}` as Hex;

  it('writes the board only in the executable part, before the metadata', () => {
    expect(executable).toBeGreaterThan(0);
    for (const offset of examRegistryRuntime.boardOffsets) expect(offset + 32).toBeLessThanOrEqual(executable);
  });

  it('refuses code that differs by one byte in the executable part, or in its length', () => {
    for (const at of [0, 4, examRegistryRuntime.boardOffsets[0] + 31, executable - 1]) {
      expect(isExamRegistryCode(flip(code, at), board), `byte ${at}`).toBe(false);
    }
    const metadata = code.slice(2 + executable * 2);
    expect(isExamRegistryCode(`${code.slice(0, 2 + executable * 2)}00${metadata}` as Hex, board)).toBe(false);
    expect(isExamRegistryCode(`${code.slice(0, 2 + (executable - 1) * 2)}${metadata}` as Hex, board)).toBe(false);
  });

  it('ignores the metadata, which a comment edit changes', () => {
    // A different source hash: any byte between the executable part and the two length bytes.
    for (const at of [executable, executable + 10, size - 3]) {
      expect(isExamRegistryCode(flip(code, at), board), `byte ${at}`).toBe(true);
    }
    // Metadata of another length, with the same executable part.
    const prefix = code.slice(0, 2 + executable * 2);
    expect(isExamRegistryCode(`${prefix}a1ff000003` as Hex, board)).toBe(true);
    expect(isExamRegistryCode(`${prefix}0000` as Hex, board)).toBe(true);
    // The board is still checked, outside the metadata.
    expect(isExamRegistryCode(flip(code, executable), '0x00000000000000000000000000000000000000cc')).toBe(false);
  });

  it('refuses code whose metadata length does not fit', () => {
    // Appending a byte moves the length bytes, so they declare garbage.
    expect(isExamRegistryCode(`${code}00`, board)).toBe(false);
    expect(isExamRegistryCode(code.slice(0, -2) as Hex, board)).toBe(false);
    // A length longer than the code, or one that swallows part of the executable code.
    expect(isExamRegistryCode(`${code.slice(0, -4)}ffff` as Hex, board)).toBe(false);
    expect(isExamRegistryCode(`${code.slice(0, -4)}${(size - executable - 1).toString(16).padStart(4, '0')}` as Hex, board)).toBe(false);
    // Too short to hold the length, empty, odd-length or not hex.
    for (const short of ['0x', '0x00', '0x0', `${code}0`, `${code.slice(0, -4)}zz00`]) {
      expect(isExamRegistryCode(short as Hex, board), short.slice(-6)).toBe(false);
    }
  });
});

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
        arkivWriters: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
        arkivWritersIgnored: [],
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

  it('fails registry when the address has no code', async () => {
    const result = await resolveExamName(name, { lookup: lookup({ code: () => Promise.resolve(undefined) }) });
    expect(result).toMatchObject({
      ok: false,
      failed: 'registry',
      reason: expect.stringContaining('no contract code') as string,
      partial: { registry },
    });
  });

  it('fails registry when the code is not ExamRegistry, whatever board() says', async () => {
    const code = registryCode(board);
    const oneByteOff = `${code.slice(0, -2)}${code.endsWith('33') ? '34' : '33'}` as Hex;
    const otherBoard: Address = '0x00000000000000000000000000000000000000cc';
    const cases: Partial<EnsLookup>[] = [
      { code: () => Promise.resolve(oneByteOff) },
      // The real code, but for another board: this board never wrote to it.
      { code: () => Promise.resolve(registryCode(otherBoard)) },
      { board: () => Promise.resolve(otherBoard) },
    ];
    for (const overrides of cases) {
      const result = await resolveExamName(name, { lookup: lookup(overrides) });
      expect(result).toMatchObject({
        ok: false,
        failed: 'registry',
        reason: expect.stringContaining('its code differs') as string,
        partial: { registry },
      });
      expect(result.ok || result.partial.board).toBeUndefined();
    }
  });

  it('fails the check whose read needs an offchain gateway, instead of retrying', async () => {
    const offchain = () => Promise.reject(needsGateway());
    const cases: [Partial<EnsLookup>, string][] = [
      [{ address: offchain }, 'registry'],
      [{ board: offchain }, 'registry'],
      [{ primaryName: offchain }, 'primaryName'],
      [{ address: (n) => (n === name ? Promise.resolve(registry) : offchain()) }, 'forward'],
      [{ text: offchain }, 'registry'],
    ];
    for (const [overrides, failed] of cases) {
      expect(await resolveExamName(name, { lookup: lookup(overrides) }), failed).toMatchObject({
        ok: false,
        failed,
        reason: expect.stringContaining('needs an offchain gateway') as string,
      });
    }
  });

  it('fails the check whose read the chain refuses, not unreadable', async () => {
    const refused = () => Promise.reject(reverted());
    expect(await resolveExamName(name, { lookup: lookup({ primaryName: refused }) })).toMatchObject({
      ok: false,
      failed: 'primaryName',
    });
    expect(await resolveExamName(name, { lookup: lookup({ address: refused }) })).toMatchObject({
      ok: false,
      failed: 'registry',
    });
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
    expect(await resolveExamName(name, { lookup: lookup({ code: down }) })).toMatchObject({
      ok: false,
      failed: 'unreadable',
      partial: { registry },
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

  it('fails registry when a TEE or storage record is not a web address', async () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
      const result = await resolveExamName(name, {
        lookup: lookup({ text: (_, key) => Promise.resolve(key === ens.records.storage ? bad : records[key] ?? null) }),
      });
      expect(result, bad).toMatchObject({ ok: false, failed: 'registry', reason: expect.stringContaining('not a web address') as string });
    }
  });

  it('gives null for unset text records', async () => {
    const result = await resolveExamName(name, {
      lookup: lookup({ text: (_, key) => Promise.resolve(key === ens.records.tee ? '' : null) }),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { teeUrl: null, storageUrl: null, bucket: null, arkivWriters: null, arkivWritersIgnored: [] },
    });
  });

  it('keeps the valid arkivWriters entries and reports the rest', async () => {
    const record = ' 0xab5801a7d398351b8be11c439e05c5b3259aec9b, ,nope,0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B,0xAB5801A7D398351B8BE11C439E05C5B3259AEC9b,0x1234,';
    const result = await resolveExamName(name, {
      lookup: lookup({ text: (_, key) => Promise.resolve(key === ens.records.arkivWriters ? record : null) }),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        // Lowercase and correctly checksummed entries are the same writer; a bad checksum is not.
        arkivWriters: ['0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B'],
        arkivWritersIgnored: ['nope', '0xAB5801A7D398351B8BE11C439E05C5B3259AEC9b', '0x1234'],
      },
    });
  });

  it('gives an empty list, not null, for an arkivWriters record with no valid entry', () => {
    expect(parseArkivWriters(' , ')).toEqual({ arkivWriters: [], arkivWritersIgnored: [] });
    expect(parseArkivWriters('x')).toEqual({ arkivWriters: [], arkivWritersIgnored: ['x'] });
    expect(parseArkivWriters(null)).toEqual({ arkivWriters: null, arkivWritersIgnored: [] });
  });

  it('fails registry when the chain refuses the arkivWriters record, and is unreadable when the RPC fails', async () => {
    const only = (error: () => Error) =>
      lookup({ text: (_, key) => (key === ens.records.arkivWriters ? Promise.reject(error()) : Promise.resolve(records[key] ?? null)) });
    expect(await resolveExamName(name, { lookup: only(reverted) })).toMatchObject({
      ok: false,
      failed: 'registry',
      reason: expect.stringContaining(ens.records.arkivWriters) as string,
    });
    expect(await resolveExamName(name, { lookup: only(needsGateway) })).toMatchObject({
      ok: false,
      failed: 'registry',
      reason: expect.stringContaining('needs an offchain gateway') as string,
    });
    const down = () => new HttpRequestError({ url: 'https://rpc.example.org', status: 503 });
    expect(await resolveExamName(name, { lookup: only(down) })).toMatchObject({ ok: false, failed: 'unreadable' });
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

  it('fails registry, and asks no gateway, when the resolver reverts with OffchainLookup', async () => {
    expect(offchainLookup.slice(0, 10)).toBe('0x556f1830');
    const fetch = vi.spyOn(globalThis, 'fetch');
    // The node answers eth_call as an http transport would surface it: a JSON-RPC revert with data.
    const transport = custom({
      request: ({ method, params }: { method: string; params: [{ to: Hex }] }) => {
        if (method === 'eth_chainId') return Promise.resolve('0xaa36a7');
        if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
        expect(params[0].to.toLowerCase()).toBe(universalResolver.toLowerCase());
        throw new RpcRequestError({
          body: { method },
          error: { code: 3, message: 'execution reverted', data: offchainLookup },
          url: 'https://rpc.example.org',
        });
      },
    });
    expect(await resolveExamName(name, { transport })).toMatchObject({
      ok: false,
      failed: 'registry',
      reason: expect.stringContaining('needs an offchain gateway') as string,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves a name unreadable when the RPC itself fails', async () => {
    const failures = [
      new HttpRequestError({ url: 'https://rpc.example.org', status: 503 }),
      // viem calls any -32603 with a message a revert; without revert data it is an outage.
      new RpcRequestError({ body: {}, error: { code: -32603, message: 'internal error' }, url: 'https://rpc.example.org' }),
      new Error('fetch failed'),
    ];
    for (const failure of failures) {
      const transport = custom(
        {
          request: ({ method }: { method: string }) => {
            if (method === 'eth_chainId') return Promise.resolve('0xaa36a7');
            throw failure;
          },
        },
        { retryCount: 0 },
      );
      expect(await resolveExamName(name, { transport }), failure.message).toMatchObject({
        ok: false,
        failed: 'unreadable',
      });
    }
  });

  it("refuses to fall back to viem's default public RPC", async () => {
    expect(() => createEnsLookup({})).toThrow('rpcUrl or transport');
    expect(() => createEnsLookup({ rpcUrl: '' })).toThrow('rpcUrl or transport');
    await expect(resolveExamName(name, {})).rejects.toThrow('rpcUrl or transport');
  });
});

describe('checkPasskeyName', () => {
  const holderName = 'dr-rao.maths-board.eth';
  const key: Hex = `0x04${'ab'.repeat(64)}`;
  const otherKey: Hex = `0x04${'cd'.repeat(64)}`;
  const withRecord = (value: string | null) => lookup({ text: (n, k) => Promise.resolve(n === holderName && k === ens.records.passkey ? value : null) });

  it('confirms a record that is the hash of the passkey, whatever its case or edge spaces', async () => {
    const value = passkeyRecordValue(key);
    expect(await checkPasskeyName(holderName, key, { lookup: withRecord(value) })).toMatchObject({ state: 'confirmed', expected: value });
    expect(await checkPasskeyName(holderName, key, { lookup: withRecord(` ${value.toUpperCase().replace('0X', '0x')}\n`) })).toMatchObject({
      state: 'confirmed',
    });
  });

  it('reads the paperseal.passkey record', async () => {
    const asked: string[] = [];
    await checkPasskeyName(holderName, key, { lookup: lookup({ text: (_, k) => (asked.push(k), Promise.resolve(null)) }) });
    expect(asked).toEqual(['paperseal.passkey']);
  });

  it('is a mismatch for another key, and missing when nothing is set', async () => {
    expect(await checkPasskeyName(holderName, key, { lookup: withRecord(passkeyRecordValue(otherKey)) })).toMatchObject({
      state: 'mismatch',
      found: passkeyRecordValue(otherKey),
    });
    expect(await checkPasskeyName(holderName, key, { lookup: withRecord(null) })).toMatchObject({ state: 'missing', found: null });
    expect(await checkPasskeyName(holderName, key, { lookup: withRecord('  ') })).toMatchObject({ state: 'missing' });
  });

  it('is refused, and asks no gateway, when the read needs one or reverts', async () => {
    const offchain = () => Promise.reject(needsGateway());
    expect(await checkPasskeyName(holderName, key, { lookup: lookup({ text: offchain }) })).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('needs an offchain gateway') as string,
    });
    expect(await checkPasskeyName(holderName, key, { lookup: lookup({ text: () => Promise.reject(reverted()) }) })).toMatchObject({
      state: 'refused',
    });
  });

  it('is unreadable when the RPC fails, and never throws', async () => {
    const down = () => Promise.reject(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 }));
    expect(await checkPasskeyName(holderName, key, { lookup: lookup({ text: down }) })).toMatchObject({ state: 'unreadable' });
  });

  it('is invalid for a plain name or a name that is not normalised, and reads nothing', async () => {
    const text = vi.fn(() => Promise.resolve(null));
    for (const bad of ['Dr Rao', 'Dr-Rao.maths-board.eth', 'plain']) {
      expect(await checkPasskeyName(bad, key, { lookup: lookup({ text }) }), bad).toMatchObject({ state: 'invalid' });
    }
    expect(text).not.toHaveBeenCalled();
  });

  it('asks only the viewer RPC with no gateway, through the real lookup', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const transport = custom({
      request: ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return Promise.resolve('0xaa36a7');
        throw new RpcRequestError({
          body: { method },
          error: { code: 3, message: 'execution reverted', data: offchainLookup },
          url: 'https://rpc.example.org',
        });
      },
    });
    expect(await checkPasskeyName(holderName, key, { transport })).toMatchObject({ state: 'refused' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(Promise.resolve().then(() => checkPasskeyName(holderName, key, {}))).rejects.toThrow(/own RPC/);
  });
});

describe('readPartyRecords', () => {
  const texts = (values: Record<string, string | null>): { lookup: EnsLookup } => ({
    lookup: { text: (_name: string, key: string) => Promise.resolve(values[key] ?? null) } as unknown as EnsLookup,
  });
  const failing = (error: unknown): { lookup: EnsLookup } => ({ lookup: { text: () => Promise.reject(error as Error) } as unknown as EnsLookup });
  const passkey = `0x${'ab'.repeat(32)}`;

  it('finds both records, and tidies them', async () => {
    expect(await readPartyRecords('dr-rao.eth', texts({ [ens.records.passkey]: ` ${passkey.toUpperCase().replace('0X', '0x')} `, [ens.records.credential]: '0xAB' }))).toEqual({
      state: 'found',
      name: 'dr-rao.eth',
      passkey,
      credentialId: '0xab',
    });
  });

  it('needs both records', async () => {
    expect(await readPartyRecords('dr-rao.eth', texts({ [ens.records.passkey]: passkey }))).toMatchObject({ state: 'missing' });
    expect(await readPartyRecords('dr-rao.eth', texts({ [ens.records.credential]: '0xab' }))).toMatchObject({ state: 'missing' });
    expect(await readPartyRecords('dr-rao.eth', texts({ [ens.records.passkey]: passkey, [ens.records.credential]: 'nope' }))).toMatchObject({ state: 'refused' });
  });

  it('says when it could not read, and never throws', async () => {
    expect(await readPartyRecords('dr-rao.eth', failing(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 })))).toMatchObject({ state: 'unreadable' });
    expect(await readPartyRecords('Dr Rao', texts({}))).toMatchObject({ state: 'invalid' });
  });
});

describe('readDirectory', () => {
  const holding = (value: string | null): { lookup: EnsLookup } => ({ lookup: { text: () => Promise.resolve(value) } as unknown as EnsLookup });

  it('reads the names with one text lookup', async () => {
    const text = vi.fn(() => Promise.resolve('["a.paperseal-demo.eth"]'));
    expect(await readDirectory('paperseal-demo.eth', { lookup: { text } as unknown as EnsLookup })).toEqual({
      state: 'found',
      name: 'paperseal-demo.eth',
      names: ['a.paperseal-demo.eth'],
    });
    expect(text).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledWith('paperseal-demo.eth', ens.records.directory);
  });

  it('tells an empty directory from a broken one, and an outage from both', async () => {
    expect(await readDirectory('paperseal-demo.eth', holding(null))).toMatchObject({ state: 'none' });
    expect(await readDirectory('paperseal-demo.eth', holding('not a list'))).toMatchObject({ state: 'malformed' });
    expect(
      await readDirectory('paperseal-demo.eth', { lookup: { text: () => Promise.reject(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 })) } as unknown as EnsLookup }),
    ).toMatchObject({ state: 'unreadable' });
  });
});
