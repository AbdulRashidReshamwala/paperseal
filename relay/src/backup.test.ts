import { arkiv, type BackupInput } from '@paperseal/arkiv';
import { encodeApprovedList, encodeMessage, fromHex, setterOwner, storageNames, toHex, type ApprovedListEntry } from '@paperseal/protocol';
import type { ChainState, CollectionFile, PostageBatch, UploadOptions, Wallet } from '@paperseal/swarm';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { parseCommand, UsageError, type BackupTarget, type SwarmApi } from './args';
import {
  backupFailed,
  BackupRefused,
  checkBatch,
  keyPrivBytes,
  prepareBackup,
  readBackUrl,
  resultLines,
  sha256Hex,
  sizeCaps,
  timelockRound,
  uploadBackup,
  type BackupRegistry,
} from './backup';
import { realBucket, realEndRound, realExam, realExamId, realKeyPrivTlock, realReleaseLog, realReleaseToken } from './fixtures/real-exam';
import { explorerLinks } from './mirror';
import { storageObjectUrl, type Fetch } from './storage';
import { batchQuote, buyStamp, swarmNetworks, swarmStatusLines, syncing, syncLagBlocks, type SwarmSnapshot } from './swarm-node';

// The real demo exam, so the unlock checks run on a token Google signed and a log its TEE signed.
const examId: Hex = realExamId;
const registry: Address = '0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8';
const storage = 'https://storage.example/bucket';
const batchId = 'b7'.repeat(32);
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

type LogJson = { examId: string; entries: { passkeyPublicKey: string; shareHash: string; round: string }[]; entriesHash: string; teeSignature: string; instancePublicKey: string };
const realLog = (): LogJson => JSON.parse(realReleaseLog) as LogJson;

/** The real release log, or one changed by `edit`. Re-encoded only when edited, so the default is the exact stored bytes. */
function releaseLog(edit?: (log: LogJson & Record<string, unknown>) => void): Uint8Array {
  if (!edit) return utf8(realReleaseLog);
  const log = realLog();
  edit(log);
  return utf8(JSON.stringify(log));
}

const subtle = globalThis.crypto.subtle;
const p256Order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** A low-s `r || s` over the `releaseLog` message for `log`, by a fresh key that no token attests. */
async function signedByAnotherKey(log: LogJson): Promise<{ signature: Hex; publicKey: Hex }> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const message = encodeMessage('releaseLog', { examId: fromHex(log.examId as Hex), entriesHash: fromHex(log.entriesHash as Hex) });
  const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(message)));
  const s = BigInt(toHex(raw.subarray(32)));
  if (s > p256Order / 2n) raw.set(fromHex(`0x${(p256Order - s).toString(16).padStart(64, '0')}`), 32);
  return { signature: toHex(raw), publicKey: toHex(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))) };
}

/** The real `key-priv.tlock` with its stanza's round replaced, re-armoured as tlock-js does. */
function tlockForRound(round: string): Uint8Array {
  const body = realKeyPrivTlock.replace('-----BEGIN AGE ENCRYPTED FILE-----', '').replace('-----END AGE ENCRYPTED FILE-----', '').replace(/\s+/g, '');
  const age = Buffer.from(body, 'base64').toString('binary').replace(`-> tlock ${realEndRound.toString()} `, `-> tlock ${round} `);
  const lines = Buffer.from(age, 'binary').toString('base64').match(/.{1,64}/g) ?? [];
  const footer = (lines.at(-1)?.length ?? 0) === 64 ? '\n-----END AGE ENCRYPTED FILE-----' : '-----END AGE ENCRYPTED FILE-----';
  return utf8(`-----BEGIN AGE ENCRYPTED FILE-----\n${lines.join('\n')}\n${footer}\n`);
}

/** A copy of the token with one character of its RS256 signature changed. */
function tamperedToken(): string {
  const [header, payload, signature = ''] = realReleaseToken.split('.');
  const i = 20;
  const swapped = signature[i] === 'A' ? 'B' : 'A';
  return `${header ?? ''}.${payload ?? ''}.${signature.slice(0, i)}${swapped}${signature.slice(i + 1)}`;
}

