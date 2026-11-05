/*
 * Build-time configuration for the signed-in roles: where public storage is
 * and what an attestation token must say that spec/ does not fix yet.
 */

const env = import.meta.env as Record<string, string | undefined>;

/** Base URL of public storage. Files are read from `<base>/<examId>/<name>`. Hashes protect the content. */
export const storageUrl: string | null = env.VITE_STORAGE_URL?.replace(/\/+$/, '') || null;

export const notConnectedToStorage = 'Set VITE_STORAGE_URL to read public storage.';

/**
 * The Confidential VM types the token's `hwmodel` may name. spec/ does not list them yet (see the
 * "Spec Gaps" in docs/ARCHITECTURE.md), so this mirrors `approvedHWModels` in tee/internal/attestation.
 */
export const approvedHwModels: readonly string[] = ['GCP_AMD_SEV', 'GCP_AMD_SEV_ES', 'GCP_INTEL_TDX'];

/**
 * The environment the token must show for the workload. The TEE accepts only `STORAGE_BUCKET`, so
 * with `VITE_TEE_STORAGE_BUCKET` set the token must carry exactly it, and with it unset, no
 * environment at all.
 */
export function expectedTeeEnv(): Record<string, string> {
  const bucket = env.VITE_TEE_STORAGE_BUCKET;
  return bucket ? { STORAGE_BUCKET: bucket } : {};
}
