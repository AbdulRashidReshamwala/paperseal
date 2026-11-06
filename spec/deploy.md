# Deployment

How a board runs Paper Seal on its own Google Cloud project. Change this file first, then `deploy/`, `apps/web` and `apps/verifier` in the same change. The reasoning is in [the proposal](../docs/proposals/self-hosting.md).

**Status:** parts 1 to 3 of the proposal are implemented: the config file, OpenTofu, one command per exam, `doctor` and the apps' runtime config. Exam mode, the chain allow-list and the per-exam threshold are not.

## Rules

- An operator may change any setting with no trust role. A setting with a trust role stays attested or on-chain. Nothing here changes the image digest, so none of it needs a new TEE release.
- No file here holds a secret. `gcloud`, `tofu` and `forge` use the operator's own login and keystore.
- The exam VM is never managed by OpenTofu. Its state lives only in memory, and replacing it destroys the question bank and keys.

## `deploy.json`

One file holds every operator setting. It matches [`deploy.schema.json`](deploy.schema.json), and [`deploy/deploy.example.json`](../deploy/deploy.example.json) is an example. `deploy/deploy.json` is the operator's copy and is not committed. OpenTofu, the scripts and `deploy/web-config.sh` all read it.

| Field | Meaning |
| --- | --- |
| `gcp.project`, `gcp.region`, `gcp.zone` | Where everything runs. `zone` must be in `region` |
| `gcp.machineType` | The exam VM's machine type. Default `n2d-standard-2` |
| `image.repo` | The TEE image, such as `ghcr.io/<owner>/paperseal-tee` |
| `storage.bucket` | The public bucket. Default `<project>-paperseal-exams` |
| `ingress.kind` | `cloudflare`, as today. `gcp-lb` is reserved, and the tooling refuses it as not implemented |
| `ingress.teeHost` | The TEE's public host name, such as `tee.board.example` |
| `web.appHost`, `web.verifierHost` | Where the board app and the verifier are served. Passkeys are bound to `appHost`, so choose it before anyone enrols |
| `chain.chainId` | Must equal `chain.chainId` in `constants.json` |
| `chain.rpcUrl` | The RPC the apps and scripts use |
| `chain.rpcHost` | The RPC host the TEE uses. It must answer at `https://<rpcHost>/` with no path |
| `chain.registry` | The board's `ExamRegistry` |
| `apps.arkivWriters`, `apps.swarmApiUrl`, `apps.releaseTag`, `apps.repository` | Optional app values, as in `config.json` |

## OpenTofu

`deploy/tofu/` creates what outlives an exam: the APIs, the bucket and its public read and CORS, the TEE's service account and roles, the static IP, and the firewall for the chosen ingress. It replaces `enable-apis.sh`, `create-bucket.sh` and `create-service-account.sh`. It reads `deploy.json`, and its outputs are the values `run-tee.sh` needs. It works with `tofu` and `terraform`.

## One Command per Exam

`run-tee.sh --from-chain --exam <examId>` reads the exam with `getExam` from `chain.registry` and starts the VM with exactly those settings. It refuses if the exam isn't on-chain or its `rpcHost` differs from `chain.rpcHost`.

`stop-tee.sh` and `teardown.sh` read `GET /v1/status` first. They refuse to stop a TEE that holds an exam in progress unless given `--force`, because stopping it then destroys the exam. Safe stages are `released`, `failed`, and `onboard` with no approved list and no registrations. Every other stage, an unknown stage and a status that can't be read are refused.

`doctor.sh` reads `deploy.json` and reports, one line per check, `ok`, `fail` or `skip`, and exits 1 if any check failed:

1. `deploy.json` matches the schema, and `zone` is in `region`
2. The image is public: an anonymous pull of its manifest succeeds
3. The bucket answers a public read, and its CORS allows `web.appHost` and `web.verifierHost`
4. `ingress.teeHost` resolves in DNS
5. `chain.rpcUrl` and `https://<rpcHost>/` both answer `eth_chainId` with `chain.chainId`
6. `chain.registry` has code
7. When a TEE is running, `GET /v1/status` answers on `ingress.teeHost`, and its attestation token decodes

It also warns that changing `web.appHost` after enrolment locks out every passkey.

## App `config.json`

`apps/web` and `apps/verifier` read `config.json` beside `index.html` when they load. One published build then works for every board. `deploy/web-config.sh` writes it from `deploy.json`. It matches [`web-config.schema.json`](web-config.schema.json).

| Field | Meaning |
| --- | --- |
| `teeUrl` | `https://<ingress.teeHost>` |
| `rpcUrl` | `chain.rpcUrl` |
| `registry` | `chain.registry` |
| `chainId`, `chainName` | From `constants.json` |
| `storageUrl` | `https://storage.googleapis.com/<storage.bucket>` |
| `storageBucket` | `storage.bucket`, the bucket the token's `env_override` must name |
| `repository` | `owner/name` of the public repository |
| `examId`, `arkivWriters`, `swarmApiUrl`, `releaseTag` | Optional |

Every field is optional, and an unknown field is ignored. Values resolve in this order:

1. A `VITE_` value set at build time, for development
2. `config.json`
3. The app's built-in default, usually empty

A missing or invalid `config.json` counts as empty, and the page still renders. In the verifier, a viewer's own Connection settings override all of these, including `storageBucket`. The config only supplies locators. Every value is checked again by the attestation, chain and hash checks, so a wrong one fails a check rather than passing a fake one.
