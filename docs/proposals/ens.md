# Proposal: ENS Names for Exams

**Status:** proposed, 2026-11-06. Nothing here is implemented. If accepted, the behaviour moves to the [README](../../README.md) and the shared rules to `spec/`.

## Summary

Let anyone check an exam by name, such as `jee-main-2026.board.eth`, instead of a raw contract address and exam ID. ENS helps people find the real exam. It never decides whether an exam is real, because the TEE and `ExamRegistry` never read it.

## Problem

The README says the board announces its contract address on its official site, "which is how everyone else knows it is the real board". A hacked site breaks that link. The verifier also needs a raw `registryAddress` and `examId`, which mean nothing to the people it is for.

`examId` is already the `keccak256` of the exam's name, and an ENS labelhash is the `keccak256` of a label. If exam names are valid ENS labels, the label hashes straight to `examId`, with no mapping table.

## Proposed Work

| Order | Work | Benefit | Changes |
| --- | --- | --- | --- |
| 1 | Verify by name | People can check an exam without an address, and the name supplies the contract, exam, TEE and storage settings | `spec/`, `packages/chain`, `apps/verifier` |
| 2 | `ExamResolver` | Every exam gets a name with no per-exam transaction and no second copy of its data | One new contract. `ExamRegistry` doesn't change |
| 3 | Neutral parties use their own names | The board can't invent an identity with an existing history | `spec/`, Go, Solidity and TypeScript |
| 4 | Append-only exam namespace | The board can't later change what an exam name points to | ENS configuration, after the checks below |
| 5 | Pinned verifier | A locked contenthash on an IPFS build means the verifier code can't be swapped later | Publishing step |

### Verify by Name

The verifier shows a hard failure unless all of these hold:

1. The name resolves to the registry.
2. `registry.board()` returns the board's address.
3. That address's verified primary name matches the name entered.

The existing checks then run unchanged. The RPC URL still comes from the viewer.

### ExamResolver

One read-only ENSIP-10 wildcard resolver serves every exam under a parent name. It takes the label, hashes it to `examId`, reads `getExam`, `getApprovedList` and `getBuild`, and returns records from that state. Exam data stays in `ExamRegistry` alone.

The full approved list is only emitted as an event, so this resolver can return its hash but not its entries.

### Why ENSv2

Parts 1 to 3 could mostly work on ENSv1. These parts are new in v2:

- **Per-name registries:** the board can run a separate registry for exams.
- **Per-name roles:** a low-risk operations key could add exams while the main board key stays offline.
- **Permanent role removal:** this is what makes parts 4 and 5 possible.

## Non-Goals

- **ENS in the TEE or `ExamRegistry`:** both keep using the attested address. The Universal Resolver is an upgradable proxy and CCIP-Read can make offchain calls, so either would add trust the design has deliberately avoided.
- **Names for setters:** their names are never published, and a name would show who to pressure.
- **Board-issued names as proof of neutrality:** the board can usually change a name under its own parent. Those names are fine for centres, which the board approves anyway.
- **IPFS for the passkey web app:** passkeys are tied to one domain, so a gateway operator would just replace the board as the party serving the code.

## Spec Changes

- Add a rule to `spec/api.md` that exam names must be valid, normalised ENS labels, so a name with spaces can't be used.
- Define the text record keys and how the verifier reads them.
- Add test vectors showing that a label hashes to `examId`.

## Risks and Open Questions

- **Launch status:** news reports say ENSv2 went live on mainnet on 2026-10-27, but the [deployments page](https://docs.ens.domains/learn/deployments#mainnet-ensv2) says resolution still runs through ENSv1 until the launch completes. Reading through the Universal Resolver with viem should work either way.
- **Sepolia names prove nothing:** anyone can register a look-alike name there, so Sepolia works only as a demo. Real proof needs a mainnet name, and `ExamResolver` would then need a CCIP-Read gateway to reach Sepolia data.
- **Swapped keys:** part 3 ties a key to a named organisation, but the holder still sees that key through the board-served app. It doesn't close the README's swapped-key weakness.
- **Neutral parties need a wallet once:** they set one record, which adds a step for them.
- **Permanent locks are per resolver:** a resolver role covers every name on that resolver, and the parent can repoint a name unless its own role is removed too. Part 5 must lock both.
- **Part 4 is not confirmed:** check that adding names doesn't count as a dangerous role, what happens when the parent name expires, and whether every parent in the chain must give up its powers.
- **Docs not read yet:** `verifiable-factory`, `dns-resolvers` and `tutorial-contract-developers`. The DNS page matters most, because a board's real domain would be a stronger identity than a new `.eth` name.

## Sources

Read on 2026-11-06.

- [ENSv2 readiness](https://docs.ens.domains/web/ensv2-readiness)
- [Deployments](https://docs.ens.domains/learn/deployments)
- [Registry hierarchy](https://docs.ens.domains/ensv2/registry-hierarchy)
- [Permissioned registry](https://docs.ens.domains/ensv2/permissioned-registry)
- [Permissioned resolver](https://docs.ens.domains/ensv2/permissioned-resolver)
- [Enhanced access control](https://docs.ens.domains/ensv2/enhanced-access-control)
- [Subnames](https://docs.ens.domains/ensv2/subnames)
- [Reverse resolution](https://docs.ens.domains/ensv2/reverse-resolution)
- [ENSIP-23](https://docs.ens.domains/ensip/23)
- [App developer tutorial](https://docs.ens.domains/ensv2/tutorial-app-developers)
- [crypto.news on the launch](https://crypto.news/ensv2-ethereum-mainnet-nft-name-upgrades/)
