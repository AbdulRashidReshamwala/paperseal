import { createTeeClient, type TeeClient } from '@paperseal/tee-client';

import { appEnv } from './runtime-config';

const teeUrl = appEnv().VITE_TEE_URL;

/** Null until VITE_TEE_URL is set. The TEE stays untrusted until attestation passes. */
export const tee = teeUrl ? createTeeClient({ baseUrl: teeUrl }) : null;

/** A loader for a TEE read, or null when no TEE is configured. */
export function fromTee<T>(read: (client: TeeClient) => Promise<T>): (() => Promise<T>) | null {
  return tee ? () => read(tee) : null;
}

export const notConnectedToTee = 'Set VITE_TEE_URL to connect to the TEE.';
