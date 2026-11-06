# Data Quality

**Up to date:** during unlock, `node relay/cli.mjs watch` polls the TEE's signed release log every 10 seconds. It writes each new snapshot, skips any snapshot it already wrote, and stops when the TEE reports the exam released. `mirror` brings in the final `release-log.json` and `release-token.jwt` from public storage afterwards. The verifier shows when the newest row was written, and warns when the copy goes stale while unlock is still running.

**Correct:** every row's `body` is the exact signed bytes. The verifier checks each one against Google's root, the on-chain exam settings and the TEE's signature, and ignores any row that fails.

**Exam index:** `node relay/cli.mjs index --every 60` follows `ExamRegistry`'s events and patches each exam row as its stage moves forward. A second run on unchanged data writes nothing: in the live run, all 10 exams were unchanged and all 91 participants were skipped.

**Searchable:** by exam ID and by writer, the two things a reader knows. See the query in the [README](../README.md#arkiv-copy).
