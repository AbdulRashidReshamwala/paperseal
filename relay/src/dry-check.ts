import { existsSync } from 'node:fs';

import { arkiv, backupSchema, createArkivWriter, instanceKeyHash, releaseLogSchema, releaseTokenSchema, type ExamIndexInput } from '@paperseal/arkiv';
import type { ExamNameResult, ScanEventsResult } from '@paperseal/chain';
import { chain, encodeApprovedList, setterOwner, storageNames, toHex, type ApprovedListEntry } from '@paperseal/protocol';
import type { CollectionFile, UploadOptions } from '@paperseal/swarm';
import { bytesToString, custom, type Address, type Hex } from 'viem';

import { defaultSepoliaRpc, parseCommand, UsageError, type BackupTarget, type IndexTarget } from './args';
import { BackupRefused, checkBatch, prepareBackup, sha256Hex, uploadBackup, type BackupRegistry } from './backup';
import { relayEnv } from './config';
import { indexPass, newIndexState, type IndexRegistry, type IndexWriter } from './indexer';
import { castAddressArgs, castPrivateKeyArgs } from './keystore';
import { explorerLinks, mirrorPass, type RelayWriter } from './mirror';
import { print } from './output';
import { releaseFiles, storageObjectUrl, type Fetch } from './storage';
import { buyStamp } from './swarm-node';

/* `dry-check`: everything that can be checked with no network, no Arkiv write and no key. */

