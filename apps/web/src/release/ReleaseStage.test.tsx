// @vitest-environment jsdom
import { RELEASE_NOT_OPEN_MESSAGE } from '@paperseal/tee-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReleaseAbortedError, runRelease, type ReleaseContext, type ReleaseStep } from './flow';
import { ReleaseCount, ReleaseStage } from './ReleaseStage';
import { status } from './testkit';

vi.mock('./flow', async (original) => ({ ...(await original<typeof import('./flow')>()), runRelease: vi.fn() }));

const run = vi.mocked(runRelease);
const context = {} as ReleaseContext;
const stepsThen = (steps: ReleaseStep[], end: () => Promise<void>) => async (ctx: ReleaseContext) => {
  for (const step of steps) ctx.onStep?.(step);
  await end();
};
const press = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Release my part of the key' }));
};

beforeEach(() => {
  run.mockReset();
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
      ctx.onStep?.('attest');
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
    expect(onReleased).not.toHaveBeenCalled();
    finish();
    await waitFor(() => {
      expect(onReleased).toHaveBeenCalledOnce();
    });
  });

  it('treats a failed touch as a key problem and offers another go', async () => {
    run.mockImplementation(stepsThen(['attest', 'release'], () => Promise.reject(new DOMException('no', 'NotAllowedError'))));
    render(<ReleaseStage context={context} onReleased={vi.fn()} next="Next." />);
    press();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('No security key answered');
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('never blames the key for a failed check, and says who to contact', async () => {
    run.mockImplementation(stepsThen(['attest'], () => Promise.reject(new ReleaseAbortedError('attest', 'token claim eat_nonce'))));
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
