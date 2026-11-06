// @vitest-environment jsdom
import type { EnsLookup } from '@paperseal/chain';
import { createWebAuthnKeys } from '@paperseal/keys';
import { plantedKey, plantedRecords } from '@paperseal/keys/demo';
import { fromHex, hashMessage, utf8ToBytes, type Hex } from '@paperseal/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensRecords } from '../../../../e2e/demo/cards';
import { ownerNameOf, roster } from '../../../../e2e/live/roster';
import { demoCredentials } from './credentials';
import { activePersona, changePersona, personas, type Persona } from './personas';
import { newUserAction, setTouchEnabled, touchEnabled, touchForShow } from './touch';
import { registerName } from '../shared/RegisterByName';

const person = (id: string) => personas.find((persona) => persona.id === id) as Persona;
const examId = `0x${'ee'.repeat(32)}` as Hex;

/** The real `navigator.credentials`, as a test sees it. */
function realKey(result: (options: { signal?: AbortSignal }) => Promise<unknown> = () => Promise.resolve({ rawId: new Uint8Array([9, 9]).buffer })) {
  const key = { create: vi.fn(result), get: vi.fn(result) } as unknown as { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } & Pick<CredentialsContainer, 'create' | 'get'>;
  Object.defineProperty(globalThis.navigator, 'credentials', { value: key, configurable: true });
  return key;
}

beforeEach(() => {
  localStorage.clear();
  newUserAction();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('personas', () => {
  it('are the roster, plus the exam board', () => {
    expect(personas.map(({ id }) => id)).toEqual(['board', ...roster.map(({ name }) => name)]);
    for (const entry of roster) expect(person(entry.name).owner).toBe(ownerNameOf(entry));
  });

  it('start on a page for their role', () => {
    expect(person('board').path).toBe('/board');
    expect(person('setter-2').path).toBe('/setter');
    expect(person('neutral-1').path).toBe('/keyholder');
    expect(person('centre-8').path).toBe('/centre');
  });

  it('starts as the exam board, who keeps what was already here', () => {
    localStorage.setItem('paperseal.board.drafts', '[1]');
    expect(activePersona().id).toBe('board');
    changePersona(person('setter-1'));
    expect(localStorage.getItem('paperseal.board.drafts')).toBeNull();
    changePersona(person('board'));
    expect(localStorage.getItem('paperseal.board.drafts')).toBe('[1]');
  });

  it('keeps each person’s credentials, registrations and drafts away from the others', () => {
    const credential = `paperseal.credential.${examId}.keyholder`;
    changePersona(person('neutral-1'));
    localStorage.setItem(credential, 'neutral-1 key');
    localStorage.setItem('paperseal.setter.draft', 'hers');
    changePersona(person('neutral-2'));
    expect(activePersona().id).toBe('neutral-2');
    expect(localStorage.getItem(credential)).toBeNull();
    expect(localStorage.getItem('paperseal.setter.draft')).toBeNull();
    localStorage.setItem(credential, 'neutral-2 key');
    changePersona(person('neutral-1'));
    expect(localStorage.getItem(credential)).toBe('neutral-1 key');
    expect(localStorage.getItem('paperseal.setter.draft')).toBe('hers');
    changePersona(person('neutral-2'));
    expect(localStorage.getItem(credential)).toBe('neutral-2 key');
  });

  it('fills in a party’s own name the first time, and keeps what they changed', () => {
    changePersona(person('centre-3'));
    expect(localStorage.getItem('paperseal.party-name')).toBe('centre-3.paperseal-demo.eth');
    localStorage.setItem('paperseal.party-name', 'typed');
    changePersona(person('setter-1'));
    expect(localStorage.getItem('paperseal.party-name')).toBeNull();
    changePersona(person('centre-3'));
    expect(localStorage.getItem('paperseal.party-name')).toBe('typed');
  });

  it('shares only the pointer to the current exam', () => {
    localStorage.setItem('paperseal.examId', examId);
    changePersona(person('centre-1'));
    expect(localStorage.getItem('paperseal.examId')).toBe(examId);
  });

  it('leaves the demo’s own settings alone', () => {
    setTouchEnabled(false);
    changePersona(person('centre-1'));
    expect(touchEnabled()).toBe(false);
  });
});

describe('the touch for show', () => {
  it('makes one throwaway credential, then reads it, with one touch per action', async () => {
    const key = realKey();
    await touchForShow();
    await touchForShow();
    expect(key.create).toHaveBeenCalledTimes(1);
    expect(key.get).not.toHaveBeenCalled();
    const made = key.create.mock.calls[0]?.[0] as CredentialCreationOptions;
    expect(made.publicKey?.authenticatorSelection?.userVerification).toBe('discouraged');

    newUserAction();
    await touchForShow();
    await touchForShow();
    expect(key.create).toHaveBeenCalledTimes(1);
    expect(key.get).toHaveBeenCalledTimes(1);
    const read = key.get.mock.calls[0]?.[0] as CredentialRequestOptions;
    expect(new Uint8Array(read.publicKey?.allowCredentials?.[0]?.id as ArrayBuffer)).toEqual(new Uint8Array([9, 9]));
  });

  it('is skipped when turned off, and the choice is remembered', async () => {
    const key = realKey();
    expect(touchEnabled()).toBe(true);
    setTouchEnabled(false);
    expect(touchEnabled()).toBe(false);
    await touchForShow();
    expect(key.create).not.toHaveBeenCalled();
  });

  it('gives up by itself when no key answers', async () => {
    const key = realKey(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('gone', 'AbortError'));
          });
        }),
    );
    await touchForShow(key, localStorage, 5);
    expect(key.create).toHaveBeenCalledTimes(1);
  });
});

