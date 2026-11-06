import { createExamRegistry } from '@paperseal/chain';
import type { Hex } from '@paperseal/protocol';

import { appEnv } from './runtime-config';

const env = appEnv();
const rpcUrl = env.VITE_RPC_URL;
const address = env.VITE_REGISTRY_ADDRESS as Hex | undefined;

export const registryAddress: Hex | null = address ?? null;
export const registryRpcUrl: string | null = rpcUrl ?? null;

/** Null until VITE_RPC_URL and VITE_REGISTRY_ADDRESS are set. */
export const registry = rpcUrl && address ? createExamRegistry({ rpcUrl, address }) : null;

/**
 * The exam ID from VITE_EXAM_ID, which is only the starting value of the current exam. Nothing reads
 * it directly: every area uses `useCurrentExamId` or `getCurrentExamId` in currentExam.ts, so the
 * exam a role registers for is the exam every screen reads.
 */
export const envExamId = (env.VITE_EXAM_ID as Hex | undefined) ?? null;

export const notConnectedToChain =
  'Set VITE_RPC_URL, VITE_REGISTRY_ADDRESS and VITE_EXAM_ID to read ExamRegistry.';
