import {
  hpkeDeriveKeyPair,
  hpkeSerializePublicKey,
  openKeyPriv,
  openShare,
} from '@paperseal/crypto';
import { hashMessage, setterOwner, toHex, utf8ToBytes, webauthn, type Hex } from '@paperseal/protocol';

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

export interface GenerateKeyOptions {
  /**
   * Require the PRF extension, which a derived key needs. Defaults to true. Setters have no
   * derived key, so they register with `prf: false` and any device-bound passkey will do.
   */
  prf?: boolean;
}

/**
 * A key holder registers under a name for roles 2 to 4, so its passkey must support PRF.
 * `holderId` in the `registration` message is the UTF-8 bytes of `owner`.
 */
export interface HolderRegisterOptions {
  role: 'holder';
  /** The name on the approved list. */
  owner: string;
  /** From `POST /v1/register/challenge`. Any length: the TEE chooses it. */
  challenge: Uint8Array;
}

/**
 * A setter registers no derived key and needs no PRF. It has no name: its `owner` is
 * `setterOwner(passkeyPublicKey)`, which can only be computed once the passkey exists, so it is
 * made after the create and before the passkey signs `registration`.
 */
export interface SetterRegisterOptions {
  role: 'setter';
  /** From `POST /v1/register/challenge`. Any length: the TEE chooses it. */
  challenge: Uint8Array;
}

export type RegisterOptions = HolderRegisterOptions | SetterRegisterOptions;

/** The body of `POST /v1/register`, as hex. It matches `RegisterRequest` in @paperseal/tee-client. */
export interface RegisterRequestBody {
  owner: string;
  challenge: Hex;
  passkeyPublicKey: Hex;
  /** `0x` for setters. */
  derivedPublicKey: Hex;
  attestationObject: Hex;
  clientDataJSON: Hex;
  signature: Hex;
  authenticatorData: Hex;
}

export interface Registration {
  credentialId: Uint8Array;
  /** The name a holder gave, or a setter's `setterOwner` hash. Equal to `request.owner`. */
  owner: string;
  request: RegisterRequestBody;
}

/** The key interface from the README. Each call that uses a key needs a touch. */
export interface Keys {
  generateKey(user: { id: Uint8Array; name: string }, options?: GenerateKeyOptions): Promise<GeneratedKey>;
  getPublicKey(credentialId: Uint8Array): Promise<Uint8Array>;
  /** Opens a `share` sealed to the derived key. One touch. */
  decryptShare(credentialId: Uint8Array, examId: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
  /** Opens a centre's `keyPriv`, the 32-byte `K_priv`, with the derived key. One touch. */
  openKeyPriv(credentialId: Uint8Array, examId: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
  sign(credentialId: Uint8Array, message: Uint8Array): Promise<PasskeySignature>;
  /**
   * Everything `POST /v1/register` needs. The passkey signs the `registration` message with a
   * WebAuthn get, so one ceremony can't do it: the passkey must exist first, and a holder's
   * derived key goes into the message. A setter's `owner` is the hash of its new passkey's
   * public key, computed after the create and before the get. A setter takes a create and a get. A holder takes a
   * create and a get, plus a second get for the derived key when the authenticator doesn't
   * return the PRF output at creation.
   */
  register(options: RegisterOptions): Promise<Registration>;
  /**
   * One touch: a single WebAuthn get carries the message as the challenge and the PRF request.
   * It opens the sealed `share` with the derived key, discards the key, and returns the share
   * with the passkey signature over the message.
   */
  releaseShare(
    credentialId: Uint8Array,
    examId: Uint8Array,
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
    return keyPairFromOutput(credential.getClientExtensionResults().prf?.results?.first as ArrayBuffer | undefined);
  }

  async function keyPairFromOutput(output: ArrayBuffer | undefined): Promise<CryptoKeyPair> {
    if (!output) {
      throw new KeyError('prf_unavailable', 'This security key does not support the PRF extension.');
    }
    const secret = new Uint8Array(output);
    try {
      return await hpkeDeriveKeyPair(secret);
    } finally {
      secret.fill(0);
    }
  }

  /** One create. With `evalPrf`, also asks for the PRF output at creation, which not every authenticator gives. */
  async function create(
    user: { id: Uint8Array; name: string },
    prf: boolean,
    evalPrf: boolean,
  ): Promise<GeneratedKey & { prfOutput?: ArrayBuffer }> {
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
        ...(prf
          ? { extensions: { prf: evalPrf ? { eval: { first: copy(PRF_SALT) } } : {} } }
          : {}),
      },
    });
    if (!credential) throw new KeyError('ceremony_failed', 'The security key returned nothing.');
    const publicKey = credential as PublicKeyCredential;
    const response = publicKey.response as AuthenticatorAttestationResponse;
    assertDeviceBound(new Uint8Array(response.getAuthenticatorData()));

