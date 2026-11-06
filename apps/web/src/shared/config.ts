/*
 * Configuration for the signed-in roles (VITE_ values, then config.json): where public storage is
 * and which bucket an attestation token must name.
 */

import { appEnv } from './runtime-config';

const env = appEnv();

/** Base URL of public storage. Files are read from `<base>/<examId>/<name>`. Hashes protect the content. */
export const storageUrl: string | null = env.VITE_STORAGE_URL?.replace(/\/+$/, '') || null;

export const notConnectedToStorage = 'Set VITE_STORAGE_URL to read public storage.';

/**
 * The bucket the TEE was started with (`STORAGE_BUCKET`). The token's `env_override` must hold
 * exactly it. Unset, it is empty, so the check fails against any real token.
 */
export const teeStorageBucket: string = env.VITE_TEE_STORAGE_BUCKET ?? '';
