// @vitest-environment jsdom
import { roles } from '@paperseal/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReleaseContext } from '../../release/flow';
import type { HolderProgress } from '../../release/progress';
import { actions, chain, credential, facts, passkey, progress, status, tee } from '../../release/testkit';
import { KeyholderView } from './KeyholderArea';
import { keyholderStage } from './stage';

afterEach(cleanup);

describe('keyholderStage', () => {
  const unreadableMachine = { value: null, error: 'down', settled: true };
  const cases: [string, Partial<HolderProgress>, string][] = [
    ['build settings are missing', { missing: ['VITE_TEE_URL'] }, 'setup'],
    ['no key is registered here', { credential: null }, 'register'],
    ['no key is registered here and the exam has ended', { credential: null, ended: true }, 'ended'],
    ['no key is registered here and the record has not answered', { credential: null, chain: { value: null, error: null, settled: false } }, 'loading'],
    ['no key is registered here and the record is down', { credential: null, chain: { value: null, error: 'down', settled: true } }, 'register'],
    ['a new invitation is open after the exam has ended', { registering: true, ended: true }, 'ended'],
    ['a new invitation is open before it ends', { registering: true }, 'register'],
    ['the public record has not answered', { chain: { value: null, error: null, settled: false } }, 'loading'],
    ['the public record is down', { chain: { value: null, error: 'down', settled: true } }, 'unreachable'],
    ['the exam is not published', { chain: chain(facts(roles.neutral, { unlockRound: null })) }, 'no-exam'],
    ['the list is not posted', { chain: chain(facts(roles.neutral, { listPosted: false, entry: null })) }, 'awaiting-list'],
    ['this key is not on the list', { chain: chain(facts(roles.neutral, { entry: null })) }, 'not-on-list'],
    ['this key is a centre with no share', { chain: chain(facts(roles.centre)) }, 'not-on-list'],
    ['before unlock', {}, 'waiting'],
    ['the machine is down before unlock', { status: unreadableMachine }, 'waiting'],
    ['unlock has come', { reached: true, status: tee(status('unlock')) }, 'release'],
    ['the clock has passed but the machine lags', { reached: true, status: tee(status('distribute')) }, 'machine-waiting'],
    ['the machine is down at unlock', { reached: true, status: unreadableMachine }, 'machine-unreachable'],
    ['the machine has failed', { status: tee(status('failed')) }, 'machine-failed'],
    ['this key has released, after a reload', { reached: true, status: tee(status('unlock', [passkey.toUpperCase() as `0x${string}`])) }, 'done'],
    ['enough others released first', { reached: true, status: tee(status('released', ['0x01'])) }, 'not-needed'],
  ];

  it.each(cases)('%s', (_name, overrides, expected) => {
    expect(keyholderStage(progress(overrides), false)).toBe(expected);
  });

  it('never offers release before the public clock reaches unlock, whatever the machine says', () => {
    expect(keyholderStage(progress({ reached: false, status: tee(status('unlock')) }), false)).toBe('waiting');
  });

  it('is done as soon as this visit released, before the next read', () => {
    expect(keyholderStage(progress({ reached: true, status: tee(status('unlock')) }), true)).toBe('done');
  });
});

describe('KeyholderView', () => {
  const view = (overrides: Partial<HolderProgress>, justReleased = false) =>
    render(
      <KeyholderView
        progress={progress(overrides)}
        actions={actions()}
        context={{} as ReleaseContext}
        justReleased={justReleased}
        onReleased={vi.fn()}
      />,
    );

  it('waits calmly, with a countdown and nothing to press', () => {
    view({});
    expect(screen.getByRole('heading', { name: 'Nothing to do yet. Your part of the key is safe.' })).toBeTruthy();
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('does not call a share safe before any share exists', () => {
    view({ chain: chain(facts(roles.neutral, { buildPosted: false })) });
    expect(screen.queryByText(/part of the key is safe/)).toBeNull();
  });

  it('shows one action and the live count at unlock', () => {
    view({ reached: true, status: tee(status('unlock', Array.from({ length: 6 }, () => '0x01'))) });
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Release my part of the key']);
    expect(screen.getByText('6 of 8 parts of the key released')).toBeTruthy();
  });

  it('stamps it, says they can close the tab, and keeps the count', () => {
    view({ reached: true, status: tee(status('unlock', [passkey])) }, true);
    expect(screen.getByRole('heading', { name: 'Done. You can close this tab.' })).toBeTruthy();
    expect(screen.getByText('Released').getAttribute('data-press')).toBe('true');
    expect(screen.getByText('1 of 8 parts of the key released')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never tells a key holder they will get the paper', () => {
    view({ reached: true, status: tee(status('unlock', [passkey])) }, true);
    expect(document.body.textContent).toMatch(/reaches exam centres/);
    expect(document.body.textContent).not.toMatch(/you (will )?(receive|see|get) the paper/i);
  });

  it('says who to contact when the sealed machine has failed', () => {
    view({ status: tee(status('failed')) });
    expect(screen.getByRole('heading', { name: 'Paper Seal has stopped' })).toBeTruthy();
    expect(screen.getByText(/Contact your exam board now/)).toBeTruthy();
  });

  it('offers no registration once the exam has ended', () => {
    view({ credential: null, ended: true });
    expect(screen.getByRole('heading', { name: 'This exam has ended' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Register your security key/)).toBeNull();
  });

  it('offers no way to register a second key while waiting for the list', () => {
    view({ chain: chain(facts(roles.neutral, { listPosted: false, entry: null })) });
    expect(screen.getByRole('heading', { name: 'You are registered. Nothing to do yet.' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/ask your exam board for a new invitation link/)).toBeTruthy();
  });

  it('names the person when their key is not on the list', () => {
    view({ chain: chain(facts(roles.neutral, { entry: null })) });
    expect(screen.getByText(new RegExp(credential.owner))).toBeTruthy();
  });
});
