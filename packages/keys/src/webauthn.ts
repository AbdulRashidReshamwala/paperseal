import {
  hpkeDeriveKeyPair,
  hpkeSerializePublicKey,
  openKeyPriv,
  openShare,
  recoverP256PublicKeys,
} from '@paperseal/crypto';
import {
  hashMessage,
  inviteSecretBytes,
  inviteTag,
  noInviteTag,
  passkeyRecordValue,
  prfInput,
  setterOwner,
  toHex,
  utf8ToBytes,
  webauthn,
  type Hex,
} from '@paperseal/protocol';

import { assertDeviceBound } from './authenticator-data';
import { KeyError } from './errors';

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
  /** Credentials the key must not already hold. A key that holds one refuses, and nothing is made. */
  excludeCredentials?: readonly Uint8Array[];
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
  /** The invite's 32-byte secret. It never leaves this device: only `inviteTag` is sent. */
  inviteSecret: Uint8Array;
}

/**
 * A party registers for one exam with the permanent passkey from enrolment. `holderId` in the
 * `registration` message is the UTF-8 bytes of `owner`, and `inviteTag` is `noInviteTag`.
 */
export interface NameRegisterOptions {
  /** The party's ENS name. */
  owner: string;
  examId: Uint8Array;
  /** From the name's `ens.records.credential` record. */
  credentialId: Uint8Array;
  /** The name's `ens.records.passkey` record value. The key must hash to this. */
  passkey: Hex;
  /** Asked for only after the first touch, so it can't expire while the person finds their key. */
  challenge: () => Promise<Uint8Array>;
  /** From enrolment, if this browser did it. Empty otherwise. */
  attestationObject?: Uint8Array;
}

