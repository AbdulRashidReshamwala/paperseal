import { readFileSync } from 'node:fs';

import { attestationNonce, fromHex, startupArgs, type ExamSettings, type Hex } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import {
  checkClaims,
  claimNames,
  decodeToken,
  MalformedTokenError,
  settingsBindingError,
  type CheckOptions,
  type ClaimCheck,
  type ClaimName,
  type ExpectedClaims,
} from './index';

const now = 1_800_000_000;
const instancePublicKey = new Uint8Array(65).fill(4);
const examId = new Uint8Array(32).fill(9);
const imageDigest: Hex = `0x${'ab'.repeat(32)}`;

const registry: Hex = '0x00000000000000000000000000000000000000aa';
const settings: ExamSettings = {
  examId: `0x${'09'.repeat(32)}`,
  examStart: 1_900_000_000,
  delta: 3600,
  lockRound: '100',
  unlockRound: '200',
  endRound: '300',
  criteriaHash: `0x${'33'.repeat(32)}`,
  rpcHost: 'rpc.example.org',
  registry,
  chainId: 11155111,
};

const expected: ExpectedClaims = {
  instancePublicKey,
  encryptionPublicKey: new Uint8Array(65).fill(4),
  instanceKeySignature: new Uint8Array(64),
  examId,
  imageDigest,
  approvedHwModels: ['GCP_AMD_SEV', 'GCP_INTEL_TDX'],
  settings,
  registry,
  storageBucket: 'bucket-1',
};

const live: CheckOptions = { mode: 'live', now };

function goodClaims(): Record<string, unknown> {
  return {
    iss: 'https://confidentialcomputing.googleapis.com',
    aud: 'paperseal',
    iat: now - 10,
    exp: now + 3600,
    swname: 'CONFIDENTIAL_SPACE',
    dbgstat: 'disabled-since-boot',
    hwmodel: 'GCP_AMD_SEV',
    secboot: true,
    eat_nonce: attestationNonce(instancePublicKey, examId),
    submods: {
      confidential_space: {
        support_attributes: ['LATEST', 'STABLE', 'USABLE'],
      },
      container: {
        image_digest: `sha256:${'ab'.repeat(32)}`,
        args: ['/tee', ...startupArgs(settings)],
        cmd_override: startupArgs(settings),
        env: { PATH: '/bin', STORAGE_BUCKET: 'bucket-1' },
        env_override: { STORAGE_BUCKET: 'bucket-1' },
      },
    },
  };
}

type Mutator = (claims: Record<string, any>) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const failing = (mutate: Mutator, options: CheckOptions = live) => {
  const claims = goodClaims();
  mutate(claims);
  return checkClaims(claims, expected, options)
    .filter((check) => !check.ok)
    .map((check) => check.claim);
};

