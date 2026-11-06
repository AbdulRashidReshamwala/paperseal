import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { parseCommand, UsageError } from './args';
import { accessKeyFromEnvFile, findCast, loadAccessKey, relayEnv, type KeystoreConfig } from './config';
import { castAddressArgs, castPrivateKeyArgs, keystoreAddress, loadSigner, scrubCastOutput, type Spawn } from './keystore';
import { errorText, redact, registerSecret } from './output';
import { statusRows } from './status';

const examId: Hex = `0x${'ab'.repeat(32)}`;
const registry: Address = '0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8';

describe('parseCommand', () => {
  it('parses mirror with either or both sources, normalising values', () => {
    expect(parseCommand(['mirror', '--exam', examId.replace('0xab', '0xAB'), '--registry', registry.toLowerCase(), '--storage', 'https://s.example/b//'])).toEqual({
      command: 'mirror',
      target: { examId, registry, storageUrl: 'https://s.example/b', teeUrl: undefined },
    });
    const both = parseCommand(['mirror', '--exam', examId, '--registry', registry, '--storage', 'https://s', '--tee', 'https://t/']);
    expect(both).toMatchObject({ target: { storageUrl: 'https://s', teeUrl: 'https://t' } });
  });

  it('parses watch with --every, defaulting to 10 seconds', () => {
    const base = ['--exam', examId, '--registry', registry, '--tee', 'https://t'];
    expect(parseCommand(['watch', ...base])).toMatchObject({ command: 'watch', everySeconds: 10 });
    expect(parseCommand(['watch', ...base, '--every', '45'])).toMatchObject({ everySeconds: 45 });
  });

  it('parses status with and without --writer, and dry-check and help', () => {
    expect(parseCommand(['status', '--exam', examId])).toEqual({ command: 'status', examId, writer: undefined });
    expect(parseCommand(['status', '--exam', examId, '--writer', registry.toLowerCase()])).toEqual({ command: 'status', examId, writer: registry });
    expect(parseCommand(['dry-check'])).toEqual({ command: 'dry-check' });
    expect(parseCommand([])).toEqual({ command: 'help' });
  });

  it.each([
    [['mirror', '--exam', '0x12', '--registry', registry, '--tee', 'https://t']],
    [['mirror', '--exam', examId, '--registry', '0x6A9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8', '--tee', 'https://t']],
    [['mirror', '--exam', examId, '--registry', registry]],
    [['mirror', '--registry', registry, '--tee', 'https://t']],
    [['mirror', '--exam', examId, '--registry', registry, '--tee', 'file:///etc']],
    [['mirror', '--exam', examId, '--registry', registry, '--tee', 'https://t?x=1']],
    [['mirror', '--exam', examId, '--registry', registry, '--tee', 'https://t', '--unknown', '1']],
    [['mirror', '--exam', examId, '--registry', registry, '--tee', 'https://t', 'stray']],
    [['watch', '--exam', examId, '--registry', registry, '--tee', 'https://t', '--every', '1']],
    [['watch', '--exam', examId, '--registry', registry, '--tee', 'https://t', '--every', '5s']],
    [['status', '--exam', examId, '--writer', 'nope']],
    [['dry-check', '--x']],
    [['publish']],
  ])('refuses %j', (argv) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
  });
});

describe('config', () => {
  const home = '/home/relay';

  it('defaults the keystore to paperseal-board and the password file under ~/.paperseal, with env overrides', () => {
    const exists = () => false;
    expect(relayEnv({ env: {}, home, exists }).keystore).toEqual({
      account: 'paperseal-board',
      passwordFile: '/home/relay/.paperseal/board-keystore-password',
      cast: 'cast',
    });
    const custom = relayEnv({ env: { RELAY_KEYSTORE: 'relay-2', RELAY_PASSWORD_FILE: '/secrets/pw' }, home, exists });
    expect(custom.keystore).toMatchObject({ account: 'relay-2', passwordFile: '/secrets/pw' });
  });

  it('finds cast on PATH, else in ~/.foundry/bin', () => {
    expect(findCast({ env: { PATH: '/usr/bin:/opt/foundry' }, home, exists: (p) => p === '/opt/foundry/cast' })).toBe('/opt/foundry/cast');
    expect(findCast({ env: { PATH: '/usr/bin' }, home, exists: (p) => p === '/home/relay/.foundry/bin/cast' })).toBe('/home/relay/.foundry/bin/cast');
  });

  it('takes the access key from ARKIV_ACCESS_KEY, else ~/.paperseal/arkiv-relay.env, else none', () => {
    const file = '/home/relay/.paperseal/arkiv-relay.env';
    const readText = vi.fn(() => '# relay\nOTHER=1\nexport ARKIV_ACCESS_KEY="from-file"\n');
    expect(loadAccessKey({ env: { ARKIV_ACCESS_KEY: 'from-env' }, home, exists: () => true, readText })).toEqual({ value: 'from-env', source: 'ARKIV_ACCESS_KEY' });
    expect(readText).not.toHaveBeenCalled();
    expect(loadAccessKey({ env: {}, home, exists: (p) => p === file, readText })).toEqual({ value: 'from-file', source: file });
    expect(loadAccessKey({ env: {}, home, exists: () => false, readText })).toEqual({ value: undefined, source: undefined });
    expect(accessKeyFromEnvFile('ARKIV_ACCESS_KEY=\n')).toBeUndefined();
    expect(accessKeyFromEnvFile("ARKIV_ACCESS_KEY = 'k1' ")).toBe('k1');
  });
});

