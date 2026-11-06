import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import { arkiv, backupPhases, type BackupPhase } from '@paperseal/arkiv';
import { minDepth } from '@paperseal/swarm';
import { getAddress, isAddress, isHex, size, type Address, type Hex } from 'viem';

/** What one pass mirrors. `examId` is lowercase, `registry` checksummed, URLs without a trailing slash. */
export interface MirrorTarget {
  examId: Hex;
  registry: Address;
  storageUrl: string | undefined;
  teeUrl: string | undefined;
}

/** Where the Sepolia RPC came from, for the header line. */
export type RpcSource = '--rpc' | 'RELAY_SEPOLIA_RPC' | 'default';

/** The public Sepolia RPC `index` uses without `--rpc` or `RELAY_SEPOLIA_RPC`. */
export const defaultSepoliaRpc = 'https://ethereum-sepolia-rpc.publicnode.com';

/** What `index` scans and writes. `names` are trimmed, without repeats, and not yet checked. */
export interface IndexTarget {
  registry: Address;
  fromBlock: bigint;
  /** Inclusive. Undefined: the latest block at each scan. */
  toBlock: bigint | undefined;
  rpcUrl: string;
  rpcSource: RpcSource;
  names: string[];
  /** Undefined: one pass. */
  everySeconds: number | undefined;
}

/** The Bee API to use, and where it came from, for the header line. */
export interface SwarmApi {
  url: string;
  source: '--swarm' | 'RELAY_SWARM_API' | 'default';
}

/** What `backup` checks, uploads and records (spec/arkiv.md "Backups"). */
export interface BackupTarget {
  examId: Hex;
  registry: Address;
  storageUrl: string;
  /**
   * The exam's storage bucket: the `STORAGE_BUCKET` the release token's `env_override` must name.
   * `--bucket`, else the bucket in a `storage.googleapis.com` `--storage` URL, else unknown, and an
   * `unlock` backup is refused.
   */
  bucket: { name: string; source: '--bucket' | '--storage' } | undefined;
  /** 64 lowercase hex characters, no `0x`. */
  batchId: string;
  /** Undefined: `unlock` if storage has `release-log.json`, else `build`. */
  phase: BackupPhase | undefined;
  swarm: SwarmApi;
  rpcUrl: string;
  rpcSource: RpcSource;
  /** Run every check, then stop: no upload, no Arkiv write, no key. */
  dryRun: boolean;
}

export type Command =
  | { command: 'mirror'; target: MirrorTarget }
  | { command: 'watch'; target: MirrorTarget; everySeconds: number; heartbeat: boolean }
  | { command: 'status'; examId: Hex; writer: Address | undefined; registry: Address | undefined }
  | { command: 'status-index'; registry: Address; writer: Address | undefined }
  | { command: 'index'; target: IndexTarget }
  | { command: 'backup'; target: BackupTarget }
  | { command: 'swarm-status'; swarm: SwarmApi }
  | { command: 'buy-stamp'; swarm: SwarmApi; depth: number; days: number; label: string | undefined; yes: boolean }
  | { command: 'dry-check' }
  | { command: 'help' };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The batch `swarm-status` prices: deep enough for an exam's files, and a week of life. */
export const recommendedBatch = { depth: 19, days: 7 } as const;

