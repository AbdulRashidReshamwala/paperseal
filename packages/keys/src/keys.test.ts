import { hpkeContext, hpkeSeal } from '@paperseal/crypto';
import { fromHex, hashMessage, inviteTag, setterOwner, toHex, utf8ToBytes, webauthn } from '@paperseal/protocol';
import { describe, expect, it, vi } from 'vitest';

import { assertDeviceBound, createWebAuthnKeys, KeyError, readBackupFlags } from './index';

const authData = (flags: number) => {
  const data = new Uint8Array(37);
  data[32] = flags;
  return data;
};
const UP = 0x01;
const BE = 0x08;
const BS = 0x10;
const credentialId = new Uint8Array([1, 2, 3]);
const examId = new Uint8Array(32).fill(0xee);
const sealTo = (key: Uint8Array, plaintext: Uint8Array, purpose: 'share' | 'keyPriv' = 'share') =>
  hpkeSeal(key, plaintext, hpkeContext(purpose, examId));
const prfOutput = new Uint8Array(32).fill(9);
const spki = () => {
  const out = new Uint8Array(91);
  out[26] = 4;
  return out;
};

/** A stand-in for the browser's credential API, the external boundary in tests. */
function authenticator(
  options: { flags?: number; prf?: ArrayBuffer | null; prfEnabled?: boolean; prfAtCreate?: boolean } = {},
) {
  const { flags = UP, prf = prfOutput.slice().buffer, prfEnabled = true, prfAtCreate = true } = options;
  return {
    create: vi.fn(() =>
      Promise.resolve({
        rawId: credentialId.slice().buffer,
        getClientExtensionResults: () => ({
          prf: { enabled: prfEnabled, ...(prfAtCreate && prf ? { results: { first: prf.slice(0) } } : {}) },
        }),
        response: {
          attestationObject: new ArrayBuffer(4),
          clientDataJSON: new ArrayBuffer(2),
          getAuthenticatorData: () => authData(flags).buffer,
          getPublicKey: () => spki().buffer,
          getPublicKeyAlgorithm: () => -7,
        },
      } as unknown as Credential),
    ),
    get: vi.fn(() =>
      Promise.resolve({
        getClientExtensionResults: () => (prf ? { prf: { results: { first: prf.slice(0) } } } : {}),
        response: {
          authenticatorData: authData(flags).buffer,
          clientDataJSON: new ArrayBuffer(2),
          signature: new ArrayBuffer(70),
        },
      } as unknown as Credential),
    ),
  };
}

const keysFor = (credentials: ReturnType<typeof authenticator>) =>
  createWebAuthnKeys({ rpId: 'localhost', rpName: 'Paper Seal', credentials });

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof KeyError ? error.code : 'other'),
  );

describe('backup flags', () => {
  it('reads each flag', () => {
    expect(readBackupFlags(authData(UP))).toEqual({ backupEligible: false, backedUp: false });
    expect(readBackupFlags(authData(BE))).toEqual({ backupEligible: true, backedUp: false });
    expect(readBackupFlags(authData(BE | BS))).toEqual({ backupEligible: true, backedUp: true });
  });

  it('accepts device-bound credentials', () => {
    expect(() => {
      assertDeviceBound(authData(UP));
    }).not.toThrow();
  });

  it.each([
    ['backup eligible', BE],
    ['backed up', BS],
    ['both', BE | BS],
  ])('rejects %s', (_, flags) => {
    expect(() => {
      assertDeviceBound(authData(flags));
    }).toThrow(/sync/);
  });

  it('rejects truncated data', () => {
    expect(() => {
      assertDeviceBound(new Uint8Array(10));
    }).toThrow(KeyError);
  });
});

describe('generateKey', () => {
  it('skips the PRF extension for setters', async () => {
    const credentials = authenticator({ prfEnabled: false });
    await keysFor(credentials).generateKey({ id: new Uint8Array(1), name: 's' }, { prf: false });
    const [request] = credentials.create.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialCreationOptions }];
    expect(request.publicKey.extensions).toBeUndefined();
  });

  it('asks for a device-bound P-256 passkey with PRF and direct attestation', async () => {
    const credentials = authenticator();
    const key = await keysFor(credentials).generateKey({ id: new Uint8Array(1), name: 'holder-1' });
    const [request] = credentials.create.mock.calls[0] as unknown as [
      { publicKey: PublicKeyCredentialCreationOptions },
    ];
    expect(request.publicKey.attestation).toBe('direct');
    expect(request.publicKey.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(request.publicKey.extensions).toEqual({ prf: {} });
    expect(request.publicKey.authenticatorSelection?.userVerification).toBe(webauthn.userVerification);
    expect(key.credentialId).toEqual(credentialId);
    expect(key.passkeyPublicKey).toHaveLength(65);
    expect(key.passkeyPublicKey[0]).toBe(4);
  });

  it('rejects a synced passkey', async () => {
    const keys = keysFor(authenticator({ flags: UP | BE | BS }));
    expect(await codeOf(keys.generateKey({ id: new Uint8Array(1), name: 'h' }))).toBe('synced_passkey');
  });

  it('rejects an authenticator without PRF', async () => {
    const keys = keysFor(authenticator({ prfEnabled: false }));
    expect(await codeOf(keys.generateKey({ id: new Uint8Array(1), name: 'h' }))).toBe('prf_unavailable');
  });
});

