import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

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

export type Command =
  | { command: 'mirror'; target: MirrorTarget }
  | { command: 'watch'; target: MirrorTarget; everySeconds: number; heartbeat: boolean }
  | { command: 'status'; examId: Hex; writer: Address | undefined; registry: Address | undefined }
  | { command: 'status-index'; registry: Address; writer: Address | undefined }
  | { command: 'index'; target: IndexTarget }
  | { command: 'dry-check' }
  | { command: 'help' };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

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
  node relay/cli.mjs dry-check
      Offline self-test of argument parsing and payload preparation. No network, no key.

mirror and watch need at least one of --storage and --tee.`;

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
