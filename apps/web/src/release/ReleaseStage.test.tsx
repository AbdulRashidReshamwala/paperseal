// @vitest-environment jsdom
import { RELEASE_NOT_OPEN_MESSAGE } from '@paperseal/tee-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { finishRelease, prepareRelease, ReleaseAbortedError, type PreparedRelease, type ReleaseContext, type ReleaseStep } from './flow';
import { PREPARED_TTL_MS, ReleaseCount, ReleaseStage } from './ReleaseStage';
import { status } from './testkit';

vi.mock('./flow', async (original) => ({ ...(await original<typeof import('./flow')>()), prepareRelease: vi.fn(), finishRelease: vi.fn() }));

const run = vi.mocked(finishRelease);
const prepare = vi.mocked(prepareRelease);
const context = { examId: '0x01', passkeyPublicKey: '0x02', derivedPublicKey: '0x03' } as unknown as ReleaseContext;
const prepared = (): PreparedRelease => ({ preparedAt: Date.now() }) as PreparedRelease;
const stepsThen = (steps: ReleaseStep[], end: () => Promise<void>) => async (ctx: ReleaseContext) => {
  for (const step of steps) ctx.onStep?.(step);
  await end();
};
const press = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Release my part of the key' }));
};

beforeEach(() => {
  run.mockReset();
  prepare.mockReset();
  prepare.mockImplementation(() => Promise.resolve(prepared()));
  vi.stubGlobal('navigator', { credentials: {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReleaseStage', () => {
  it('offers one action, "Release my part of the key", and no way to skip it', () => {
    render(<ReleaseStage context={context} onReleased={vi.fn()} next="Next." />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Release my part of the key' })).toBeTruthy();
  });

  it('asks for the key only when the flow reaches the key', async () => {
    let finish = () => {};
    run.mockImplementation(async (ctx) => {
      ctx.onStep?.('challenge');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      ctx.onStep?.('release');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    render(<ReleaseStage context={context} onReleased={vi.fn()} next="Next." />);
    press();
    await waitFor(() => {
      expect(screen.getByText('Checking before your security key is used', { selector: 'span:not(.ps-sr)' })).toBeTruthy();
    });
    expect(screen.queryByText('Touch your security key')).toBeNull();
    finish();
    await waitFor(() => {
      expect(screen.getByText('Touch your security key')).toBeTruthy();
    });
    finish();
  });

  it('reports success only after the flow has finished', async () => {
    const onReleased = vi.fn();
    let finish = () => {};
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ReleaseStage context={context} onReleased={onReleased} next="Next." />);
    press();
    await waitFor(() => {
      expect(run).toHaveBeenCalled();
    });
    expect(onReleased).not.toHaveBeenCalled();
    finish();
    await waitFor(() => {
      expect(onReleased).toHaveBeenCalledOnce();
    });
  });

  it('treats a failed touch as a key problem and offers another go', async () => {
    run.mockImplementation(stepsThen(['challenge', 'release'], () => Promise.reject(new DOMException('no', 'NotAllowedError'))));
    render(<ReleaseStage context={context} onReleased={vi.fn()} next="Next." />);
    press();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('No security key answered');
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('never blames the key for a failed check, and says who to contact', async () => {
    prepare.mockImplementation((ctx) => {
      ctx.onStep?.('attest');
      return Promise.reject(new ReleaseAbortedError('attest', 'token claim eat_nonce'));
    });
    const onReleased = vi.fn();
    render(<ReleaseStage context={context} onReleased={onReleased} next="Next." />);
    press();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Your part of the key was not sent' })).toBeTruthy();
    });
    expect(screen.getByText(/could not confirm that this page is talking to the real Paper Seal.*contact your exam board/i)).toBeTruthy();
    expect(screen.getByText('token claim eat_nonce').closest('details')).toBeTruthy();
    expect(onReleased).not.toHaveBeenCalled();
  });

  it('says plainly when Paper Seal has not opened release yet', async () => {
    run.mockImplementation(stepsThen(['challenge'], () => Promise.reject(new ReleaseAbortedError('challenge', RELEASE_NOT_OPEN_MESSAGE))));
    render(<ReleaseStage context={context} onReleased={vi.fn()} next="Next." />);
    press();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Release is not open yet' })).toBeTruthy();
    });
  });

  it('runs the checks that need no key as soon as the page is ready, and the press goes to the touch', async () => {
    run.mockResolvedValue();
    const onReleased = vi.fn();
    render(<ReleaseStage context={context} onReleased={onReleased} next="Next." />);
    await waitFor(() => {
      expect(prepare).toHaveBeenCalledOnce();
    });
    // Nothing needing the key has started: no touch without a press.
    expect(run).not.toHaveBeenCalled();
    press();
    await waitFor(() => {
      expect(onReleased).toHaveBeenCalledOnce();
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('runs the checks again at the press when the early ones are too old', async () => {
    run.mockResolvedValue();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      render(<ReleaseStage context={context} onReleased={vi.fn()} next="Next." />);
      await vi.waitFor(() => {
        expect(prepare).toHaveBeenCalledOnce();
      });
      vi.setSystemTime(Date.now() + PREPARED_TTL_MS + 1000);
      press();
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledOnce();
      });
      expect(prepare).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the checks at the press when the early ones failed, and says nothing about the early failure', async () => {
    prepare.mockRejectedValueOnce(new Error('offline'));
    run.mockResolvedValue();
    render(<ReleaseStage context={context} onReleased={vi.fn()} next="Next." />);
    await waitFor(() => {
      expect(prepare).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    press();
    await waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
    });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('tells the page when it shows a failure, so the seal can go', async () => {
    prepare.mockImplementation((ctx) => {
      ctx.onStep?.('attest');
      return Promise.reject(new ReleaseAbortedError('attest', 'x'));
    });
    const onRefused = vi.fn();
    render(<ReleaseStage context={context} onReleased={vi.fn()} onRefused={onRefused} next="Next." />);
    press();
    await screen.findByRole('heading', { name: 'Your part of the key was not sent' });
    expect(onRefused).toHaveBeenLastCalledWith(true);
  });

  it('shows no working action without a context', () => {
    render(<ReleaseStage context={null} onReleased={vi.fn()} next="Next." />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/contact your exam board/)).toBeTruthy();
  });
});

describe('ReleaseCount', () => {
  it('shows the live count', () => {
    render(<ReleaseCount status={status('unlock', Array.from({ length: 6 }, () => '0x01'))} />);
    expect(screen.getByRole('status').textContent).toBe('6 of 8 parts of the key released');
  });

  it('does not guess a count it could not read', () => {
    render(<ReleaseCount status={null} />);
    expect(screen.queryByText(/of 8/)).toBeNull();
    expect(screen.getByText(/can't see how many/)).toBeTruthy();
  });
});
