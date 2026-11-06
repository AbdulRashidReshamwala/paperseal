import { arkiv, type BackupInput } from '@paperseal/arkiv';
import {
  attestationNonce,
  encodeApprovedList,
  entriesHash,
  fromHex,
  setterOwner,
  storageNames,
  toHex,
  type ApprovedListEntry,
} from '@paperseal/protocol';
import type { ChainState, CollectionFile, PostageBatch, UploadOptions, Wallet } from '@paperseal/swarm';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { parseCommand, UsageError, type BackupTarget, type SwarmApi } from './args';
import { backupFailed, BackupRefused, checkBatch, prepareBackup, readBackUrl, resultLines, sha256Hex, uploadBackup, type BackupRegistry } from './backup';
import { explorerLinks } from './mirror';
import { storageObjectUrl, type Fetch } from './storage';
import { batchQuote, buyStamp, swarmNetworks, swarmStatusLines, syncing, syncLagBlocks, type SwarmSnapshot } from './swarm-node';

const examId: Hex = `0x${'ab'.repeat(32)}`;
const registry: Address = '0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8';
const storage = 'https://storage.example/bucket';
const batchId = 'b7'.repeat(32);
const instanceKey: Hex = `0x04${'33'.repeat(64)}`;
const utf8 = (text: string) => new TextEncoder().encode(text);
const links = explorerLinks(arkiv.network.explorer);

const point = (byte: number) => {
  const key = new Uint8Array(65).fill(byte);
  key[0] = 4;
  return key;
};

/** One setter, 3 neutral key holders and 7 centres that hold keys, as dry-check's sample list. */
const listEntries: ApprovedListEntry[] = (() => {
  const setter = point(1);
  const entries: ApprovedListEntry[] = [{ role: 1, passkeyPublicKey: setter, derivedPublicKey: new Uint8Array(), owner: setterOwner(setter) }];
  for (let i = 0; i < 10; i += 1) {
    entries.push({ role: i < 3 ? 2 : 3, passkeyPublicKey: point(10 + 2 * i), derivedPublicKey: point(11 + 2 * i), owner: `holder-${String(i)}` });
  }
  return entries;
})();
const holders = listEntries.filter((e) => e.role !== 1).map((e) => e.derivedPublicKey);
const centres = listEntries.filter((e) => e.role === 3 || e.role === 4).map((e) => e.derivedPublicKey);

/** The pre-Build files, by storage name. */
const buildFiles: Record<string, Uint8Array> = {
  [storageNames.paper]: utf8('encrypted paper'),
  [storageNames.keyPub]: utf8('timelocked K_pub'),
  [storageNames.token]: utf8('build.token.jwt'),
  ...Object.fromEntries(holders.map((key, i) => [storageNames.share(key), utf8(`share ${String(i)}`)])),
};

function manifestBytes(files: Record<string, Uint8Array> = buildFiles, exam: Hex = examId): Uint8Array {
  const listed = Object.keys(files)
    .sort()
    .map((name) => {
      const holder = holders.find((key) => storageNames.share(key) === name);
      return { name, sha256: sha256Hex(files[name] as Uint8Array), ...(holder ? { recipient: toHex(holder), shareHash: `0x${'5'.repeat(64)}` } : {}) };
    });
  return utf8(JSON.stringify({ examId: exam, files: listed }));
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (nonce: string) => `${b64({ alg: 'RS256' })}.${b64({ eat_nonce: [nonce], iss: 'https://confidentialcomputing.googleapis.com' })}.c2ln`;

function releaseLog(options: { exam?: Hex; badHash?: boolean } = {}): Uint8Array {
  const entries = [{ passkeyPublicKey: toHex(point(10)), shareHash: `0x${'77'.repeat(32)}` as Hex, round: '42' }];
  const hash = toHex(entriesHash(entries.map((e) => ({ passkeyPublicKey: fromHex(e.passkeyPublicKey), shareHash: fromHex(e.shareHash), round: BigInt(e.round) }))));
  return utf8(
    JSON.stringify({
      examId: options.exam ?? examId,
      entries,
      entriesHash: options.badHash ? `0x${'00'.repeat(32)}` : hash,
      teeSignature: `0x${'00'.repeat(64)}`,
      instancePublicKey: instanceKey,
    }),
  );
}

/** The files written at unlock. */
const unlockStorage = (): Record<string, Uint8Array> => ({
  [storageNames.releaseLog]: releaseLog(),
  'release-token.jwt': utf8(jwt(attestationNonce(fromHex(instanceKey), fromHex(examId)))),
  [storageNames.keyPriv]: utf8('timelocked K_priv'),
  ...Object.fromEntries(centres.map((key, i) => [storageNames.centreKeyPriv(key), utf8(`K_priv for centre ${String(i)}`)])),
});

const without = (files: Record<string, Uint8Array>, name: string) => Object.fromEntries(Object.entries(files).filter(([key]) => key !== name));

/** A fetch serving `<storage>/<examId>/<name>` from a table, 404 for the rest. */
function storageFetch(files: Record<string, Uint8Array>): Fetch {
  const table = new Map(Object.entries(files).map(([name, bytes]) => [storageObjectUrl(storage, examId, name), bytes]));
  return ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bytes = table.get(url);
    return Promise.resolve(bytes ? new Response(new Uint8Array(bytes)) : new Response('NoSuchKey', { status: 404 }));
  }) as Fetch;
}

