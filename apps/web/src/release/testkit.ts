import { roles, type ApprovedListEntry, type Hex } from '@paperseal/protocol';
import type { StatusResponse } from '@paperseal/tee-client';
import { vi } from 'vitest';

import type { StoredCredential } from '../shared/Register';
import type { ChainFacts, HolderProgress, ProgressActions } from './progress';

export const passkey: Hex = `0x04${'aa'.repeat(64)}`;
export const credential: StoredCredential = { owner: 'St Mary’s', role: 'centre', credentialId: '0x01', passkeyPublicKey: passkey };

const entry = (role: number): ApprovedListEntry => ({
  role,
  passkeyPublicKey: new Uint8Array(65).fill(0xaa),
  derivedPublicKey: new Uint8Array(65).fill(0xbb),
  owner: credential.owner,
});

export const facts = (role: number = roles.neutral, overrides: Partial<ChainFacts> = {}): ChainFacts => ({
  unlockRound: 33_700_743,
  endRound: 33_701_000,
  listPosted: true,
  entry: entry(role),
  buildPosted: true,
  ...overrides,
});

export const status = (stage: StatusResponse['stage'], released: Hex[] = [], required = 8): StatusResponse => ({
  stage,
  questionCount: 20,
  release: { released, required },
});

/** A page that has read everything. Each case changes only what it is about. */
export function progress(overrides: Partial<HolderProgress> = {}): HolderProgress {
  return {
    missing: [],
    examId: `0x${'11'.repeat(32)}`,
    credential,
    registering: false,
    chain: { value: facts(), error: null, settled: true },
    status: { value: status('distribute'), error: null, settled: true },
    reached: false,
    ended: false,
    ...overrides,
  };
}

export const chain = (value: ChainFacts) => ({ value, error: null, settled: true });
export const tee = (value: StatusResponse) => ({ value, error: null, settled: true });

export const actions = (): ProgressActions => ({ refresh: vi.fn(), registered: vi.fn() });
