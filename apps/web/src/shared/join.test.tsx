// @vitest-environment jsdom
import { encodeInviteFragment, type Hex, type Invite } from '@paperseal/protocol';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCurrentExamId } from './currentExam';
import { clearHeldInvites, heldInvite } from './invite';
import Join from './Join';

const examId: Hex = `0x${'12'.repeat(32)}`;
const secret = `0x${'c9'.repeat(32)}` as Hex;
const keyholder: Invite = { examId, role: 'keyholder', owner: 'asha.eth', inviteSecret: secret };

/** Shows where the router is, so a test can see what the address bar would hold. */
function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

function open(fragment: string) {
  return render(
    <MemoryRouter initialEntries={[fragment.slice(1)]}>
      <Routes>
        <Route path="/join" element={<Join />} />
        <Route path="/keyholder" element={<p>Key holder page</p>} />
        <Route path="/centre" element={<p>Centre page</p>} />
        <Route path="/setter" element={<p>Setter page</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  clearHeldInvites();
});
afterEach(cleanup);

describe('an invitation link', () => {
  it('is read once, held in memory, cleared from the address, and opens the role page', async () => {
    open(encodeInviteFragment(keyholder));
    await screen.findByText('Key holder page');
    expect(heldInvite('keyholder')).toEqual(keyholder);
    // The secret is no longer in the address, and nothing was written to storage.
    expect(screen.getByTestId('where').textContent).toBe('/keyholder');
    expect(JSON.stringify(localStorage)).not.toContain(secret.slice(2));
    expect(getCurrentExamId()).toBe(examId);
  });

  it.each([
    ['setter', { examId, role: 'setter', inviteSecret: secret }, 'Setter page'],
    ['centre', { examId, role: 'centre', owner: 'north.centres.maths-board.eth', inviteSecret: secret }, 'Centre page'],
  ] as const)('opens the %s page', async (role, invite, page) => {
    open(encodeInviteFragment(invite));
    await screen.findByText(page);
    expect(heldInvite(role)).toEqual(invite);
  });

  it('explains plainly, holds nothing and clears the address when the link is damaged', async () => {
    open(encodeInviteFragment(keyholder).replace(/&secret=[^&]*/, '&secret=0x1234'));
    expect(await screen.findByRole('heading', { name: 'This invitation link doesn’t work' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/join');
    });
    expect(heldInvite('keyholder')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/ask your exam board to send it again/)).toBeTruthy();
  });

  it('explains instead of showing a form when opened with no invite at all', () => {
    open('#/join');
    expect(screen.getByRole('heading', { name: 'Open your invitation link' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