const usableBatch: PostageBatch = {
  batchId,
  usable: true,
  label: 'paperseal',
  depth: 19,
  bucketDepth: 16,
  amount: 10n ** 9n,
  utilization: 2,
  immutable: true,
  exists: true,
  ttlSeconds: 7 * 86_400,
  blockNumber: 100,
};

const swarmApi: SwarmApi = { url: 'http://127.0.0.1:1633', source: 'default' };
const reference = 'ce'.repeat(32);

function setup(options: {
  files?: Record<string, Uint8Array>;
  chainHash?: Hex | null;
  batch?: PostageBatch;
  readBack?: Uint8Array | null;
} = {}) {
  const files = options.files ?? { ...buildFiles, [storageNames.manifest]: manifestBytes() };
  const manifest = files[storageNames.manifest];
  const chainHash = options.chainHash === undefined ? (manifest ? sha256Hex(manifest) : `0x${'99'.repeat(32)}`) : options.chainHash;
  const registryMock: BackupRegistry = {
    getBuild: vi.fn(() => Promise.resolve(chainHash === null ? null : ({ storageManifestHash: chainHash } as never))),
    getApprovedListEntries: vi.fn(() => Promise.resolve(toHex(encodeApprovedList(listEntries)))),
  };
  const uploads: { files: CollectionFile[]; options: UploadOptions }[] = [];
  const swarm = {
    stamps: vi.fn(() => Promise.resolve([options.batch ?? usableBatch])),
    uploadCollection: vi.fn((uploaded: readonly CollectionFile[], uploadOptions: UploadOptions) => {
      uploads.push({ files: [...uploaded], options: uploadOptions });
      return Promise.resolve({ reference });
    }),
    download: vi.fn(() => Promise.resolve(options.readBack === undefined ? (manifest ?? null) : options.readBack)),
  };
  const rows: BackupInput[] = [];
  const writer = {
    address: '0x1111111111111111111111111111111111111111' as Address,
    mirrorBackup: vi.fn((input: BackupInput) => {
      rows.push(input);
      return Promise.resolve({ written: true, entityKey: `0x${'0e'.repeat(32)}` as Hex, txHash: `0x${'0f'.repeat(32)}` as Hex });
    }),
  };
  const target = (overrides: Partial<BackupTarget> = {}): BackupTarget => ({
    examId,
    registry,
    storageUrl: storage,
    batchId,
    phase: undefined,
    swarm: swarmApi,
    rpcUrl: 'https://sepolia.example',
    rpcSource: '--rpc',
    dryRun: false,
    ...overrides,
  });
  /** What `backup` does: every check, then the upload and the row. */
  const run = async (overrides: Partial<BackupTarget> = {}) => {
    const t = target(overrides);
    const plan = await prepareBackup(t, { fetch: storageFetch(files), registry: registryMock });
    await checkBatch(swarm, t.batchId);
    return { plan, result: await uploadBackup(t, plan, { swarm, writer }) };
  };
  return { run, target, uploads, rows, swarm, writer, registry: registryMock, files };
}

