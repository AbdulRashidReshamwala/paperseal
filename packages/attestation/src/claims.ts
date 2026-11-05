import {
  attestation as spec,
  attestationNonce,
  chain,
  fromHex,
  startupArgs,
  type ExamSettings,
  type Hex,
} from '@paperseal/protocol';

/** Decoded token payload. Treated as untrusted until every check passes. */
export type DecodedClaims = Readonly<Record<string, unknown>>;

/**
 * Checks the two settings that bind the TEE to the app's own chain: `registry`
 * must be the contract address the app is using and `chainId` the chain from
 * constants. Returns a reason on mismatch, or null.
 */
export function settingsBindingError(settings: ExamSettings, registry: Hex): string | null {
  if (settings.registry.toLowerCase() !== registry.toLowerCase()) {
    return `registry ${settings.registry} is not the contract in use, ${registry}`;
  }
  if (settings.chainId !== chain.chainId) {
    return `chainId ${settings.chainId} is not ${chain.chainId}`;
  }
  return null;
}

export interface ExpectedClaims {
  /** The instance key the TEE presented, and the exam it claims to serve. */
  instancePublicKey: Uint8Array;
  /** The key the TEE says opens HPKE messages, and its signature over the `instanceKey` message. */
  encryptionPublicKey: Uint8Array;
  instanceKeySignature: Uint8Array;
  examId: Uint8Array;
  /** `imageDigest` from ExamRegistry: raw bytes32, without `sha256:`. */
  imageDigest: Hex;
  /** Approved `hwmodel` values. An empty list approves nothing. */
  approvedHwModels: readonly string[];
  /** The on-chain exam settings, with the registry and chain the TEE was given. */
  settings: ExamSettings;
  /** The `ExamRegistry` address this app is using, not one read from the token. */
  registry: Hex;
  cmdOverride: readonly string[];
  env: Readonly<Record<string, string>>;
}

export interface CheckOptions {
  /** Live checks enforce the validity window. Published tokens are a historical record. */
  mode: 'live' | 'published';
  /** Unix seconds. */
  now: number;
  /** Tolerated clock difference for live checks. */
  skewSeconds?: number;
  /** A DER root to trust in place of Google's pinned one. Tests only. */
  trustedRoot?: Uint8Array;
}

export const claimNames = [
  'iss',
  'aud',
  'iat',
  'exp',
  'swname',
  'dbgstat',
  'hwmodel',
  'secboot',
  'support_attributes',
  'image_digest',
  'args',
  'cmd_override',
  'env',
  'eat_nonce',
] as const;
export type ClaimName = (typeof claimNames)[number];

export interface ClaimCheck {
  claim: ClaimName;
  ok: boolean;
  expected: string;
  actual: unknown;
  /** Why a check failed when `expected` can't say, such as an unfinished check. */
  note?: string;
}

const DEFAULT_SKEW_SECONDS = 60;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function argsCheck(actual: unknown, expected: ExpectedClaims): ClaimCheck {
  const mismatch = settingsBindingError(expected.settings, expected.registry);
  const args = startupArgs(expected.settings);
  const wanted = JSON.stringify(args);
  if (mismatch) return { claim: 'args', ok: false, expected: wanted, actual, note: mismatch };
  return { claim: 'args', ok: sameStrings(actual, args), expected: wanted, actual };
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((item, i) => item === expected[i])
  );
}

function sameEnv(actual: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
  const entries = Object.entries(actual);
  return (
    entries.length === Object.keys(expected).length &&
    entries.every(([key, value]) => expected[key] === value)
  );
}

/** Google allows several nonces, but a Paper Seal token carries exactly one. */
function singleNonce(claim: unknown): unknown {
  return Array.isArray(claim) && claim.length === 1 ? (claim[0] as unknown) : claim;
}

/**
 * The README's token claim table as a pure function. Returns one result per
 * claim, for the verifier page to show. The signature is checked separately.
 */
export function checkClaims(
  claims: DecodedClaims,
  expected: ExpectedClaims,
  options: CheckOptions,
): ClaimCheck[] {
  const submods = record(claims.submods);
  const space = record(submods.confidential_space);
  const container = record(submods.container);
  const skew = options.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  const { iat, exp } = claims;
  const live = options.mode === 'live';
  const validTimes = typeof iat === 'number' && typeof exp === 'number' && iat < exp;

  const digest = `sha256:${expected.imageDigest.slice(2)}`;
  // Validates the expected bytes too, so a bad on-chain value can't match by accident.
  fromHex(expected.imageDigest);
  const nonce = attestationNonce(expected.instancePublicKey, expected.examId);

  const check = (claim: ClaimName, actual: unknown, ok: boolean, wanted: string): ClaimCheck => ({
    claim,
    ok,
    expected: wanted,
    actual,
  });
  const equal = (claim: ClaimName, actual: unknown, wanted: string | boolean) =>
    check(claim, actual, actual === wanted, String(wanted));
  const supportAttributes = space.support_attributes;

  return [
    equal('iss', claims.iss, spec.issuer),
    equal('aud', claims.aud, spec.audience),
    check(
      'iat',
      iat,
      validTimes && (!live || iat <= options.now + skew),
      live ? 'issued by now' : 'a time before exp',
    ),
    check(
      'exp',
      exp,
      validTimes && (!live || exp > options.now - skew),
      live ? 'not expired' : 'a time after iat',
    ),
    equal('swname', claims.swname, spec.swname),
    equal('dbgstat', claims.dbgstat, spec.dbgstat),
    check(
      'hwmodel',
      claims.hwmodel,
      typeof claims.hwmodel === 'string' && expected.approvedHwModels.includes(claims.hwmodel),
      `one of: ${expected.approvedHwModels.join(', ') || 'none approved'}`,
    ),
    equal('secboot', claims.secboot, true),
    check(
      'support_attributes',
      supportAttributes,
      Array.isArray(supportAttributes) && supportAttributes.includes(spec.supportAttribute),
      `includes ${spec.supportAttribute}`,
    ),
    equal('image_digest', container.image_digest, digest),
    argsCheck(container.args, expected),
    check(
      'cmd_override',
      container.cmd_override,
      sameStrings(container.cmd_override, expected.cmdOverride),
      JSON.stringify(expected.cmdOverride),
    ),
    check('env', container.env, sameEnv(container.env, expected.env), JSON.stringify(expected.env)),
    equal('eat_nonce', singleNonce(claims.eat_nonce), nonce),
  ];
}
