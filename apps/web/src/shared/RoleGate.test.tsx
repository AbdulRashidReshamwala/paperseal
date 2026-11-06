// @vitest-environment jsdom
import { roles, type ApprovedListEntry, type Hex, type Invite } from '@paperseal/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PersonaGate from '../demo/PersonaGate';
import { activeKey, personas } from '../demo/personas';
import { BoardGate } from './BoardGate';
import { setCurrentExamId } from './currentExam';
import { saveEnrolment } from './enrolment';
import { clearHeldInvites, holdInvite } from './invite';
import { saveCredential, type RegisterRole } from './Register';
import { HolderGate, holderAccess, SetterGate, setterAccess } from './RoleGate';

const exam = `0x${'ab'.repeat(32)}` as Hex;
const otherExam = `0x${'cd'.repeat(32)}` as Hex;
const key = `0x${'11'.repeat(33)}` as Hex;
const board = '0xC3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa20' as Hex;
const other = '0x12bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb34' as Hex;
const secret = <p>Your exams</p>;
const invite = (examId: Hex) => ({ examId, role: 'setter', inviteSecret: `0x${'22'.repeat(32)}` }) as Invite;

const inRouter = (node: ReactNode, path = '/') => render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });
const registered = (role: RegisterRole, examId = exam) => {
  saveCredential(examId, { owner: 'me', role, credentialId: '0xaa', passkeyPublicKey: key });
};

type Listener = () => void;

/** A wallet whose accounts the test can change, with the events a real one fires. */
function installWallet(start: { accounts: string[]; pick?: string[]; decline?: boolean }) {
  const listeners = new Set<Listener>();
  const wallet = {
    accounts: start.accounts,
    emit: () => {
      for (const listener of listeners) listener();
    },
  };
  (globalThis as { ethereum?: unknown }).ethereum = {
    request: ({ method }: { method: string }) => {
      switch (method) {
        case 'eth_accounts':
          return Promise.resolve(wallet.accounts);
        case 'eth_requestAccounts':
          if (start.decline) return Promise.reject(new Error('User rejected the request.'));
          wallet.accounts = start.pick ?? [];
          return Promise.resolve(wallet.accounts);
        case 'wallet_requestPermissions':
          wallet.accounts = start.pick ?? [];
          return Promise.resolve([]);
        default:
          return Promise.reject(new Error(`unexpected ${method}`));
      }
    },
    on: (_: string, listener: Listener) => listeners.add(listener),
    removeListener: (_: string, listener: Listener) => listeners.delete(listener),
  };
  return wallet;
}