describe('demo credentials', () => {
  it('answer as the active person', async () => {
    realKey();
    changePersona(person('centre-1'));
    const planted = await plantedKey('centre-1');
    const keys = createWebAuthnKeys({ rpId: 'localhost', rpName: 'Paper Seal', credentials: demoCredentials() });
    const signature = await keys.sign(planted.credentialId, new Uint8Array(32));
    expect(signature.authenticatorData[32]).toBe(0x05);

    changePersona(person('centre-2'));
    await expect(keys.sign(planted.credentialId, new Uint8Array(32))).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('give the exam board no key', async () => {
    const key = realKey();
    const planted = await plantedKey('centre-1');
    const keys = createWebAuthnKeys({ rpId: 'localhost', rpName: 'Paper Seal', credentials: demoCredentials() });
    await expect(keys.sign(planted.credentialId, new Uint8Array(32))).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(key.create).not.toHaveBeenCalled();
  });

  it.each([
    ['cancels', () => Promise.reject(new DOMException('no', 'NotAllowedError'))],
    ['fails', () => Promise.reject(new Error('boom'))],
    ['returns nothing', () => Promise.resolve(null)],
  ])('carry on with the planted key when the real key %s', async (_name, result) => {
    realKey(result);
    changePersona(person('setter-1'));
    const planted = await plantedKey('setter-1');
    const keys = createWebAuthnKeys({ rpId: 'localhost', rpName: 'Paper Seal', credentials: demoCredentials() });
    await expect(keys.sign(planted.credentialId, new Uint8Array(32))).resolves.toBeDefined();
  });

  it('touch once for a registration by name, which needs two ceremonies, and it passes the app’s own checks on localhost', async () => {
    const key = realKey();
    changePersona(person('neutral-1'));
    const owner = 'neutral-1.paperseal-demo.eth';
    const planted = await plantedKey('neutral-1');
    // What `write-names` puts on the name, read back as the app reads any name.
    const records = ensRecords(plantedRecords(planted));
    const lookup = { text: (_name: string, key_: string) => Promise.resolve(records[key_] ?? null) } as unknown as EnsLookup;
    const register = vi.fn(() => Promise.resolve({}));
    const challenge = `0x${'c1'.repeat(32)}` as Hex;
    const tee = {
      registrations: () => Promise.resolve({ registrations: [] }),
      registerChallenge: () => Promise.resolve({ challenge }),
      register,
    };

    const known = await registerName({
      keys: createWebAuthnKeys({ rpId: 'localhost', rpName: 'Paper Seal', credentials: demoCredentials() }),
      tee: tee as never,
      lookup,
      registry: null,
      examId,
      owner,
    });

    expect(known.credentialId).toBe(plantedRecords(planted).credentialId);
    expect(key.create.mock.calls.length + key.get.mock.calls.length).toBe(1);
    const request = (register.mock.calls as unknown as [{ passkeyPublicKey: Hex; derivedPublicKey: Hex; clientDataJSON: Hex }][])[0]?.[0];
    expect(request?.passkeyPublicKey).toBe(`0x${Buffer.from(planted.publicKey).toString('hex')}`);
    const signedOver = JSON.parse(new TextDecoder().decode(fromHex(request?.clientDataJSON as Hex))) as { challenge: string };
    const message = hashMessage('registration', {
      derivedPublicKey: fromHex(request?.derivedPublicKey as Hex),
      holderId: utf8ToBytes(owner),
      challenge: fromHex(challenge),
      inviteTag: new Uint8Array(32),
    });
    expect(Buffer.from(signedOver.challenge, 'base64url')).toEqual(Buffer.from(message));
  });
});
