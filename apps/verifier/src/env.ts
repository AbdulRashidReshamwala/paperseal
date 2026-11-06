/**
 * The bucket the TEE was started with, which `env_override` must name. Build-time, like the other
 * defaults, and an exam name's bucket record replaces it for that view. Unset, it is empty and the
 * claim fails against any real token.
 */
export const teeStorageBucket: string =
  (import.meta.env as Record<string, string | undefined>).VITE_TEE_STORAGE_BUCKET ?? '';
