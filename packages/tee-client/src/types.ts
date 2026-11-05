import type { DecimalString, Hex, ReleaseEntryWire, Stage } from '@paperseal/protocol';

/*
 * Request and response bodies are the "TEE API" table in spec/api.md, field for field.
 * Bytes are lowercase 0x hex. Integers that can exceed 2^53 are decimal strings.
 */

/** `GET /v1/attestation`. The app checks all of it with @paperseal/attestation before trusting any other route. */
export interface AttestationResponse {
  /** Google-signed Confidential Space token. */
  token: string;
  /** The P-256 signing key. It signs every TEE message, and `eat_nonce` binds it. */
  instancePublicKey: Hex;
  /** The P-256 key that opens HPKE messages sent to the TEE. */
  encryptionPublicKey: Hex;
  /** `instancePublicKey`'s signature over the `instanceKey` message. */
  instanceKeySignature: Hex;
  /** Present in real responses. The app does not rely on it: only the token's checks establish trust. */
  attested?: boolean;
}

/**
 * The TEE's P-256 signature (64-byte r || s) over the `approvedList` message. Apps compare
 * `hash` with the chain and check the signature against `instancePublicKey`.
 */
export interface SignedApprovedList {
  examId: Hex;
  /** abi.encode(Entry[]), as posted on chain. */
  entries: Hex;
  hash: Hex;
  teeSignature: Hex;
}

/** `GET /v1/status`. `approvedList` is present once onboarding has finished. */
export interface StatusResponse {
  stage: Stage;
  questionCount: number;
  approvedList?: SignedApprovedList;
  /** Hex identifiers of accepted releases (spec/api.md does not say which key), and the number needed. */
  release: { released: Hex[]; required: number };
}

/**
 * The response of every `.../challenge` route. An opaque token: 32 random bytes plus an expiry, authenticated by the TEE. It is
 * single use and expires after 5 minutes. Its width is the TEE's choice, so callers pass it back and sign it as given.
 * Release challenges are refused until `unlockRound` is published (see `isReleaseNotOpen`).
 */
export interface ChallengeResponse {
  challenge: Hex;
}

/** A WebAuthn assertion over a message hash, as three hex fields. */
export interface PasskeySignatureWire {
  signature: Hex;
  authenticatorData: Hex;
  clientDataJSON: Hex;
}

/** `POST /v1/register`. `signature` covers the `registration` message. */
export interface RegisterRequest extends PasskeySignatureWire {
  owner: string;
  challenge: Hex;
  passkeyPublicKey: Hex;
  /** Empty (`0x`) for setters. */
  derivedPublicKey: Hex;
  attestationObject: Hex;
}

/** One verified registration. `derivedPublicKey` is `0x` for a setter. */
export interface RegistrationEntry {
  owner: string;
  passkeyPublicKey: Hex;
  derivedPublicKey: Hex;
}

/** `GET /v1/registrations`. The role is the board's choice, so it is not here. */
export interface RegistrationsResponse {
  registrations: RegistrationEntry[];
}

/** `POST /v1/questions`. `ciphertext` is the padded question sealed with the `question` purpose. */
export interface QuestionRequest extends PasskeySignatureWire {
  passkeyPublicKey: Hex;
  ciphertext: Hex;
  challenge: Hex;
}

/** `teeSignature` covers the `questionReceipt` message. */
export interface QuestionReceipt {
  questionHash: Hex;
  teeSignature: Hex;
}

/** The only outbox message kind is the Build. `teeSignature` covers the `build` message. */
export interface OutboxMessage {
  kind: 'build';
  examId: Hex;
  fields: Record<string, Hex | DecimalString | number>;
  teeSignature: Hex;
  instancePublicKey: Hex;
}

export interface OutboxResponse {
  messages: OutboxMessage[];
}

/** `POST /v1/release/share`. `sealed` is the `release` plaintext sealed with the `release` purpose. */
export interface ReleaseShareRequest {
  passkeyPublicKey: Hex;
  challenge: Hex;
  sealed: Hex;
}

/** `GET /v1/release/log`. `teeSignature` covers the `releaseLog` message, under `instancePublicKey`. */
export interface ReleaseLogResponse {
  examId: Hex;
  entries: ReleaseEntryWire[];
  entriesHash: Hex;
  teeSignature: Hex;
  instancePublicKey: Hex;
}

/** Routes that answer `{}`. */
export type EmptyResponse = Record<string, never>;