export const usage = `Paper Seal relay: mirrors an exam's public unlock evidence to Arkiv (spec/arkiv.md)

  node relay/cli.mjs mirror --exam <examId> --registry <address> [--storage <url>] [--tee <url>]
      One pass: the release token first, then the release log, from storage and/or the TEE.
  node relay/cli.mjs watch  --exam <examId> --registry <address> [--storage <url>] [--tee <url>] [--every 10] [--no-heartbeat]
      Repeats the pass every N seconds until the TEE says released or failed, or Ctrl+C, and writes
      a heartbeat every heartbeatSeconds (spec/arkiv.json) unless --no-heartbeat.
  node relay/cli.mjs status --exam <examId> [--registry <address>] [--writer <address>]
      Read-only: this exam's rows and heartbeats on Arkiv from one writer (default: the relay's own
      address), newest first, only for --registry when given.
  node relay/cli.mjs status --index --registry <address> [--writer <address>]
      Read-only: the exam-index rows for --registry from one writer.
  node relay/cli.mjs index --registry <address> --from-block <n> [--to-block <n>] [--rpc <sepolia url>]
                           [--names a.board.eth,b.board.eth] [--every <seconds>]
      Mirrors the registry's exams (ExamCreated, ApprovedListPosted, BuildPosted) and their
      approved lists to the Arkiv exam index. --every repeats it from the last block scanned.
      Sepolia RPC: --rpc, else RELAY_SEPOLIA_RPC, else ${defaultSepoliaRpc}.
  node relay/cli.mjs backup --exam <examId> --registry <address> --storage <url> --batch <batchId>
                            [--bucket <name>] [--phase build|unlock] [--swarm <bee api>] [--rpc <sepolia url>] [--dry-run]
      Checks the exam's storage files against the Build's storageManifestHash on Sepolia, and the
      unlock files as readers do (release token, signed release log, timelock round, key-priv
      sizes), uploads them to Swarm as one collection and writes a paperseal.v1.backup row. Phase
      defaults to unlock once storage has every unlock file, else build. --bucket is the exam's
      STORAGE_BUCKET, which defaults to the bucket in a storage.googleapis.com --storage URL.
      --dry-run stops after the checks.
  node relay/cli.mjs swarm-status [--swarm <bee api>]
      Read-only: the Bee node's health, address, wallet, price and postage batches, and what a
      depth-${String(recommendedBatch.depth)}, ${String(recommendedBatch.days)}-day batch would cost.
  node relay/cli.mjs buy-stamp --depth <n> --days <n> [--label <text>] [--swarm <bee api>] [--yes]
      Prints the exact cost of a postage batch. Only with --yes does it buy one, with the node's sBZZ.
  node relay/cli.mjs dry-check
      Offline self-test of argument parsing and payload preparation. No network, no key.

mirror and watch need at least one of --storage and --tee.
Bee API: --swarm, else RELAY_SWARM_API, else ${arkiv.swarm.defaultApiUrl} (swarm.defaultApiUrl in spec/arkiv.json).`;

export function parseExamId(value: string | undefined): Hex {
  if (value === undefined) throw new UsageError('--exam <examId> is required');
  if (!isHex(value, { strict: true }) || size(value) !== 32) {
    throw new UsageError(`--exam must be a 32-byte 0x hex exam ID, got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase() as Hex;
}

/** Lowercase and checksummed addresses pass; a mixed-case address with a bad checksum is refused. */
export function parseAddress(flag: string, value: string | undefined): Address {
  if (value === undefined) throw new UsageError(`${flag} <address> is required`);
  if (!isAddress(value, { strict: false })) throw new UsageError(`${flag} must be a 20-byte 0x address, got ${JSON.stringify(value)}`);
  if (value !== value.toLowerCase() && !isAddress(value, { strict: true })) {
    throw new UsageError(`${flag} ${value} has a bad checksum; check it, or pass it in lowercase`);
  }
  return getAddress(value);
}

export function parseBaseUrl(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag} must be an http(s) URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`${flag} must be an http(s) URL`);
  if (url.search || url.hash) throw new UsageError(`${flag} must not have a query or fragment`);
  return value.replace(/\/+$/, '');
}

export function parseEvery(value: string | undefined): number {
  if (value === undefined) return 10;
  if (!/^\d+$/.test(value)) throw new UsageError(`--every must be a whole number of seconds, got ${JSON.stringify(value)}`);
  const seconds = Number(value);
  if (seconds < 2 || seconds > 3600) throw new UsageError('--every must be between 2 and 3600 seconds');
  return seconds;
}

/** A block number: a whole decimal number. */
export function parseBlock(flag: string, value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} must be a whole block number, got ${JSON.stringify(value)}`);
  return BigInt(value);
}

/** Comma-separated names, trimmed, without empties or repeats. Each is checked in full later. */
export function parseNames(value: string | undefined): string[] {
  if (value === undefined) return [];
  const names = [...new Set(value.split(',').map((name) => name.trim()).filter((name) => name !== ''))];
  if (names.length === 0) throw new UsageError('--names needs at least one name, like jee-main-2026.board.eth');
  return names;
}

/** `--rpc`, else `RELAY_SEPOLIA_RPC`, else the public default. */
export function sepoliaRpc(flag: string | undefined, env: NodeJS.ProcessEnv): { rpcUrl: string; rpcSource: RpcSource } {
  if (flag !== undefined) return { rpcUrl: parseRpcUrl('--rpc', flag), rpcSource: '--rpc' };
  const fromEnv = env.RELAY_SEPOLIA_RPC?.trim();
  if (fromEnv) return { rpcUrl: parseRpcUrl('RELAY_SEPOLIA_RPC', fromEnv), rpcSource: 'RELAY_SEPOLIA_RPC' };
  return { rpcUrl: defaultSepoliaRpc, rpcSource: 'default' };
}

/** An http(s) URL. Unlike a base URL it may carry a path or query, where providers put their key. */
function parseRpcUrl(flag: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag} must be an http(s) URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`${flag} must be an http(s) URL`);
  return value;
}

