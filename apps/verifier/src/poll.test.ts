// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withinTime } from './load';
import { MAX_BACKOFF_MS, usePoll } from './poll';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('usePoll', () => {
  it('reads at its pace while the source answers', async () => {
    const load = vi.fn(() => Promise.resolve(1));
    renderHook(() => usePoll(load, 100));
    await wait(1000);
    expect(load).toHaveBeenCalledTimes(11);
  });

  it('asks a failing source less and less often, and keeps the last good read', async () => {
    let up = true;
    const load = vi.fn(() => (up ? Promise.resolve('good') : Promise.reject(new Error('429'))));
    const { result } = renderHook(() => usePoll(load, 100));
    await wait(0);
    up = false;
    load.mockClear();
    // Waits of 100, then 200, 400 and 800 after each failure in a row.
    await wait(100 + 200 + 400 + 800);
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.current).toMatchObject({ state: 'ready', value: 'good', stale: '429' });
  });

  it('goes back to its pace after the source answers again', async () => {
    let up = false;
    const load = vi.fn(() => (up ? Promise.resolve('good') : Promise.reject(new Error('429'))));
    renderHook(() => usePoll(load, 100));
    await wait(100 * 2 + 100 * 4 + 100 * 8);
    up = true;
    await wait(100 * 16);
    load.mockClear();
    await wait(300);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('never waits longer than the limit', async () => {
    const load = vi.fn(() => Promise.reject(new Error('429')));
    renderHook(() => usePoll(load, 60_000));
    await wait(60_000 * 2 + 60_000 * 4);
    load.mockClear();
    await wait(MAX_BACKOFF_MS);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('withinTime', () => {
  it('gives up on a read that never answers', async () => {
    const never = new Promise<number>(() => undefined);
    const outcome = withinTime(never, 1000, 'too slow');
    const seen = expect(outcome).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(1000);
    await seen;
  });

  it('passes on a read that answers in time', async () => {
    await expect(withinTime(Promise.resolve(1), 1000, 'too slow')).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
