import { hpkeSeal } from '@paperseal/crypto';
import { utf8ToBytes, webauthn } from '@paperseal/protocol';
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
const prfOutput = new Uint8Array(32).fill(9);
const spki = () => {
  const out = new Uint8Array(91);
  out[26] = 4;
  return out;
};

/** A stand-in for the browser's credential API, the external boundary in tests. */
function authenticator(options: { flags?: number; prf?: ArrayBuffer | null; prfEnabled?: boolean } = {}) {
  const { flags = UP, prf = prfOutput.slice().buffer, prfEnabled = true } = options;
  return {
    create: vi.fn(() =>
      Promise.resolve({
        rawId: credentialId.slice().buffer,
        getClientExtensionResults: () => ({ prf: { enabled: prfEnabled } }),
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
    const sealed = await hpkeSeal(await keys.getPublicKey(credentialId), new Uint8Array([7, 7]));
    expect(await keys.decryptShare(credentialId, sealed)).toEqual(new Uint8Array([7, 7]));
  });

  it('fails when the PRF result is missing or the passkey has become synced', async () => {
    expect(await codeOf(keysFor(authenticator({ prf: null })).getPublicKey(credentialId))).toBe(
      'prf_unavailable',
    );
    expect(await codeOf(keysFor(authenticator({ flags: BS })).decryptShare(credentialId, new Uint8Array()))).toBe(
      'synced_passkey',
    );
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
    const sealed = await hpkeSeal(await keys.getPublicKey(credentialId), new Uint8Array([4, 5, 6]));
    credentials.get.mockClear();

    const message = new Uint8Array(32).fill(5);
    const released = await keys.releaseShare(credentialId, message, sealed);

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
    expect(await codeOf(keysFor(authenticator({ flags: BE })).releaseShare(credentialId, message, new Uint8Array()))).toBe(
      'synced_passkey',
    );
    expect(await codeOf(keysFor(authenticator({ prf: null })).releaseShare(credentialId, message, new Uint8Array()))).toBe(
      'prf_unavailable',
    );
  });
});
