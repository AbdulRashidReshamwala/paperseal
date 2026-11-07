# Why Arkiv

## What Users Would Lose with Postgres

The unlock record exists to check the exam board, and the board already runs the TEE and the storage. A Postgres copy would be one more server someone controls. Whoever ran it could:

- go quiet during unlock;
- change or delete rows later;
- decide who may read them.

With Arkiv:

- **Nobody can change a row.** Every entity is `readonly`, even for its writer, and every write is on-chain with a block number ([example](https://rabdi.explorer.arkiv.network/entity/0xc0a486560fef7c07cee20e1d656706de53f763fa81f631f54589d022f0df70a2)).
- **Anyone can read it from a static page.** Arkiv's RPC answers browsers from any site, so the verifier, which anyone can host, reads it with no server of ours.
- **Anyone can keep it alive.** A journalist or a court can extend the record past 180 days without our permission.
- **Anyone can be a writer.** A neutral party can run the relay too, so one writer going quiet doesn't stop the record. The demo has one writer, so this is the design, not yet the demo.
- **It's searchable the way people ask.** "This exam's release logs from these writers", "this registry's exams by date" and "which exams is centre-1 on" are each one query. Sepolia can only look up one exam by its ID.

## What We Kept Off Arkiv, and Why

Arkiv is public and lasts, so only data that is already public and signed goes on it.

- **Never copied:**
  - Questions, even encrypted, because a future break of the encryption would leak them forever.
  - Setters' receipts, keys and submission times, which would show who to pressure.
  - Invite secrets and key shares.
- **Not on Arkiv either:** the encrypted paper and the other exam files. They stay in the board's public storage, with a backup on Swarm. They're too big for one entity, so Arkiv holds only the Swarm reference ([swarm.md](swarm.md)).
- **Arkiv is never the source of truth.** `ExamRegistry`, the TEE's signatures and Google's tokens are. The verifier checks every row, so a writer can only go quiet, never lie.
