import {
  hpkeDeriveKeyPair,
  hpkeOpen,
  hpkeSerializePublicKey,
} from '@paperseal/crypto';
import { utf8ToBytes, webauthn } from '@paperseal/protocol';

import { assertDeviceBound } from './authenticator-data';
import { KeyError } from './errors';

/** The fixed PRF salt, from spec/constants.json. */
const PRF_SALT = utf8ToBytes(webauthn.prfSalt);
/** The spec's user-verification policy, narrowed once from the JSON's string type. */
const USER_VERIFICATION = webauthn.userVerification as UserVerificationRequirement;
const ES256 = -7;
/** A P-256 SubjectPublicKeyInfo: a 26-byte header, then the 65-byte point. */
const P256_SPKI_BYTES = 91;

export interface GeneratedKey {
  credentialId: Uint8Array;
  /** The passkey's own 65-byte uncompressed P-256 public key. */
  passkeyPublicKey: Uint8Array;
  /** Returned to the TEE, which verifies the attestation chain. */
  attestationObject: Uint8Array;
  clientDataJSON: Uint8Array;
}

/** A WebAuthn assertion over the message, which is used as the challenge. */
export interface PasskeySignature {
  signature: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
}

/** The key interface from the README. Each call that uses a key needs a touch. */
export interface Keys {
  generateKey(user: { id: Uint8Array; name: string }): Promise<GeneratedKey>;
  getPublicKey(credentialId: Uint8Array): Promise<Uint8Array>;
  decryptShare(credentialId: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
  sign(credentialId: Uint8Array, message: Uint8Array): Promise<PasskeySignature>;
  /**
   * One touch: a single WebAuthn get carries the message as the challenge and the PRF request.
   * It opens the sealed share with the derived key, discards the key, and returns the share
   * with the passkey signature over the message.
   */
  releaseShare(
    credentialId: Uint8Array,
    message: Uint8Array,
    sealedShare: Uint8Array,
  ): Promise<ReleasedShare>;
}

export interface ReleasedShare {
  share: Uint8Array;
  signature: PasskeySignature;
}

export interface WebAuthnKeysOptions {
  /** Relying party ID. Passkeys only work on this domain. */
  rpId: string;
  rpName: string;
  /** Defaults to the browser's container. The same code serves hardware keys and Chrome's virtual authenticator. */
  credentials?: Pick<CredentialsContainer, 'create' | 'get'>;
}

const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const signatureOf = (response: AuthenticatorAssertionResponse): PasskeySignature => ({
  signature: new Uint8Array(response.signature),
  authenticatorData: new Uint8Array(response.authenticatorData),
  clientDataJSON: new Uint8Array(response.clientDataJSON),
});

function randomChallenge(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export function createWebAuthnKeys(options: WebAuthnKeysOptions): Keys {
  const { rpId, rpName } = options;
  const credentials = () => options.credentials ?? navigator.credentials;

  async function assertion(
    credentialId: Uint8Array,
    challenge: Uint8Array<ArrayBuffer>,
    prf: boolean,
  ): Promise<{ credential: PublicKeyCredential; response: AuthenticatorAssertionResponse }> {
    const credential = await credentials().get({
      publicKey: {
        rpId,
        challenge,
        allowCredentials: [{ type: 'public-key', id: copy(credentialId) }],
        userVerification: USER_VERIFICATION,
        ...(prf ? { extensions: { prf: { eval: { first: copy(PRF_SALT) } } } } : {}),
      },
    });
    if (!credential) throw new KeyError('ceremony_failed', 'The security key returned nothing.');
    const publicKey = credential as PublicKeyCredential;
    const response = publicKey.response as AuthenticatorAssertionResponse;
    assertDeviceBound(new Uint8Array(response.authenticatorData));
    return { credential: publicKey, response };
  }

  /** Re-derives the keypair in memory. It is never stored and goes out of scope with the caller. */
  async function deriveKeyPair(credentialId: Uint8Array): Promise<CryptoKeyPair> {
    const { credential } = await assertion(credentialId, randomChallenge(), true);
    return keyPairFrom(credential);
  }

  async function keyPairFrom(credential: PublicKeyCredential): Promise<CryptoKeyPair> {
    const output = credential.getClientExtensionResults().prf?.results?.first;
    if (!output) {
      throw new KeyError('prf_unavailable', 'This security key does not support the PRF extension.');
    }
    const secret = new Uint8Array(output as ArrayBuffer);
    try {
      return await hpkeDeriveKeyPair(secret);
    } finally {
      secret.fill(0);
    }
  }

  return {
    async generateKey(user) {
      const credential = await credentials().create({
        publicKey: {
          rp: { id: rpId, name: rpName },
          user: { id: copy(user.id), name: user.name, displayName: user.name },
          challenge: randomChallenge(),
          pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
          authenticatorSelection: {
            authenticatorAttachment: 'cross-platform',
            residentKey: 'required',
            userVerification: USER_VERIFICATION,
          },
          attestation: 'direct',
          extensions: { prf: {} },
        },
      });
      if (!credential) throw new KeyError('ceremony_failed', 'The security key returned nothing.');
      const publicKey = credential as PublicKeyCredential;
      const response = publicKey.response as AuthenticatorAttestationResponse;
      assertDeviceBound(new Uint8Array(response.getAuthenticatorData()));

      if (!publicKey.getClientExtensionResults().prf?.enabled) {
        throw new KeyError('prf_unavailable', 'This security key does not support the PRF extension.');
      }
      const spki = response.getPublicKey();
      if (response.getPublicKeyAlgorithm() !== ES256 || spki?.byteLength !== P256_SPKI_BYTES) {
        throw new KeyError('unsupported_key', 'The passkey is not a P-256 key.');
      }
      return {
        credentialId: new Uint8Array(publicKey.rawId),
        passkeyPublicKey: new Uint8Array(spki).slice(-65),
        attestationObject: new Uint8Array(response.attestationObject),
        clientDataJSON: new Uint8Array(response.clientDataJSON),
      };
    },

    async getPublicKey(credentialId) {
      const pair = await deriveKeyPair(credentialId);
      return hpkeSerializePublicKey(pair.publicKey);
    },

    async decryptShare(credentialId, sealed) {
      return hpkeOpen(await deriveKeyPair(credentialId), sealed);
    },

    async sign(credentialId, message) {
      const { response } = await assertion(credentialId, copy(message), false);
      return signatureOf(response);
    },

    async releaseShare(credentialId, message, sealedShare) {
      const { credential, response } = await assertion(credentialId, copy(message), true);
      const signature = signatureOf(response);
      // The key pair lives only in this scope and is dropped when it returns.
      const share = await hpkeOpen(await keyPairFrom(credential), sealedShare);
      return { share, signature };
    },
  };
}