describe('backup phase', () => {
  it('is build when storage has no release-log.json', async () => {
    const s = setup();
    const { plan } = await s.run();
    expect(plan.phase).toBe('build');
    expect(plan.phaseReason).toBe('storage has no release-log.json');
    expect(s.uploads[0]?.files.map((f) => f.path)).toEqual([storageNames.manifest, ...Object.keys(buildFiles).sort()]);
  });

  it('is unlock when storage has release-log.json, and adds the unlock files', async () => {
    const s = setup({ files: { ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage() } });
    const { plan } = await s.run();
    expect(plan.phase).toBe('unlock');
    const paths = s.uploads[0]?.files.map((f) => f.path) ?? [];
    expect(paths.slice(0, 1 + Object.keys(buildFiles).length)).toEqual([storageNames.manifest, ...Object.keys(buildFiles).sort()]);
    expect(paths.slice(1 + Object.keys(buildFiles).length)).toEqual([
      'release-log.json',
      'release-token.jwt',
      'key-priv.tlock',
      ...centres.map((key) => storageNames.centreKeyPriv(key)).sort(),
    ]);
    expect(plan.checks.filter((c) => c.result === 'unhashed').map((c) => c.file)).toEqual(['key-priv.tlock', 'key-priv/*']);
    expect(s.rows[0]?.files).toBe(paths.length);
  });

  it('follows --phase build even when the log is there', async () => {
    const s = setup({ files: { ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage() } });
    const { plan } = await s.run({ phase: 'build' });
    expect(plan.phase).toBe('build');
    expect(s.uploads[0]?.files.some((f) => f.path === 'release-log.json')).toBe(false);
  });

  it('refuses --phase unlock with no release log', async () => {
    const s = setup();
    await expect(s.run({ phase: 'unlock' })).rejects.toThrow(/no release-log.json/);
    expect(s.swarm.uploadCollection).not.toHaveBeenCalled();
  });
});

describe('backup refusals upload nothing and write nothing', () => {
  const refuses = async (s: ReturnType<typeof setup>, pattern: RegExp, overrides: Partial<BackupTarget> = {}) => {
    const error: unknown = await s.run(overrides).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BackupRefused);
    expect((error as Error).message).toMatch(pattern);
    expect(s.swarm.uploadCollection).not.toHaveBeenCalled();
    expect(s.writer.mirrorBackup).not.toHaveBeenCalled();
  };

  it('when the manifest does not hash to the Build storageManifestHash', async () => {
    await refuses(setup({ chainHash: `0x${'99'.repeat(32)}` }), /not the Build's storageManifestHash 0x9999/);
  });

  it('when there is no Build', async () => {
    await refuses(setup({ chainHash: null }), /has no Build on chain/);
  });

  it('when a listed file does not match its sha256', async () => {
    const files = { ...buildFiles, [storageNames.manifest]: manifestBytes(), [storageNames.paper]: utf8('tampered paper') };
    await refuses(setup({ files }), /paper.bin hashes to 0x[0-9a-f]{64}, not 0x[0-9a-f]{64} in the manifest/);
  });

  it('when a listed file is missing', async () => {
    const files = without({ ...buildFiles, [storageNames.manifest]: manifestBytes() }, storageNames.keyPub);
    await refuses(setup({ files }), /storage has no key-pub.tlock/);
  });

  it('when the manifest is for another exam', async () => {
    await refuses(setup({ files: { ...buildFiles, [storageNames.manifest]: manifestBytes(buildFiles, `0x${'cd'.repeat(32)}`) } }), /is for exam 0xcdcd/);
  });

  it("when the release log's entriesHash is not its entries' hash", async () => {
    const files = { ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage(), [storageNames.releaseLog]: releaseLog({ badHash: true }) };
    await refuses(setup({ files }), /entries hash to/);
  });

  it('when the release log is for another exam', async () => {
    const files = { ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage(), [storageNames.releaseLog]: releaseLog({ exam: `0x${'cd'.repeat(32)}` }) };
    await refuses(setup({ files }), /release log is for exam 0xcdcd/);
  });

  it("when the release token's eat_nonce does not bind the log's signer", async () => {
    const files = { ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage(), 'release-token.jwt': utf8(jwt('00'.repeat(32))) };
    await refuses(setup({ files }), /eat_nonce does not bind/);
  });

  it("when a centre's key-priv file is missing", async () => {
    const files = without({ ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage() }, storageNames.centreKeyPriv(centres[3] as Uint8Array));
    await refuses(setup({ files }), /storage has no key-priv\/0x04/);
  });

  it('when the batch is not usable', async () => {
    await refuses(setup({ batch: { ...usableBatch, usable: false } }), /is not usable yet/);
  });

  it('when the node does not hold the batch', async () => {
    await refuses(setup({ batch: { ...usableBatch, batchId: 'aa'.repeat(32) } }), /has no postage batch/);
  });
});

