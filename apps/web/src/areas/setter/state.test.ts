import { describe, expect, it } from 'vitest';

import type { StoredReceipt } from './receipts';
import { closedCheck, nextTopic, setterScreen, topicProgress, type BuildRead } from './state';

const screenFor = (over: Partial<Parameters<typeof setterScreen>[0]>) =>
  setterScreen({ configured: true, stage: 'submit', statusFailed: false, registered: true, buildPosted: false, ...over });

describe('which screen shows', () => {
  it.each([
    [{ configured: false }, 'not-set-up'],
    [{ stage: null }, 'opening'],
    [{ stage: null, statusFailed: true }, 'unreachable'],
    [{ stage: null, statusFailed: true, buildPosted: true }, 'closed'],
    [{ stage: 'publish', registered: false }, 'not-open'],
    [{ stage: 'publish' }, 'waiting'],
    [{ stage: 'onboard', registered: false }, 'register'],
    [{ stage: 'onboard' }, 'waiting'],
    [{ stage: 'submit', registered: false }, 'register'],
    [{ stage: 'submit' }, 'write'],
    [{ stage: 'lock' }, 'closed'],
    [{ stage: 'released', registered: false }, 'closed'],
    [{ stage: 'failed' }, 'closed'],
  ] as const)('%o shows %s', (over, expected) => {
    expect(screenFor(over)).toBe(expected);
  });
});

describe('topic progress', () => {
  const criteria = {
    maxSetterPercent: 50,
    minBankMultiple: 2,
    topics: [
      { name: 'Mechanics', questions: 2 },
      { name: 'Optics', questions: 1 },
    ],
  };

  it('counts only the hashes given, and sizes each topic from the criteria', () => {
    expect(topicProgress(criteria, ['0x1'], { '0x1': 'Optics', '0x2': 'Optics' })).toEqual([
      { name: 'Mechanics', sealed: 0, needed: 4 },
      { name: 'Optics', sealed: 1, needed: 2 },
    ]);
  });

  it('starts on the topic furthest from its minimum', () => {
    expect(nextTopic(topicProgress(criteria, [], {}))).toBe('Mechanics');
    expect(nextTopic(topicProgress(criteria, ['0x1', '0x2'], { '0x1': 'Mechanics', '0x2': 'Mechanics' }))).toBe('Optics');
  });
});

describe('the closed check', () => {
  const keyA = `0x04${'aa'.repeat(64)}` as const;
  const keyB = `0x04${'bb'.repeat(64)}` as const;
  const receipt: StoredReceipt = { questionHash: '0x11', instancePublicKey: keyA, teeSignature: '0x00', sealedAt: 0 };
  const posted = (key: `0x${string}`): BuildRead => ({ state: 'posted', key });
  const verdict = (over: Partial<Parameters<typeof closedCheck>[0]>) =>
    closedCheck({ receipts: [receipt], checks: { '0x11': true }, canVerify: true, build: posted(keyA), ...over }).status;

  it('passes only with a good signature and the Build key', () => {
    expect(verdict({})).toBe('pass');
  });

  it('never passes while anything is unknown', () => {
    expect(verdict({ checks: {} })).toBe('pending');
    expect(verdict({ build: { state: 'not-posted' } })).toBe('pending');
    expect(verdict({ build: { state: 'unread' } })).toBe('pending');
    expect(verdict({ build: { state: 'failed' } })).toBe('not-checked');
    expect(verdict({ canVerify: false })).toBe('not-checked');
  });

  it('fails on a different key or a bad signature, before anything else', () => {
    expect(verdict({ build: posted(keyB) })).toBe('fail');
    expect(verdict({ build: posted(keyB), checks: {} })).toBe('fail');
    expect(verdict({ checks: { '0x11': false } })).toBe('fail');
    expect(verdict({ checks: { '0x11': false }, build: { state: 'not-posted' } })).toBe('fail');
  });

  it('has nothing to say with no receipts', () => {
    expect(verdict({ receipts: [] })).toBe('none');
  });
});
