// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Connected, Countdown, Hash, KeyTouch, PrimaryAction } from './index';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PrimaryAction', () => {
  it('runs when idle', () => {
    const onClick = vi.fn();
    render(<PrimaryAction onClick={onClick}>Seal</PrimaryAction>);
    fireEvent.click(screen.getByRole('button', { name: 'Seal' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(['busy', 'done'] as const)('ignores presses while %s and keeps focus', (status) => {
    const onClick = vi.fn();
    render(
      <PrimaryAction status={status} onClick={onClick}>
        Seal
      </PrimaryAction>,
    );
    const button = screen.getByRole('button');
    button.focus();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  it('does not submit a form while busy', () => {
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { container } = render(
      <form>
        <PrimaryAction type="submit" status="busy">
          Seal
        </PrimaryAction>
      </form>,
    );
    container.querySelector('form')?.addEventListener('submit', onSubmit);
    fireEvent.click(screen.getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('announces its progress', () => {
    render(
      <PrimaryAction status="done" doneLabel="Sealed">
        Seal
      </PrimaryAction>,
    );
    expect(screen.getByRole('status').textContent).toBe('Sealed');
  });
});

describe('KeyTouch', () => {
  it('starts the request from its button', () => {
    const onUse = vi.fn();
    render(<KeyTouch state="idle" onUse={onUse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use security key' }));
    expect(onUse).toHaveBeenCalledOnce();
  });

  it('shows the hint when a browser that has credentials gets no answer', () => {
    vi.stubGlobal('navigator', { credentials: {} });
    render(<KeyTouch state="failed" onUse={vi.fn()} error={new DOMException('no', 'NotAllowedError')} />);
    expect(screen.getByRole('alert').textContent).toContain('No security key answered');
    expect(screen.getByRole('alert').textContent).toContain('pnpm demo');
  });

  it('gives different guidance when the browser has no credentials API', () => {
    vi.stubGlobal('navigator', {});
    render(<KeyTouch state="failed" onUse={vi.fn()} error={new DOMException('no', 'NotAllowedError')} />);
    expect(screen.getByRole('alert').textContent).toContain('can’t reach a security key');
    expect(screen.getByRole('alert').textContent).not.toContain('pnpm demo');
  });

  it('lets a screen explain the failure itself', () => {
    render(<KeyTouch state="failed" onUse={vi.fn()} error={new Error('x')} failureText="This key is not on the list." />);
    expect(screen.getByRole('alert').textContent).toContain('This key is not on the list.');
  });
});

describe('Hash', () => {
  const value = `0x${'ab'.repeat(32)}`;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  it('copies the full value and prints it, for touch screens', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { container } = render(<Hash value={value} />);
    fireEvent.click(screen.getByRole('button'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(value);
    expect(screen.getByRole('status').textContent).toBe('Copied');
    expect(container.querySelector('.ps-hash-full')?.textContent).toBe(value);
  });

  it('never claims a copy that failed, and still shows the value', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    const { container } = render(<Hash value={value} />);
    fireEvent.click(screen.getByRole('button'));
    await flush();
    expect(screen.getByRole('status').textContent).toContain('Copy failed');
    expect(container.querySelector('.ps-hash-full')?.textContent).toBe(value);
  });

  it('copes with no clipboard at all', () => {
    vi.stubGlobal('navigator', {});
    render(<Hash value={value} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('status').textContent).toContain('Copy failed');
  });
});

describe('Countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('ticks, then stops at the moment', () => {
    const start = Date.UTC(2026, 10, 6, 9, 0);
    vi.setSystemTime(start);
    render(<Countdown at={start + 2000} round={5} reached="Open now" />);
    expect(screen.getByRole('timer').textContent).toBe('0:00:02');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('timer').textContent).toBe('0:00:01');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('timer').textContent).toBe('Open now');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Connected', () => {
  it('still reads again after pollMs and shows the new value', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const load = () => {
      reads += 1;
      return Promise.resolve(reads);
    };
    render(
      <Connected title="Status" notConnected="Set it." load={load} pollMs={1000}>
        {(value) => <span>read {value}</span>}
      </Connected>,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('read 1')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText('read 2')).toBeTruthy();
  });
});
