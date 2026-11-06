// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RouteFade } from './RouteFade';

const animate = vi.fn(() => ({ cancel: vi.fn() }));
const reduced = vi.fn(() => false);

function Draft() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  return (
    <>
      <input
        aria-label="Name"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          void navigate('/board/draft/1', { replace: true });
        }}
      />
      <button
        onClick={() => {
          void navigate('/board');
        }}
      >
        Push
      </button>
      <button
        onClick={() => {
          void navigate('?exam=1');
        }}
      >
        Query
      </button>
    </>
  );
}

function open(path = '/board/new') {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <RouteFade>
          <Routes>
            <Route path="/board" element={<p>Home</p>} />
            <Route path="/board/new" element={<Draft />} />
            <Route path="/board/draft/:id" element={<Draft />} />
          </Routes>
        </RouteFade>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('RouteFade', () => {
  beforeEach(() => {
    animate.mockClear();
    reduced.mockReturnValue(false);
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return reduced();
      },
    }));
    Element.prototype.animate = animate as unknown as Element['animate'];
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('fades a page in when it first shows, and when the path changes', async () => {
    open();
    expect(animate).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Push' }));
      await Promise.resolve();
    });
    screen.getByText('Home');
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it('leaves a replace alone, and the input keeps its text and focus', async () => {
    open();
    animate.mockClear();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    input.focus();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'A' } });
      await Promise.resolve();
    });
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('A');
    expect(animate).not.toHaveBeenCalled();
  });

  it('leaves a change to the query alone', async () => {
    open();
    animate.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Query' }));
      await Promise.resolve();
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it('does not move when the reader asks for reduced motion', () => {
    reduced.mockReturnValue(true);
    open();
    expect(animate).not.toHaveBeenCalled();
  });
});
