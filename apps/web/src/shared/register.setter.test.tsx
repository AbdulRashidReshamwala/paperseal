// @vitest-environment jsdom
import { fromHex, setterOwner, type Hex } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { holderCredential } from './holder';
import { loadCredential, Register, registerWithTee, saveCredential } from './Register';

const examId: Hex = `0x${'11'.repeat(32)}`;
const passkey = `0x04${'07'.repeat(64)}` as Hex;
const credentialId = '0x0102' as Hex;
/** A challenge longer than 32 bytes, as the TEE issues now. */
const challenge = `0x${'cd'.repeat(80)}` as Hex;

const request = (owner: string) => ({
  owner,
  challenge,
  passkeyPublicKey: passkey,
  derivedPublicKey: '0x' as Hex,
  attestationObject: '0x00' as Hex,
  clientDataJSON: '0x00' as Hex,
  signature: '0x00' as Hex,
  authenticatorData: '0x00' as Hex,
});

function makeKeys() {
  return {
    register: vi.fn((options: { role: 'holder' | 'setter'; owner?: string }) => {
      const owner = options.role === 'setter' ? setterOwner(fromHex(passkey)) : (options.owner ?? '');
      return Promise.resolve({ credentialId: fromHex(credentialId), owner, request: request(owner) });
    }),
  };
}

const makeTee = () => ({
  registerChallenge: vi.fn(() => Promise.resolve({ challenge })),
  register: vi.fn(() => Promise.resolve({})),
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('registerWithTee', () => {
  it('registers a setter with no name, and the owner is the hash of its passkey', async () => {
    const keys = makeKeys();
    const tee = makeTee();
    const registration = await registerWithTee({ keys, tee, owner: 'Asha Rao', role: 'setter' });
    // The name typed (if any) never reaches the keys or the TEE.
    expect(keys.register).toHaveBeenCalledWith({ role: 'setter', challenge: fromHex(challenge) });
    expect(registration.owner).toBe(setterOwner(fromHex(passkey)));
    expect(JSON.stringify(tee.register.mock.calls)).not.toContain('Asha');
    expect(tee.register).toHaveBeenCalledWith(expect.objectContaining({ owner: setterOwner(fromHex(passkey)) }));
  });

  it('passes the TEE challenge on as given, whatever its width', async () => {
    const keys = makeKeys();
    await registerWithTee({ keys, tee: makeTee(), owner: 'Centre One', role: 'centre' });
    expect(keys.register).toHaveBeenCalledWith({ role: 'holder', owner: 'Centre One', challenge: fromHex(challenge) });
  });
});

describe('Register', () => {
  const mount = (role: 'setter' | 'keyholder' | 'centre', keys = makeKeys(), tee = makeTee()) =>
    render(<Register role={role} examId={examId} tee={tee} keys={keys} />);

  const registerButton = () => screen.getByRole('button', { name: 'Register your security key' });

  it('asks a setter for nothing, registers, and keeps only the hash', async () => {
    const keys = makeKeys();
    mount('setter', keys);
    expect(screen.queryByLabelText(/Commitment/)).toBeNull();
    expect(screen.queryByLabelText('Name on the approved list')).toBeNull();
    fireEvent.click(registerButton());
    await waitFor(() => {
      expect(screen.getByText('Your security key is registered')).toBeTruthy();
    });
    expect(screen.queryByText(/Registered as/)).toBeNull();
    expect(loadCredential(examId, 'setter')?.owner).toBe(setterOwner(fromHex(passkey)));
  });

  it.each(['keyholder', 'centre'] as const)('keeps a name for a %s, and asks for it before any key touch', async (role) => {
    const keys = makeKeys();
    mount(role, keys);
    fireEvent.click(registerButton());
    expect(await screen.findByText('Enter your name first.')).toBeTruthy();
    expect(keys.register).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Name on the approved list/), { target: { value: 'Centre One' } });
    fireEvent.click(registerButton());
    await waitFor(() => {
      expect(keys.register).toHaveBeenCalledWith({ role: 'holder', owner: 'Centre One', challenge: fromHex(challenge) });
    });
    expect(await screen.findByText('Registered as Centre One.')).toBeTruthy();
  });
});

describe('credential storage', () => {
  it('keeps a key holder and a centre apart, so one browser can be both', () => {
    saveCredential(examId, { owner: 'Neutral', role: 'keyholder', credentialId: '0x01', passkeyPublicKey: '0x04aa' });
    saveCredential(examId, { owner: 'Centre', role: 'centre', credentialId: '0x02', passkeyPublicKey: '0x04bb' });
    expect(holderCredential('keyholder', examId)?.owner).toBe('Neutral');
    expect(holderCredential('centre', examId)?.owner).toBe('Centre');
    expect(loadCredential(examId, 'setter')).toBeNull();
  });

  it('is read per exam, so another exam never gets this exam key', () => {
    saveCredential(examId, { owner: 'Centre', role: 'centre', credentialId: '0x02', passkeyPublicKey: '0x04bb' });
    expect(holderCredential('centre', `0x${'22'.repeat(32)}`)).toBeNull();
  });
});
