import { useEffect, useRef, useState } from 'react';

/** A room on this page. Nothing here leaves the browser: handing out is shown, not sent. */
export type RoomStatus = 'not-sent' | 'sending' | 'sent';

export interface Room {
  id: number;
  name: string;
  /** What the person typed, so a half-typed number is never rewritten under their fingers. */
  copies: string;
  status: RoomStatus;
}

export const MAX_ROOMS = 20;
export const MAX_COPIES = 999;
const START_ROOMS = 3;
const START_COPIES = '30';

export function startRooms(): Room[] {
  return Array.from({ length: START_ROOMS }, (_unused, at) => ({ id: at + 1, name: `Room ${String(at + 1)}`, copies: START_COPIES, status: 'not-sent' }));
}

/** A whole number from 1 to 999, or null. */
export function parseCopies(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const count = Number(text.trim());
  return count >= 1 && count <= MAX_COPIES ? count : null;
}

export function copiesProblem(text: string): string | null {
  return parseCopies(text) === null ? `Enter a number from 1 to ${String(MAX_COPIES)}.` : null;
}

export function totalCopies(rooms: Room[]): number {
  return rooms.reduce((sum, room) => sum + (parseCopies(room.copies) ?? 0), 0);
}

export interface HandOut {
  rooms: Room[];
  /** True while at least one room is being marked. */
  sending: boolean;
  /** Every room has been marked as sent. */
  allSent: boolean;
  /** Sending is open when every copies field holds a valid number and something is left to send. */
  canSend: boolean;
  setCopies: (id: number, copies: string) => void;
  addRoom: () => void;
  send: () => void;
}

/**
 * The demonstration behind "Hand out the paper". It only changes what this page shows, one room after another.
 * It holds no paper and calls nothing, so the paper stays in memory where `useOpenPaper` put it.
 */
export function useHandOut(stepMs = 700): HandOut {
  const [rooms, setRooms] = useState<Room[]>(startRooms);
  const [sending, setSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const patch = (id: number, change: Partial<Room>) => {
    setRooms((now) => now.map((room) => (room.id === id ? { ...room, ...change } : room)));
  };

  function next(queue: number[]) {
    const [id, ...rest] = queue;
    if (id === undefined) {
      setSending(false);
      return;
    }
    patch(id, { status: 'sending' });
    timer.current = setTimeout(() => {
      patch(id, { status: 'sent' });
      timer.current = setTimeout(() => {
        next(rest);
      }, 0);
    }, stepMs);
  }

  const valid = rooms.every((room) => parseCopies(room.copies) !== null);
  const pending = rooms.filter((room) => room.status === 'not-sent');
  return {
    rooms,
    sending,
    allSent: rooms.length > 0 && rooms.every((room) => room.status === 'sent'),
    canSend: valid && !sending && pending.length > 0,
    setCopies: (id, copies) => {
      // A changed number has not been sent yet.
      patch(id, { copies, status: 'not-sent' });
    },
    addRoom: () => {
      setRooms((now) => (now.length >= MAX_ROOMS || sending ? now : [...now, { id: Math.max(0, ...now.map((room) => room.id)) + 1, name: `Room ${String(now.length + 1)}`, copies: START_COPIES, status: 'not-sent' }]));
    },
    send: () => {
      if (!valid || sending || pending.length === 0) return;
      setSending(true);
      next(pending.map((room) => room.id));
    },
  };
}