describe('backup upload', () => {
  it('uploads with deferred false and writes the row with the right fields', async () => {
    const s = setup();
    const { plan, result } = await s.run();
    expect(s.uploads).toHaveLength(1);
    expect(s.uploads[0]?.options).toEqual({ batchId, deferred: false });
    for (const file of s.uploads[0]?.files ?? []) expect(file.bytes).toEqual(s.files[file.path]);
    expect(s.rows).toEqual([
      {
        examId,
        registry,
        phase: 'build',
        swarmRef: reference,
        swarmNetwork: arkiv.swarm.network,
        manifestHash: sha256Hex(s.files[storageNames.manifest] as Uint8Array),
        files: 1 + Object.keys(buildFiles).length,
        batchId,
      },
    ]);
    expect(plan.manifestHash).toBe(s.rows[0]?.manifestHash);
    expect(s.swarm.download).toHaveBeenCalledWith(reference, 'manifest.json');
    expect(result.readBack).toEqual({ result: 'match' });
    expect(backupFailed(result)).toBe(false);
    const lines = resultLines(result, swarmApi.url, links).join('\n');
    expect(lines).toContain(`reference ${reference}`);
    expect(lines).toContain(`http://127.0.0.1:1633/bzz/${reference}/manifest.json`);
    expect(lines).toContain(`${arkiv.network.explorer}/entity/0x${'0e'.repeat(32)}`);
    expect(lines).toContain('matches the bytes uploaded');
  });

  it('reports a read-back mismatch', async () => {
    const s = setup({ readBack: utf8('something else') });
    const { result } = await s.run();
    expect(result.readBack.result).toBe('mismatch');
    expect(backupFailed(result)).toBe(true);
    expect(resultLines(result, swarmApi.url, links).join('\n')).toMatch(/read-back MISMATCH: 14 bytes hashing to 0x/);
  });

  it('reports a read-back that finds nothing', async () => {
    const s = setup({ readBack: null });
    const { result } = await s.run();
    expect(result.readBack.result).toBe('missing');
    expect(backupFailed(result)).toBe(true);
  });

  it('still prints the reference when the row fails', async () => {
    const s = setup();
    s.writer.mirrorBackup.mockRejectedValueOnce(new Error('rpc down'));
    const { result } = await s.run();
    expect(backupFailed(result)).toBe(true);
    expect(resultLines(result, swarmApi.url, links).join('\n')).toMatch(/row {7}FAILED: Error: rpc down/);
  });

  it('builds the read-back link from the Bee API', () => {
    expect(readBackUrl('http://bee:1633/', reference)).toBe(`http://bee:1633/bzz/${reference}/manifest.json`);
  });
});

