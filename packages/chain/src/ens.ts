import {
  credentialRecordValue,
  ens,
  ensNameProblem,
  examIdFromName,
  examNameProblem,
  looksLikeEnsName,
  parseDirectory,
  passkeyRecordMatches,
  passkeyRecordValue,
  splitExamEnsName,
  type Hex,
} from '@paperseal/protocol';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  ExecutionRevertedError,
  http,
  HttpRequestError,
  isAddressEqual,
  isHex,
  offchainLookupSignature,
  RpcError,
  RpcRequestError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
  type Address,
  type PublicClient,
  type Transport,
} from 'viem';
import { sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';

import { isExamRegistryCode } from './code';
import { createExamRegistry } from './registry';

/*
 * Verify by Name, from "Exam Names" in spec/api.md. An exam name `<label>.<parent>` only helps people
 * find an exam: every value it supplies is checked again by the usual checks. The reader uses the
 * viewer's own RPC and on-chain resolution only (`ens.ccipRead` is false), and fails unless the label
 * is a valid exam name, the code at the name's `addr` is ExamRegistry's with that board filled in, and
 * the board's primary name is `parent` both ways. A read the chain refuses, an OffchainLookup included,
 * fails at its check; only an RPC that can't answer leaves the name `unreadable`.
 */

if (ens.ccipRead !== false) {
  throw new Error('spec/ens.json ccipRead must be false: the reader asks no offchain gateway');
}

export interface ResolvedExamName {
  name: string;
  label: string;
  parent: string;
  /** `labelhash(label)`, the `examId` for every other check. */
  examId: Hex;
  /** The name's `addr` record, an `ExamRegistry`. */
  registry: Address;
  /** `registry.board()`, whose primary name is `parent` both ways. */
  board: Address;
  /** The text records only say where to look. Null when unset. */
  teeUrl: string | null;
  storageUrl: string | null;
  bucket: string | null;
}

/** The check that failed, in the order of spec/api.md. `unreadable`: the RPC failed, so nothing was decided. */
export type ExamNameCheck = 'name' | 'registry' | 'primaryName' | 'forward' | 'unreadable';

export type ExamNameResult =
  | { ok: true; value: ResolvedExamName }
  | { ok: false; failed: ExamNameCheck; reason: string; partial: Partial<ResolvedExamName> };

/**
 * The five on-chain reads the checks need. Throws when the RPC can't answer, or when the chain refuses
 * the read: a revert, an OffchainLookup that would need a gateway, or data that doesn't decode.
 */
export interface EnsLookup {
  /** The forward `addr` (ETH) record, or null when unset. */
  address(name: string): Promise<Address | null>;
  /** The primary name by reverse resolution, or null when unset. */
  primaryName(address: Address): Promise<string | null>;
  text(name: string, key: string): Promise<string | null>;
  /** The deployed code at `address`, or undefined when there is none. */
  code(address: Address): Promise<Hex | undefined>;
  /** `ExamRegistry.board()`. Reverts when `registry` is not an ExamRegistry. */
  board(registry: Address): Promise<Address>;
}

interface EnsOptions {
  /** RPC endpoint for Sepolia. Ignored when `transport` is given. */
  rpcUrl?: string;
  transport?: Transport;
}

/** Throws without `rpcUrl` or `transport`, so viem's default public RPC is never asked. */
export function createEnsLookup(options: EnsOptions): EnsLookup {
  if (!options.transport && !options.rpcUrl) {
    throw new Error("Reading an exam name needs the viewer's own RPC: pass rpcUrl or transport.");
  }
  const transport = options.transport ?? http(options.rpcUrl);
  const client: PublicClient = createPublicClient({ chain: sepolia, transport, ccipRead: false });
  return {
    address: (name) => client.getEnsAddress({ name }),
    primaryName: (address) => client.getEnsName({ address }),
    text: (name, key) => client.getEnsText({ name, key }),
    code: (address) => client.getCode({ address }),
    board: (registry) => createExamRegistry({ address: registry, transport, ccipRead: false }).board(),
  };
}

/** The revert data in a viem error chain, if any: a ContractFunctionRevertedError's raw data, or an RPC error's. */
function revertData(error: BaseError): Hex | undefined {
  let found: Hex | undefined;
  error.walk((cause) => {
    const data: unknown =
      cause instanceof ContractFunctionRevertedError ? cause.raw : (cause as { data?: unknown } | null)?.data;
    // Some nodes nest it as `{ data: '0x…' }`, as viem's own getRevertErrorData allows.
    const hex: unknown = typeof data === 'object' && data !== null ? (data as { data?: unknown }).data : data;
    if (typeof hex === 'string' && isHex(hex) && hex.length > 2) found = hex;
    return found !== undefined;
  });
  return found;
}

/**
 * A JSON-RPC error that is a revert, not an outage: code 3, a node message naming the revert, or revert
 * data. viem itself also calls any -32603 with a message a revert, which would turn a flaky node into
 * a failed check, so that alone isn't taken as one.
 */
const isRevertRpcError = (error: RpcError | RpcRequestError): boolean =>
  error.code === ExecutionRevertedError.code ||
  ExecutionRevertedError.nodeMessage.test(error.details) ||
  revertData(error) !== undefined;

/** The RPC couldn't answer: HTTP, socket or timeout failures, and JSON-RPC errors that aren't reverts. */
const isTransportFailure = (cause: unknown): boolean =>
  cause instanceof HttpRequestError ||
  cause instanceof TimeoutError ||
  cause instanceof WebSocketRequestError ||
  cause instanceof SocketClosedError ||
  ((cause instanceof RpcError || cause instanceof RpcRequestError) && !isRevertRpcError(cause));

/**
 * What a failed read means. `offchain`: it would need a CCIP-Read gateway, which this reader never
 * asks. `refused`: the chain answered with a revert, no data, or data that doesn't decode. `unreadable`:
 * the RPC couldn't answer, so nothing was decided.
 */
function readFailure(error: unknown): 'offchain' | 'refused' | 'unreadable' {
  if (!(error instanceof BaseError)) return 'unreadable';
  if (revertData(error)?.slice(0, 10).toLowerCase() === offchainLookupSignature) return 'offchain';
  return error.walk(isTransportFailure) ? 'unreadable' : 'refused';
}

type DecidingCheck = Exclude<ExamNameCheck, 'name' | 'unreadable'>;

/** A read the chain refused, which fails `check`. */
class CheckFailure extends Error {
  readonly check: DecidingCheck;

  constructor(check: DecidingCheck, reason: string) {
    super(reason);
    this.check = check;
  }
}

/**
 * Runs one read for `check`. A refused read fails the check with `refused`, or a reason naming `what`;
 * a read that would need an offchain gateway always says so. An RPC that can't answer is thrown on.
 */
async function readFor<T>(check: DecidingCheck, what: string, read: () => Promise<T>, refused?: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const failure = readFailure(error);
    if (failure === 'unreadable') throw error;
    throw new CheckFailure(
      check,
      failure === 'offchain'
        ? `${what} needs an offchain gateway, and this reader reads ENS on chain only.`
        : (refused ?? `${what} could not be read on chain: ${messageOf(error)}`),
    );
  }
}

