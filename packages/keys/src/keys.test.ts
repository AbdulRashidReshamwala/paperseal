import { hpkeContext, hpkeSeal } from '@paperseal/crypto';
import { p256 } from '@noble/curves/nist';
import { fromHex, hashMessage, inviteTag, noInviteTag, prfInput, setterOwner, toHex, utf8ToBytes, webauthn, type Hex } from '@paperseal/protocol';
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

const keysFor = (credentials: { create: unknown; get: unknown }) =>
  createWebAuthnKeys({ rpId: 'localhost', rpName: 'Paper Seal', credentials: credentials as Pick<CredentialsContainer, 'create' | 'get'> });

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
    const first = await keys.getPublicKey(credentialId, examId);
    expect(await keys.getPublicKey(credentialId, examId)).toEqual(first);
    expect(first).toHaveLength(65);
    const salts = credentials.get.mock.calls.map((call) => {
      const [request] = call as unknown as [{ publicKey: PublicKeyCredentialRequestOptions }];
      return request.publicKey.extensions?.prf?.eval?.first;
    });
    expect(salts[0]).toEqual(salts[1]);
    expect(salts[0]).toEqual(prfInput(examId));
  });

  it('decrypts a share sealed to it', async () => {
    const keys = keysFor(authenticator());
    const sealed = await sealTo(await keys.getPublicKey(credentialId, examId), new Uint8Array([7, 7]));
    expect(await keys.decryptShare(credentialId, examId, sealed)).toEqual(new Uint8Array([7, 7]));
  });

  it('fails when the PRF result is missing or the passkey has become synced', async () => {
    expect(await codeOf(keysFor(authenticator({ prf: null })).getPublicKey(credentialId, examId))).toBe(
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
    const publicKey = await keys.getPublicKey(credentialId, examId);
    const keyPriv = await sealTo(publicKey, new Uint8Array(32).fill(1), 'keyPriv');
    await expect(keys.decryptShare(credentialId, examId, keyPriv)).rejects.toThrow();
    const share = await sealTo(publicKey, new Uint8Array([1]));
    await expect(keys.decryptShare(credentialId, new Uint8Array(32), share)).rejects.toThrow();
  });

  it('openKeyPriv opens the 32-byte K_priv for a centre', async () => {
    const keys = keysFor(authenticator());
    const kPriv = new Uint8Array(32).fill(0x5a);
    const sealed = await sealTo(await keys.getPublicKey(credentialId, examId), kPriv, 'keyPriv');
    expect(await keys.openKeyPriv(credentialId, examId, sealed)).toEqual(kPriv);
    const share = await sealTo(await keys.getPublicKey(credentialId, examId), kPriv);
    await expect(keys.openKeyPriv(credentialId, examId, share)).rejects.toThrow();
  });
});

describe('register', () => {
  const challenge = new Uint8Array(32).fill(0x77);
  const inviteSecret = new Uint8Array(32).fill(0x33);
  const challengeOf = (call: unknown) => (call as [{ publicKey: PublicKeyCredentialRequestOptions }])[0].publicKey.challenge;

  it('registers a setter with no PRF key and an empty derived key', async () => {
    const credentials = authenticator({ prfEnabled: false, prf: null });
    const keys = keysFor(credentials);
    const { request, owner, credentialId: id } = await keys.register({ role: 'setter', challenge, inviteSecret });
    expect(id).toEqual(credentialId);
    const [create] = credentials.create.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialCreationOptions }];
    expect(create.publicKey.extensions).toBeUndefined();
    expect(request.derivedPublicKey).toBe('0x');
    expect(Object.keys(request).sort()).toEqual(
      ['attestationObject', 'authenticatorData', 'challenge', 'clientDataJSON', 'derivedPublicKey', 'inviteTag', 'owner', 'passkeyPublicKey', 'signature'],
    );
    // The tag is the HMAC of the invite secret over this passkey, and the secret itself is never sent.
    expect(request.inviteTag).toBe(toHex(inviteTag(inviteSecret, fromHex(request.passkeyPublicKey))));
    expect(JSON.stringify(request)).not.toContain(toHex(inviteSecret).slice(2));
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

  it('refuses a synced passkey', async () => {
    expect(await codeOf(keysFor(authenticator({ flags: UP | BE | BS })).register({ role: 'setter', challenge, inviteSecret }))).toBe('synced_passkey');
  });
});

