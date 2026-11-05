export type KeyErrorCode =
  | 'synced_passkey'
  | 'prf_unavailable'
  | 'ceremony_failed'
  | 'unsupported_key'
  | 'malformed_authenticator_data';

export class KeyError extends Error {
  readonly code: KeyErrorCode;

  constructor(code: KeyErrorCode, message: string) {
    super(message);
    this.name = 'KeyError';
    this.code = code;
  }
}
