import { NotImplementedError } from '@paperseal/protocol';

import {
  checkClaims,
  type CheckOptions,
  type ClaimCheck,
  type DecodedClaims,
  type ExpectedClaims,
} from './claims';

export class MalformedTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedTokenError';
  }
}

export class TokenSignatureNotImplementedError extends NotImplementedError {
  constructor() {
    super('attestation token signature check', 'PKI token verification against Google roots');
    this.name = 'TokenSignatureNotImplementedError';
  }
}

export type SignatureResult =
  | { ok: true }
  | {
      ok: false;
      error: TokenSignatureNotImplementedError | MalformedTokenError;
    };

/** Reads the payload without verifying anything. */
export function decodeToken(token: string): DecodedClaims {
  const payload = token.split('.')[1];
  if (token.split('.').length !== 3 || !payload) {
    throw new MalformedTokenError('expected a three-part JWT');
  }
  let claims: unknown;
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MalformedTokenError('the JWT payload is not base64url JSON');
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw new MalformedTokenError('the JWT payload is not an object');
  }
  return claims as DecodedClaims;
}

/** Not implemented yet, so it reports failure. It never passes a token it did not check. */
export function verifyTokenSignature(token: string): Promise<SignatureResult> {
  void token;
  return Promise.resolve({
    ok: false,
    error: new TokenSignatureNotImplementedError(),
  });
}

export interface TokenVerdict {
  /** True only when the signature and every claim pass. */
  trusted: boolean;
  signature: SignatureResult;
  claims: ClaimCheck[];
}

export async function checkToken(
  token: string,
  expected: ExpectedClaims,
  options: CheckOptions,
): Promise<TokenVerdict> {
  const claims = checkClaims(decodeToken(token), expected, options);
  const signature = await verifyTokenSignature(token);
  return {
    trusted: signature.ok && claims.every((claim) => claim.ok),
    signature,
    claims,
  };
}
