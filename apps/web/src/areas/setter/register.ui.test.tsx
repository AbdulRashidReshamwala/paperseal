// @vitest-environment jsdom
import { fromHex, inviteTag, setterOwner, toHex, type Hex, type Invite } from '@paperseal/protocol';
import { TeeApiError } from '@paperseal/tee-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadCredential, Register } from '../../shared/Register';

/*
 * The shared registration screen, by role. It lives here because this agent owns Register.tsx and
 * this folder. shared/register.setter.test.tsx covers the flow beneath it.
 */

const examId: Hex = `0x${'11'.repeat(32)}`;
const passkey = `0x04${'07'.repeat(64)}` as Hex;
const challenge = `0x${'cd'.repeat(80)}` as Hex;

const inviteSecret = `0x${'a5'.repeat(32)}` as Hex;
const invite = (role: Invite['role'], owner?: string): Invite => ({ examId, role, ...(owner === undefined ? {} : { owner }), inviteSecret });

function makeKeys() {
  return {
    register: vi.fn((options: { role: 'holder' | 'setter'; owner?: string; inviteSecret: Uint8Array }) => {
      const owner = options.role === 'setter' ? setterOwner(fromHex(passkey)) : (options.owner ?? '');
      const tag = toHex(inviteTag(options.inviteSecret, fromHex(passkey)));
      return Promise.resolve({ credentialId: fromHex('0x0102'), owner, request: { owner, passkeyPublicKey: passkey, inviteTag: tag } } as never);
    }),
  };
}
const makeTee = () => ({
  registerChallenge: vi.fn(() => Promise.resolve({ challenge })),
  register: vi.fn(() => Promise.resolve({})),
});

const button = () => screen.getByRole('button', { name: 'Register your security key' });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Register by role', () => {
  it('asks a setter for no name and says it is never published', async () => {
    const keys = makeKeys();
    const onRegistered = vi.fn();
    render(<Register role="setter" examId={examId} tee={makeTee()} keys={keys} invite={invite('setter')} onRegistered={onRegistered} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/Your name is not published/)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(button());
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalledTimes(1);
    });
    expect(keys.register).toHaveBeenCalledWith({ role: 'setter', challenge: fromHex(challenge), inviteSecret: fromHex(inviteSecret) });
    expect(loadCredential(examId, 'setter')?.owner).toBe(setterOwner(fromHex(passkey)));
  });

  it.each(['keyholder', 'centre'] as const)('tells a %s who they register as, with one button and nothing to type', async (role) => {
    const keys = makeKeys();
    render(<Register role={role} examId={examId} tee={makeTee()} keys={keys} invite={invite(role, 'Centre One')} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/Centre One/)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText(/public list for this exam/)).toBeTruthy();

    fireEvent.click(button());
    expect(await screen.findByText('Your security key is registered')).toBeTruthy();
    expect(screen.getByText('Registered as Centre One.')).toBeTruthy();
    expect(keys.register).toHaveBeenCalledWith({
      role: 'holder',
      owner: 'Centre One',
      challenge: fromHex(challenge),
      inviteSecret: fromHex(inviteSecret),
    });
  });

  it('remembers nothing if the sealed system refuses, and explains in plain words', async () => {
    const tee = makeTee();
    tee.register.mockRejectedValueOnce(new TeeApiError(403, 'closed', 'registration is closed'));
    render(<Register role="setter" examId={examId} tee={tee} keys={makeKeys()} invite={invite('setter')} />);
    fireEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Contact your exam board');
    expect(alert.textContent).toContain('registration is closed');
    expect(loadCredential(examId, 'setter')).toBeNull();
    expect(button()).toBeTruthy();
  });

  it('gives key guidance when the key fails', async () => {
    const keys = makeKeys();
    keys.register.mockRejectedValueOnce(new DOMException('cancelled', 'NotAllowedError'));
    Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
    render(<Register role="setter" examId={examId} tee={makeTee()} keys={keys} invite={invite('setter')} />);
    fireEvent.click(button());
    expect(await screen.findByText('No security key answered')).toBeTruthy();
  });

  it('says so when there is no exam or sealed system to register with', () => {
    render(<Register role="setter" examId={null} tee={null} keys={makeKeys()} />);
    expect(screen.getByText(/isn’t connected to an exam yet/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
