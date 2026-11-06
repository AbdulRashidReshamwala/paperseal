# Schema

Paper Seal mirrors an exam's unlock evidence to Arkiv's Rabdi testnet. The full rules are in [`spec/arkiv.md`](../spec/arkiv.md), and the values in [`spec/arkiv.json`](../spec/arkiv.json). The code is [`packages/arkiv`](../packages/arkiv) (schemas, reader and writer), [`relay/`](../relay) (the import) and [`apps/verifier`](../apps/verifier) (the reader people use).

## Entities

| Schema | One entity per | `body` holds |
| --- | --- | --- |
| `paperseal.v1.release-log` | Signed release log snapshot: which key holders have released, signed by the TEE | The exact bytes of the TEE's `GET /v1/release/log`, or of `release-log.json` in public storage |
| `paperseal.v1.release-token` | Unlock machine | The Google-signed PKI attestation token that proves which code the Unlock machine runs and which signing key it holds |

## Fields

| Field | Type | Indexed | In |
| --- | --- | --- | --- |
| `examId` | `str` | Yes, every query filters on it | Both |
| `registry` | `addr` | Yes | Both |
| `entriesHash` | `str` | Yes, for the writer's duplicate check | Log |
| `instanceKeyHash` | `str` | Yes, for the writer's duplicate check | Token |
| `chainId` | `u64` | No | Both |
| `released` | `i32` | No | Log |
| `body` | `bytes` | No, it can't be | Both |

Readers query by `examId`, and by `$creator` in the writers they trust. Then they parse `body` and check it, and never trust the other columns over it.

## Ownership and Editing

- The relay's wallet creates and owns each entity. Readers only accept rows whose `$creator` is a published writer, because ownership can be handed over.
- Every entity is created `readonly`, so nobody can change it, its owner included.
- Every entity also has `permissionlessExtension`, so anyone can pay to keep the evidence alive after the board loses interest.

## Expiry

Each entity lives for 180 days (`lifetimeDays`), just under Arkiv's limit of about 182.5. That covers an exam's results and appeals season, and anyone can extend it after that.

## Writer

| Wallet | Role |
| --- | --- |
| [`0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b`](https://rabdi.explorer.arkiv.network/address/0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b) | Paper Seal relay for the demo. It is also the demo board's wallet. |
