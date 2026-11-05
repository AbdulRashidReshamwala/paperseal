import type { DecimalString, Hex, Stage } from '@paperseal/protocol';

/*
 * docs/ARCHITECTURE.md says request and response bodies are defined in
 * spec/api.md, but that file does not define them yet. These shapes are
 * inferred from the README and are provisional until the spec has them.
 */

export interface AttestationResponse {
  /** Google-signed Confidential Space token. */
  token: string;
  instancePublicKey: Hex;
}

export interface StatusResponse {
  stage: Stage;
  /** Once onboarding has finished. `hash` is the `approvedList` message hash, which apps compare with the chain. */
  approvedList?: SignedApprovedList;
  release: { holders: string[]; required: number };
}

/**
 * The TEE's P-256 signature (64-byte r || s) over the `approvedList` message
 * hash. The Confirm step checks `hash` against the chain and the signature
 * against `instancePublicKey`.
 */
export interface SignedApprovedList {
  examId: Hex;
  /** abi.encode(Entry[]), as posted on chain. */
  entries: Hex;
  hash: Hex;
  teeSignature: Hex;
}

export interface ChallengeResponse {
  challenge: Hex;
}

export interface RegisterChallengeRequest {
  holderId: string;
}

export interface PasskeySignatureWire {
  signature: Hex;
  authenticatorData: Hex;
  clientDataJSON: Hex;
}

export interface RegisterRequest {
  holderId: string;
  owner: string;
  challenge: Hex;
  passkeyPublicKey: Hex;
  derivedPublicKey: Hex;
  attestationObject: Hex;
  clientDataJSON: Hex;
  signature: PasskeySignatureWire;
}

/** The TEE reads the posted list from chain itself, so the request names only the exam. */
export interface OnboardListRequest {
  examId: Hex;
}

export type OnboardListResponse = SignedApprovedList;

/** `ciphertext` is padded and HPKE-sealed to the attested instance key. The passkey signs `questionSubmission`. */
export interface QuestionRequest {
  examId: Hex;
  topic: string;
  ciphertext: Hex;
  passkeyPublicKey: Hex;
  challenge: Hex;
  signature: PasskeySignatureWire;
}

/** `teeSignature` covers the `questionReceipt` message. */
export interface QuestionReceipt {
  questionHash: Hex;
  teeSignature: Hex;
}

export interface OutboxMessage {
  kind: 'approvedList' | 'questionReceipt' | 'build';
  examId: Hex;
  fields: Record<string, Hex | DecimalString | number>;
  teeSignature: Hex;
  instancePublicKey: Hex;
}

export interface OutboxResponse {
  messages: OutboxMessage[];
}

export interface ReleaseChallengeRequest {
  holderId: string;
}

/** The share and signature, sealed together to the attested instance key. */
export interface ReleaseShareRequest {
  examId: Hex;
  holderId: string;
  sealed: Hex;
}

export interface ReleaseEntry {
  holderId: string;
  shareHash: Hex;
  round: DecimalString;
}

export interface ReleaseLogResponse {
  examId: Hex;
  entries: ReleaseEntry[];
  entriesHash: Hex;
  teeSignature: Hex;
}
