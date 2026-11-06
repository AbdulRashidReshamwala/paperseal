// @vitest-environment jsdom
import { roles, type Paper } from '@paperseal/protocol';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { actions, chain, facts, progress, status, tee } from '../../release/testkit';
import { CentreView } from './CentreArea';
import type { Downloaded } from './download';
import { copiesProblem, MAX_ROOMS, parseCopies, startRooms, totalCopies, useHandOut } from './rooms';
import type { Files } from './useDownload';
import type { OpenPaper } from './useOpenPaper';

vi.mock('../../shared/registry', () => ({ registry: null, envExamId: `0x${'11'.repeat(32)}`, notConnectedToChain: '' }));
vi.mock('../../shared/config', () => ({ storageUrl: 'https://storage.example', teeStorageBucket: '' }));
vi.mock('../../shared/holder', () => ({ listEntryFor: vi.fn(), useHolderCredential: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const paper: Paper = {
  examId: `0x${'11'.repeat(32)}`,
  questions: [{ topic: 'Mechanics', text: 'Which is a unit of force?', options: ['Joule', 'Newton'] }],
};
const ready: Files = { state: 'ready', downloaded: {} as Downloaded };
const opened: OpenPaper = { phase: { name: 'idle' }, paper, start: vi.fn(), prepare: vi.fn() };

describe('copies', () => {
  it('accepts whole numbers from 1 to 999 only', () => {
    expect(parseCopies('30')).toBe(30);
    expect(parseCopies(' 7 ')).toBe(7);
    for (const bad of ['', '0', '-1', '1.5', 'ten', '1000', '1e2']) expect(parseCopies(bad)).toBeNull();
    expect(copiesProblem('x')).toBe('Enter a number from 1 to 999.');
    expect(copiesProblem('5')).toBeNull();
  });

  it('adds up the copies and ignores a field that is not a number', () => {
    const rooms = startRooms();
    expect(totalCopies(rooms)).toBe(90);
    expect(totalCopies(rooms.map((room, at) => (at === 0 ? { ...room, copies: 'x' } : room)).slice(0, 2))).toBe(30);
  });
});

describe('useHandOut', () => {
  it('marks the rooms one after another, and only then is everything sent', () => {
    const { result } = renderHook(() => useHandOut(100));
    expect(result.current.rooms.map((room) => room.status)).toEqual(['not-sent', 'not-sent', 'not-sent']);
    act(() => {
      result.current.send();
    });
    expect(result.current.sending).toBe(true);
    expect(result.current.rooms.map((room) => room.status)).toEqual(['sending', 'not-sent', 'not-sent']);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.rooms.map((room) => room.status)).toEqual(['sent', 'sending', 'not-sent']);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.rooms.every((room) => room.status === 'sent')).toBe(true);
    expect(result.current.sending).toBe(false);
    expect(result.current.allSent).toBe(true);
    expect(result.current.canSend).toBe(false);
  });

  it('will not send while a copies field is not a number', () => {
    const { result } = renderHook(() => useHandOut(10));
    act(() => {
      result.current.setCopies(2, 'lots');
    });
    expect(result.current.canSend).toBe(false);
    act(() => {
      result.current.send();
    });
    expect(result.current.sending).toBe(false);
    expect(result.current.rooms.every((room) => room.status === 'not-sent')).toBe(true);
  });

  it('puts a room back to not sent when its number changes, and sends only what is left', () => {
    const { result } = renderHook(() => useHandOut(10));
    act(() => {
      result.current.send();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      result.current.setCopies(1, '12');
    });
    expect(result.current.rooms.map((room) => room.status)).toEqual(['not-sent', 'sent', 'sent']);
    expect(result.current.canSend).toBe(true);
  });

  it('adds rooms up to a limit', () => {
    const { result } = renderHook(() => useHandOut(10));
    for (let i = 0; i < MAX_ROOMS + 5; i += 1) {
      act(() => {
        result.current.addRoom();
      });
    }
    expect(result.current.rooms).toHaveLength(MAX_ROOMS);
    expect(new Set(result.current.rooms.map((room) => room.id)).size).toBe(MAX_ROOMS);
  });
});

describe('Hand out the paper screen', () => {
  const view = (open: OpenPaper = opened) =>
    render(
      <CentreView
        progress={progress({ chain: chain(facts(roles.centre)), reached: true, status: tee(status('released')) })}
        actions={actions()}
        context={null}
        files={ready}
        retryFiles={vi.fn()}
        open={open}
        justReleased={false}
        onReleased={vi.fn()}
        log={<p>The log</p>}
        handOutStepMs={50}
      />,
    );

  it('follows "The paper is open" with one primary action, and still has Print', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    view();
    expect(screen.getByRole('heading', { name: 'The paper is open' })).toBeTruthy();
    expect(document.querySelectorAll('.ps-primary')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Print the paper' }));
    expect(print).toHaveBeenCalledOnce();
  });

  it('shows the opened paper, the rooms, the demo label and no claim of delivery', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Hand out the paper' }));
    expect(screen.getByRole('heading', { name: 'Hand out the paper' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe('Demo: nothing is sent to any room');
    expect(screen.getByRole('article', { name: 'The examination paper' })).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.getAllByText('Not sent')).toHaveLength(3);
    expect(screen.getByText('3 rooms, 90 copies in all')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/delivered|received/i);
    expect(screen.getByRole('button', { name: 'Print the paper' })).toBeTruthy();
    expect(document.querySelectorAll('.ps-primary')).toHaveLength(1);
  });

  it('sends room by room and says each one is only marked as sent', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Hand out the paper' }));
    fireEvent.change(screen.getByLabelText('Copies for Room 2'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to the rooms' }));
    expect(screen.getByText('Sending')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getAllByText('Marked as sent (demo)')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Sent to all rooms (demo)' })).toBeTruthy();
    expect(screen.getByText('3 rooms, 105 copies in all')).toBeTruthy();
  });

  it('shows a bad number beside its room and keeps sending shut', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Hand out the paper' }));
    fireEvent.change(screen.getByLabelText('Copies for Room 1'), { target: { value: 'abc' } });
    expect(screen.getByText('Enter a number from 1 to 999.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send to the rooms' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a room', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Hand out the paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a room' }));
    expect(screen.getByLabelText('Copies for Room 4')).toBeTruthy();
  });

  it('does not store the paper anywhere', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Hand out the paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send to the rooms' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(set).not.toHaveBeenCalled();
  });
});
