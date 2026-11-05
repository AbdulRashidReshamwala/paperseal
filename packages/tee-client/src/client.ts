import type { ApiErrorBody } from '@paperseal/protocol';

import type {
  AttestationResponse,
  ChallengeResponse,
  OnboardListRequest,
  OnboardListResponse,
  OutboxResponse,
  QuestionReceipt,
  QuestionRequest,
  RegisterChallengeRequest,
  RegisterRequest,
  ReleaseChallengeRequest,
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

  return {
    attestation: () => call<AttestationResponse>('GET', '/v1/attestation'),
    status: () => call<StatusResponse>('GET', '/v1/status'),
    registerChallenge: (body: RegisterChallengeRequest) =>
      call<ChallengeResponse>('POST', '/v1/register/challenge', body),
    register: (body: RegisterRequest) => call<unknown>('POST', '/v1/register', body),
    onboardList: (body: OnboardListRequest) => call<OnboardListResponse>('POST', '/v1/onboard/list', body),
    question: (body: QuestionRequest) => call<QuestionReceipt>('POST', '/v1/questions', body),
    lock: () => call<unknown>('POST', '/v1/lock', {}),
    build: () => call<unknown>('POST', '/v1/build', {}),
    outbox: () => call<OutboxResponse>('GET', '/v1/outbox'),
    releaseChallenge: (body: ReleaseChallengeRequest) =>
      call<ChallengeResponse>('POST', '/v1/release/challenge', body),
    releaseShare: (body: ReleaseShareRequest) => call<unknown>('POST', '/v1/release/share', body),
    releaseLog: () => call<ReleaseLogResponse>('GET', '/v1/release/log'),
  };
}

export type TeeClient = ReturnType<typeof createTeeClient>;