describe('arguments', () => {
  it('parse backup, swarm-status and buy-stamp, with the Bee API from --swarm, RELAY_SWARM_API or the spec', () => {
    const backup = parseCommand(['backup', '--exam', examId, '--registry', registry, '--storage', `${storage}/`, '--batch', `0x${batchId.toUpperCase()}`], {});
    expect(backup.command === 'backup' && backup.target).toMatchObject({
      examId,
      registry,
      storageUrl: storage,
      batchId,
      phase: undefined,
      swarm: { url: arkiv.swarm.defaultApiUrl, source: 'default' },
      rpcSource: 'default',
      dryRun: false,
    });
    const env = parseCommand(['swarm-status'], { RELAY_SWARM_API: 'http://bee.local:1633/' });
    expect(env.command === 'swarm-status' && env.swarm).toEqual({ url: 'http://bee.local:1633', source: 'RELAY_SWARM_API' });
    const flag = parseCommand(['buy-stamp', '--depth', '19', '--days', '7', '--swarm', 'http://x:1633'], { RELAY_SWARM_API: 'http://bee.local:1633' });
    expect(flag.command === 'buy-stamp' && flag).toMatchObject({ depth: 19, days: 7, yes: false, swarm: { url: 'http://x:1633', source: '--swarm' } });
    const phase = parseCommand(['backup', '--exam', examId, '--registry', registry, '--storage', storage, '--batch', batchId, '--phase', 'unlock', '--dry-run'], {});
    expect(phase.command === 'backup' && phase.target.phase === 'unlock' && phase.target.dryRun).toBe(true);
  });

  it.each([
    [['backup', '--exam', examId, '--registry', registry, '--batch', batchId]],
    [['backup', '--exam', examId, '--registry', registry, '--storage', storage]],
    [['backup', '--exam', examId, '--registry', registry, '--storage', storage, '--batch', 'abc']],
    [['backup', '--exam', examId, '--registry', registry, '--storage', storage, '--batch', batchId, '--phase', 'later']],
    [['buy-stamp', '--depth', '16', '--days', '7']],
    [['buy-stamp', '--depth', '19']],
    [['buy-stamp', '--depth', '19', '--days', '0']],
    [['swarm-status', '--swarm', 'ftp://bee']],
  ])('refuses %j', (argv) => {
    expect(() => parseCommand(argv, {})).toThrow(UsageError);
  });
});

const chainState: ChainState = { chainTip: 1000, block: 1000, totalAmount: 5n, currentPrice: 24_000n };
const wallet = (bzz: bigint): Wallet => ({ bzzBalance: bzz, nativeTokenBalance: 10n ** 17n, chainId: 11_155_111, walletAddress: '0xNODE' });

describe('swarm-status', () => {
  it('prints health, node, wallet, price, batches and the recommended quote', () => {
    const snapshot: SwarmSnapshot = {
      api: swarmApi,
      health: { ok: true, value: { status: 'ok', version: '2.6.0', apiVersion: '7.3.0' } },
      addresses: { ok: true, value: { overlay: 'ov'.repeat(32), underlay: [], ethereum: '0xNODE', chainAddress: '', publicKey: '', pssPublicKey: '' } },
      wallet: { ok: true, value: wallet(5n * 10n ** 15n) },
      chainState: { ok: true, value: chainState },
      stamps: { ok: true, value: [usableBatch] },
    };
    const lines = swarmStatusLines(snapshot);
    const quote = batchQuote(chainState, 19, 7, swarmNetworks.sepolia);
    expect(lines).toEqual([
      'Bee API   http://127.0.0.1:1633 (swarm.defaultApiUrl in spec/arkiv.json)',
      'health    ok, Bee 2.6.0, API 7.3.0',
      `node      0xNODE (overlay ${'ov'.repeat(32)})`,
      'wallet    0xNODE on chain 11155111 (sepolia)',
      '          0.5 sBZZ (5000000000000000 PLUR), 0.1 ETH',
      'price     24000 PLUR per chunk per block; block 1000 of tip 1000',
      'batches   1',
      `  ${batchId}  depth 19  usable  utilization 2/8 (25.0%)  ttl 7d 0h  label paperseal`,
      'recommended batch: depth 19 for 7 days (bucket depth 16), not bought',
      '  depth     19: 524288 chunks of 4096 bytes, at most; fewer fill in practice (see the Swarm docs\' effective volume table)',
      `  amount    ${quote.amount.toString()} PLUR per chunk: 50400 blocks of 12s for 7 days (Bee's minimum 414720000)`,
      `  cost      ${quote.plur.toString()} PLUR = ${quote.bzz} sBZZ`,
      '  buy it:   node relay/cli.mjs buy-stamp --depth 19 --days 7 --yes',
    ]);
    const behind = swarmStatusLines({ ...snapshot, chainState: { ok: true, value: { ...chainState, block: 900 } } });
    expect(behind).toContain('          note: Bee is still syncing the postage contract, so this price may change and batches may be unavailable');
    // 7 days of 12-second blocks at 24000 PLUR: 50400 * 24000 per chunk, times 2^19 chunks.
    expect(quote.amount).toBe(50_400n * 24_000n);
    expect(quote.plur).toBe(50_400n * 24_000n * 524_288n);
  });

  it('prints each unavailable endpoint and still prints the rest', () => {
    const down = { ok: false as const, error: 'SwarmApiError: GET /wallet: 503 syncing' };
    const lines = swarmStatusLines({
      api: { url: 'http://bee:1633', source: '--swarm' },
      health: { ok: true, value: { status: 'ok', version: '2.6.0', apiVersion: '7.3.0' } },
      addresses: down,
      wallet: down,
      chainState: down,
      stamps: { ok: true, value: [] },
    });
    expect(lines).toContain('wallet    unavailable: SwarmApiError: GET /wallet: 503 syncing');
    expect(lines).toContain('batches   0 (buy one with buy-stamp)');
    expect(lines.at(-1)).toBe('  no quote: the price is unavailable');
  });

  it("raises a short batch to Bee's minimum amount", () => {
    const quote = batchQuote({ ...chainState, minimumValidityBlocks: 100_000 }, 17, 1, swarmNetworks.sepolia);
    expect(quote.raised).toBe(true);
    expect(quote.amount).toBe(24_000n * 100_000n);
  });
});