let failures = 0;
async function check(label: string, run: () => Promise<string | undefined> | string | undefined): Promise<void> {
  try {
    const detail = await run();
    print(`PASS  ${label}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    print(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const expect = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

const EXAM: Hex = `0x${'ab'.repeat(32)}`;
const OTHER: Hex = `0x${'cd'.repeat(32)}`;
const REGISTRY: Address = '0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8';
const KEY: Hex = `0x04${'11'.repeat(64)}`;
const ENTRIES_HASH: Hex = `0x${'ef'.repeat(32)}`;
const JWT = 'aGVhZA.Ym9keQ.c2ln';

const logBody = (examId: Hex) =>
  JSON.stringify({ examId, entries: [{ passkeyPublicKey: '0x04', shareHash: ENTRIES_HASH, round: '1' }], entriesHash: ENTRIES_HASH, teeSignature: '0x00', instancePublicKey: KEY });

/** Answers storage requests from a table, and 404s everything else, without the network. */
function offlineFetch(files: Record<string, string>): Fetch {
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = files[url];
    return Promise.resolve(body === undefined ? new Response('not found', { status: 404 }) : new Response(body));
  };
}

/** A writer that records what it would write and sends nothing. */
function recordingWriter() {
  const calls: { kind: 'token' | 'log'; body: string }[] = [];
  const writer: RelayWriter = {
    address: '0x1111111111111111111111111111111111111111',
    mirrorReleaseToken: (input) => {
      calls.push({ kind: 'token', body: bytesToString(input.body) });
      return Promise.resolve({ written: true, entityKey: `0x${'01'.repeat(32)}`, txHash: `0x${'02'.repeat(32)}` });
    },
    mirrorReleaseLog: (input) => {
      calls.push({ kind: 'log', body: bytesToString(input.body) });
      return Promise.resolve({ written: true, entityKey: `0x${'03'.repeat(32)}`, txHash: `0x${'04'.repeat(32)}` });
    },
  };
  return { writer, calls };
}

const point = (byte: number) => {
  const key = new Uint8Array(65).fill(byte);
  key[0] = 4;
  return key;
};

/** A list that passes the rules: one setter, then the neutral and centre key holders `threshold` asks for. */
function sampleList(): Hex {
  const setter = point(1);
  const entries: ApprovedListEntry[] = [{ role: 1, passkeyPublicKey: setter, derivedPublicKey: new Uint8Array(), owner: setterOwner(setter) }];
  for (let i = 0; i < 10; i += 1) {
    entries.push({ role: i < 3 ? 2 : 3, passkeyPublicKey: point(10 + 2 * i), derivedPublicKey: point(11 + 2 * i), owner: `holder-${String(i)}` });
  }
  return toHex(encodeApprovedList(entries));
}

/** An index pass against an in-memory registry and a recording writer. No network, nothing sent. */
async function offlineIndex(scan: ScanEventsResult, names: Record<string, ExamNameResult>) {
  const upserts: ExamIndexInput[] = [];
  const participants: { examId: Hex; count: number }[] = [];
  const ZERO: Hex = `0x${'00'.repeat(32)}`;
  const registry = {
    board: () => Promise.resolve('0x2222222222222222222222222222222222222222' as Address),
    scanEvents: () => Promise.resolve(scan),
    getExam: (examId: Hex) => Promise.resolve({ createdBlock: 5n, settings: { examId, examStart: 1_800_000_000n, criteriaHash: ENTRIES_HASH } }),
    getApprovedList: () => Promise.resolve({ listHash: ENTRIES_HASH, postedAt: 1n, postedBlock: 6n }),
    getApprovedListEntries: () => Promise.resolve(sampleList()),
  } as unknown as IndexRegistry;
  const writer: IndexWriter = {
    address: '0x1111111111111111111111111111111111111111',
    upsertExam: (input) => {
      upserts.push(input);
      return Promise.resolve({ action: 'created', entityKey: ZERO });
    },
    mirrorParticipants: (input) => {
      participants.push({ examId: input.examId, count: input.entries.length });
      return Promise.resolve({ written: [], skipped: [], txHashes: [] });
    },
  };
  const target: IndexTarget = {
    registry: REGISTRY,
    fromBlock: 10n,
    toBlock: 20n,
    rpcUrl: defaultSepoliaRpc,
    rpcSource: 'default',
    names: Object.keys(names),
    everySeconds: undefined,
  };
  const resolveName = (name: string) => Promise.resolve(names[name] ?? { ok: false as const, failed: 'name' as const, reason: 'unknown', partial: {} });
  const report = await indexPass(target, { registry, writer, resolveName, chainId: chain.chainId }, newIndexState(10n));
  return { report, upserts, participants };
}

/** A build-phase backup against in-memory storage, chain and Bee. Nothing leaves the process. */
async function offlineBackup(options: { tamper?: boolean; chainHash?: Hex } = {}) {
  const base = 'https://s.example';
  const files: Record<string, string> = { [storageNames.paper]: 'paper', [storageNames.keyPub]: 'kpub', [storageNames.token]: JWT };
  const manifest = JSON.stringify({
    examId: EXAM,
    files: Object.keys(files).sort().map((name) => ({ name, sha256: sha256Hex(new TextEncoder().encode(files[name])) })),
  });
  const served = { ...files, [storageNames.manifest]: manifest, ...(options.tamper ? { [storageNames.paper]: 'tampered' } : {}) };
  const fetch = offlineFetch(Object.fromEntries(Object.entries(served).map(([name, body]) => [storageObjectUrl(base, EXAM, name), body])));
  const registry: BackupRegistry = {
    getBuild: () => Promise.resolve({ storageManifestHash: options.chainHash ?? sha256Hex(new TextEncoder().encode(manifest)) } as never),
    getApprovedListEntries: () => Promise.resolve(sampleList()),
    getExam: () => Promise.reject(new Error('offline: a build-phase backup reads no exam')),
  };
  const uploads: { paths: string[]; options: UploadOptions }[] = [];
  const batchId = 'b7'.repeat(32);
  const swarm = {
    stamps: () => Promise.resolve([{ batchId, usable: true, label: '', depth: 19, bucketDepth: 16, amount: 1n, utilization: 0, immutable: true, exists: true, ttlSeconds: 86_400, blockNumber: 1 }]),
    uploadCollection: (uploaded: readonly CollectionFile[], uploadOptions: UploadOptions) => {
      uploads.push({ paths: uploaded.map((f) => f.path), options: uploadOptions });
      return Promise.resolve({ reference: 'ce'.repeat(32) });
    },
    download: () => Promise.resolve(new TextEncoder().encode(manifest)),
  };
  const created: { schema: string; values: Record<string, unknown> }[] = [];
  const writer = createArkivWriter({
    account: '0x1111111111111111111111111111111111111111',
    transport: custom({
      request: ({ method }: { method: string }) =>
        method === 'arkiv_query' ? Promise.resolve({ data: [], blockNumber: '0x1' }) : Promise.reject(new Error(`offline: ${method}`)),
    }),
    walletClient: {
      createEntity: ((schema: { name: string }, values: Record<string, unknown>) => {
        created.push({ schema: schema.name, values });
        return Promise.resolve({ entityKey: `0x${'05'.repeat(32)}`, txHash: `0x${'06'.repeat(32)}` });
      }) as never,
    },
  });
  const target: BackupTarget = {
    examId: EXAM,
    registry: REGISTRY,
    storageUrl: base,
    bucket: undefined,
    batchId,
    phase: undefined,
    swarm: { url: arkiv.swarm.defaultApiUrl, source: 'default' },
    rpcUrl: defaultSepoliaRpc,
    rpcSource: 'default',
    dryRun: false,
  };
  try {
    const plan = await prepareBackup(target, { fetch, registry });
    await checkBatch(swarm, batchId);
    const result = await uploadBackup(target, plan, { swarm, writer });
    return { plan, result, uploads, created, refused: undefined };
  } catch (error) {
    if (!(error instanceof BackupRefused)) throw error;
    return { uploads, created, refused: error.message };
  }
}

export async function dryCheck(): Promise<void> {
  await check('arguments: mirror, watch, status and dry-check parse; IDs are lowercased and addresses checksummed', () => {
    const mirror = parseCommand(['mirror', '--exam', EXAM.toUpperCase().replace('0X', '0x'), '--registry', REGISTRY.toLowerCase(), '--storage', 'https://s.example/b/']);
    expect(mirror.command === 'mirror' && mirror.target.examId === EXAM && mirror.target.registry === REGISTRY, 'mirror target');
    expect(mirror.command === 'mirror' && mirror.target.storageUrl === 'https://s.example/b' && mirror.target.teeUrl === undefined, 'storage URL');
    const watched = parseCommand(['watch', '--exam', EXAM, '--registry', REGISTRY, '--tee', 'https://tee.example', '--every', '30']);
    expect(watched.command === 'watch' && watched.everySeconds === 30, '--every');
    const defaulted = parseCommand(['watch', '--exam', EXAM, '--registry', REGISTRY, '--tee', 'https://tee.example']);
    expect(defaulted.command === 'watch' && defaulted.everySeconds === 10, '--every defaults to 10');
    expect(defaulted.command === 'watch' && defaulted.heartbeat, 'watch writes heartbeats by default');
    const quiet = parseCommand(['watch', '--exam', EXAM, '--registry', REGISTRY, '--tee', 'https://tee.example', '--no-heartbeat']);
    expect(quiet.command === 'watch' && !quiet.heartbeat, '--no-heartbeat');
    const status = parseCommand(['status', '--exam', EXAM]);
    expect(status.command === 'status' && status.writer === undefined && status.registry === undefined, 'status without --writer or --registry');
    const narrowed = parseCommand(['status', '--exam', EXAM, '--registry', REGISTRY.toLowerCase()]);
    expect(narrowed.command === 'status' && narrowed.registry === REGISTRY, 'status --registry');
    expect(parseCommand(['dry-check']).command === 'dry-check', 'dry-check');
    return 'mirror, watch (--no-heartbeat), status (--registry), dry-check';
  });

  await check('arguments: bad input is a usage error', () => {
    const bad: string[][] = [
      ['mirror', '--exam', '0x1234', '--registry', REGISTRY, '--tee', 'https://t'],
      ['mirror', '--exam', EXAM, '--registry', '0x6A9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8', '--tee', 'https://t'],
      ['mirror', '--exam', EXAM, '--registry', REGISTRY],
      ['mirror', '--exam', EXAM, '--registry', REGISTRY, '--tee', 'ftp://t'],
      ['mirror', '--exam', EXAM, '--registry', REGISTRY, '--tee', 'https://t', '--bogus', 'x'],
      ['watch', '--exam', EXAM, '--registry', REGISTRY, '--tee', 'https://t', '--every', '0'],
      ['status'],
      ['frobnicate'],
    ];
    for (const argv of bad) {
      let threw = false;
      try {
        parseCommand(argv);
      } catch (error) {
        threw = error instanceof UsageError;
      }
      expect(threw, `accepted ${argv.join(' ')}`);
    }
    return `${String(bad.length)} refused`;
  });

  await check('arguments: index and status --index parse; --every takes no --to-block', () => {
    const one = parseCommand(['index', '--registry', REGISTRY.toLowerCase(), '--from-block', '10', '--to-block', '20', '--names', 'a.b.eth, c.b.eth'], {});
    expect(one.command === 'index' && one.target.registry === REGISTRY && one.target.fromBlock === 10n && one.target.toBlock === 20n, 'index range');
    expect(one.command === 'index' && one.target.names.join() === 'a.b.eth,c.b.eth' && one.target.everySeconds === undefined, '--names');
    expect(one.command === 'index' && one.target.rpcSource === 'default' && one.target.rpcUrl === defaultSepoliaRpc, 'default RPC');
    const env = parseCommand(['index', '--registry', REGISTRY, '--from-block', '0', '--every', '30'], { RELAY_SEPOLIA_RPC: 'https://env.example' });
    expect(env.command === 'index' && env.target.rpcSource === 'RELAY_SEPOLIA_RPC' && env.target.everySeconds === 30, 'RELAY_SEPOLIA_RPC and --every');
    const flag = parseCommand(['index', '--registry', REGISTRY, '--from-block', '0', '--rpc', 'https://flag.example'], { RELAY_SEPOLIA_RPC: 'https://env.example' });
    expect(flag.command === 'index' && flag.target.rpcSource === '--rpc', '--rpc wins');
    const status = parseCommand(['status', '--index', '--registry', REGISTRY]);
    expect(status.command === 'status-index' && status.registry === REGISTRY, 'status --index');
    for (const argv of [
      ['index', '--registry', REGISTRY],
      ['index', '--registry', REGISTRY, '--from-block', '5', '--to-block', '4'],
      ['index', '--registry', REGISTRY, '--from-block', '5', '--to-block', '9', '--every', '5'],
      ['status', '--index'],
    ]) {
      let threw = false;
      try {
        parseCommand(argv, {});
      } catch (error) {
        threw = error instanceof UsageError;
      }
      expect(threw, `accepted ${argv.join(' ')}`);
    }
    return 'index (range, names, RPC from --rpc / RELAY_SEPOLIA_RPC / default, --every), status --index; 4 refused';
  });

  await check('index: each exam\'s full row from its events, with ExamCreated before the range read from getExam', async () => {
    const at = { txHash: ENTRIES_HASH };
    const A: Hex = `0x${'a1'.repeat(32)}`;
    const B: Hex = `0x${'b2'.repeat(32)}`;
    const C: Hex = `0x${'c3'.repeat(32)}`;
    const createdA = { ...at, block: 12n, examStart: 1_900_000_000n, criteriaHash: OTHER, criteria: '0x' } as never;
    const scan: ScanEventsResult = {
      fromBlock: 10n,
      toBlock: 20n,
      exams: [
        { examId: A, created: createdA },
        { examId: B, created: createdA, list: { ...at, block: 13n, listHash: KEY.slice(0, 66) as Hex, entries: sampleList() } },
        { examId: C, created: null, build: { ...at, block: 14n, paperHash: OTHER } as never },
      ],
    };
    const { upserts, participants } = await offlineIndex(scan, {});
    const [a, b, c] = upserts;
    if (!a || !b || !c) throw new Error(`${String(upserts.length)} exam rows, not 3`);
    expect(a.stage === 'published' && a.approvedListHash === null && a.createdBlock === 12n && a.examStart === 1_900_000_000n, 'published');
    expect(b.stage === 'listed' && b.approvedListHash === KEY.slice(0, 66) && b.paperHash === null, 'listed');
    expect(c.stage === 'built' && c.createdBlock === 5n && c.examStart === 1_800_000_000n && c.approvedListHash === ENTRIES_HASH && c.paperHash === OTHER, 'built, filled in');
    expect(upserts.every((u) => u.chainId === chain.chainId && u.name === null && u.registry === REGISTRY), 'chainId, registry, no name');
    expect(participants.map((p) => `${p.examId.slice(0, 4)}:${String(p.count)}`).join() === '0xb2:11,0xc3:11', JSON.stringify(participants));
    return 'published, listed, built (getExam + getApprovedList fill-in); 11 participants each for B and C';
  });

  await check('index: a name is set only if it passes and names this registry and exam; a bad list writes no participants', async () => {
    const A: Hex = `0x${'a1'.repeat(32)}`;
    const created = { txHash: ENTRIES_HASH, block: 12n, examStart: 1n, criteriaHash: OTHER, criteria: '0x' } as never;
    const value = (name: string, examId: Hex, registry: Address): ExamNameResult => ({
      ok: true,
      value: { name, label: '', parent: '', examId, registry, board: REGISTRY, teeUrl: null, storageUrl: null, bucket: null, arkivWriters: null, arkivWritersIgnored: [] },
    });
    const { report, upserts, participants } = await offlineIndex(
      { fromBlock: 10n, toBlock: 20n, exams: [{ examId: A, created, list: { txHash: ENTRIES_HASH, block: 13n, listHash: OTHER, entries: '0x00' } }] },
      {
        'wrong-registry.b.eth': value('wrong-registry.b.eth', A, '0x1111111111111111111111111111111111111111'),
        'wrong-exam.b.eth': value('wrong-exam.b.eth', EXAM, REGISTRY),
        'fails.b.eth': { ok: false, failed: 'forward', reason: 'b.eth points elsewhere', partial: {} },
        'good.b.eth': value('good.b.eth', A, REGISTRY),
      },
    );
    expect(upserts[0]?.name === 'good.b.eth', `name ${String(upserts[0]?.name)}`);
    expect(report.names.filter((line) => line.startsWith('skipped')).length === 2, report.names.join('; '));
    expect(report.notes.some((note) => note.startsWith('wrong-exam.b.eth')), 'no note for the name of another exam');
    expect(participants.length === 0 && report.outcomes[0]?.participants.result === 'refused', 'participants written for a bad list');
    return 'good.b.eth used; wrong registry and failing name skipped; other exam noted; bad list refused';
  });

  await check('storage: object URLs are <base>/<examId>/<name>, as apps/verifier builds them', () => {
    const url = storageObjectUrl('https://storage.googleapis.com/bucket//', EXAM.toUpperCase().replace('0X', '0x') as Hex, releaseFiles.log);
    expect(url === `https://storage.googleapis.com/bucket/${EXAM}/release-log.json`, url);
    expect(releaseFiles.token === 'release-token.jwt', 'release-token.jwt');
    return url;
  });

  await check('mirror pass: the token is written before the log, and both carry their exact bytes', async () => {
    const base = 'https://s.example';
    const { writer, calls } = recordingWriter();
    const fetch = offlineFetch({ [storageObjectUrl(base, EXAM, releaseFiles.log)]: logBody(EXAM), [storageObjectUrl(base, EXAM, releaseFiles.token)]: JWT });
    const report = await mirrorPass({ examId: EXAM, registry: REGISTRY, storageUrl: base, teeUrl: undefined }, { fetch, writer, chainId: chain.chainId });
    expect(calls.map((c) => c.kind).join(',') === 'token,log', `order ${calls.map((c) => c.kind).join(',')}`);
    expect(calls[0]?.body === JWT && calls[1]?.body === logBody(EXAM), 'bodies changed');
    expect(report.outcomes.every((o) => o.result === 'written'), JSON.stringify(report.outcomes));
    return 'token, then log';
  });

  await check('mirror pass: a log for another exam is refused, and nothing is written', async () => {
    const base = 'https://s.example';
    const { writer, calls } = recordingWriter();
    const fetch = offlineFetch({ [storageObjectUrl(base, EXAM, releaseFiles.log)]: logBody(OTHER), [storageObjectUrl(base, EXAM, releaseFiles.token)]: JWT });
    const report = await mirrorPass({ examId: EXAM, registry: REGISTRY, storageUrl: base, teeUrl: undefined }, { fetch, writer, chainId: chain.chainId });
    expect(calls.length === 0, 'wrote something');
    expect(report.outcomes.some((o) => o.kind === 'log' && o.result === 'refused'), 'log not refused');
    return report.outcomes.map((o) => `${o.kind} ${o.result}`).join(', ');
  });

  await check('payload: packages/arkiv fills the columns of spec/arkiv.md from the bodies (stub RPC, no send)', async () => {
    const created: { schema: string; values: Record<string, unknown>; flags: unknown }[] = [];
    const writer = createArkivWriter({
      account: '0x1111111111111111111111111111111111111111',
      transport: custom({
        request: ({ method }: { method: string }) =>
          method === 'arkiv_query' ? Promise.resolve({ data: [], blockNumber: '0x1' }) : Promise.reject(new Error(`offline: ${method}`)),
      }),
      walletClient: {
        createEntity: ((schema: { name: string }, values: Record<string, unknown>, options: { flags: unknown }) => {
          created.push({ schema: schema.name, values, flags: options.flags });
          return Promise.resolve({ entityKey: `0x${'05'.repeat(32)}`, txHash: `0x${'06'.repeat(32)}` });
        }) as never,
      },
    });
    const body = new TextEncoder().encode(logBody(EXAM));
    await writer.mirrorReleaseToken({ examId: EXAM, registry: REGISTRY, chainId: chain.chainId, body: new TextEncoder().encode(JWT), instancePublicKey: KEY });
    await writer.mirrorReleaseLog({ examId: EXAM, registry: REGISTRY, chainId: chain.chainId, body });
    const [token, log] = created;
    if (!token || !log) throw new Error(`${String(created.length)} rows prepared, not 2`);
    expect(token.schema === releaseTokenSchema.name && log.schema === releaseLogSchema.name, 'schemas');
    expect(token.values.instanceKeyHash === instanceKeyHash(KEY), 'instanceKeyHash');
    expect(log.values.entriesHash === ENTRIES_HASH && log.values.released === 1 && log.values.examId === EXAM, 'log columns');
    expect(JSON.stringify(log.flags) === JSON.stringify({ readonly: true, permissionlessExtension: true }), 'flags');
    return `${releaseTokenSchema.name}, ${releaseLogSchema.name}, readonly, ${String(arkiv.lifetimeDays)} days`;
  });

  await check('arguments: backup, swarm-status and buy-stamp parse; the Bee API defaults to swarm.defaultApiUrl', () => {
    const backup = parseCommand(['backup', '--exam', EXAM, '--registry', REGISTRY, '--storage', 'https://s.example', '--batch', `0x${'B7'.repeat(32)}`], {});
    expect(backup.command === 'backup' && backup.target.batchId === 'b7'.repeat(32) && backup.target.phase === undefined, 'backup target');
    expect(backup.command === 'backup' && backup.target.swarm.url === arkiv.swarm.defaultApiUrl && backup.target.swarm.source === 'default', 'default Bee API');
    const env = parseCommand(['swarm-status'], { RELAY_SWARM_API: 'http://bee:1633' });
    expect(env.command === 'swarm-status' && env.swarm.source === 'RELAY_SWARM_API', 'RELAY_SWARM_API');
    const buy = parseCommand(['buy-stamp', '--depth', '19', '--days', '7'], {});
    expect(buy.command === 'buy-stamp' && !buy.yes && buy.depth === 19 && buy.days === 7, 'buy-stamp without --yes');
    for (const argv of [['backup', '--exam', EXAM, '--registry', REGISTRY, '--storage', 'https://s.example'], ['buy-stamp', '--depth', '16', '--days', '7']]) {
      let threw = false;
      try {
        parseCommand(argv, {});
      } catch (error) {
        threw = error instanceof UsageError;
      }
      expect(threw, `accepted ${argv.join(' ')}`);
    }
    return `backup, swarm-status, buy-stamp; Bee API default ${arkiv.swarm.defaultApiUrl}; 2 refused`;
  });

  await check('backup: a bad manifest hash or a tampered file is refused before any upload or row', async () => {
    const wrong = await offlineBackup({ chainHash: `0x${'99'.repeat(32)}` });
    expect(wrong.refused?.includes("not the Build's storageManifestHash") === true, String(wrong.refused));
    const tampered = await offlineBackup({ tamper: true });
    expect(tampered.refused?.includes('paper.bin hashes to') === true, String(tampered.refused));
    expect(wrong.uploads.length + tampered.uploads.length === 0 && wrong.created.length + tampered.created.length === 0, 'uploaded or wrote');
    return 'manifest hash mismatch and file hash mismatch: nothing uploaded, nothing written';
  });

  await check('backup: a build backup uploads the storage paths with deferred false and fills the backup row (stub Bee and RPC)', async () => {
    const { plan, result, uploads, created } = await offlineBackup();
    if (!plan || !result) throw new Error('refused');
    const upload = uploads[0];
    expect(upload?.paths.join() === 'manifest.json,key-pub.tlock,paper.bin,token.jwt', String(upload?.paths.join()));
    expect(upload?.options.deferred === false, 'deferred is not false');
    const row = created[0];
    if (!row) throw new Error('no row prepared');
    expect(row.schema === backupSchema.name, row.schema);
    const v = row.values;
    expect(v.phase === 'build' && v.swarmRef === 'ce'.repeat(32) && v.swarmNetwork === arkiv.swarm.network && v.files === 4 && v.manifestHash === plan.manifestHash, JSON.stringify(v));
    expect(result.readBack.result === 'match', result.readBack.result);
    return `${backupSchema.name}: phase build, 4 files, ${arkiv.swarm.network}; read-back matched`;
  });

  await check('buy-stamp: without --yes it prints the cost and buys nothing (stub Bee)', async () => {
    let bought = false;
    const outcome = await buyStamp(
      { api: { url: arkiv.swarm.defaultApiUrl, source: 'default' }, depth: 19, days: 7, label: undefined, yes: false },
      {
        chainState: () => Promise.resolve({ chainTip: 1, block: 1, totalAmount: 0n, currentPrice: 24_000n }),
        wallet: () => Promise.resolve({ bzzBalance: 10n ** 17n, nativeTokenBalance: 0n, chainId: 11_155_111, walletAddress: '0x' }),
        buyStamp: () => {
          bought = true;
          return Promise.resolve('fe'.repeat(32));
        },
      },
    );
    expect(!bought && outcome.exitCode === 0, 'bought without --yes');
    const cost = outcome.lines.find((line) => line.trim().startsWith('cost'));
    expect(cost !== undefined, 'no cost line');
    return cost?.trim().replace(/\s+/g, ' ');
  });

  await check('keystore: cast gets the account and the password file path, never a password', () => {
    const { keystore } = relayEnv();
    const args = castPrivateKeyArgs(keystore);
    expect(args.join(' ') === `wallet private-key --account ${keystore.account} --password-file ${keystore.passwordFile}`, args.join(' '));
    expect(castAddressArgs(keystore)[1] === 'address', 'address args');
    expect(!args.includes('--password'), '--password on the command line');
    return `${keystore.cast} ${args.slice(0, 4).join(' ')} --password-file <path, ${existsSync(keystore.passwordFile) ? 'present' : 'missing'}; not read here>`;
  });

  await check('access key: found or not, and never printed', () => {
    const { accessKey } = relayEnv();
    return accessKey.value ? `set, from ${accessKey.source ?? 'unknown'}` : 'not set: the relay would use the public RPC';
  });

  await check('explorer links come from arkiv.network.explorer', () => {
    const link = explorerLinks(arkiv.network.explorer).entity(`0x${'07'.repeat(32)}`);
    expect(link.startsWith(`${arkiv.network.explorer}/entity/0x`), link);
    return link;
  });

  print(failures === 0 ? '\nAll dry checks passed.' : `\n${String(failures)} dry check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}
