import { createExamRegistry, type ExamRegistry } from '@paperseal/chain';
import type { Hex } from '@paperseal/protocol';

const env = import.meta.env as Record<string, string | undefined>;
const rpcUrl = env.VITE_RPC_URL;
const address = env.VITE_REGISTRY_ADDRESS as Hex | undefined;

export const registryAddress: Hex | null = address ?? null;
export const registryRpcUrl: string | null = rpcUrl ?? null;

/** Null until VITE_RPC_URL and VITE_REGISTRY_ADDRESS are set. */
export const registry = rpcUrl && address ? createExamRegistry({ rpcUrl, address }) : null;

/** bytes32 exam ID. Null until VITE_EXAM_ID is set. */
export const examId = (env.VITE_EXAM_ID as Hex | undefined) ?? null;

/** A loader for an ExamRegistry read, or null when the chain or exam is not configured. */
export function fromExam<T>(
  read: (client: ExamRegistry, id: Hex) => Promise<T>,
): (() => Promise<T>) | null {
  return registry && examId ? () => read(registry, examId) : null;
}

export const notConnectedToChain =
  'Set VITE_RPC_URL, VITE_REGISTRY_ADDRESS and VITE_EXAM_ID to read ExamRegistry.';