describe('derived key', () => {
  it('is deterministic for one PRF output, sent with a fixed salt', async () => {
    const credentials = authenticator();
    const keys = keysFor(credentials);
    const first = await keys.getPublicKey(credentialId);
    expect(await keys.getPublicKey(credentialId)).toEqual(first);
    expect(first).toHaveLength(65);
    const salts = credentials.get.mock.calls.map((call) => {
      const [request] = call as unknown as [{ publicKey: PublicKeyCredentialRequestOptions }];
      return request.publicKey.extensions?.prf?.eval?.first;
    });
    expect(salts[0]).toEqual(salts[1]);
    expect(salts[0]).toEqual(utf8ToBytes(webauthn.prfSalt));
  });

  it('decrypts a share sealed to it', async () => {
    const keys = keysFor(authenticator());
    const sealed = await sealTo(await keys.getPublicKey(credentialId), new Uint8Array([7, 7]));
    expect(await keys.decryptShare(credentialId, examId, sealed)).toEqual(new Uint8Array([7, 7]));
  });

  it('fails when the PRF result is missing or the passkey has become synced', async () => {
    expect(await codeOf(keysFor(authenticator({ prf: null })).getPublicKey(credentialId))).toBe(
      'prf_unavailable',
    );
    expect(await codeOf(keysFor(authenticator({ flags: BS })).decryptShare(credentialId, examId, new Uint8Array()))).toBe(
      'synced_passkey',
    );
  });
});

describe('derived key purposes', () => {
  it('decryptShare rejects a keyPriv, and a share for another exam', async () => {
    const keys = keysFor(authenticator());
    const publicKey = await keys.getPublicKey(credentialId);
    const keyPriv = await sealTo(publicKey, new Uint8Array(32).fill(1), 'keyPriv');
    await expect(keys.decryptShare(credentialId, examId, keyPriv)).rejects.toThrow();
    const share = await sealTo(publicKey, new Uint8Array([1]));
    await expect(keys.decryptShare(credentialId, new Uint8Array(32), share)).rejects.toThrow();
  });

  it('openKeyPriv opens the 32-byte K_priv for a centre', async () => {
    const keys = keysFor(authenticator());
    const kPriv = new Uint8Array(32).fill(0x5a);
    const sealed = await sealTo(await keys.getPublicKey(credentialId), kPriv, 'keyPriv');
    expect(await keys.openKeyPriv(credentialId, examId, sealed)).toEqual(kPriv);
    const share = await sealTo(await keys.getPublicKey(credentialId), kPriv);
    await expect(keys.openKeyPriv(credentialId, examId, share)).rejects.toThrow();
  });
});

