import {
  createTeeClient,
  TeeApiError,
  type AttestationResponse,
  type StatusResponse,
} from '@paperseal/tee-client';

import type { Fetch } from './storage';

/*
 * The TEE's public routes, through @paperseal/tee-client. The relay trusts none of it: it only
 * copies signed evidence, which readers check. The release log row must hold the exact bytes of
 * the `GET /v1/release/log` body, so the client's response is cloned before it parses it.
 */

/** The parts of one look at the TEE. A missing part has its reason in the matching `*Error`. */
export interface TeeSnapshot {
  status?: StatusResponse;
  statusError?: string;
  /** The exact `GET /v1/release/log` body. */
  log?: Uint8Array;
  /** Why there is no log: an error, or the TEE saying it has none at this stage. */
  logError?: string;
  /** True when the TEE answered that the log isn't served at its stage, which isn't a fault. */
  logNotYet?: boolean;
  attestation?: AttestationResponse;
  attestationError?: string;
}

const describe = (error: unknown): string =>
  error instanceof TeeApiError
    ? `${String(error.status)} ${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

/** Every call has a timeout, so one hung route can't stall `watch`. */
function timed(send: Fetch, timeoutMs: number): Fetch {
  return (input, init) => send(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** `GET /v1/release/log` as its exact bytes. Errors are the client's TeeApiError. */
export async function fetchReleaseLogBytes(send: Fetch, baseUrl: string, timeoutMs = 20_000): Promise<Uint8Array> {
  let raw: Response | undefined;
  const client = createTeeClient({
    baseUrl,
    fetch: async (input, init) => {
      const response = await timed(send, timeoutMs)(input, init);
      raw = response.clone();
      return response;
    },
  });
  await client.releaseLog();
  if (!raw) throw new Error('the TEE client made no request');
  return new Uint8Array(await raw.arrayBuffer());
}

export async function readTeeStatus(send: Fetch, baseUrl: string, timeoutMs = 20_000): Promise<StatusResponse> {
  return createTeeClient({ baseUrl, fetch: timed(send, timeoutMs) }).status();
}

export async function readTeeAttestation(send: Fetch, baseUrl: string, timeoutMs = 20_000): Promise<AttestationResponse> {
  return createTeeClient({ baseUrl, fetch: timed(send, timeoutMs) }).attestation();
}

/** Status and the release log. The attestation is read separately, once a log ties it to the exam. */
export async function readTee(send: Fetch, baseUrl: string): Promise<TeeSnapshot> {
  const snapshot: TeeSnapshot = {};
  const [status, log] = await Promise.allSettled([readTeeStatus(send, baseUrl), fetchReleaseLogBytes(send, baseUrl)]);
  if (status.status === 'fulfilled') snapshot.status = status.value;
  else snapshot.statusError = describe(status.reason);
  if (log.status === 'fulfilled') {
    snapshot.log = log.value;
  } else {
    snapshot.logError = describe(log.reason);
    // The TEE serves its log only during unlock and after release (tee/internal/lifecycle).
    const reason: unknown = log.reason;
    snapshot.logNotYet = reason instanceof TeeApiError && (reason.code === 'wrong_stage' || reason.code === 'too_early');
  }
  return snapshot;
}

export { describe as describeTeeError };
