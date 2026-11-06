import { existsSync } from 'node:fs';

import { arkiv, createArkivWriter, instanceKeyHash, releaseLogSchema, releaseTokenSchema } from '@paperseal/arkiv';
import { chain } from '@paperseal/protocol';
import { bytesToString, custom, type Address, type Hex } from 'viem';

import { parseCommand, UsageError } from './args';
import { relayEnv } from './config';
import { castAddressArgs, castPrivateKeyArgs } from './keystore';
import { explorerLinks, mirrorPass, type RelayWriter } from './mirror';
import { print } from './output';
import { releaseFiles, storageObjectUrl, type Fetch } from './storage';

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
