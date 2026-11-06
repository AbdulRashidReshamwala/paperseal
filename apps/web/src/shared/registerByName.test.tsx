// @vitest-environment jsdom
import type { EnsLookup } from '@paperseal/chain';
import { KeyError } from '@paperseal/keys';
import { encodeApprovedList, ens, fromHex, noInviteTag, passkeyRecordValue, roles, toHex, type Hex } from '@paperseal/protocol';
import { TeeApiError } from '@paperseal/tee-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveEnrolment } from './enrolment';
import { holderCredential } from './holder';
import { RegisterByName } from './RegisterByName';

const examId: Hex = `0x${'11'.repeat(32)}`;
const owner = 'centre-1.paperseal-demo.eth';
const passkey = `0x04${'07'.repeat(64)}` as Hex;
const derived = `0x04${'08'.repeat(64)}` as Hex;
const credentialId = '0x0102' as Hex;
const challenge = `0x${'cd'.repeat(80)}` as Hex;

const records = (values: Partial<Record<string, string>> = {}) => ({
  [ens.records.passkey]: passkeyRecordValue(passkey),
  [ens.records.credential]: credentialId,
  ...values,
});

const lookupOf = (values: Partial<Record<string, string>> = records(), directory: string | null = JSON.stringify([owner])): EnsLookup =>
  ({ text: (_name: string, key: string) => Promise.resolve(key === ens.records.directory ? directory : (values[key] ?? null)) }) as unknown as EnsLookup;

const request = {
  owner,
  inviteTag: toHex(noInviteTag),
  challenge,
  passkeyPublicKey: passkey,
  derivedPublicKey: derived,
  attestationObject: '0x' as Hex,
  clientDataJSON: '0x00' as Hex,
  signature: '0x00' as Hex,
  authenticatorData: '0x00' as Hex,
};

const makeKeys = () => ({
  registerByName: vi.fn(async (options: { challenge: () => Promise<Uint8Array>; attestationObject?: Uint8Array }) => {
    await options.challenge();
    return { credentialId: fromHex(credentialId), owner, request };
  }),
});

const makeTee = (registered: { owner: string; passkeyPublicKey: Hex; derivedPublicKey: Hex; inviteTag: Hex }[] = []) => ({
  registerChallenge: vi.fn(() => Promise.resolve({ challenge })),
  register: vi.fn(() => Promise.resolve({})),
  registrations: vi.fn(() => Promise.resolve({ registrations: registered })),
});

const noList = { getApprovedListEntries: () => Promise.resolve(null) };

const mount = (over: Partial<Parameters<typeof RegisterByName>[0]> = {}) =>
  render(<RegisterByName examId={examId} keys={makeKeys()} tee={makeTee()} lookup={lookupOf()} registry={noList} {...over} />);

