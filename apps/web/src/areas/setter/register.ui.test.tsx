// @vitest-environment jsdom
import { fromHex, setterOwner, type Hex } from '@paperseal/protocol';
import { TeeApiError } from '@paperseal/tee-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadCredential, Register, saveCredential } from '../../shared/Register';

/*
 * The shared registration screen, by role. It lives here because this agent owns Register.tsx and
 * this folder. shared/register.setter.test.tsx covers the flow beneath it.
 */

const examId: Hex = `0x${'11'.repeat(32)}`;
const passkey = `0x04${'07'.repeat(64)}` as Hex;
const challenge = `0x${'cd'.repeat(80)}` as Hex;

function makeKeys() {
  return {
    register: vi.fn((options: { role: 'holder' | 'setter'; owner?: string }) => {
      const owner = options.role === 'setter' ? setterOwner(fromHex(passkey)) : (options.owner ?? '');
      return Promise.resolve({ credentialId: fromHex('0x0102'), owner, request: { owner, passkeyPublicKey: passkey } } as never);
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
    render(<Register role="setter" examId={examId} tee={makeTee()} keys={keys} onRegistered={onRegistered} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/Your name is never published/)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(button());
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalledTimes(1);
    });
    expect(keys.register).toHaveBeenCalledWith({ role: 'setter', challenge: fromHex(challenge) });
    expect(loadCredential(examId, 'setter')?.owner).toBe(setterOwner(fromHex(passkey)));
  });

  it.each(['keyholder', 'centre'] as const)('gives a %s one name field and one button', async (role) => {
    const keys = makeKeys();
    render(<Register role={role} examId={examId} tee={makeTee()} keys={keys} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByLabelText('Name on the approved list')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText(/public approved list/)).toBeTruthy();

    // The touch only starts once there is a name to register under.
    fireEvent.click(button());
    expect(await screen.findByText('Enter your name first.')).toBeTruthy();
    expect(keys.register).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Centre One ' } });
    fireEvent.click(button());
    expect(await screen.findByText('Your security key is registered')).toBeTruthy();
    expect(screen.getByText('Registered as Centre One.')).toBeTruthy();
    expect(keys.register).toHaveBeenCalledWith({ role: 'holder', owner: 'Centre One', challenge: fromHex(challenge) });
  });

  it('remembers nothing if the sealed system refuses, and explains in plain words', async () => {
    const tee = makeTee();
    tee.register.mockRejectedValueOnce(new TeeApiError(403, 'closed', 'registration is closed'));
    render(<Register role="setter" examId={examId} tee={tee} keys={makeKeys()} />);
    fireEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The sealed system refused this');
    expect(alert.textContent).toContain('registration is closed');
    expect(loadCredential(examId, 'setter')).toBeNull();
    expect(button()).toBeTruthy();
  });

  it('gives key guidance when the key fails', async () => {
    const keys = makeKeys();
    keys.register.mockRejectedValueOnce(new DOMException('cancelled', 'NotAllowedError'));
    Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
    render(<Register role="setter" examId={examId} tee={makeTee()} keys={keys} />);
    fireEvent.click(button());
    expect(await screen.findByText('No security key answered')).toBeTruthy();
  });

  it('shows a stored key as registered, and goes straight to the touch when replacing it', () => {
    saveCredential(examId, { owner: 'Centre', role: 'centre', credentialId: '0x02', passkeyPublicKey: '0x04bb' });
    const { unmount } = render(<Register role="centre" examId={examId} tee={makeTee()} keys={makeKeys()} />);
    expect(screen.getByText('Your security key is registered')).toBeTruthy();
    unmount();
    render(<Register role="centre" examId={examId} tee={makeTee()} keys={makeKeys()} again />);
    expect(button()).toBeTruthy();
  });

  it('says so when there is no exam or sealed system to register with', () => {
    render(<Register role="setter" examId={null} tee={null} keys={makeKeys()} />);
    expect(screen.getByText(/isn’t connected to an exam yet/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
