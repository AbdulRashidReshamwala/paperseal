import type { TokenVerdict } from '@paperseal/attestation';
import type { Hex } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { attestationChecker, describeVerdict, examSettings, verifyTee } from './attest';

const examId: Hex = `0x${'11'.repeat(32)}`;
const address: Hex = `0x${'aa'.repeat(20)}`;
const registry = {
  address,
  getExam: () =>
    Promise.resolve({
      commitHash: `0x${'01'.repeat(20)}` as Hex,
      imageDigest: `0x${'02'.repeat(32)}` as Hex,
      createdAt: 1n,
      createdBlock: 1n,
      settings: {
        examId,
        examStart: 2_000_000_000n,
        delta: 1800n,
        lockRound: 10n,
        unlockRound: 20n,
        endRound: 30n,
        criteriaHash: `0x${'03'.repeat(32)}` as Hex,
        rpcHost: 'rpc.example.org',
      },
    }),
};
const attestation = {
  token: 'not-a-token',
  instancePublicKey: `0x04${'05'.repeat(64)}` as Hex,
  encryptionPublicKey: `0x04${'06'.repeat(64)}` as Hex,
  instanceKeySignature: `0x${'07'.repeat(64)}` as Hex,
};

describe('attestation', () => {
  it('builds the settings from the exam on-chain and the registry in use', async () => {
    const { settings, imageDigest } = await examSettings(registry, examId);
    expect(settings).toMatchObject({ registry: address, chainId: 11155111, unlockRound: '20', delta: 1800 });
    expect(imageDigest).toBe(`0x${'02'.repeat(32)}`);
  });

  it('never trusts a token that is not a real Google-signed token', async () => {
    await expect(verifyTee({ attestation: () => Promise.resolve(attestation) }, { registry, examId })).rejects.toThrow();
    await expect(attestationChecker({ registry, examId })(attestation)).rejects.toThrow();
  });

  it('says what failed', () => {
    const verdict = {
      trusted: false,
      signature: { ok: true },
      instanceKey: { ok: false, error: 'bad' },
      claims: [{ claim: 'dbgstat', ok: false, expected: 'x', actual: 'y' }],
    } as unknown as TokenVerdict;
    expect(describeVerdict(verdict)).toBe('The TEE attestation failed: instance key: bad; dbgstat.');
  });
});
