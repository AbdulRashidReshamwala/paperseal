# Why Arkiv

## What People Would Lose with Postgres

The evidence exists to check the exam board, and the board runs the TEE and the storage. A Postgres copy would be one more server somebody controls. Whoever ran it could:

- go quiet at unlock;
- rewrite or delete rows afterwards;
- decide who may read them.

On Arkiv:

- **Nobody can edit a row.** Every entity is created `readonly`, so even its writer can't change it later, and every operation is on-chain with a block number ([example](https://rabdi.explorer.arkiv.network/entity/0xc0a486560fef7c07cee20e1d656706de53f763fa81f631f54589d022f0df70a2)).
- **Anyone can read it, from a static page.** Rabdi's RPC answers browsers from any origin, so the verifier, which anyone can host, reads Arkiv directly with no backend of ours.
- **Anyone can keep it alive.** `permissionlessExtension` lets a journalist or a court extend the evidence past 180 days without our permission.
- **Anyone can be a writer.** A neutral party can run the relay too, and viewers add its address. Readers trust writers by `$creator` and check every row, so with two relays one going silent wouldn't stop the feed. The demo has only one writer, the board's own wallet, so this is the design rather than the demo.
- **It's searchable the way people ask.** "Show me exam X's release logs from these writers" is one indexed query.

## What We Kept Off Arkiv, and Why

Arkiv is public and permanent, so only evidence that is already public and signed goes on it (see [`spec/arkiv.md`](../spec/arkiv.md), "What May Be Mirrored"):

- **Never mirrored:**
  - Questions, even encrypted, because a future break of the encryption would leak them forever.
  - Setter receipts, keys and submission times, which would show who to pressure.
  - Invite secrets.
  - Key shares.
  - Anything not already public.
- **Not on Arkiv either:** the paper (1 MiB, padded) and the approved list. They already sit in public storage, with their hashes on Sepolia, and the paper is too big for one entity anyway.
- **Arkiv is never the source of truth.** `ExamRegistry`, the TEE's signatures and Google's tokens are. The verifier re-checks every row, so a writer can only stay silent, never lie.