describe('register', () => {
  const challenge = new Uint8Array(32).fill(0x77);
  const inviteSecret = new Uint8Array(32).fill(0x33);

  const challengeOf = (call: unknown) =>
    (call as [{ publicKey: PublicKeyCredentialRequestOptions }])[0].publicKey.challenge;

  it('returns the POST /v1/register body, with the passkey signing the registration message', async () => {
    const credentials = authenticator();
    const keys = keysFor(credentials);
    const { credentialId: id, request } = await keys.register({ owner: 'centre-01', role: 'holder', challenge, inviteSecret });
    expect(id).toEqual(credentialId);

    const derived = await keys.getPublicKey(credentialId);
    expect(request.derivedPublicKey).toBe(`0x${Buffer.from(derived).toString('hex')}`);
    expect(request.owner).toBe('centre-01');
    expect(request.challenge).toBe(`0x${'77'.repeat(32)}`);
    expect(fromHex(request.passkeyPublicKey)).toHaveLength(65);
    expect(Object.keys(request).sort()).toEqual(
      ['attestationObject', 'authenticatorData', 'challenge', 'clientDataJSON', 'derivedPublicKey', 'inviteTag', 'owner', 'passkeyPublicKey', 'signature'],
    );
    // The tag is the HMAC of the invite secret over this passkey, and the secret itself is never sent.
    expect(request.inviteTag).toBe(toHex(inviteTag(inviteSecret, fromHex(request.passkeyPublicKey))));
    expect(JSON.stringify(request)).not.toContain(toHex(inviteSecret).slice(2));

    // The WebAuthn challenge of the signing get is the registration message hash.
    const expected = hashMessage('registration', {
      derivedPublicKey: derived,
      holderId: utf8ToBytes('centre-01'),
      challenge,
      inviteTag: fromHex(request.inviteTag),
    });
    expect(challengeOf(credentials.get.mock.calls[0])).toEqual(expected);
  });

  it('asks for the PRF output at creation and takes one create and one get when it is returned', async () => {
    const credentials = authenticator();
    await keysFor(credentials).register({ owner: 'n', role: 'holder', challenge, inviteSecret });
    const [request] = credentials.create.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialCreationOptions }];
    expect(request.publicKey.extensions?.prf?.eval?.first).toEqual(utf8ToBytes(webauthn.prfSalt));
    expect(credentials.create).toHaveBeenCalledTimes(1);
    expect(credentials.get).toHaveBeenCalledTimes(1);
  });

  it('derives the key with an extra get when the authenticator gives no PRF output at creation', async () => {
    const credentials = authenticator({ prfAtCreate: false });
    const keys = keysFor(credentials);
    const { request } = await keys.register({ owner: 'n', role: 'holder', challenge, inviteSecret });
    expect(credentials.get).toHaveBeenCalledTimes(2);
    expect(request.derivedPublicKey).toBe(`0x${Buffer.from(await keys.getPublicKey(credentialId)).toString('hex')}`);
  });

  it('registers a setter with no PRF key and an empty derived key', async () => {
    const credentials = authenticator({ prfEnabled: false, prf: null });
    const keys = keysFor(credentials);
    const { request, owner } = await keys.register({ role: 'setter', challenge, inviteSecret });
    const [create] = credentials.create.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialCreationOptions }];
    expect(create.publicKey.extensions).toBeUndefined();
    expect(request.derivedPublicKey).toBe('0x');
    // No name goes anywhere: the owner is the hash of the new passkey's public key.
    expect(owner).toBe(setterOwner(fromHex(request.passkeyPublicKey)));
    expect(request.owner).toBe(owner);
    const expected = hashMessage('registration', {
      derivedPublicKey: new Uint8Array(),
      holderId: utf8ToBytes(owner),
      challenge,
      inviteTag: fromHex(request.inviteTag),
    });
    expect(challengeOf(credentials.get.mock.calls[0])).toEqual(expected);
    const [get] = credentials.get.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialRequestOptions }];
    expect(get.publicKey.extensions).toBeUndefined();
    expect(get.publicKey.userVerification).toBe(webauthn.userVerification);
  });

  it('refuses a holder whose authenticator has no PRF, and any synced passkey', async () => {
    expect(await codeOf(keysFor(authenticator({ prfEnabled: false })).register({ owner: 'n', role: 'holder', challenge, inviteSecret }))).toBe('prf_unavailable');
    expect(await codeOf(keysFor(authenticator({ flags: UP | BE | BS })).register({ role: 'setter', challenge, inviteSecret }))).toBe('synced_passkey');
  });
});

describe('sign', () => {
  it('uses the message as the challenge and sends no PRF request', async () => {
    const credentials = authenticator();
    const message = new Uint8Array(32).fill(3);
    const signed = await keysFor(credentials).sign(credentialId, message);
    const [request] = credentials.get.mock.calls[0] as unknown as [
      { publicKey: PublicKeyCredentialRequestOptions },
    ];
    expect(request.publicKey.challenge).toEqual(message);
    expect(request.publicKey.userVerification).toBe(webauthn.userVerification);
    expect(request.publicKey.extensions).toBeUndefined();
    expect(signed.signature).toHaveLength(70);
  });

  it('rejects a synced passkey', async () => {
    const keys = keysFor(authenticator({ flags: BE }));
    expect(await codeOf(keys.sign(credentialId, new Uint8Array(32)))).toBe('synced_passkey');
  });
});

describe('releaseShare', () => {
  it('makes exactly one get, with the message as challenge and the PRF eval, and opens the share', async () => {
    const credentials = authenticator();
    const keys = keysFor(credentials);
    const sealed = await sealTo(await keys.getPublicKey(credentialId), new Uint8Array([4, 5, 6]));
    credentials.get.mockClear();

    const message = new Uint8Array(32).fill(5);
    const released = await keys.releaseShare(credentialId, examId, message, sealed);

    expect(credentials.get).toHaveBeenCalledTimes(1);
    const [request] = credentials.get.mock.calls[0] as unknown as [
      { publicKey: PublicKeyCredentialRequestOptions },
    ];
    expect(request.publicKey.challenge).toEqual(message);
    expect(request.publicKey.extensions?.prf?.eval?.first).toEqual(utf8ToBytes(webauthn.prfSalt));
    expect(released.share).toEqual(new Uint8Array([4, 5, 6]));
    expect(released.signature.signature).toHaveLength(70);
  });

  it('rejects a synced passkey and a missing PRF result', async () => {
    const message = new Uint8Array(32);
    expect(await codeOf(keysFor(authenticator({ flags: BE })).releaseShare(credentialId, examId, message, new Uint8Array()))).toBe(
      'synced_passkey',
    );
    expect(await codeOf(keysFor(authenticator({ prf: null })).releaseShare(credentialId, examId, message, new Uint8Array()))).toBe(
      'prf_unavailable',
    );
  });
});