describe('buy-stamp', () => {
  const client = (bzz = 10n ** 17n) => ({
    chainState: vi.fn(() => Promise.resolve(chainState)),
    wallet: vi.fn(() => Promise.resolve(wallet(bzz))),
    buyStamp: vi.fn(() => Promise.resolve('fe'.repeat(32))),
  });

  it('prints the cost and buys nothing without --yes', async () => {
    const c = client();
    const outcome = await buyStamp({ api: swarmApi, depth: 19, days: 7, label: undefined, yes: false }, c);
    expect(c.buyStamp).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.batchId).toBeUndefined();
    const quote = batchQuote(chainState, 19, 7, swarmNetworks.sepolia);
    expect(outcome.lines).toContain(`  cost      ${quote.plur.toString()} PLUR = ${quote.bzz} sBZZ`);
    expect(outcome.lines.join('\n')).toContain('not bought: nothing was spent.');
    expect(outcome.lines.at(-1)).toBe('To buy it, run the same command with --yes: node relay/cli.mjs buy-stamp --depth 19 --days 7 --yes');
  });

  it('buys with --yes and prints the batch ID', async () => {
    const c = client();
    const outcome = await buyStamp({ api: swarmApi, depth: 19, days: 7, label: 'exam', yes: true }, c);
    expect(c.buyStamp).toHaveBeenCalledWith({ amount: 50_400n * 24_000n, depth: 19, label: 'exam' });
    expect(outcome.batchId).toBe('fe'.repeat(32));
    expect(outcome.lines.join('\n')).toContain(`bought    batch ${'fe'.repeat(32)}`);
  });

  it('refuses --yes while Bee is still syncing the postage contract', async () => {
    const c = { ...client(), chainState: vi.fn(() => Promise.resolve({ ...chainState, block: 900 })) };
    const outcome = await buyStamp({ api: swarmApi, depth: 19, days: 7, label: undefined, yes: true }, c);
    expect(c.buyStamp).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.at(-1)).toMatch(/^not bought: Bee has processed block 900 of 1000/);
  });

  it('refuses when the wallet cannot pay, even with --yes', async () => {
    const c = client(1n);
    const outcome = await buyStamp({ api: swarmApi, depth: 19, days: 7, label: undefined, yes: true }, c);
    expect(c.buyStamp).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(1);
  });
});

describe('syncing', () => {
  it('allows the few blocks Bee trails the tip by when it is in step, and no more', () => {
    expect(syncing({ ...chainState, block: 1000, chainTip: 1000 })).toBe(false);
    expect(syncing({ ...chainState, block: 995, chainTip: 1000 })).toBe(false);
    expect(syncing({ ...chainState, block: 1000 - syncLagBlocks, chainTip: 1000 })).toBe(false);
    expect(syncing({ ...chainState, block: 1000 - syncLagBlocks - 1, chainTip: 1000 })).toBe(true);
    expect(syncing({ ...chainState, block: 6_596_277, chainTip: 12_077_980 })).toBe(true);
  });
});