describe('checkClaims', () => {
  it('passes a good token, one result per claim', () => {
    const checks = checkClaims(goodClaims(), expected, live);
    expect(checks.map((check) => check.claim)).toEqual([...claimNames]);
    expect(checks.filter((check) => !check.ok).map((check) => check.claim)).toEqual([]);
  });

  const cases: [string, ClaimName, Mutator][] = [
    ['wrong issuer', 'iss', (c) => (c.iss = 'https://accounts.google.com')],
    ['wrong audience', 'aud', (c) => (c.aud = 'other')],
    ['issued in the future', 'iat', (c) => (c.iat = now + 3000)],
    ['expired', 'exp', (c) => ((c.iat = now - 100), (c.exp = now - 61))],
    ['wrong software', 'swname', (c) => (c.swname = 'GCE')],
    ['debug image', 'dbgstat', (c) => (c.dbgstat = 'enabled')],
    ['unapproved hardware', 'hwmodel', (c) => (c.hwmodel = 'GCP_SHIELDED_VM')],
    ['secure boot off', 'secboot', (c) => (c.secboot = false)],
    ['secure boot as a string', 'secboot', (c) => (c.secboot = 'true')],
    [
      'not STABLE',
      'support_attributes',
      (c) => (c.submods.confidential_space.support_attributes = ['USABLE']),
    ],
    [
      'wrong digest',
      'image_digest',
      (c) => (c.submods.container.image_digest = `sha256:${'cd'.repeat(32)}`),
    ],
    ['wrong override', 'cmd_override', (c) => (c.submods.container.cmd_override = [])],
    ['changed env_override', 'env_override', (c) => (c.submods.container.env_override = { STORAGE_BUCKET: 'other' })],
    ['extra env_override', 'env_override', (c) => (c.submods.container.env_override.EXTRA = '1')],
    ['missing entrypoint in args', 'args', (c) => c.submods.container.args.shift()],
    ['wrong nonce', 'eat_nonce', (c) => (c.eat_nonce = 'ff'.repeat(32))],
    ['several nonces', 'eat_nonce', (c) => (c.eat_nonce = [c.eat_nonce, 'other'])],
  ];

  it.each(cases)('fails only %s', (_, claim, mutate) => {
    expect(failing(mutate)).toEqual([claim]);
  });

  it.each(
    claimNames.filter(
      (name) =>
        !['support_attributes', 'image_digest', 'args', 'cmd_override', 'env_override'].includes(name),
    ),
  )('fails when %s is missing', (claim) => {
    expect(
      failing((c) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete c[claim];
      }),
    ).toContain(claim);
  });

  it('fails every submods claim when submods is missing, without throwing', () => {
    expect(failing((c) => delete c.submods)).toEqual([
      'support_attributes',
      'image_digest',
      'args',
      'cmd_override',
      'env_override',
    ]);
  });

  it('accepts a single nonce in an array', () => {
    expect(failing((c) => (c.eat_nonce = [c.eat_nonce]))).toEqual([]);
  });

  it('allows small clock skew on live checks', () => {
    expect(failing((c) => (c.iat = now + 30))).toEqual([]);
    expect(failing((c) => ((c.iat = now - 100), (c.exp = now - 30)))).toEqual([]);
  });

  it('treats a published token as a record of when it was issued', () => {
    const published: CheckOptions = {
      mode: 'published',
      now: now + 10_000_000,
    };
    expect(failing(() => undefined, published)).toEqual([]);
    expect(failing((c) => (c.exp = c.iat), published)).toEqual(['iat', 'exp']);
  });

  it('approves no hardware with an empty list', () => {
    const checks = checkClaims(goodClaims(), { ...expected, approvedHwModels: [] }, live);
    expect(checks.filter((check) => !check.ok).map((check) => check.claim)).toEqual(['hwmodel']);
  });

  it('binds the nonce to the instance key and exam', () => {
    const other = { ...expected, examId: new Uint8Array(32).fill(1) };
    const checks = checkClaims(goodClaims(), other, live);
    expect(checks.filter((check) => !check.ok).map((check) => check.claim)).toEqual(['eat_nonce']);
  });
});

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenFor = (claims: unknown) => `${encode({ alg: 'RS256' })}.${encode(claims)}.c2ln`;

describe('args', () => {
  const argsCheck = (exp: ExpectedClaims) =>
    checkClaims(goodClaims(), exp, live).filter((c) => c.claim === 'args')[0] as ClaimCheck;

  it('passes when the token args are /tee then startupArgs(settings)', () => {
    expect(argsCheck(expected).ok).toBe(true);
  });

  it('rejects settings naming a different registry', () => {
    const other: Hex = '0x00000000000000000000000000000000000000bb';
    expect(settingsBindingError({ ...settings, registry: other }, registry)).toContain('registry');
    // Even a TEE whose args match its own settings fails when they name another registry.
    const check = argsCheck({ ...expected, settings: { ...settings, registry: other } });
    expect(check.ok).toBe(false);
    expect(check.note).toContain('registry');
  });

  it('compares the registry without regard to case', () => {
    const upper = `0x${registry.slice(2).toUpperCase()}` as Hex;
    expect(settingsBindingError({ ...settings, registry: upper }, registry)).toBeNull();
  });

  it('rejects settings for a different chain', () => {
    expect(settingsBindingError({ ...settings, chainId: 1 }, registry)).toContain('chainId');
    expect(argsCheck({ ...expected, settings: { ...settings, chainId: 1 } }).ok).toBe(false);
  });
});