describe('output', () => {
  it('redacts a registered secret and its URL-encoded form', () => {
    registerSecret('k/ey+1');
    expect(redact('https://rpc.example/k%2Fey%2B1 and k/ey+1')).toBe('https://rpc.example/[redacted] and [redacted]');
    expect(errorText(new Error('URL: https://rpc.example/k%2Fey%2B1'))).toBe('Error: URL: https://rpc.example/[redacted]');
  });
});

/** A child process stand-in: emits stdout, stderr and an exit code on the next tick. */
function fakeSpawn(result: { stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException }) {
  const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
  const spawn = ((command: string, args: readonly string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    setImmediate(() => {
      if (result.error) {
        child.emit('error', result.error);
        return;
      }
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      setImmediate(() => child.emit('close', result.code ?? 0));
    });
    return child;
  }) as unknown as Spawn;
  return { spawn, calls };
}

describe('keystore', () => {
  const config: KeystoreConfig = { account: 'paperseal-board', passwordFile: '/home/relay/.paperseal/board-keystore-password', cast: '/home/relay/.foundry/bin/cast' };
  const exists = (path: string) => path === config.passwordFile;

  it('builds the cast commands from the account and the password file path only', () => {
    expect(castPrivateKeyArgs(config)).toEqual(['wallet', 'private-key', '--account', 'paperseal-board', '--password-file', config.passwordFile]);
    expect(castAddressArgs(config)).toEqual(['wallet', 'address', '--account', 'paperseal-board', '--password-file', config.passwordFile]);
  });

  it('turns cast output into an in-memory account, with stdin closed so cast never prompts', async () => {
    const key = generatePrivateKey();
    const { spawn, calls } = fakeSpawn({ stdout: `${key}\n` });
    const account = await loadSigner(config, { spawn, exists });
    expect(account.address).toBe(privateKeyToAccount(key).address);
    expect(calls).toEqual([{ command: config.cast, args: castPrivateKeyArgs(config), options: { stdio: ['ignore', 'pipe', 'pipe'] } }]);
  });

  it('reads the address for status without a key', async () => {
    const { spawn } = fakeSpawn({ stdout: '0x1e6220497ecc77edea4e79d73cb194bb2d1b188b\n' });
    expect(await keystoreAddress(config, { spawn, exists })).toBe('0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b');
  });

  it('refuses a missing password file before running cast', async () => {
    const { spawn, calls } = fakeSpawn({});
    await expect(loadSigner(config, { spawn, exists: () => false })).rejects.toThrow(/does not exist .*never read/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a cast failure without its stdout or anything key-shaped', async () => {
    const key = generatePrivateKey();
    const { spawn } = fakeSpawn({ stdout: key, stderr: `Error: wrong password for keystore (debug ${key.slice(2)})`, code: 1 });
    const error = await loadSigner(config, { spawn, exists }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/^cast wallet private-key --account paperseal-board exited 1: Error: wrong password/);
    expect(error?.message).not.toContain(key.slice(2));
    expect(error?.message).toContain('[redacted]');
  });

  it('never echoes output that is not a key', async () => {
    const { spawn } = fakeSpawn({ stdout: 'something unexpected 0xdeadbeef' });
    const error = await loadSigner(config, { spawn, exists }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe('cast wallet private-key did not print a 32-byte hex key (its output is not shown)');
  });

  it('explains a missing cast', async () => {
    const { spawn } = fakeSpawn({ error: Object.assign(new Error('spawn cast ENOENT'), { code: 'ENOENT' }) });
    await expect(loadSigner(config, { spawn, exists })).rejects.toThrow(/ENOENT \(install Foundry/);
  });

  it('scrubs 32-byte hex with or without 0x', () => {
    expect(scrubCastOutput(`a ${'ab'.repeat(32)} b 0x${'cd'.repeat(32)}`)).toBe('a [redacted] b [redacted]');
  });
});

describe('statusRows', () => {
  it('lists log and token rows newest first, with write times from the latest block', async () => {
    const reader = {
      releaseRows: vi.fn(() =>
        Promise.resolve({
          logs: [
            { entityKey: `0x${'01'.repeat(32)}` as Hex, creator: registry, createdAtBlock: 90n, examId, registry, body: new TextEncoder().encode('{"entries":[1,2]}'), entriesHash: 'h1' },
            { entityKey: `0x${'02'.repeat(32)}` as Hex, creator: registry, createdAtBlock: 99n, examId, registry, body: new TextEncoder().encode('{"entries":[1,2,3]}'), entriesHash: 'h2' },
          ],
          tokens: [{ entityKey: `0x${'03'.repeat(32)}` as Hex, creator: registry, createdAtBlock: 80n, examId, registry, body: new Uint8Array(), instanceKeyHash: 'k1' }],
        }),
      ),
      latestBlock: vi.fn(() => Promise.resolve({ number: 100n, time: 1_000 })),
    };
    const { rows } = await statusRows(reader, examId, registry);
    expect(reader.releaseRows).toHaveBeenCalledWith(examId, [registry]);
    expect(rows.map((r) => [r.kind, r.createdAtBlock, r.writtenAt])).toEqual([
      ['log', 99n, 998],
      ['log', 90n, 980],
      ['token', 80n, 960],
    ]);
    expect(rows[0]?.detail).toBe('entriesHash h2, 3 entries');
    expect(rows[2]?.detail).toBe('instanceKeyHash k1');
  });
});