/** The files written at unlock: the real log, token and timelock, and one 113-byte keyPriv per centre. */
const unlockStorage = (): Record<string, Uint8Array> => ({
  [storageNames.releaseLog]: releaseLog(),
  'release-token.jwt': utf8(realReleaseToken),
  [storageNames.keyPriv]: utf8(realKeyPrivTlock),
  ...Object.fromEntries(centres.map((key, i) => [storageNames.centreKeyPriv(key), new Uint8Array(keyPrivBytes).fill(i + 1)])),
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
  exam?: unknown;
  batch?: PostageBatch;
  readBack?: Uint8Array | null;
} = {}) {
  const files = options.files ?? { ...buildFiles, [storageNames.manifest]: manifestBytes() };
  const manifest = files[storageNames.manifest];
  const chainHash = options.chainHash === undefined ? (manifest ? sha256Hex(manifest) : `0x${'99'.repeat(32)}`) : options.chainHash;
  const registryMock: BackupRegistry = {
    getBuild: vi.fn(() => Promise.resolve(chainHash === null ? null : ({ storageManifestHash: chainHash } as never))),
    getApprovedListEntries: vi.fn(() => Promise.resolve(toHex(encodeApprovedList(listEntries)))),
    getExam: vi.fn(() => Promise.resolve((options.exam === undefined ? realExam : options.exam) as never)),
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
    bucket: { name: realBucket, source: '--bucket' },
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

  it('is build when storage has release-log.json but not every unlock file, and says why', async () => {
    for (const missing of ['release-token.jwt', storageNames.keyPriv, storageNames.centreKeyPriv(centres[0] as Uint8Array)]) {
      const s = setup({ files: without({ ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage() }, missing) });
      const { plan } = await s.run();
      expect(plan.phase).toBe('build');
      expect(plan.phaseReason).toContain(`storage has release-log.json but not yet ${missing}`);
      expect(s.uploads[0]?.files.map((f) => f.path)).toEqual([storageNames.manifest, ...Object.keys(buildFiles).sort()]);
      expect(s.rows[0]?.phase).toBe('build');
    }
  });

  it('checks the real unlock files: token, log signature, timelock round and key-priv sizes', async () => {
    const s = setup({ files: { ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage() } });
    const { plan } = await s.run();
    expect(plan.phase).toBe('unlock');
    expect(plan.phaseReason).toBe('storage has release-log.json and every unlock file');
    const detail = (file: string) => plan.checks.find((c) => c.file === file)?.detail ?? '';
    expect(detail('release-token.jwt')).toContain(`Google PKI signature; claims bound to the on-chain exam, bucket ${realBucket}`);
    expect(detail('release-log.json')).toContain('teeSignature valid under the attested');
    expect(detail('key-priv.tlock')).toContain(`endRound ${realEndRound.toString()}`);
    expect(detail('key-priv/*')).toContain(`each ${String(keyPrivBytes)} bytes`);
    expect(timelockRound(utf8(realKeyPrivTlock))).toBe(realEndRound.toString());
    expect(s.rows[0]?.phase).toBe('unlock');
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

  const unlocked = (replace: Record<string, Uint8Array | null> = {}) => {
    const files: Record<string, Uint8Array> = { ...buildFiles, [storageNames.manifest]: manifestBytes(), ...unlockStorage() };
    for (const [name, bytes] of Object.entries(replace)) {
      if (bytes === null) delete files[name];
      else files[name] = bytes;
    }
    return files;
  };

  it("when the release log's entriesHash is not its entries' hash", async () => {
    const files = unlocked({ [storageNames.releaseLog]: releaseLog((log) => {
      log.entriesHash = `0x${'00'.repeat(32)}`;
    }) });
    await refuses(setup({ files }), /entries hash to/);
  });

  it('when the release log is for another exam', async () => {
    const files = unlocked({ [storageNames.releaseLog]: releaseLog((log) => {
      log.examId = `0x${'cd'.repeat(32)}`;
    }) });
    await refuses(setup({ files }), /release log is for exam 0xcdcd/);
  });

  it('when the release log has a field the TEE does not write', async () => {
    await refuses(setup({ files: unlocked({ [storageNames.releaseLog]: releaseLog((log) => {
      log.extra = 1;
    }) }) }), /unknown field "extra"/);
    const inEntry = releaseLog((log) => Object.assign(log.entries[0] ?? {}, { note: 'x' }));
    await refuses(setup({ files: unlocked({ [storageNames.releaseLog]: inEntry }) }), /entry 0 has an unknown field "note"/);
  });

  it('when the release log is signed by a key other than the one the token attests', async () => {
    // The log names the attested key, but its signature is another key's.
    const log = realLog();
    const other = await signedByAnotherKey(log);
    const forged = releaseLog((l) => {
      l.teeSignature = other.signature;
    });
    await refuses(setup({ files: unlocked({ [storageNames.releaseLog]: forged }) }), /teeSignature does not verify under the attested instancePublicKey/);
    // The log names the other key and is validly signed by it, but no token attests that key.
    const renamed = releaseLog((l) => {
      l.teeSignature = other.signature;
      l.instancePublicKey = other.publicKey;
    });
    await refuses(setup({ files: unlocked({ [storageNames.releaseLog]: renamed }) }), /release-token.jwt: it does not attest .* claim eat_nonce/);
  });

  it('when the release token signature does not verify', async () => {
    await refuses(setup({ files: unlocked({ 'release-token.jwt': utf8(tamperedToken()) }) }), /release-token.jwt: .*(signature does not verify|cannot be verified)/);
  });

  it('when the release token is not a JWT', async () => {
    await refuses(setup({ files: unlocked({ 'release-token.jwt': utf8('not a token') }) }), /release-token.jwt: .*three-part JWT/);
  });

  it("when the release token's claims are not the on-chain exam's", async () => {
    const exam = { ...realExam, settings: { ...realExam.settings, endRound: realEndRound + 1n } };
    await refuses(setup({ files: unlocked(), exam }), /release-token.jwt: .*claim args/);
    const digest = { ...realExam, imageDigest: `0x${'00'.repeat(32)}` };
    await refuses(setup({ files: unlocked(), exam: digest }), /claim image_digest/);
  });

  it("when the release token names another bucket, or the bucket is unknown", async () => {
    await refuses(setup({ files: unlocked() }), /claim env_override/, { bucket: { name: 'other-bucket', source: '--bucket' } });
    await refuses(setup({ files: unlocked() }), /storage bucket is unknown.*--bucket/, { bucket: undefined });
  });

  it('when the token is checked against a registry other than the one it was started with', async () => {
    await refuses(setup({ files: unlocked() }), /claim args/, { registry: '0x1111111111111111111111111111111111111111' });
  });

  it("when key-priv.tlock is sealed to a round other than the exam's endRound", async () => {
    const early = tlockForRound((realEndRound - 1n).toString());
    expect(timelockRound(early)).toBe((realEndRound - 1n).toString());
    await refuses(setup({ files: unlocked({ [storageNames.keyPriv]: early }) }), /sealed to round 33700842, not the exam's endRound 33700843/);
  });

  it('when key-priv.tlock is not a tlock ciphertext', async () => {
    await refuses(setup({ files: unlocked({ [storageNames.keyPriv]: utf8('timelocked K_priv') }) }), /key-priv.tlock: it is not an armoured age file/);
  });

  it("when a centre's key-priv file is missing, with --phase unlock", async () => {
    const files = unlocked({ [storageNames.centreKeyPriv(centres[3] as Uint8Array)]: null });
    await refuses(setup({ files }), /--phase unlock, but storage has no key-priv\/0x04/, { phase: 'unlock' });
  });

  it("when a centre's key-priv file is not the size of an HPKE keyPriv", async () => {
    const name = storageNames.centreKeyPriv(centres[2] as Uint8Array);
    await refuses(setup({ files: unlocked({ [name]: new Uint8Array(keyPrivBytes - 1) }) }), /is 112 bytes, not the 113 of an HPKE keyPriv/);
    await refuses(setup({ files: unlocked({ [name]: new Uint8Array(keyPrivBytes + 1) }) }), /is 114 bytes, not the 113/);
    await refuses(setup({ files: unlocked({ [name]: new Uint8Array(sizeCaps.keyPriv + 1) }) }), /over its 4096-byte cap/);
  });

  it('when a file is over its size cap', async () => {
    const share = storageNames.share(holders[0] as Uint8Array);
    const big = { ...buildFiles, [share]: new Uint8Array(sizeCaps.listed + 1) };
    await refuses(setup({ files: { ...big, [storageNames.manifest]: manifestBytes(big) } }), /shares\/0x04.*over its 8192-byte cap/);
    await refuses(setup({ files: unlocked({ [storageNames.releaseLog]: new Uint8Array(sizeCaps.releaseLog + 1) }) }), /release-log.json in storage is over its 16384-byte cap/);
    await refuses(setup({ files: unlocked({ 'release-token.jwt': new Uint8Array(sizeCaps.token + 1) }) }), /release-token.jwt in storage is over its 65536-byte cap/);
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
      bucket: undefined,
      batchId,
      phase: undefined,
      swarm: { url: arkiv.swarm.defaultApiUrl, source: 'default' },
      rpcSource: 'default',
      dryRun: false,
    });
    const gcs = parseCommand(['backup', '--exam', examId, '--registry', registry, '--storage', `https://storage.googleapis.com/${realBucket}`, '--batch', batchId], {});
    expect(gcs.command === 'backup' && gcs.target.bucket).toEqual({ name: realBucket, source: '--storage' });
    const named = parseCommand(['backup', '--exam', examId, '--registry', registry, '--storage', storage, '--batch', batchId, '--bucket', 'my-bucket'], {});
    expect(named.command === 'backup' && named.target.bucket).toEqual({ name: 'my-bucket', source: '--bucket' });
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
    [['backup', '--exam', examId, '--registry', registry, '--storage', storage, '--batch', batchId, '--bucket', 'Not A Bucket']],
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
