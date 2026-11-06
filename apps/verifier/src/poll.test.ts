// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withinTime } from './load';
import { FIRST_RETRY_MS, keepAnswers, MAX_BACKOFF_MS, MAX_RETRY_MS, nextReadMs, READ_GIVE_UP_MS, usePoll } from './poll';

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
    let up = true;
    const load = vi.fn(() => (up ? Promise.resolve('good') : Promise.reject(new Error('429'))));
    renderHook(() => usePoll(load, 100));
    await wait(0);
    up = false;
    await wait(100 + 200 + 400);
    up = true;
    await wait(800);
    load.mockClear();
    await wait(300);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('never waits longer than the limit', async () => {
    let up = true;
    const load = vi.fn(() => (up ? Promise.resolve('good') : Promise.reject(new Error('429'))));
    renderHook(() => usePoll(load, 60_000));
    await wait(0);
    up = false;
    await wait(60_000 * 1 + 60_000 * 2 + 60_000 * 4);
    load.mockClear();
    await wait(MAX_BACKOFF_MS);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps trying a source that has never answered, and recovers by itself', async () => {
    let up = false;
    const load = vi.fn(() => (up ? Promise.resolve('good') : Promise.reject(new Error('429'))));
    const { result } = renderHook(() => usePoll(load, 15_000));
    await wait(0);
    expect(result.current).toEqual({ state: 'error', message: '429' });
    // The first read, then waits of 3, 6, 12 and 24 seconds, then 30 each.
    await wait(3000 + 6000 + 12_000 + 24_000 + 30_000 * 3);
    expect(load).toHaveBeenCalledTimes(8);
    up = true;
    await wait(30_000);
    expect(result.current).toMatchObject({ state: 'ready', value: 'good' });
    load.mockClear();
    await wait(15_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps reading after a read that never ends', async () => {
    const load = vi.fn(() => new Promise<number>(() => undefined));
    const { result } = renderHook(() => usePoll(load, 15_000));
    await wait(READ_GIVE_UP_MS);
    expect(result.current).toMatchObject({ state: 'error' });
    await wait(FIRST_RETRY_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops reading when it goes away, and when the exam changes', async () => {
    const first = vi.fn(() => Promise.reject(new Error('429')));
    const second = vi.fn(() => Promise.resolve(1));
    const { rerender, unmount } = renderHook(({ load }) => usePoll(load, 100), { initialProps: { load: first as () => Promise<number> } });
    await wait(0);
    rerender({ load: second });
    await wait(0);
    first.mockClear();
    second.mockClear();
    await wait(FIRST_RETRY_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    unmount();
    second.mockClear();
    await wait(MAX_RETRY_MS);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('nextReadMs', () => {
  it('keeps its pace while reads answer', () => {
    expect(nextReadMs(15_000, 0, false)).toBe(15_000);
    expect(nextReadMs(15_000, 0, true)).toBe(15_000);
  });

  it('tries a source with nothing to show after 3, 6, 12 and 24 seconds, then every 30', () => {
    expect([1, 2, 3, 4, 5, 6, 40].map((failures) => nextReadMs(15_000, failures, false))).toEqual([3000, 6000, 12_000, 24_000, 30_000, 30_000, 30_000]);
  });

  it('gives a source with a last good read more room, and never more than the limit', () => {
    expect([1, 2, 3, 4, 5, 40].map((failures) => nextReadMs(15_000, failures, true))).toEqual([30_000, 60_000, 120_000, 240_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(nextReadMs(10 * 60_000, 3, true)).toBe(10 * 60_000);
  });
});

describe('keepAnswers', () => {
  it('asks again only for what failed, and for everything after forget', async () => {
    const answers = keepAnswers();
    const good = vi.fn(() => Promise.resolve('good'));
    const bad = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('429')).mockResolvedValue('later');
    await expect(answers.read('good', good)).resolves.toBe('good');
    await expect(answers.read('bad', bad)).rejects.toThrow('429');
    await expect(answers.read('good', good)).resolves.toBe('good');
    await expect(answers.read('bad', bad)).resolves.toBe('later');
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(2);
    answers.forget();
    await answers.read('good', good);
    expect(good).toHaveBeenCalledTimes(2);
  });

  it('shares a read still under way', async () => {
    const answers = keepAnswers();
    const load = vi.fn(() => Promise.resolve(1));
    await Promise.all([answers.read('one', load), answers.read('one', load)]);
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