/** `--swarm`, else `RELAY_SWARM_API`, else `swarm.defaultApiUrl` in spec/arkiv.json. */
export function swarmApi(flag: string | undefined, env: NodeJS.ProcessEnv): SwarmApi {
  if (flag !== undefined) return { url: parseBaseUrl('--swarm', flag) ?? flag, source: '--swarm' };
  const fromEnv = env.RELAY_SWARM_API?.trim();
  if (fromEnv) return { url: parseBaseUrl('RELAY_SWARM_API', fromEnv) ?? fromEnv, source: 'RELAY_SWARM_API' };
  return { url: arkiv.swarm.defaultApiUrl.replace(/\/+$/, ''), source: 'default' };
}

/** A postage batch ID: 64 hex characters. A `0x` prefix is dropped, and the rest lowercased. */
export function parseBatchId(value: string | undefined): string {
  if (value === undefined) throw new UsageError('--batch <batchId> is required: a usable postage batch on the Bee node (see swarm-status)');
  const bare = value.replace(/^0[xX]/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) throw new UsageError(`--batch must be a 64-hex postage batch ID, got ${JSON.stringify(value)}`);
  return bare.toLowerCase();
}

const bucketName = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/** `--bucket`, else the bucket a `https://storage.googleapis.com/<bucket>` URL names, else undefined. */
export function parseBucket(value: string | undefined, storageUrl: string): BackupTarget['bucket'] {
  if (value !== undefined) {
    if (!bucketName.test(value)) throw new UsageError(`--bucket must be a storage bucket name, got ${JSON.stringify(value)}`);
    return { name: value, source: '--bucket' };
  }
  const url = new URL(storageUrl);
  let name: string | undefined;
  if (url.hostname === 'storage.googleapis.com') name = url.pathname.split('/').filter(Boolean)[0];
  else if (url.hostname.endsWith('.storage.googleapis.com')) name = url.hostname.slice(0, -'.storage.googleapis.com'.length);
  return name !== undefined && bucketName.test(name) ? { name, source: '--storage' } : undefined;
}

export function parsePhase(value: string | undefined): BackupPhase | undefined {
  if (value === undefined) return undefined;
  if (!(backupPhases as readonly string[]).includes(value)) throw new UsageError(`--phase must be ${backupPhases.join(' or ')}, got ${JSON.stringify(value)}`);
  return value as BackupPhase;
}

