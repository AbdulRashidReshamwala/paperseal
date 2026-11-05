// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Connected } from '@paperseal/ui';

import { TEE_STATUS_POLL_MS } from './TeeStatus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('polling', () => {
  it('Connected reads again after pollMs and stops on unmount', async () => {
    vi.useFakeTimers();
    let n = 0;
    const load = vi.fn(() => Promise.resolve(++n));
    const { unmount } = render(
      <Connected title="TEE" notConnected="no" load={load} pollMs={TEE_STATUS_POLL_MS}>
        {(value) => `read ${String(value)}`}
      </Connected>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('read 1')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEE_STATUS_POLL_MS);
    });
    expect(screen.getByText('read 2')).toBeTruthy();
    unmount();
    await vi.advanceTimersByTimeAsync(TEE_STATUS_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows a failed poll, then recovers on the next one', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new Error('TEE went away'))
      .mockResolvedValue('back');
    render(
      <Connected title="TEE" notConnected="no" load={load} pollMs={1000}>
        {(value) => value}
      </Connected>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('first')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('TEE went away')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('back')).toBeTruthy();
  });
});