    const prfResult = publicKey.getClientExtensionResults().prf;
    if (prf && !prfResult?.enabled) {
      throw new KeyError('prf_unavailable', 'This security key does not support the PRF extension.');
    }
    const spki = response.getPublicKey();
    if (response.getPublicKeyAlgorithm() !== ES256 || spki?.byteLength !== P256_SPKI_BYTES) {
      throw new KeyError('unsupported_key', 'The passkey is not a P-256 key.');
    }
    const prfOutput = prfResult?.results?.first as ArrayBuffer | undefined;
    return {
      credentialId: new Uint8Array(publicKey.rawId),
      passkeyPublicKey: new Uint8Array(spki).slice(-65),
      attestationObject: new Uint8Array(response.attestationObject),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
      ...(prfOutput ? { prfOutput } : {}),
    };
  }

  const generated = ({ prfOutput: _output, ...key }: GeneratedKey & { prfOutput?: ArrayBuffer }): GeneratedKey => key;

  return {
    async generateKey(user, options = {}) {
      return generated(await create(user, options.prf ?? true, false));
    },

    async register(options) {
      const { role, challenge } = options;
      const holder = role === 'holder';
      // A setter has no name to derive an id from, so its user handle is random.
      const userId = holder
        ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', copy(utf8ToBytes(options.owner))))
        : globalThis.crypto.getRandomValues(new Uint8Array(32));
      const created = await create({ id: userId, name: holder ? options.owner : 'Setter' }, holder, holder);
      const owner = holder ? options.owner : setterOwner(created.passkeyPublicKey);

      let derivedPublicKey: Uint8Array = new Uint8Array();
      if (holder) {
        // The create gives the PRF output when the authenticator can. Otherwise this is a second touch.
        const pair = created.prfOutput
          ? await keyPairFromOutput(created.prfOutput)
          : await deriveKeyPair(created.credentialId);
        derivedPublicKey = await hpkeSerializePublicKey(pair.publicKey);
      }

      const message = hashMessage('registration', {
        derivedPublicKey,
        holderId: utf8ToBytes(owner),
        challenge,
      });
      const { response } = await assertion(created.credentialId, copy(message), false);
      const signature = signatureOf(response);
      return {
        credentialId: created.credentialId,
        owner,
        request: {
          owner,
          challenge: toHex(challenge),
          passkeyPublicKey: toHex(created.passkeyPublicKey),
          derivedPublicKey: toHex(derivedPublicKey),
          attestationObject: toHex(created.attestationObject),
          clientDataJSON: toHex(signature.clientDataJSON),
          signature: toHex(signature.signature),
          authenticatorData: toHex(signature.authenticatorData),
        },
      };
    },

    async getPublicKey(credentialId) {
      const pair = await deriveKeyPair(credentialId);
      return hpkeSerializePublicKey(pair.publicKey);
    },

    async decryptShare(credentialId, examId, sealed) {
      return openShare(await deriveKeyPair(credentialId), examId, sealed);
    },

    async openKeyPriv(credentialId, examId, sealed) {
      return openKeyPriv(await deriveKeyPair(credentialId), examId, sealed);
    },

    async sign(credentialId, message) {
      const { response } = await assertion(credentialId, copy(message), false);
      return signatureOf(response);
    },

    async releaseShare(credentialId, examId, message, sealedShare) {
      const { credential, response } = await assertion(credentialId, copy(message), true);
      const signature = signatureOf(response);
      // The key pair lives only in this scope and is dropped when it returns.
      const share = await openShare(await keyPairFrom(credential), examId, sealedShare);
      return { share, signature };
    },
  };
}