beforeEach(() => {
  localStorage.clear();
  clearHeldInvites();
  delete (globalThis as { ethereum?: unknown }).ethereum;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the exam board', () => {
  const chain = { board: () => Promise.resolve(board) };
  const gate = (reader: Parameters<typeof BoardGate>[0]['reader'] = chain) => inRouter(<BoardGate reader={reader} retryMs={10}>{secret}</BoardGate>);

  it('shows nothing of the board before the check is back', () => {
    installWallet({ accounts: [board] });
    gate({ board: () => new Promise(() => undefined) });
    expect(screen.queryByText('Your exams')).toBeNull();
  });

  it('opens for the board’s account, whatever its letter case', async () => {
    installWallet({ accounts: [board.toLowerCase()] });
    gate();
    expect(await screen.findByText('Your exams')).toBeTruthy();
  });

  it('says to install a wallet when there is none', async () => {
    gate();
    await heading('Install a wallet to use this page');
    expect(screen.queryByText('Your exams')).toBeNull();
  });

  it('asks to connect, then opens', async () => {
    installWallet({ accounts: [], pick: [board] });
    gate();
    await heading('Connect the exam board’s wallet');
    fireEvent.click(screen.getByRole('button', { name: 'Connect your wallet' }));
    expect(await screen.findByText('Your exams')).toBeTruthy();
  });

  it('stays closed when the wallet declines to connect', async () => {
    installWallet({ accounts: [], decline: true });
    gate();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect your wallet' }));
    expect((await screen.findByRole('alert')).textContent).toContain('did not share an account');
    expect(screen.queryByText('Your exams')).toBeNull();
  });

  it('names the account it expects, and the picker can open the page', async () => {
    installWallet({ accounts: [other], pick: [board] });
    gate();
    await heading('Switch to the exam board’s account');
    expect(screen.getByText(/Connected: 0x12…34\. The exam board uses: 0xC3…20\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the board’s account' }));
    expect(await screen.findByText('Your exams')).toBeTruthy();
  });

  it('closes again when the wallet moves to another account, and opens when it comes back', async () => {
    const wallet = installWallet({ accounts: [board] });
    gate();
    await screen.findByText('Your exams');
    wallet.accounts = [other];
    act(() => {
      wallet.emit();
    });
    await heading('Switch to the exam board’s account');
    expect(screen.queryByText('Your exams')).toBeNull();
    wallet.accounts = [board];
    act(() => {
      wallet.emit();
    });
    expect(await screen.findByText('Your exams')).toBeTruthy();
  });

  it('closes when the active account is another one, even with the board’s also connected', async () => {
    installWallet({ accounts: [other, board] });
    gate();
    await heading('Switch to the exam board’s account');
  });

  it('stays closed when the board can’t be read, and tries again by itself', async () => {
    installWallet({ accounts: [board] });
    const reader = { board: vi.fn().mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue(board) };
    gate(reader);
    await heading('Can’t check your wallet right now');
    expect(screen.queryByText('Your exams')).toBeNull();
    expect(await screen.findByText('Your exams')).toBeTruthy();
  });

  it('stays closed when this page has no public record to read', async () => {
    installWallet({ accounts: [board] });
    gate(null);
    await heading('This page is not ready to use yet');
  });
});

describe('the setter page', () => {
  const given = { examId: exam, invite: null, setterKey: false, holderKey: false };

  it('wants a link or a key for this exam', () => {
    expect(setterAccess(given)).toEqual({ state: 'needs-link' });
    expect(setterAccess({ ...given, examId: null, invite: invite(exam) })).toEqual({ state: 'needs-link' });
    expect(setterAccess({ ...given, invite: invite(otherExam) })).toEqual({ state: 'needs-link' });
    expect(setterAccess({ ...given, invite: invite(exam) })).toEqual({ state: 'open' });
    expect(setterAccess({ ...given, setterKey: true })).toEqual({ state: 'open' });
  });

  it('asks for the invitation link', async () => {
    setCurrentExamId(exam);
    inRouter(<SetterGate>{secret}</SetterGate>);
    await heading('Open your invitation link');
    expect(screen.getByText(/invitation link from your exam board/)).toBeTruthy();
    expect(screen.queryByText('Your exams')).toBeNull();
  });

  it('opens from an invite held for this exam', () => {
    setCurrentExamId(exam);
    holdInvite(invite(exam));
    inRouter(<SetterGate>{secret}</SetterGate>);
    expect(screen.getByText('Your exams')).toBeTruthy();
  });

  it('opens for a setter’s key on this exam only', () => {
    registered('setter', otherExam);
    setCurrentExamId(exam);
    const { unmount } = inRouter(<SetterGate>{secret}</SetterGate>);
    expect(screen.queryByText('Your exams')).toBeNull();
    unmount();
    registered('setter');
    inRouter(<SetterGate>{secret}</SetterGate>);
    expect(screen.getByText('Your exams')).toBeTruthy();
  });

  it('sends a key holder to their exam page', async () => {
    setCurrentExamId(exam);
    registered('keyholder');
    inRouter(<SetterGate>{secret}</SetterGate>);
    await heading('This page is for question setters');
    expect(screen.getByRole('link', { name: 'Open your exam page' }).getAttribute('href')).toBe('/exam');
  });
});

describe('the key holder and centre pages', () => {
  const given = { role: 'centre', linked: false, enrolled: false, holderKey: false, setterKey: false, listed: null } as const;

  it('lets registration start from an exam link or an enrolled key', () => {
    expect(holderAccess(given)).toEqual({ state: 'needs-link' });
    expect(holderAccess({ ...given, linked: true })).toEqual({ state: 'open' });
    expect(holderAccess({ ...given, enrolled: true })).toEqual({ state: 'open' });
  });

  it('opens for a key until the list says otherwise', () => {
    expect(holderAccess({ ...given, holderKey: true })).toEqual({ state: 'open' });
    expect(holderAccess({ ...given, holderKey: true, listed: roles.centre })).toEqual({ state: 'open' });
    expect(holderAccess({ ...given, holderKey: true, listed: roles.neutral })).toEqual({ state: 'wrong-role', right: 'keyholder' });
    expect(holderAccess({ ...given, role: 'keyholder', holderKey: true, listed: roles.centre })).toEqual({ state: 'wrong-role', right: 'centre' });
  });

  it('opens both pages for a centre that holds part of the key', () => {
    for (const role of ['keyholder', 'centre'] as const) {
      expect(holderAccess({ ...given, role, holderKey: true, listed: roles.centreKeyHolder })).toEqual({ state: 'open' });
    }
  });

  it('sends a setter to the setter page', () => {
    expect(holderAccess({ ...given, setterKey: true })).toEqual({ state: 'wrong-role', right: 'setter' });
  });

  it('asks for the exam link', async () => {
    setCurrentExamId(exam);
    inRouter(<HolderGate role="keyholder" reader={null}>{secret}</HolderGate>, '/keyholder');
    await heading('Open your exam link');
    expect(screen.getByText(/exam link from your exam board/)).toBeTruthy();
    expect(screen.queryByText('Your exams')).toBeNull();
  });

  it('opens from the public exam link, in a browser that knows nothing yet', () => {
    inRouter(<HolderGate role="centre" reader={null}>{secret}</HolderGate>, `/centre?exam=${exam}`);
    expect(screen.getByText('Your exams')).toBeTruthy();
  });

  it('opens for a browser with an enrolled key', () => {
    saveEnrolment({ credentialId: '0xaa', passkeyPublicKey: '0xbb', attestationObject: '0xcc' });
    inRouter(<HolderGate role="centre" reader={null}>{secret}</HolderGate>, '/centre');
    expect(screen.getByText('Your exams')).toBeTruthy();
  });

  it('names the right page once the list shows a key holder on the centre page', async () => {
    setCurrentExamId(exam);
    registered('centre');
    const entry = { role: roles.neutral, owner: 'me', passkeyPublicKey: new Uint8Array(33).fill(0x11) } as unknown as ApprovedListEntry;
    const holder = await import('./holder');
    vi.spyOn(holder, 'listEntryFor').mockResolvedValue(entry);
    inRouter(<HolderGate role="centre" reader={{ getApprovedListEntries: () => Promise.resolve(null) }}>{secret}</HolderGate>, '/centre');
    await waitFor(() => {
      expect(screen.queryByText('Your exams')).toBeNull();
    });
    await heading('This page is for exam centres');
    expect(screen.getByRole('link', { name: 'Open your key holder page' }).getAttribute('href')).toBe('/keyholder');
  });

  it('shows the page when the list can’t be read, so its own screen can say so', async () => {
    setCurrentExamId(exam);
    registered('keyholder');
    inRouter(<HolderGate role="keyholder" reader={{ getApprovedListEntries: () => Promise.reject(new Error('rpc down')) }}>{secret}</HolderGate>, '/keyholder');
    expect(await screen.findByText('Your exams')).toBeTruthy();
  });
});

describe('demo keys', () => {
  const become = (id: string) => {
    sessionStorage.setItem(activeKey, id);
  };

  it.each([
    ['setter-1', 'board', 'This page is for the exam board', 'Switch to Exam board'],
    ['neutral-1', 'setter', 'This page is for question setters', 'Switch to Setter 1'],
    ['centre-2', 'keyholder', 'This page is for key holders', 'Switch to Key holder 1'],
    ['board', 'centre', 'This page is for exam centres', 'Switch to Centre 1'],
  ] as const)('%s on the %s page is offered the switch', async (persona, role, title, button) => {
    become(persona);
    inRouter(<PersonaGate role={role}>{secret}</PersonaGate>);
    await heading(title);
    expect(screen.getByRole('button', { name: button })).toBeTruthy();
    expect(screen.queryByText('Your exams')).toBeNull();
  });

  it('every persona has a page, and passes on their own', () => {
    const pages = { '/board': 'board', '/setter': 'setter', '/keyholder': 'keyholder', '/centre': 'centre' } as const;
    for (const persona of personas) {
      become(persona.id);
      const { unmount } = inRouter(<PersonaGate role={pages[persona.path as keyof typeof pages]}>{secret}</PersonaGate>);
      expect(screen.getByText('Your exams')).toBeTruthy();
      unmount();
    }
  });
});
