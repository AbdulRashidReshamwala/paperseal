# Proposal: Arkiv Evidence Mirror

**Status:** part 1, the live unlock feed, is implemented, built a little differently from the table below. There is one row per signed log snapshot rather than per release, so each row can be checked by its signature. The Unlock token is mirrored too, so a mirrored log can be checked with the board silent. A heartbeat row shows the relay is alive. The verifier polls instead of using `watchEntityEvents`. The rules are in [`spec/arkiv.md`](../../spec/arkiv.md), which replaces this proposal where they differ, the behaviour is in the [README](../../README.md#arkiv-copy), the relay is in [`relay/`](../../relay), and the prize answers are in [`arkiv/`](../../arkiv). Part 2, the exam index, is implemented too: `node relay/cli.mjs index` writes one row per exam and per approved-list entry from `ExamRegistry`'s events, and the verifier's `#/exams` page lists and searches them, checking each against Sepolia. Part 3, backups, is implemented as well. `node relay/cli.mjs backup` uploads an exam's files to Swarm's Sepolia testnet and records the reference on Arkiv, and the verifier reads from that backup when the bucket fails, checking it against Sepolia ([`arkiv/swarm.md`](../../arkiv/swarm.md)). Unlike this proposal's table, the encrypted shares go on Swarm, never on Arkiv. Not built yet: the same fallback in the key holder and centre pages, 2026-11-06.

## Summary

Mirror Paper Seal's public evidence to [Arkiv](https://docs.arkiv.network/start-here/introduction/), so anyone can find exams and watch an unlock without relying on the board's servers. Arkiv is only a mirror. `ExamRegistry`, TEE signatures and file hashes stay the source of truth, and apps recheck everything they read from it.

This pairs with the [ENS proposal](ens.md): ENS tells you which exam is the real one, and Arkiv helps you find exams and watch them live.

## Problem

- Live release status comes from the TEE's `GET /v1/status`, which the board hosts. The README accepts that the board can block the TEE's traffic.
- `ExamRegistry` can look up one exam by ID but can't list exams, so nobody can browse a board's history without an indexer.
- The README lists a storage outage at `T−Δ` as an availability risk.

## Proposed Work

| Order | Work | What goes on Arkiv |
| --- | --- | --- |
| 1 | Live unlock feed | One row per release, tagged by exam and holder, watched with `watchEntityEvents` |
| 2 | Exam index | One row per exam and per approved participant, with stage, hashes and ENS name |
| 3 | Backup files (optional) | `key-pub.tlock`, shares and `manifest.json`, with `paper.bin` on Swarm |

### Relay

A small TypeScript relay outside the TEE does the writing. Changing the TEE would change its on-chain image digest, and no Go SDK was found.

`GET /v1/release/log` already returns a signed log of the releases so far during unlock, so the relay can mirror it with no TEE change. The content is signed, so the relay can't forge anything. It can only stay silent.

### Reading

- The verifier rechecks every row against the TEE's signature, Sepolia or the file hashes. As built, a row that doesn't match is ignored and counted, never treated as a failure of the exam, because anyone who is a writer could post one (`spec/arkiv.md`, "Reading").
- Anyone can write to Arkiv, so apps read only from published writer addresses.
- The feed is only as live as the relay's last read. If it goes quiet, the verifier warns that it has stopped, and doesn't treat that as proof that nothing happened.
- The verifier must really read from Arkiv. The prize doesn't count Arkiv "used only as a log that nothing reads".

## Non-Goals

Arkiv data is public, so these never go on it:

- Questions, even encrypted
- Setter receipts, keys or submission timing
- Invite secrets
- Anything unencrypted before unlock

Arkiv also doesn't replace `ExamRegistry`, and the TEE never reads from it.

## Spec Changes

- Add the Arkiv schema to `spec/`, with attribute names, types and expiry per row type.
- Define how writer addresses are published and rotated.
- Add a rule for which public data may be mirrored, based on the list above.

## Limits

| Limit | Value | What it means here |
| --- | --- | --- |
| Bytes per create or patch | 128 KiB | `paper.bin` is padded to 1 MiB, so it can't go in one entity. The approved list can reach 130,000 bytes, so it needs one row per person |
| Lifetime | About 182.5 days, then it must be extended | Rows created with `permissionlessExtension` can be extended by anyone, so the public could keep the evidence alive |
| Network | Testnet only, Rabdi | Fine for a mirror, not for primary storage |
| Durability | No guarantee found | Same as above |
| Public RPC | Heavily rate-limited | An access key in a static verifier would be visible to anyone |

## Open Questions

- Can a static verifier read Arkiv reliably from the browser without an access key? **Answered: yes.** Rabdi's RPC returns `access-control-allow-origin: *`, and the verifier reads it with no key. It is rate limited, so a hosted verifier should use an origin-locked key ([`arkiv/friction.md`](../../arkiv/friction.md) #5).
- Should the board run the only relay, or should anyone be able to run one and publish a writer address? **Answered: anyone.** The board lists its writers in the exam's ENS name (`paperseal.arkiv-writers`), and viewers can add their own, such as a neutral party's relay. In the demo, the board's wallet is the only writer.
- Is the Swarm bonus worth the extra work? **Answered: built.** See [`arkiv/swarm.md`](../../arkiv/swarm.md). The rest of this point, kept as written: It covers uploading `paper.bin`, buying a postage batch and writing `/arkiv/swarm.md`. Our ciphertext is already encrypted, so upload it as a plain Swarm reference. An encrypted reference contains its key, and entities are public.

## Prize Fit

ETHGlobal Mumbai's [Arkiv prize](https://ethglobal.com/events/mumbai/prizes/arkiv): this project targets **Build on Arkiv (from scratch)**, which pays $3,000 for 1st and $1,000 for 2nd. The Swarm bonus adds $500, and Arkiv uses one partner prize pick.

The entry needs:

- Writes to the current testnet with `@arkiv-network/sdk` or JSON-RPC, and a feature that reads the data back
- `/arkiv/schema.md`, `friction.md`, `reach.md`, `why-arkiv.md` and `how-you-use-arkiv.md`
- A README listing the writer wallets and one query to run
- A public, open-source repo that says how AI was used

## Sources

Read on 2026-11-06.

- [Arkiv prize page](https://ethglobal.com/events/mumbai/prizes/arkiv)
- [Introduction](https://docs.arkiv.network/start-here/introduction/)
- [Limits](https://docs.arkiv.network/reference/limits/)
- [Expiration](https://docs.arkiv.network/writing/expiration/)
- [Watching events](https://docs.arkiv.network/querying/watch-events/)
- [Rabdi testnet](https://docs.arkiv.network/networks/rabdi/)
