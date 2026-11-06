// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOADING_DEADLINE_MS, LoadingSeal, useLoaded } from './index';

const here = import.meta.dirname;
const web = join(here, '..', '..', '..', 'apps', 'web');
const html = readFileSync(join(web, 'index.html'), 'utf8');

describe('LoadingSeal', () => {
  afterEach(cleanup);

  it('is a status named Loading, with nothing else to read', () => {
    render(<LoadingSeal />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading');
    expect(screen.getByText('Loading').className).toBe('ps-sr');
    expect(status.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(status.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('carries on from the first paint instead of starting again', () => {
    document.body.innerHTML = `<img class="ps-boot-seal" src="http://localhost/seal.svg" /><svg class="ps-boot-ring"></svg>`;
    const seal = document.querySelector<HTMLImageElement>('.ps-boot-seal');
    const ring = document.querySelector('.ps-boot-ring');
    if (!seal || !ring) throw new Error('missing first paint');
    Object.defineProperty(seal, 'currentSrc', { value: seal.src });
    ring.getAnimations = vi.fn(() => [{ currentTime: 900 } as Animation]);

    render(<LoadingSeal />);
    const status = screen.getByRole('status');
    expect(status.style.getPropertyValue('--ps-loading-ran')).toBe('900ms');
    expect(status.querySelector('img')?.getAttribute('src')).toBe('http://localhost/seal.svg');
    document.body.innerHTML = '';
  });
});

describe('the first paint in apps/web/index.html', () => {
  it('sits inside #root, so React replaces it', () => {
    expect(html).toMatch(/<div id="root">\s+<div class="ps-boot" role="status">/);
    expect(html).toContain('<span class="ps-boot-label">Loading</span>');
  });

  it('uses the same seal as the app, from a relative address', () => {
    expect(html).toContain('src="./seal.svg"');
    const copy = readFileSync(join(web, 'public', 'seal.svg'), 'utf8');
    expect(copy).toBe(readFileSync(join(here, 'assets', 'seal.svg'), 'utf8'));
  });

  it('asks for nothing from another host', () => {
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });

  it('honours reduced motion', () => {
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('useLoaded', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the first reads, then stays loaded', () => {
    const { result, rerender } = renderHook(({ done }) => useLoaded(done), { initialProps: { done: false } });
    expect(result.current).toBe(false);
    rerender({ done: true });
    expect(result.current).toBe(true);
    rerender({ done: false });
    expect(result.current).toBe(true);
  });

  it('never holds a page past the deadline when a read is stuck', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLoaded(false));
    act(() => {
      vi.advanceTimersByTime(LOADING_DEADLINE_MS - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });
});
