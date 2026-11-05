// @vitest-environment jsdom
import { fromHex, roles, roundTimeSeconds, setterCommitment, type ApprovedListEntry, type Hex } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EntryRows } from './Onboarding';
import { InviteStep } from './InviteStep';
import { createInvite, exportInvites, InviteError, loadInvites, saveInvites } from './invites';

const examId: Hex = `0x${'11'.repeat(32)}`;
const endRound = 5000;
const afterEnd = () => (roundTimeSeconds(endRound) + 1) * 1000;
const beforeEnd = () => (roundTimeSeconds(endRound) - 100) * 1000;
const counter = (): ((n: number) => Uint8Array) => {
  let next = 1;
  return (n) => new Uint8Array(n).fill(next++);
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe('createInvite', () => {
  it('makes a 32-byte salt and the commitment over the exam, name and salt', () => {
    const invite = createInvite(examId, '  Asha Rao ', [], counter());
    expect(invite.name).toBe('Asha Rao');
    expect(invite.salt).toBe(`0x${'01'.repeat(32)}`);
    expect(invite.commitment).toBe(setterCommitment(fromHex(examId), 'Asha Rao', fromHex(invite.salt)));
  });

  it('draws the salt from crypto.getRandomValues by default', () => {
    const a = createInvite(examId, 'A', []);
    const b = createInvite(examId, 'B', []);
    expect(a.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.salt).not.toBe(b.salt);
  });

  it('rejects an empty or repeated name', () => {
    expect(() => createInvite(examId, '   ', [])).toThrow(InviteError);
    const first = createInvite(examId, 'A', []);
    expect(() => createInvite(examId, 'A', [first])).toThrow('already has an invite');
  });

  it('keeps invites per exam and drops a stored invite whose commitment no longer recomputes', () => {
    const invite = createInvite(examId, 'A', []);
    saveInvites(examId, { invites: [invite], exportedAt: null });
    expect(loadInvites(examId).invites).toEqual([invite]);
    expect(loadInvites(`0x${'22'.repeat(32)}`).invites).toEqual([]);
    saveInvites(examId, { invites: [{ ...invite, name: 'Changed' }], exportedAt: null });
    expect(loadInvites(examId).invites).toEqual([]);
  });

  it('exports name and salt only', () => {
    const invite = createInvite(examId, 'A', []);
    expect(JSON.parse(exportInvites([invite]))).toEqual([{ name: 'A', salt: invite.salt }]);
  });
});

function mount(now: () => number) {
  return render(<InviteStep examId={examId} endRound={endRound} now={now} random={counter()} />);
}

describe('invite step', () => {
  it('shows the commitment and salt to give to the setter, and keeps them in localStorage', () => {
    mount(beforeEnd);
    fireEvent.change(screen.getByLabelText("Setter's name"), { target: { value: 'Asha Rao' } });
    fireEvent.click(screen.getByText('Create invite'));
    const commitment = setterCommitment(fromHex(examId), 'Asha Rao', new Uint8Array(32).fill(1));
    expect(screen.getAllByText(commitment).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`0x${'01'.repeat(32)}`).length).toBeGreaterThan(0);
    expect(loadInvites(examId).invites).toEqual([{ name: 'Asha Rao', salt: `0x${'01'.repeat(32)}`, commitment }]);
    expect(screen.getByText(/Local only. These names are not on-chain./)).toBeTruthy();
  });

  it('keeps export closed until the end round', () => {
    mount(beforeEnd);
    fireEvent.change(screen.getByLabelText("Setter's name"), { target: { value: 'Asha Rao' } });
    fireEvent.click(screen.getByText('Create invite'));
    const button = screen.getByText('Export names and salts') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(`Export opens when drand publishes round ${String(endRound)}.`)).toBeTruthy();
  });

  it('exports once after the end round, then removes the names and salts', () => {
    saveInvites(examId, { invites: [createInvite(examId, 'Asha Rao', [], counter())], exportedAt: null });
    mount(afterEnd);
    fireEvent.click(screen.getByText('Export names and salts'));
    const json = (screen.getByLabelText('Names and salts to publish') as HTMLTextAreaElement).value;
    expect(JSON.parse(json)).toEqual([{ name: 'Asha Rao', salt: `0x${'01'.repeat(32)}` }]);
    fireEvent.click(screen.getByText(/I saved it/));
    expect(loadInvites(examId)).toMatchObject({ invites: [], exportedAt: expect.any(Number) });
    expect((screen.getByText('Export names and salts') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Asha Rao')).toBeNull();
  });
});

describe('on-chain list rows', () => {
  const key = (n: number) => Uint8Array.from([4, ...new Uint8Array(64).fill(n)]);
  it('show a setter as sealed with the commitment, and never a name', () => {
    const commitment = setterCommitment(fromHex(examId), 'Asha Rao', new Uint8Array(32).fill(3));
    const entries: ApprovedListEntry[] = [
      { role: roles.setter, owner: commitment, passkeyPublicKey: key(1), derivedPublicKey: new Uint8Array() },
      { role: roles.neutral, owner: 'Dr Rao', passkeyPublicKey: key(2), derivedPublicKey: key(3) },
    ];
    const html = renderToString(<EntryRows entries={entries} />);
    expect(html).toContain('Setter (sealed)');
    expect(html).toContain(commitment);
    expect(html).not.toContain('Asha Rao');
    expect(html).toContain('Dr Rao');
  });
});