describe('token', () => {
  it('decodes a JWT payload', () => {
    expect(decodeToken(tokenFor({ iss: 'x' }))).toEqual({ iss: 'x' });
  });

  it.each(['', 'a.b', 'a.!!!.c', `a.${encode([1])}.c`])('rejects malformed token %j', (token) => {
    expect(() => decodeToken(token)).toThrow(MalformedTokenError);
  });
});

describe('real Confidential Space token claims', () => {
  const real = JSON.parse(
    readFileSync(new URL('../../../spec/fixtures/confidential-space-claims.json', import.meta.url), 'utf8'),
  ) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const fromOverride = (override: string[]): ExamSettings => {
    const arg = (name: string) => (override.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=').slice(1).join('=');
    return {
      examId: arg('exam-id') as Hex,
      examStart: Number(arg('exam-start')),
      delta: Number(arg('delta')),
      lockRound: arg('lock-round'),
      unlockRound: arg('unlock-round'),
      endRound: arg('end-round'),
      criteriaHash: arg('criteria-hash') as Hex,
      rpcHost: arg('rpc-host'),
      registry: arg('registry') as Hex,
      chainId: Number(arg('chain-id')),
    };
  };

  const realSettings = fromOverride(real.submods.container.cmd_override as string[]);
  const realExpected: ExpectedClaims = {
    instancePublicKey: new Uint8Array(65).fill(4),
    encryptionPublicKey: new Uint8Array(),
    instanceKeySignature: new Uint8Array(),
    examId: fromHex(realSettings.examId),
    imageDigest: `0x${(real.submods.container.image_digest as string).slice('sha256:'.length)}` as Hex,
    approvedHwModels: ['GCP_AMD_SEV'],
    settings: realSettings,
    registry: realSettings.registry,
    storageBucket: 'paperseal-demo-paperseal-exams',
  };
  const published: CheckOptions = { mode: 'published', now: real.iat as number };

  // The fixture's nonce belongs to a key that is not in the fixture, so it is not under test here.
  const failures = (claims: Record<string, unknown>, expectedClaims = realExpected) =>
    checkClaims(claims, expectedClaims, published)
      .filter((c) => !c.ok && c.claim !== 'eat_nonce')
      .map((c) => c.claim);
  const copy = () => structuredClone(real);

  it('passes with expected values built from the token own cmd_override', () => {
    expect(failures(copy())).toEqual([]);
  });

  it('fails when one startup argument is changed', () => {
    const claims = copy();
    claims.submods.container.cmd_override[2] = '--delta=601';
    claims.submods.container.args[3] = '--delta=601';
    expect(failures(claims)).toEqual(['args', 'cmd_override']);
    const onlyArgs = copy();
    onlyArgs.submods.container.args[3] = '--delta=601';
    expect(failures(onlyArgs)).toEqual(['args']);
  });

  it('fails when env_override has an extra key', () => {
    const claims = copy();
    claims.submods.container.env_override.EXTRA = '1';
    expect(failures(claims)).toEqual(['env_override']);
  });

  it('ignores env, which holds base image variables', () => {
    const claims = copy();
    claims.submods.container.env.EXTRA = '1';
    expect(failures(claims)).toEqual([]);
  });

  it('fails when dbgstat is not disabled-since-boot', () => {
    const claims = copy();
    claims.dbgstat = 'enabled';
    expect(failures(claims)).toEqual(['dbgstat']);
  });
});
