// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePoll } from './usePoll';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('usePoll', () => {
  it('reads nothing without a source', () => {
    const { result } = renderHook(() => usePoll<number>(null, 10));
    expect(result.current).toMatchObject({ value: null, error: null, settled: false });
  });

  it('keeps the last good value through a failed read, and says why', async () => {
    const load = vi.fn<() => Promise<number>>().mockResolvedValueOnce(1).mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => usePoll(load, 1));
    await waitFor(() => {
      expect(result.current.error).toBe('down');
    });
    expect(result.current.value).toBe(1);
  });

  it('stops once the value can no longer change, until asked', async () => {
    const load = vi.fn(() => Promise.resolve(7));
    const finished = () => true;
    const { result } = renderHook(() => usePoll(load, 1, finished));
    await waitFor(() => {
      expect(result.current.value).toBe(7);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(load).toHaveBeenCalledOnce();
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2);
    });
  });
});