/** Whether a TEE or storage record is a web address, the same rule the verifier's own settings have. */
function isWebAddress(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const messageOf = (error: unknown): string =>
  error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);

/** The parent must be normalised too: a name that normalises to something else is a different name to ENS. */
function wholeNameProblem(name: string): string | null {
  try {
    return normalize(name) === name ? null : `The name must already be in normalised form, ${normalize(name)}.`;
  } catch (error) {
    return `The name is not a valid ENS name: ${messageOf(error).replace(/[‎‏]/g, '')}`;
  }
}

/** Runs the checks of "Exam Names" in spec/api.md in order, stopping at the first that fails. */
export async function resolveExamName(
  name: string,
  options: EnsOptions & { lookup?: EnsLookup },
): Promise<ExamNameResult> {
  const lookup = options.lookup ?? createEnsLookup(options);
  const partial: Partial<ResolvedExamName> = { name };
  const fail = (failed: ExamNameCheck, reason: string): ExamNameResult => ({
    ok: false,
    failed,
    reason,
    partial: { ...partial },
  });

  // 1. The first label is a valid exam name, and the whole name is normalised.
  if (name.length === 0) return fail('name', 'The name is empty.');
  const parts = splitExamEnsName(name);
  if (!parts) return fail('name', 'The name needs an exam name and a parent, like jee-main-2026.board.eth.');
  const { label, parent } = parts;
  Object.assign(partial, { label, parent });
  const labelProblem = examNameProblem(label);
  if (labelProblem) return fail('name', labelProblem);
  const examId = examIdFromName(label);
  partial.examId = examId;
  const nameProblem = wholeNameProblem(name);
  if (nameProblem) return fail('name', nameProblem);

  try {
    // 2. The name's addr record is set, and the code there is ExamRegistry's with board() filled in.
    const registry = await readFor('registry', `The address record of ${name}`, () => lookup.address(name));
    if (!registry) return fail('registry', `${name} has no address record, so it names no exam registry.`);
    partial.registry = registry;
    const code = await readFor('registry', `The code at ${registry}`, () => lookup.code(registry));
    if (!code || code === '0x') {
      return fail(
        'registry',
        `${name} points to ${registry}, which has no contract code, so it is not an exam registry.`,
      );
    }
    const board = await readFor(
      'registry',
      `board() on ${registry}`,
      () => lookup.board(registry),
      `${name} points to ${registry}, which is not an exam registry: board() failed.`,
    );
    // Any contract can answer board() with the real board's address, so only the exact code counts.
    if (!isExamRegistryCode(code, board)) {
      return fail(
        'registry',
        `${name} points to ${registry}, which is not the ExamRegistry contract: its code differs, so its board() can't be trusted.`,
      );
    }
    partial.board = board;

    // 3. The board's primary name is exactly parent.
    const primary = await readFor('primaryName', `The primary name of ${board}`, () => lookup.primaryName(board));
    if (primary === null) {
      return fail('primaryName', `The registry's board ${board} has no primary name, so it can't be ${parent}.`);
    }
    if (primary !== parent) {
      return fail('primaryName', `The registry's board ${board} calls itself ${primary}, not ${parent}.`);
    }

    // 4. parent's own addr record is that board, so the primary name holds both ways.
    const forward = await readFor('forward', `The address record of ${parent}`, () => lookup.address(parent));
    if (!forward || !isAddressEqual(forward, board)) {
      return fail('forward', `${parent} points to ${forward ?? 'no address'}, not the board ${board}.`);
    }

    // The text records belong to the name, so a refused one fails the registry check with the addr record.
    const [teeUrl, storageUrl, bucket] = await Promise.all(
      [ens.records.tee, ens.records.storage, ens.records.bucket].map(
        async (key) =>
          (await readFor('registry', `The ${key} text record of ${name}`, () => lookup.text(name, key))) || null,
      ),
    );
    for (const [key, value] of [
      [ens.records.tee, teeUrl],
      [ens.records.storage, storageUrl],
    ] as const) {
      if (value && !isWebAddress(value)) return fail('registry', `The ${key} text record of ${name} is not a web address.`);
    }
    return {
      ok: true,
      value: {
        name,
        label,
        parent,
        examId,
        registry,
        board,
        teeUrl: teeUrl ?? null,
        storageUrl: storageUrl ?? null,
        bucket: bucket ?? null,
      },
    };
  } catch (error) {
    if (error instanceof CheckFailure) return fail(error.check, error.message);
    return fail('unreadable', `The RPC failed before the name could be checked: ${messageOf(error)}`);
  }
}

