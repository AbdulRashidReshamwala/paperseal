# Data Quality

**Up to date.** During unlock, `node relay/cli.mjs watch` reads the TEE's signed release log every 10 seconds. It writes each new copy, skips any it already wrote, and stops when the exam is released. Afterwards, `mirror` copies the final files from public storage. The verifier shows when the newest row was written, and warns if the copy stops during unlock.

**Correct.** Each row's `body` is the exact signed bytes. The verifier checks it against Google's root, the exam on Sepolia and the TEE's signature, and ignores any row that fails.

**Exam list.** `node relay/cli.mjs index --every 60` follows `ExamRegistry`'s events and updates each exam's row as its stage moves on. Running it again on unchanged data writes nothing: in our live run, all 10 exams and all 91 people were skipped.

**Searchable.** By exam ID and by writer, the two things a reader knows. See the query in the [README](../README.md#arkiv-copy).
