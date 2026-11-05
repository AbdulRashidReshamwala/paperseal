import 'reflect-metadata';

import { verifyTeeSignature } from '@paperseal/crypto';
import { encodeMessage, equalBytes, NotImplementedError } from '@paperseal/protocol';
import { BasicConstraintsExtension, X509Certificate } from '@peculiar/x509';
import { compactVerify, decodeProtectedHeader, errors as joseErrors, importX509 } from 'jose';

import { GOOGLE_ROOT_DER_BASE64 } from './google-root';
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

/** The token is an OIDC token, which Google signs with keys from its JWKS, not with the PKI chain. */
export class TokenSignatureNotImplementedError extends NotImplementedError {
  constructor() {
    super(
      'OIDC attestation token signature check',
      "only PKI tokens (an x5c chain to Google's root) are verified; OIDC tokens need Google's JWKS",
    );
    this.name = 'TokenSignatureNotImplementedError';
  }
}

/** The token is well formed, but its signature or certificate chain does not check out. */
export class TokenSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenSignatureError';
  }
}

export type SignatureResult =
  | { ok: true }
  | {
      ok: false;
      error: TokenSignatureNotImplementedError | TokenSignatureError | MalformedTokenError;
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

const bytesFromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const googleRoot = bytesFromBase64(GOOGLE_ROOT_DER_BASE64);

function derToPem(der: ArrayBuffer): string {
  const body = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----`;
}

/**
 * Verifies a PKI token the way Google documents and tee/ does: the header's `x5c` is exactly
 * leaf, intermediate and root, the root is byte-for-byte `root`, each certificate is valid as
 * of the token's `iat` and signed by the next, the issuers are CAs, and the leaf's RSA key
 * verifies the RS256 signature. `exp` is not checked here, because a published token is a
 * record. `root` defaults to Google's pinned root, and only tests pass another.
 */
export async function verifyPkiToken(
  token: string,
  root: Uint8Array = googleRoot,
): Promise<SignatureResult> {
  try {
    const claims = decodeToken(token);
    const header = decodeProtectedHeader(token);
    if (!Array.isArray(header.x5c)) {
      // An OIDC token names a `kid` and carries no chain. Its keys come from Google's JWKS.
      return {
        ok: false,
        error: header.kid !== undefined ? new TokenSignatureNotImplementedError() : new TokenSignatureError('token has no x5c chain'),
      };
    }
    if (header.alg !== 'RS256') {
      return { ok: false, error: new TokenSignatureError(`token alg ${String(header.alg)}, want RS256`) };
    }
    if (typeof claims.iat !== 'number' || !(claims.iat > 0)) {
      return { ok: false, error: new TokenSignatureError('token has no iat') };
    }
    if (header.x5c.length !== 3) {
      return { ok: false, error: new TokenSignatureError(`x5c has ${String(header.x5c.length)} certificates, want 3`) };
    }
    const [leaf, intermediate, top] = header.x5c.map((cert) => new X509Certificate(cert)) as [
      X509Certificate,
      X509Certificate,
      X509Certificate,
    ];
    if (!equalBytes(new Uint8Array(top.rawData), root)) {
      return { ok: false, error: new TokenSignatureError("token chain does not end at Google's root") };
    }
    const at = new Date(claims.iat * 1000);
    const links: [string, X509Certificate, X509Certificate][] = [
      ['leaf', leaf, intermediate],
      ['intermediate', intermediate, top],
      ['root', top, top],
    ];
    for (const [name, cert, issuer] of links) {
      if (cert.issuer !== issuer.subject) {
        return { ok: false, error: new TokenSignatureError(`the ${name} certificate was not issued by the next one`) };
      }
      if (!(await cert.verify({ publicKey: issuer, date: at }))) {
        return {
          ok: false,
          error: new TokenSignatureError(`the ${name} certificate is not valid as of the token's iat`),
        };
      }
    }
    for (const [name, ca] of [['intermediate', intermediate], ['root', top]] as const) {
      if (!ca.getExtension(BasicConstraintsExtension)?.ca) {
        return { ok: false, error: new TokenSignatureError(`the ${name} certificate is not a CA`) };
      }
    }
    const key = await importX509(derToPem(leaf.rawData), 'RS256');
    await compactVerify(token, key, { algorithms: ['RS256'] });
    return { ok: true };
  } catch (error) {
    if (error instanceof MalformedTokenError) return { ok: false, error };
    return {
      ok: false,
      error: new TokenSignatureError(
        error instanceof joseErrors.JWSSignatureVerificationFailed
          ? 'token signature does not verify'
          : `token cannot be verified: ${(error as Error).message}`,
      ),
    };
  }
}

/** Checks a token's signature against Google's pinned root. */
export function verifyTokenSignature(token: string): Promise<SignatureResult> {
  return verifyPkiToken(token);
}

export interface InstanceKeyResult {
  ok: boolean;
  error?: string;
}

/**
 * Checks `instanceKeySignature`: the signing key (`instancePublicKey`, which `eat_nonce` binds)
 * signed the `instanceKey` message over the exam and `encryptionPublicKey`. Apps must pass
 * before encrypting anything to the encryption key.
 */
export async function verifyInstanceKey(expected: ExpectedClaims): Promise<InstanceKeyResult> {
  try {
    const message = encodeMessage('instanceKey', {
      examId: expected.examId,
      encryptionPublicKey: expected.encryptionPublicKey,
    });
    const ok = await verifyTeeSignature(expected.instancePublicKey, expected.instanceKeySignature, message);
    return ok ? { ok } : { ok, error: 'instanceKeySignature does not verify under instancePublicKey' };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export interface TokenVerdict {
  /** True only when the token signature, the instance key signature and every claim pass. */
  trusted: boolean;
  signature: SignatureResult;
  instanceKey: InstanceKeyResult;
  claims: ClaimCheck[];
}

/**
 * Checks the token and the keys it vouches for: the token signature, every claim (including
 * `eat_nonce` binding `instancePublicKey` and the exam), and `instanceKeySignature`.
 */
export async function checkToken(
  token: string,
  expected: ExpectedClaims,
  options: CheckOptions,
): Promise<TokenVerdict> {
  const claims = checkClaims(decodeToken(token), expected, options);
  const signature = await verifyPkiToken(token, options.trustedRoot);
  const instanceKey = await verifyInstanceKey(expected);
  return {
    trusted: signature.ok && instanceKey.ok && claims.every((claim) => claim.ok),
    signature,
    instanceKey,
    claims,
  };
}