/* -------------------------------------------------------------- Party names */

/**
 * What a party's ENS name says about its passkey, from "Party Names" in spec/api.md.
 * `confirmed`: the `ens.records.passkey` record is the hash of this passkey's public key.
 * `mismatch`: the record is set to something else. `missing`: no record is set yet.
 * `refused`: the chain would not answer on chain, an offchain lookup included, so the name says nothing.
 * `unreadable`: the RPC failed. `invalid`: not a normalised ENS name.
 */
export type PasskeyNameState = 'confirmed' | 'mismatch' | 'missing' | 'refused' | 'unreadable' | 'invalid';

export interface PasskeyNameResult {
  state: PasskeyNameState;
  name: string;
  /** What the record must hold for this passkey. */
  expected: Hex;
  /** What the record holds. Null when unset, and absent when it could not be read. */
  found?: string | null;
  reason: string;
}

/**
 * Reads `name`'s `ens.records.passkey` record on chain, with CCIP-Read off and the viewer's own RPC, and
 * compares it with `passkeyRecordValue(passkeyPublicKey)`. A label and a proof of who holds this key,
 * never a check anything depends on: every state other than `confirmed` only means "not confirmed".
 * Never throws for a chain or RPC failure.
 */
export async function checkPasskeyName(
  name: string,
  passkeyPublicKey: Hex,
  options: EnsOptions & { lookup?: EnsLookup },
): Promise<PasskeyNameResult> {
  const expected = passkeyRecordValue(passkeyPublicKey);
  const result = (state: PasskeyNameState, reason: string, found?: string | null): PasskeyNameResult => ({
    state,
    name,
    expected,
    reason,
    ...(found === undefined ? {} : { found }),
  });
  const problem = looksLikeEnsName(name) ? ensNameProblem(name) : 'The name is not written like an ENS name.';
  if (problem) return result('invalid', problem);
  const lookup = options.lookup ?? createEnsLookup(options);
  const key = ens.records.passkey;
  let found: string | null;
  try {
    found = await lookup.text(name, key);
  } catch (error) {
    const failure = readFailure(error);
    if (failure === 'unreadable') return result('unreadable', `The RPC failed before ${name} could be read: ${messageOf(error)}`);
    return result(
      'refused',
      failure === 'offchain'
        ? `The ${key} record of ${name} needs an offchain gateway, and this reader reads ENS on chain only.`
        : `The ${key} record of ${name} could not be read on chain: ${messageOf(error)}`,
    );
  }
  const value = found?.trim() ?? '';
  if (value === '') return result('missing', `${name} has no ${key} record yet.`, null);
  if (passkeyRecordMatches(value, expected)) return result('confirmed', `The ${key} record of ${name} matches this key.`, value);
  return result('mismatch', `The ${key} record of ${name} is ${value}, not ${expected}.`, value);
}