/** A whole number in `[min, max]`. */
export function parseWhole(flag: string, value: string | undefined, min: number, max: number): number {
  if (value === undefined) throw new UsageError(`${flag} <n> is required`);
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} must be a whole number, got ${JSON.stringify(value)}`);
  const n = Number(value);
  if (n < min || n > max) throw new UsageError(`${flag} must be from ${String(min)} to ${String(max)}`);
  return n;
}

const backupFlags = {
  exam: { type: 'string' },
  registry: { type: 'string' },
  storage: { type: 'string' },
  bucket: { type: 'string' },
  batch: { type: 'string' },
  phase: { type: 'string' },
  swarm: { type: 'string' },
  rpc: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;

function backupTarget(values: Partial<Record<Exclude<keyof typeof backupFlags, 'dry-run'>, string>> & { 'dry-run'?: boolean }, env: NodeJS.ProcessEnv): BackupTarget {
  const storageUrl = parseBaseUrl('--storage', values.storage);
  if (storageUrl === undefined) throw new UsageError('--storage <url> is required: the public bucket the files are read from');
  return {
    examId: parseExamId(values.exam),
    registry: parseAddress('--registry', values.registry),
    storageUrl,
    bucket: parseBucket(values.bucket, storageUrl),
    batchId: parseBatchId(values.batch),
    phase: parsePhase(values.phase),
    swarm: swarmApi(values.swarm, env),
    ...sepoliaRpc(values.rpc, env),
    dryRun: values['dry-run'] === true,
  };
}

const indexFlags = {
  registry: { type: 'string' },
  'from-block': { type: 'string' },
  'to-block': { type: 'string' },
  rpc: { type: 'string' },
  names: { type: 'string' },
  every: { type: 'string' },
} as const;

function indexTarget(values: Partial<Record<keyof typeof indexFlags, string>>, env: NodeJS.ProcessEnv): IndexTarget {
  const registry = parseAddress('--registry', values.registry);
  const fromBlock = parseBlock('--from-block', values['from-block']);
  if (fromBlock === undefined) throw new UsageError('--from-block <n> is required: the block to start scanning at');
  const toBlock = parseBlock('--to-block', values['to-block']);
  if (toBlock !== undefined && toBlock < fromBlock) throw new UsageError('--to-block must not be before --from-block');
  const everySeconds = values.every === undefined ? undefined : parseEvery(values.every);
  if (everySeconds !== undefined && toBlock !== undefined) {
    throw new UsageError('--every follows the chain as it grows, so it takes no --to-block');
  }
  return { registry, fromBlock, toBlock, ...sepoliaRpc(values.rpc, env), names: parseNames(values.names), everySeconds };
}

const mirrorFlags = {
  exam: { type: 'string' },
  registry: { type: 'string' },
  storage: { type: 'string' },
  tee: { type: 'string' },
} as const;

function flags(argv: string[], options: ParseArgsOptionsConfig) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function mirrorTarget(values: { exam?: string; registry?: string; storage?: string; tee?: string }): MirrorTarget {
  const target: MirrorTarget = {
    examId: parseExamId(values.exam),
    registry: parseAddress('--registry', values.registry),
    storageUrl: parseBaseUrl('--storage', values.storage),
    teeUrl: parseBaseUrl('--tee', values.tee),
  };
  if (!target.storageUrl && !target.teeUrl) throw new UsageError('give --storage <url>, --tee <url>, or both');
  return target;
}

export function parseCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Command {
  const [command, ...rest] = argv;
  switch (command) {
    case 'mirror':
      return { command, target: mirrorTarget(flags(rest, mirrorFlags) as Record<string, string>) };
    case 'watch': {
      const values = flags(rest, { ...mirrorFlags, every: { type: 'string' }, 'no-heartbeat': { type: 'boolean' } }) as {
        exam?: string;
        registry?: string;
        storage?: string;
        tee?: string;
        every?: string;
        'no-heartbeat'?: boolean;
      };
      return { command, target: mirrorTarget(values), everySeconds: parseEvery(values.every), heartbeat: values['no-heartbeat'] !== true };
    }
    case 'status': {
      const values = flags(rest, { exam: { type: 'string' }, registry: { type: 'string' }, writer: { type: 'string' }, index: { type: 'boolean' } }) as {
        exam?: string;
        registry?: string;
        writer?: string;
        index?: boolean;
      };
      if (values.index === true) {
        if (values.exam !== undefined) throw new UsageError('status --index lists a registry\'s exams, so it takes no --exam');
        return {
          command: 'status-index',
          registry: parseAddress('--registry', values.registry),
          writer: values.writer === undefined ? undefined : parseAddress('--writer', values.writer),
        };
      }
      return {
        command,
        examId: parseExamId(values.exam),
        writer: values.writer === undefined ? undefined : parseAddress('--writer', values.writer),
        registry: values.registry === undefined ? undefined : parseAddress('--registry', values.registry),
      };
    }
    case 'index':
      return { command, target: indexTarget(flags(rest, indexFlags) as Partial<Record<keyof typeof indexFlags, string>>, env) };
    case 'backup':
      return { command, target: backupTarget(flags(rest, backupFlags) as Parameters<typeof backupTarget>[0], env) };
    case 'swarm-status': {
      const values = flags(rest, { swarm: { type: 'string' } }) as { swarm?: string };
      return { command, swarm: swarmApi(values.swarm, env) };
    }
    case 'buy-stamp': {
      const values = flags(rest, {
        depth: { type: 'string' },
        days: { type: 'string' },
        label: { type: 'string' },
        swarm: { type: 'string' },
        yes: { type: 'boolean' },
      }) as { depth?: string; days?: string; label?: string; swarm?: string; yes?: boolean };
      return {
        command,
        swarm: swarmApi(values.swarm, env),
        depth: parseWhole('--depth', values.depth, minDepth, 255),
        days: parseWhole('--days', values.days, 1, 3650),
        label: values.label,
        yes: values.yes === true,
      };
    }
    case 'dry-check':
      flags(rest, {});
      return { command };
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { command: 'help' };
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}
