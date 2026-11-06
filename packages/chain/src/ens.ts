import { ens, examIdFromName, examNameProblem, splitExamEnsName, type Hex } from '@paperseal/protocol';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
  isAddressEqual,
  type Address,
  type PublicClient,
  type Transport,
} from 'viem';
import { sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';

import { createExamRegistry } from './registry';

/*
 * Verify by Name, from "Exam Names" in spec/api.md. An exam name `<label>.<parent>` only helps people
 * find an exam: every value it supplies is checked again by the usual checks. The reader uses the
 * viewer's own RPC and on-chain resolution only (`ens.ccipRead` is false), and fails unless the label
 * is a valid exam name, the name's `addr` is an ExamRegistry, and its board's primary name is `parent`
 * both ways.
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

/** The four on-chain reads the checks need. Throws only when the RPC can't answer. */
export interface EnsLookup {
  /** The forward `addr` (ETH) record, or null when unset. */
  address(name: string): Promise<Address | null>;
  /** The primary name by reverse resolution, or null when unset. */
  primaryName(address: Address): Promise<string | null>;
  text(name: string, key: string): Promise<string | null>;
  /** `ExamRegistry.board()`. Reverts when `registry` is not an ExamRegistry. */
  board(registry: Address): Promise<Address>;
}

interface EnsOptions {
  /** RPC endpoint for Sepolia. Ignored when `transport` is given. */
  rpcUrl?: string;
  transport?: Transport;
}

export function createEnsLookup(options: EnsOptions): EnsLookup {
  const transport = options.transport ?? http(options.rpcUrl);
  const client: PublicClient = createPublicClient({ chain: sepolia, transport, ccipRead: false });
  return {
    address: (name) => client.getEnsAddress({ name }),
    primaryName: (address) => client.getEnsName({ address }),
    text: (name, key) => client.getEnsText({ name, key }),
    board: (registry) => createExamRegistry({ address: registry, transport, ccipRead: false }).board(),
  };
}

/** `board()` reverted or the address has no code: the `addr` record is not an ExamRegistry. */
function notARegistry(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const found = error.walk(
    (cause) => cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError,
  );
  return found !== null;
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
    // 2. The name's addr record is set, and board() on it answers.
    const registry = await lookup.address(name);
    if (!registry) return fail('registry', `${name} has no address record, so it names no exam registry.`);
    partial.registry = registry;
    let board: Address;
    try {
      board = await lookup.board(registry);
    } catch (error) {
      if (notARegistry(error)) {
        return fail('registry', `${name} points to ${registry}, which is not an exam registry: board() failed.`);
      }
      throw error;
    }
    partial.board = board;

    // 3. The board's primary name is exactly parent.
    const primary = await lookup.primaryName(board);
    if (primary === null) {
      return fail('primaryName', `The registry's board ${board} has no primary name, so it can't be ${parent}.`);
    }
    if (primary !== parent) {
      return fail('primaryName', `The registry's board ${board} calls itself ${primary}, not ${parent}.`);
    }

    // 4. parent's own addr record is that board, so the primary name holds both ways.
    const forward = await lookup.address(parent);
    if (!forward || !isAddressEqual(forward, board)) {
      return fail('forward', `${parent} points to ${forward ?? 'no address'}, not the board ${board}.`);
    }

    const [teeUrl, storageUrl, bucket] = await Promise.all(
      [ens.records.tee, ens.records.storage, ens.records.bucket].map(
        async (key) => (await lookup.text(name, key)) || null,
      ),
    );
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
    return fail('unreadable', `The RPC failed before the name could be checked: ${messageOf(error)}`);
  }
}