/** The body of `POST /v1/register`, as hex. It matches `RegisterRequest` in @paperseal/tee-client. */
export interface RegisterRequestBody {
  owner: string;
  /** `HMAC-SHA-256(inviteSecret, passkeyPublicKey)`, or 32 zero bytes for a registration by name. */
  inviteTag: Hex;
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
  /** The exam's derived public key. One touch. */
  getPublicKey(credentialId: Uint8Array, examId: Uint8Array): Promise<Uint8Array>;
  /** Opens a `share` sealed to the derived key. One touch. */
  decryptShare(credentialId: Uint8Array, examId: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
  /** Opens a centre's `keyPriv`, the 32-byte `K_priv`, with the derived key. One touch. */
  openKeyPriv(credentialId: Uint8Array, examId: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
  sign(credentialId: Uint8Array, message: Uint8Array): Promise<PasskeySignature>;
  /**
   * Everything `POST /v1/register` needs for a setter. The passkey signs the `registration` message
   * with a WebAuthn get, so one ceremony can't do it: a setter's `owner` is the hash of its new
   * passkey's public key, computed after the create and before the get. Two touches.
   */
  register(options: SetterRegisterOptions): Promise<Registration>;
  /**
   * Everything `POST /v1/register` needs for a party, from the passkey made at enrolment. Two touches,
   * because the derived public key is inside the signed message: one get gives the PRF output for this
   * exam, and a second signs. Throws `KeyError('wrong_key')` if the key doesn't hash to `passkey`.
   */
  registerByName(options: NameRegisterOptions): Promise<Registration>;
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

/** The key whose hash is `passkey` among those that could have signed this assertion. */
async function passkeyFrom(signature: PasskeySignature, passkey: Hex): Promise<Uint8Array> {
  const digest = async (bytes: Uint8Array) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', copy(bytes)));
  const signed = await digest(new Uint8Array([...signature.authenticatorData, ...(await digest(signature.clientDataJSON))]));
  const found = recoverP256PublicKeys(signature.signature, signed).find((key) => passkeyRecordValue(key) === passkey);
  if (!found) throw new KeyError('wrong_key', 'This security key is not the one published for this name.');
  return found;
}

const signatureOf = (response: AuthenticatorAssertionResponse): PasskeySignature => ({
  signature: new Uint8Array(response.signature),
  authenticatorData: new Uint8Array(response.authenticatorData),
  clientDataJSON: new Uint8Array(response.clientDataJSON),
});

function requestBody(
  owner: string,
  tag: Uint8Array,
  challenge: Uint8Array,
  passkeyPublicKey: Uint8Array,
  derivedPublicKey: Uint8Array,
  attestationObject: Uint8Array,
  signature: PasskeySignature,
): RegisterRequestBody {
  return {
    owner,
    inviteTag: toHex(tag),
    challenge: toHex(challenge),
    passkeyPublicKey: toHex(passkeyPublicKey),
    derivedPublicKey: toHex(derivedPublicKey),
    attestationObject: toHex(attestationObject),
    clientDataJSON: toHex(signature.clientDataJSON),
    signature: toHex(signature.signature),
    authenticatorData: toHex(signature.authenticatorData),
  };
}

function randomChallenge(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export function createWebAuthnKeys(options: WebAuthnKeysOptions): Keys {
  const { rpId, rpName } = options;
  const credentials = () => options.credentials ?? navigator.credentials;

  async function assertion(
    credentialId: Uint8Array,
    challenge: Uint8Array<ArrayBuffer>,
    /** The exam to derive for, or null for no PRF request. */
    examId: Uint8Array | null,
  ): Promise<{ credential: PublicKeyCredential; response: AuthenticatorAssertionResponse }> {
    const credential = await credentials().get({
      publicKey: {
        rpId,
        challenge,
        allowCredentials: [{ type: 'public-key', id: copy(credentialId) }],
        userVerification: USER_VERIFICATION,
        ...(examId ? { extensions: { prf: { eval: { first: copy(prfInput(examId)) } } } } : {}),
      },
    });
    if (!credential) throw new KeyError('ceremony_failed', 'The security key returned nothing.');
    const publicKey = credential as PublicKeyCredential;
    const response = publicKey.response as AuthenticatorAssertionResponse;
    assertDeviceBound(new Uint8Array(response.authenticatorData));
    return { credential: publicKey, response };
  }

  /** Re-derives the keypair in memory. It is never stored and goes out of scope with the caller. */
  async function deriveKeyPair(credentialId: Uint8Array, examId: Uint8Array): Promise<CryptoKeyPair> {
    const { credential } = await assertion(credentialId, randomChallenge(), examId);
    return keyPairFrom(credential);
  }

  async function keyPairFrom(credential: PublicKeyCredential): Promise<CryptoKeyPair> {
    const output = credential.getClientExtensionResults().prf?.results?.first as ArrayBuffer | undefined;
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

  async function create(user: { id: Uint8Array; name: string }, prf: boolean, exclude: readonly Uint8Array[] = []): Promise<GeneratedKey> {
    const made = credentials().create({
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
        ...(exclude.length > 0
          ? { excludeCredentials: exclude.map((id) => ({ type: 'public-key' as const, id: copy(id) })) }
          : {}),
        ...(prf ? { extensions: { prf: {} } } : {}),
      },
    });
    const credential = await made.catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'InvalidStateError') {
        throw new KeyError('already_enrolled', 'This security key is already set up. Nothing new was made.');
      }
      throw error;
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
    return {
      credentialId: new Uint8Array(publicKey.rawId),
      passkeyPublicKey: new Uint8Array(spki).slice(-65),
      attestationObject: new Uint8Array(response.attestationObject),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
    };
  }

  return {
    generateKey(user, options = {}) {
      return create(user, options.prf ?? true, options.excludeCredentials);
    },

    async register({ challenge, inviteSecret }) {
      // Checked before the create, so a bad secret never costs a security key touch.
      if (inviteSecret.length !== inviteSecretBytes) throw new RangeError('inviteSecret must be 32 bytes');
      // A setter has no name to derive an id from, so its user handle is random.
      const created = await create({ id: globalThis.crypto.getRandomValues(new Uint8Array(32)), name: 'Setter' }, false);
      const owner = setterOwner(created.passkeyPublicKey);
      const derivedPublicKey = new Uint8Array();
      // The tag binds the invite to this passkey, so it can only be made after the create.
      const tag = inviteTag(inviteSecret, created.passkeyPublicKey);
      const message = hashMessage('registration', { derivedPublicKey, holderId: utf8ToBytes(owner), challenge, inviteTag: tag });
      const { response } = await assertion(created.credentialId, copy(message), null);
      return {
        credentialId: created.credentialId,
        owner,
        request: requestBody(owner, tag, challenge, created.passkeyPublicKey, derivedPublicKey, created.attestationObject, signatureOf(response)),
      };
    },

    async registerByName({ owner, examId, credentialId, passkey, challenge, attestationObject }) {
      // The first touch gives the derived key, and shows whether this is the published key.
      const first = await assertion(credentialId, randomChallenge(), examId);
      const passkeyPublicKey = await passkeyFrom(signatureOf(first.response), passkey);
      const pair = await keyPairFrom(first.credential);
      const derivedPublicKey = await hpkeSerializePublicKey(pair.publicKey);
      const fresh = await challenge();
      const message = hashMessage('registration', { derivedPublicKey, holderId: utf8ToBytes(owner), challenge: fresh, inviteTag: noInviteTag });
      const { response } = await assertion(credentialId, copy(message), null);
      return {
        credentialId,
        owner,
        request: requestBody(owner, noInviteTag, fresh, passkeyPublicKey, derivedPublicKey, attestationObject ?? new Uint8Array(), signatureOf(response)),
      };
    },

    async getPublicKey(credentialId, examId) {
      const pair = await deriveKeyPair(credentialId, examId);
      return hpkeSerializePublicKey(pair.publicKey);
    },

    async decryptShare(credentialId, examId, sealed) {
      return openShare(await deriveKeyPair(credentialId, examId), examId, sealed);
    },

    async openKeyPriv(credentialId, examId, sealed) {
      return openKeyPriv(await deriveKeyPair(credentialId, examId), examId, sealed);
    },

    async sign(credentialId, message) {
      const { response } = await assertion(credentialId, copy(message), null);
      return signatureOf(response);
    },

    async releaseShare(credentialId, examId, message, sealedShare) {
      const { credential, response } = await assertion(credentialId, copy(message), examId);
      const signature = signatureOf(response);
      // The key pair lives only in this scope and is dropped when it returns.
      const share = await openShare(await keyPairFrom(credential), examId, sealedShare);
      return { share, signature };
    },
  };
}