const typeName = async (name = owner) => {
  fireEvent.change(await screen.findByLabelText(/^Your name/), { target: { value: name } });
};
const go = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Register with your security key' }));
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('RegisterByName', () => {
  it('registers from the name alone: its credential comes from the record, and there is no secret', async () => {
    const keys = makeKeys();
    const tee = makeTee();
    const onRegistered = vi.fn();
    mount({ keys, tee, onRegistered });
    await typeName();
    go();
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalledTimes(1);
    });
    const options = keys.registerByName.mock.calls[0]?.[0] as unknown as { owner: string; credentialId: Uint8Array; passkey: Hex; examId: Uint8Array; attestationObject?: Uint8Array };
    expect(options.owner).toBe(owner);
    expect(toHex(options.credentialId)).toBe(credentialId);
    expect(options.passkey).toBe(passkeyRecordValue(passkey));
    expect(toHex(options.examId)).toBe(examId);
    expect(options.attestationObject).toBeUndefined();
    expect(tee.register).toHaveBeenCalledWith(request);
  });

  it('keeps the key for both holder pages, because the role is the board’s choice', async () => {
    const onRegistered = vi.fn();
    mount({ onRegistered });
    await typeName();
    go();
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalled();
    });
    expect(holderCredential('keyholder', examId)).toMatchObject({ owner, credentialId, passkeyPublicKey: passkey });
    expect(holderCredential('centre', examId)).toMatchObject({ owner, credentialId, passkeyPublicKey: passkey });
  });

  it('resends the attestation object when this browser enrolled the key, and fills in the name', async () => {
    saveEnrolment({ credentialId, passkeyPublicKey: passkey, attestationObject: '0xa0' });
    const keys = makeKeys();
    const onRegistered = vi.fn();
    mount({ keys, onRegistered });
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(/^Your name/).value).toBe(owner);
    });
    go();
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalled();
    });
    expect((keys.registerByName.mock.calls[0]?.[0] as { attestationObject?: Uint8Array }).attestationObject).toEqual(new Uint8Array([0xa0]));
  });

  it('refuses a plain name before any touch', async () => {
    const keys = makeKeys();
    mount({ keys });
    await typeName('Centre One');
    go();
    expect(await screen.findByText('Use an ENS name, like iit-delhi.eth.')).toBeTruthy();
    expect(keys.registerByName).not.toHaveBeenCalled();
  });

  it('says a name with no key on it needs a card first', async () => {
    const keys = makeKeys();
    mount({ keys, lookup: lookupOf({}) });
    await typeName();
    go();
    expect((await screen.findAllByText(/has no security key on it yet\. Send your key card to whoever runs paperseal-demo\.eth/)).length).toBeGreaterThan(0);
    expect(keys.registerByName).not.toHaveBeenCalled();
  });

  it('says plainly when the key is not the one on the name', async () => {
    const keys = makeKeys();
    keys.registerByName.mockRejectedValueOnce(new KeyError('wrong_key', 'no'));
    const tee = makeTee();
    mount({ keys, tee });
    await typeName();
    go();
    expect(await screen.findByText(/not the security key on that name/)).toBeTruthy();
    expect(tee.register).not.toHaveBeenCalled();
  });

  it('needs no touch when the sealed machine already holds this key under this name', async () => {
    const keys = makeKeys();
    const onRegistered = vi.fn();
    mount({ keys, tee: makeTee([{ owner, passkeyPublicKey: passkey, derivedPublicKey: derived, inviteTag: toHex(noInviteTag) }]), onRegistered });
    await typeName();
    go();
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalled();
    });
    expect(keys.registerByName).not.toHaveBeenCalled();
  });

  it('ignores someone else registered under this name with another key', async () => {
    const keys = makeKeys();
    const onRegistered = vi.fn();
    const other = `0x04${'09'.repeat(64)}` as Hex;
    mount({ keys, tee: makeTee([{ owner, passkeyPublicKey: other, derivedPublicKey: derived, inviteTag: toHex(noInviteTag) }]), onRegistered });
    await typeName();
    go();
    await waitFor(() => {
      expect(keys.registerByName).toHaveBeenCalled();
    });
  });

  it('learns the key from the posted list in a new browser, with no touch and no sealed machine', async () => {
    const point = (i: number) => fromHex(`0x04${(i + 16).toString(16).repeat(64)}`);
    const others = Array.from({ length: 9 }, (_, i) => ({
      role: i < 3 ? roles.neutral : roles.centreKeyHolder,
      owner: `other-${String(i)}.paperseal-demo.eth`,
      passkeyPublicKey: point(i),
      derivedPublicKey: point(i + 20),
    }));
    const encoded = encodeApprovedList([{ role: roles.centreKeyHolder, owner, passkeyPublicKey: fromHex(passkey), derivedPublicKey: fromHex(derived) }, ...others]);
    const keys = makeKeys();
    const tee = makeTee();
    const onRegistered = vi.fn();
    mount({ keys, tee, onRegistered, registry: { getApprovedListEntries: () => Promise.resolve(toHex(encoded)) } });
    await typeName();
    go();
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalled();
    });
    expect(keys.registerByName).not.toHaveBeenCalled();
    expect(tee.registrations).not.toHaveBeenCalled();
  });

  it('treats already_registered as done only if the machine shows this key', async () => {
    const tee = makeTee();
    const entry = { owner, passkeyPublicKey: passkey, derivedPublicKey: derived, inviteTag: toHex(noInviteTag) };
    tee.register.mockRejectedValueOnce(new TeeApiError(409, 'already_registered', 'known'));
    tee.registrations.mockResolvedValueOnce({ registrations: [] }).mockResolvedValueOnce({ registrations: [entry] });
    const onRegistered = vi.fn();
    mount({ tee, onRegistered });
    await typeName();
    go();
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalled();
    });
  });

  it('says registration has closed, in words', async () => {
    const tee = makeTee();
    tee.register.mockRejectedValueOnce(new TeeApiError(409, 'wrong_stage', 'closed'));
    mount({ tee });
    await typeName();
    go();
    expect(await screen.findByText(/Registration for this exam has closed/)).toBeTruthy();
    expect(holderCredential('centre', examId)).toBeNull();
  });

  it('asks for a name, with the directory as suggestions', async () => {
    mount();
    await waitFor(() => {
      expect(document.querySelectorAll('#party-names option')).toHaveLength(1);
    });
    expect(screen.getByText(/touch your key twice/)).toBeTruthy();
  });

  it('says so when nothing is connected', () => {
    mount({ examId: null });
    expect(screen.getByText(/isn’t connected to an exam yet/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
