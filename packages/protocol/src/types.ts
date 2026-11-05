/** Lowercase hex with a 0x prefix, the JSON form of bytes in spec/api.md. */
export type Hex = `0x${string}`;

/** Integers that can exceed 2^53, including drand rounds, are decimal strings in JSON. */
export type DecimalString = string;

/** Attested startup arguments and the values stored by createExam. See "Exam Settings" in spec/api.md. */
export interface ExamSettings {
  examId: Hex;
  /** T, in Unix seconds. */
  examStart: number;
  /** Δ, in seconds. */
  delta: number;
  lockRound: DecimalString;
  unlockRound: DecimalString;
  endRound: DecimalString;
  criteriaHash: Hex;
  /** The RPC operator's hostname, with no scheme, port or path. */
  rpcHost: string;
  /** The ExamRegistry contract address. */
  registry: Hex;
  /** Equal to `chain.chainId` in constants.json. */
  chainId: number;
}

/** The two extra values createExam stores, which are not startup arguments. */
export interface ExamPublication {
  /** bytes20, the git SHA-1 of the tagged commit. */
  commitHash: Hex;
  /** bytes32, the raw image digest without the `sha256:` prefix. */
  imageDigest: Hex;
}

/** Lifecycle stages from docs/ARCHITECTURE.md, plus the TEE's `released` and `failed` from "TEE API" in spec/api.md. */
export const stages = [
  'publish',
  'onboard',
  'submit',
  'lock',
  'build',
  'split',
  'distribute',
  'unlock',
  'verify',
  'released',
  'failed',
] as const;
export type Stage = (typeof stages)[number];

/** Error body from spec/api.md. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Thrown by anything unfinished. Never fake a check to avoid raising this. */
export class NotImplementedError extends Error {
  readonly code = 'not_implemented';
  readonly feature: string;

  constructor(feature: string, detail?: string) {
    super(detail ? `${feature} is not implemented: ${detail}` : `${feature} is not implemented`);
    this.name = 'NotImplementedError';
    this.feature = feature;
  }
}
