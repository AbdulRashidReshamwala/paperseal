import type { ApiErrorBody } from '@paperseal/protocol';

import type {
  AttestationResponse,
  ChallengeResponse,
  EmptyResponse,
  OutboxResponse,
  QuestionReceipt,
  QuestionRequest,
  RegisterRequest,
  RegistrationsResponse,
  ReleaseLogResponse,
  ReleaseShareRequest,
  StatusResponse,
} from './types';

/** A non-2xx response. `code` is `invalid_response` if the body broke the error shape. */
export class TeeApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TeeApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The TEE refuses a release challenge, and a share, until `unlockRound` is published. It answers
 * 425 `too_early`, which is not a fault: the exam has simply not unlocked yet.
 */
export function isReleaseNotOpen(error: unknown): boolean {
  return error instanceof TeeApiError && (error.code === 'too_early' || error.status === 425);
}

export const RELEASE_NOT_OPEN_MESSAGE =
  'Release opens once the unlock round is published. The TEE refuses release challenges before then, so wait for the countdown to finish and try again.';

function isErrorBody(body: unknown): body is ApiErrorBody {
  const error = (body as Partial<ApiErrorBody> | null)?.error;
  return typeof error?.code === 'string' && typeof error.message === 'string';
}

export interface TeeClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** The TEE is untrusted until the attestation check passes. This client checks nothing itself. */
export function createTeeClient(options: TeeClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const send = options.fetch ?? globalThis.fetch;
    const response = await send(`${baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (isErrorBody(parsed)) {
        throw new TeeApiError(response.status, parsed.error.code, parsed.error.message);
      }
      throw new TeeApiError(response.status, 'invalid_response', `TEE returned ${String(response.status)}`);
    }
    if (parsed === undefined) {
      throw new TeeApiError(response.status, 'invalid_response', 'TEE response was not JSON');
    }
    return parsed as T;
  }

  // The eleven routes of "TEE API" in spec/api.md.
  return {
    attestation: () => call<AttestationResponse>('GET', '/v1/attestation'),
    status: () => call<StatusResponse>('GET', '/v1/status'),
    registerChallenge: () => call<ChallengeResponse>('POST', '/v1/register/challenge', {}),
    registrations: () => call<RegistrationsResponse>('GET', '/v1/registrations'),
    register: (body: RegisterRequest) => call<EmptyResponse>('POST', '/v1/register', body),
    questionChallenge: () => call<ChallengeResponse>('POST', '/v1/questions/challenge', {}),
    question: (body: QuestionRequest) => call<QuestionReceipt>('POST', '/v1/questions', body),
    outbox: () => call<OutboxResponse>('GET', '/v1/outbox'),
    releaseChallenge: () => call<ChallengeResponse>('POST', '/v1/release/challenge', {}),
    releaseShare: (body: ReleaseShareRequest) => call<EmptyResponse>('POST', '/v1/release/share', body),
    releaseLog: () => call<ReleaseLogResponse>('GET', '/v1/release/log'),
  };
}

export type TeeClient = ReturnType<typeof createTeeClient>;
