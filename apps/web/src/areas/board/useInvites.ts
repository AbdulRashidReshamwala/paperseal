import type { Hex } from '@paperseal/protocol';
import { useCallback, useState } from 'react';

import { loadInvites, saveInvites, type BoardInvite } from './invites';

/** This exam's invites, read from the board's browser and saved back on every change. */
export function useInvites(examId: Hex | null): { invites: readonly BoardInvite[]; update: (next: readonly BoardInvite[]) => void } {
  const [held, setHeld] = useState<{ examId: Hex | null; invites: readonly BoardInvite[] }>(() => ({
    examId,
    invites: examId ? loadInvites(examId) : [],
  }));
  // Another exam never shows this one's invites.
  const invites = held.examId === examId ? held.invites : examId ? loadInvites(examId) : [];
  const update = useCallback(
    (next: readonly BoardInvite[]) => {
      setHeld({ examId, invites: next });
      if (examId) saveInvites(examId, next);
    },
    [examId],
  );
  return { invites, update };
}