describe('enrolment', () => {
  it('asks for a PRF passkey and passes the known keys as excludeCredentials', async () => {
    const credentials = authenticator();
    const known = new Uint8Array([7, 7]);
    await keysFor(credentials).generateKey({ id: new Uint8Array(32), name: 'Paper Seal key' }, { excludeCredentials: [known] });
    const [request] = credentials.create.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialCreationOptions }];
    expect(request.publicKey.extensions?.prf).toEqual({});
    expect(request.publicKey.excludeCredentials?.map(({ id }) => id)).toEqual([known]);
  });

  it('turns a key that already holds one into already_enrolled, and keeps other failures', async () => {
    const refused = authenticator();
    refused.create.mockRejectedValueOnce(new DOMException('known', 'InvalidStateError'));
    expect(await codeOf(keysFor(refused).generateKey({ id: new Uint8Array(32), name: 'k' }))).toBe('already_enrolled');
    const cancelled = authenticator();
    cancelled.create.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    await expect(keysFor(cancelled).generateKey({ id: new Uint8Array(32), name: 'k' })).rejects.toThrow('no');
  });
});

describe('registerByName', () => {
  const owner = 'centre-1.paperseal-demo.eth';
  const challenge = new Uint8Array(32).fill(0x77);

  /** A real software P-256 passkey, because the first touch recovers the public key from a signature. */
  function signingKey() {
    const secret = p256.utils.randomPrivateKey();
    const publicKey = p256.getPublicKey(secret, false);
    const clientDataJSON = utf8ToBytes('{"type":"webauthn.get"}');
    const authenticatorData = authData(UP);
    const get = vi.fn(async (options: { publicKey: PublicKeyCredentialRequestOptions }) => {
      const clientHash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(clientDataJSON)));
      const signed = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array([...authenticatorData, ...clientHash])));
      const prfRequested = options.publicKey.extensions?.prf !== undefined;
      return {
        getClientExtensionResults: () => (prfRequested ? { prf: { results: { first: prfOutput.slice().buffer } } } : {}),
        response: {
          signature: p256.sign(signed, secret).toDERRawBytes().slice().buffer,
          authenticatorData: authenticatorData.slice().buffer,
          clientDataJSON: clientDataJSON.slice().buffer,
        },
      } as unknown as Credential;
    });
    return { publicKey, credentials: { create: vi.fn(), get } };
  }

  const options = (passkey: Hex) => ({
    owner,
    examId,
    credentialId,
    passkey,
    challenge: () => Promise.resolve(challenge),
  });

  it('takes two gets: the exam PRF first, then the signature with a zero tag', async () => {
    const { publicKey, credentials } = signingKey();
    const keys = keysFor(credentials);
    const { request } = await keys.registerByName(options(setterOwner(publicKey)));
    expect(credentials.get).toHaveBeenCalledTimes(2);
    const [first] = credentials.get.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialRequestOptions }];
    expect(first.publicKey.extensions?.prf?.eval?.first).toEqual(prfInput(examId));
    expect(first.publicKey.allowCredentials?.map(({ id }) => id)).toEqual([credentialId]);
    const [second] = credentials.get.mock.calls[1] as unknown as [{ publicKey: PublicKeyCredentialRequestOptions }];
    expect(second.publicKey.extensions).toBeUndefined();
    expect(request.passkeyPublicKey).toBe(toHex(publicKey));
    expect(request.inviteTag).toBe(`0x${'00'.repeat(32)}`);
    expect(request.attestationObject).toBe('0x');
    expect(request.owner).toBe(owner);
    const expected = hashMessage('registration', {
      derivedPublicKey: fromHex(request.derivedPublicKey),
      holderId: utf8ToBytes(owner),
      challenge,
      inviteTag: noInviteTag,
    });
    expect(second.publicKey.challenge).toEqual(expected);
  });

  it('resends the attestation object from enrolment', async () => {
    const { publicKey, credentials } = signingKey();
    const { request } = await keysFor(credentials).registerByName({ ...options(setterOwner(publicKey)), attestationObject: new Uint8Array([1, 2]) });
    expect(request.attestationObject).toBe('0x0102');
  });

  it('stops after one touch when the key is not the published one', async () => {
    const { credentials } = signingKey();
    const other = setterOwner(fromHex(`0x04${'11'.repeat(64)}`));
    expect(await codeOf(keysFor(credentials).registerByName(options(other)))).toBe('wrong_key');
    expect(credentials.get).toHaveBeenCalledTimes(1);
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
    const sealed = await sealTo(await keys.getPublicKey(credentialId, examId), new Uint8Array([4, 5, 6]));
    credentials.get.mockClear();

    const message = new Uint8Array(32).fill(5);
    const released = await keys.releaseShare(credentialId, examId, message, sealed);

    expect(credentials.get).toHaveBeenCalledTimes(1);
    const [request] = credentials.get.mock.calls[0] as unknown as [
      { publicKey: PublicKeyCredentialRequestOptions },
    ];
    expect(request.publicKey.challenge).toEqual(message);
    expect(request.publicKey.extensions?.prf?.eval?.first).toEqual(prfInput(examId));
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