/**
 * What a party's name publishes. `found`: both records are set, so a browser can find the key and a
 * board can check it. `missing`: the directory owner has not finished it. Other states are as for
 * `PasskeyNameState`, and `refused` covers a credential record that isn't hex.
 */
export type PartyRecords =
  | { state: 'found'; name: string; passkey: Hex; credentialId: Hex }
  | { state: 'missing' | 'refused' | 'unreadable' | 'invalid'; name: string; reason: string };

/** A failed read in words, on chain only. Never throws for a chain or RPC failure. */
function failedRead(name: string, what: string, error: unknown): { state: 'refused' | 'unreadable'; name: string; reason: string } {
  const failure = readFailure(error);
  if (failure === 'unreadable') return { state: 'unreadable', name, reason: `The RPC failed before ${what} could be read: ${messageOf(error)}` };
  return {
    state: 'refused',
    name,
    reason:
      failure === 'offchain'
        ? `${what} needs an offchain gateway, and this reader reads ENS on chain only.`
        : `${what} could not be read on chain: ${messageOf(error)}`,
  };
}

/** Reads a party's `ens.records.passkey` and `ens.records.credential` records, on chain and with the viewer's own RPC. */
export async function readPartyRecords(name: string, options: EnsOptions & { lookup?: EnsLookup }): Promise<PartyRecords> {
  const problem = looksLikeEnsName(name) ? ensNameProblem(name) : 'The name is not written like an ENS name.';
  if (problem) return { state: 'invalid', name, reason: problem };
  const lookup = options.lookup ?? createEnsLookup(options);
  try {
    const [passkey, credential] = await Promise.all([lookup.text(name, ens.records.passkey), lookup.text(name, ens.records.credential)]);
    const value = passkey?.trim().toLowerCase() ?? '';
    if (value === '' || !credential?.trim()) {
      return { state: 'missing', name, reason: `${name} has no security key published yet.` };
    }
    const credentialId = credentialRecordValue(credential);
    if (!credentialId) return { state: 'refused', name, reason: `The ${ens.records.credential} record of ${name} is not a credential ID.` };
    return { state: 'found', name, passkey: value as Hex, credentialId };
  } catch (error) {
    return failedRead(name, `The records of ${name}`, error);
  }
}

/** What a directory holds. `none`: its record is not set. `malformed`: it is set, but isn't a list of names. */
export type Directory =
  | { state: 'found'; name: string; names: string[] }
  | { state: 'none' | 'malformed' | 'refused' | 'unreadable' | 'invalid'; name: string; reason: string };

/** Reads the `ens.records.directory` record of a parent name with one text lookup. The list is a menu: each name is verified on its own. */
export async function readDirectory(name: string, options: EnsOptions & { lookup?: EnsLookup }): Promise<Directory> {
  const problem = looksLikeEnsName(name) ? ensNameProblem(name) : 'The directory name is not written like an ENS name.';
  if (problem) return { state: 'invalid', name, reason: problem };
  const lookup = options.lookup ?? createEnsLookup(options);
  let text: string | null;
  try {
    text = await lookup.text(name, ens.records.directory);
  } catch (error) {
    return failedRead(name, `The directory of ${name}`, error);
  }
  if (!text?.trim()) return { state: 'none', name, reason: `${name} has no ${ens.records.directory} record yet.` };
  const parsed = parseDirectory(text);
  return parsed.ok ? { state: 'found', name, names: parsed.names } : { state: 'malformed', name, reason: parsed.reason };
}
