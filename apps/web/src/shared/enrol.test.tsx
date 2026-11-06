// @vitest-environment jsdom
import { KeyError } from '@paperseal/keys';
import { parseKeyCard, passkeyRecordValue, toHex } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnrolView } from './Enrol';
import { loadEnrolments, saveEnrolment } from './enrolment';

const credentialId = new Uint8Array([1, 2, 3]);
const passkey = new Uint8Array(65).fill(7);
passkey[0] = 4;
const attestationObject = new Uint8Array([0xa0]);

const makeKeys = () => ({
  generateKey: vi.fn((..._args: unknown[]) => Promise.resolve({ credentialId, passkeyPublicKey: passkey, attestationObject, clientDataJSON: new Uint8Array() })),
});

const setUp = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Set up your security key' }));
};
const stored = { credentialId: toHex(credentialId), passkeyPublicKey: toHex(passkey), attestationObject: toHex(attestationObject) };

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Enrol', () => {
  it('makes a key with one action and shows a card of public values', async () => {
    const keys = makeKeys();
    render(<EnrolView keys={keys} />);
    setUp();
    expect(await screen.findByRole('heading', { name: 'Your key card' })).toBeTruthy();
    expect(screen.getByText(/Nothing on this card is secret/)).toBeTruthy();
    expect(screen.getByText(/Send this card to whoever runs paperseal-demo\.eth/)).toBeTruthy();
    const card = parseKeyCard(screen.getByLabelText('Your key card').textContent ?? '');
    expect(card).toEqual({ passkey: passkeyRecordValue(passkey), credentialId: '0x010203', attestationObject: '0xa0' });
    expect(loadEnrolments()).toEqual([stored]);
  });

  it('copies the card', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    saveEnrolment(stored);
    render(<EnrolView keys={makeKeys()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy your key card' }));
    await screen.findByText('Copied');
    expect(parseKeyCard((writeText.mock.calls[0] as unknown as [string])[0]).credentialId).toBe('0x010203');
  });

  it('uses a random user handle, because a repeated one overwrites the earlier passkey', async () => {
    const keys = makeKeys();
    render(<EnrolView keys={keys} />);
    setUp();
    await screen.findByRole('heading', { name: 'Your key card' });
    localStorage.clear();
    cleanup();
    render(<EnrolView keys={keys} />);
    setUp();
    await screen.findByRole('heading', { name: 'Your key card' });
    const handles = keys.generateKey.mock.calls.map((call) => toHex((call[0] as { id: Uint8Array }).id));
    expect(handles[0]).not.toBe(handles[1]);
  });

  it('shows the card again in a browser that already enrolled, and offers no second key by accident', () => {
    saveEnrolment(stored);
    const keys = makeKeys();
    render(<EnrolView keys={keys} />);
    expect(screen.getByRole('heading', { name: 'Your key card' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up your security key' })).toBeNull();
    expect(keys.generateKey).not.toHaveBeenCalled();
  });

  it('passes what this browser and the directory know as excluded keys', async () => {
    saveEnrolment(stored);
    const keys = makeKeys();
    const published = new Uint8Array([9]);
    render(<EnrolView keys={keys} known={[published]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up a different key' }));
    setUp();
    await screen.findByRole('heading', { name: 'Your key card' });
    expect((keys.generateKey.mock.calls[0]?.[1] as { excludeCredentials: Uint8Array[] }).excludeCredentials).toEqual([credentialId, published]);
  });

  it('makes nothing for a key already known, and says so', async () => {
    const keys = makeKeys();
    keys.generateKey.mockRejectedValueOnce(new KeyError('already_enrolled', 'known'));
    render(<EnrolView keys={keys} known={[new Uint8Array([1, 2, 3])]} />);
    setUp();
    expect(await screen.findByRole('heading', { name: 'This security key is already set up' })).toBeTruthy();
    expect(screen.getByText(/Nothing new was made/)).toBeTruthy();
    expect(loadEnrolments()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Use a different key' }));
    expect(screen.getByRole('button', { name: 'Set up your security key' })).toBeTruthy();
  });

  it('says when it can not check the directory, and still works', async () => {
    render(<EnrolView keys={makeKeys()} directoryUnread />);
    expect(screen.getByText(/can’t tell if your key is already on it/)).toBeTruthy();
    setUp();
    expect(await screen.findByRole('heading', { name: 'Your key card' })).toBeTruthy();
  });

  it('has no field that takes a secret', () => {
    render(<EnrolView keys={makeKeys()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
