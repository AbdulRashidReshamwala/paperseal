import { addr, bytes, defineSchema, i32, str, u64 } from '@arkiv-network/sdk/schema';

import { arkiv } from './spec';

// The row types of spec/arkiv.md "Rows" and "Exam Index", column for column. Only the columns readers look rows
// up by are indexed. Every reader parses `body` and ignores the other columns where they disagree.

/** One signed release log, exactly as the TEE returned it. */
export const releaseLogSchema = defineSchema(arkiv.schemas.releaseLog, {
  examId: str().indexed(),
  registry: addr().indexed(),
  chainId: u64(),
  entriesHash: str().indexed(),
  released: i32(),
  body: bytes(),
});

/** One PKI attestation token of the instance that ran Unlock. */
export const releaseTokenSchema = defineSchema(arkiv.schemas.releaseToken, {
  examId: str().indexed(),
  registry: addr().indexed(),
  chainId: u64(),
  instanceKeyHash: str().indexed(),
  body: bytes(),
});

/** A writer's sign of life while it watches an exam. Not evidence, and never counts toward progress. */
export const relayHeartbeatSchema = defineSchema(arkiv.schemas.relayHeartbeat, {
  examId: str().indexed(),
  registry: addr().indexed(),
  entriesHash: str(),
  stage: str(),
});

/**
 * One exam in one registry, for the exam index. Not readonly: its writer patches it as the exam
 * moves on. Readers check every row against Sepolia.
 */
export const examSchema = defineSchema(arkiv.schemas.exam, {
  examId: str().indexed(),
  registry: addr().indexed(),
  board: addr().indexed(),
  chainId: u64(),
  stage: str().indexed(),
  examStart: u64().indexed(),
  createdBlock: u64(),
  criteriaHash: str(),
  approvedListHash: str(),
  paperHash: str(),
  name: str(),
});

/** One entry of an exam's approved list, for the exam index. Readonly: the list is written once. */
export const participantSchema = defineSchema(arkiv.schemas.participant, {
  examId: str().indexed(),
  registry: addr().indexed(),
  role: str().indexed(),
  owner: str().indexed(),
  passkeyKeyHash: str().indexed(),
  derivedKeyHash: str(),
});

/**
 * Where one Swarm backup of an exam's storage files is (spec/arkiv.md, "Backups"). Readonly. Readers
 * use a collection only after its `manifest.json` hashes to the Build's `storageManifestHash`.
 */
export const backupSchema = defineSchema(arkiv.schemas.backup, {
  examId: str().indexed(),
  registry: addr().indexed(),
  phase: str().indexed(),
  swarmRef: str().indexed(),
  swarmNetwork: str(),
  manifestHash: str(),
  files: i32(),
  batchId: str(),
});
