import { addr, bytes, defineSchema, i32, str, u64 } from '@arkiv-network/sdk/schema';

import { arkiv } from './spec';

// The two row types of spec/arkiv.md "Rows", column for column. Only the columns readers look rows
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
