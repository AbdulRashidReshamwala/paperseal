// @vitest-environment jsdom
import { fromHex, inviteTag, setterOwner, toHex, type Hex, type Invite } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { holderCredential } from './holder';
import { clearHeldInvites, holdInvite } from './invite';
import { loadCredential, Register, registerWithTee, saveCredential } from './Register';

const examId: Hex = `0x${'11'.repeat(32)}`;
const passkey = `0x04${'07'.repeat(64)}` as Hex;
const credentialId = '0x0102' as Hex;
/** A challenge longer than 32 bytes, as the TEE issues now. */
const challenge = `0x${'cd'.repeat(80)}` as Hex;

const inviteSecret = `0x${'a5'.repeat(32)}` as Hex;
const otherSecret = `0x${'5a'.repeat(32)}` as Hex;
const inviteFor = (secret: Hex = inviteSecret): Invite => ({ examId, role: 'setter', inviteSecret: secret });
const tagOf = (secret: Hex) => toHex(inviteTag(fromHex(secret), fromHex(passkey)));

const request = (owner: string, secret: Uint8Array) => ({
  owner,
  inviteTag: toHex(inviteTag(secret, fromHex(passkey))),
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
    register: vi.fn((options: { inviteSecret: Uint8Array }) => {
      const owner = setterOwner(fromHex(passkey));
      return Promise.resolve({ credentialId: fromHex(credentialId), owner, request: request(owner, options.inviteSecret) });
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
  clearHeldInvites();
  vi.clearAllMocks();
});

describe('registerWithTee', () => {
  it('registers a setter from its invite, and the owner is the hash of its passkey', async () => {
    const keys = makeKeys();
    const tee = makeTee();
    const registration = await registerWithTee({ keys, tee, invite: inviteFor() });
    expect(keys.register).toHaveBeenCalledWith({ role: 'setter', challenge: fromHex(challenge), inviteSecret: fromHex(inviteSecret) });
    expect(registration.owner).toBe(setterOwner(fromHex(passkey)));
    expect(tee.register).toHaveBeenCalledWith(expect.objectContaining({ owner: setterOwner(fromHex(passkey)), inviteTag: tagOf(inviteSecret) }));
    expect(JSON.stringify(tee.register.mock.calls)).not.toContain(inviteSecret.slice(2));
  });
});

describe('Register', () => {
  const mount = (invite: Invite | null, keys = makeKeys(), tee = makeTee()) => render(<Register examId={examId} tee={tee} keys={keys} invite={invite} />);
  const registerButton = () => screen.getByRole('button', { name: 'Register your security key' });

  it('registers a setter from its invite with nothing to type, and keeps only the hash and the tag', async () => {
    mount(inviteFor());
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(registerButton());
    await waitFor(() => {
      expect(screen.getByText('Your security key is registered')).toBeTruthy();
    });
    expect(screen.queryByText(/Registered as/)).toBeNull();
    expect(loadCredential(examId, 'setter')).toMatchObject({ owner: setterOwner(fromHex(passkey)), inviteTag: tagOf(inviteSecret) });
  });

  it('shows a plain explanation and no form or key touch without a link', () => {
    mount(null);
    expect(screen.getByRole('heading', { name: 'Open your invitation link' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('does not use a link made for another exam', () => {
    mount({ ...inviteFor(), examId: `0x${'22'.repeat(32)}` });
    expect(screen.getByRole('heading', { name: 'Open your invitation link' })).toBeTruthy();
  });

  it('uses the invite this browser opened from a link', () => {
    holdInvite(inviteFor());
    render(<Register examId={examId} tee={makeTee()} keys={makeKeys()} />);
    expect(registerButton()).toBeTruthy();
  });

  it('keeps a stored key as registered, until a new invite is opened that it was not registered under', () => {
    saveCredential(examId, { owner: setterOwner(fromHex(passkey)), role: 'setter', credentialId: '0x02', passkeyPublicKey: passkey, inviteTag: tagOf(inviteSecret) });
    const same = mount(inviteFor());
    expect(screen.getByText('Your security key is registered')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    same.unmount();
    // A reissued invite has a new secret, so the old key no longer counts and a new one can be registered.
    mount(inviteFor(otherSecret));
    expect(registerButton()).toBeTruthy();
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
