# ENSv2 in Paper Seal

Paper Seal uses ENSv2 names on Sepolia for two things: who holds a key, and which exam is which. Every name is a subname whose records sit on its parent's ENSv2 Permissioned Resolver. Nothing is registered per subname.

## What It Does

**People are names.** Each key holder and exam centre has a subname such as `centre-1.paperseal-demo.eth`. It publishes the hash of their security key and its credential ID. The parent, `paperseal-demo.eth`, lists every name in one record.

- The board picks people by name, not by address.
- A registration joins the exam only if its security key matches the name's record, so knowing someone's name isn't enough to take their place.
- People need no wallet. Losing a key means one record update.

**Exams are names.** An exam such as `paperseal-live-20261106t175851z.paperseal-demo.eth` points to the `ExamRegistry` contract, and its text records say where the TEE, the files and the Arkiv writers are. The exam ID is the hash of the first label.

- Anyone can open an exam by typing its name, instead of a contract address and a 66-character ID.
- When the board publishes an exam, the app writes all its records in one `multicall`, so the board confirms once.
- The verifier accepts the name only if the contract is exactly `ExamRegistry`'s code, and the board's primary name is the parent, checked both ways.

## ENSv2 Features We Use

| Feature | How |
| --- | --- |
| Permissioned Resolver, records keyed by name | We write each subname's records on the parent's resolver with `setAddress(bytes,uint256,bytes)` and `setText(bytes,string,string)`, by DNS-encoded name |
| Subnames resolved off the parent's resolver | No subname is registered. On Sepolia, `centre-1.paperseal-demo.eth` and the exam names have no ENSv1 registry entry, and resolve through the same resolver as their parent |
| `multicall` on the resolver | One confirmation writes an exam's address and every text record |
| Primary names | The verifier reads the board's primary name to prove the exam's parent belongs to the board |
| Text records | `paperseal.passkey`, `paperseal.credential`, `paperseal.directory`, `paperseal.tee`, `paperseal.storage`, `paperseal.bucket` and `paperseal.arkiv-writers` ([spec/ens.json](../spec/ens.json)) |

All reads go through the viewer's own RPC, with offchain lookups (CCIP-Read) turned off.

## Try It

| | |
| --- | --- |
| Open an exam by name | [`#/name/paperseal-live-20261106t175851z.paperseal-demo.eth`](https://paperverify.abdulrashid.dev/#/name/paperseal-live-20261106t175851z.paperseal-demo.eth). Step 1, "Name", passes |
| Board's name | `paperseal-demo.eth`, the primary name of the board [`0xC3808daC38cA53a709F981Fb663814DbaaAB7420`](https://sepolia.etherscan.io/address/0xC3808daC38cA53a709F981Fb663814DbaaAB7420) |
| Its Permissioned Resolver | [`0xeF882e399948Da185884f363167E2a105e502A79`](https://sepolia.etherscan.io/address/0xeF882e399948Da185884f363167E2a105e502A79) |
| Directory | 11 names in `paperseal.directory` on `paperseal-demo.eth`: `neutral-1` to `neutral-3` and `centre-1` to `centre-8` |

## Code

| File | Does |
| --- | --- |
| [`packages/chain/src/ens.ts`](../packages/chain/src/ens.ts) | Reads exam names (`resolveExamName`), party names (`checkPasskeyName`, `readPartyRecords`) and the directory (`readDirectory`). Encodes an exam's records as one resolver `multicall` (`encodeExamNameRecords`) |
| [`apps/web/src/areas/board/nameFlow.ts`](../apps/web/src/areas/board/nameFlow.ts), [`ExamNameCard.tsx`](../apps/web/src/areas/board/ExamNameCard.tsx) | Names an exam after it is published, then reads it back with the verifier's checks |
| [`apps/web/src/areas/board/parties.ts`](../apps/web/src/areas/board/parties.ts), [`PeopleStep.tsx`](../apps/web/src/areas/board/PeopleStep.tsx) | The board picks people from the directory and lists a registration only if its key matches the name |
| [`apps/verifier/src/identity.ts`](../apps/verifier/src/identity.ts), [`page.tsx`](../apps/verifier/src/page.tsx) | Reads the board's primary name both ways, and shows whether each listed person's name confirms their key |
| [`deploy/ens/records.mjs`](../deploy/ens/records.mjs) | Prints the resolver commands to put a person's key card on their name |

The setup steps are in [ens-setup.md](ens-setup.md), and the rules in `spec/api.md`, "Exam Names" and "Party Names".

## Limits

- On Sepolia anyone can register a look-alike name, so a name only proves something on mainnet.
- In the demo the board owns `paperseal-demo.eth` and writes the neutral parties' records, so the neutrals aren't independent of the board. A real exam needs each neutral to own their name.
- We don't use Enhanced Access Control yet. Next, each neutral party could get a role that edits only their own key record.
