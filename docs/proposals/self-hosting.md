# Proposal: Easy Self-Hosting

**Status:** proposed, 2026-11-06. Nothing here is implemented. If accepted, the behaviour moves to the [README](../../README.md) and the shared rules to `spec/`.

## Summary

A board should be able to run Paper Seal on its own Google Cloud project from one config file, with OpenTofu for the long-lived infrastructure and one command per exam, using our published image unchanged.

Not everything can be free-form config. Anything that affects trust stays attested and visible to the public, so the rule is: **operators can change anything that has no trust role, and anything with a trust role must show up in the image digest or on-chain.**

## Problem

[`deploy/README.md`](../../deploy/README.md) works, but it is a hand-run demo guide tied to one deployment.

| Today | Why it hurts |
| --- | --- |
| Settings are spread across shell exports, `contracts/.env`, script flags and 8 `VITE_` variables | Nothing checks that they agree |
| The board copies ten exam settings into `run-tee.sh` by hand | They must match the chain byte for byte, or attestation fails |
| App settings are fixed at build time | Each board must rebuild the apps, and anyone hosting their own verifier must rebuild it to set `VITE_TEE_STORAGE_BUCKET` |
| Cloudflare is assumed for firewall rules and the TLS proxy, and `tee.abdulrashid.dev` is the documented name | A board needs a Cloudflare zone, even though the transport has no trust role |
| No step hosts the web apps | The guide ends at build-time values |
| `repro.yml` names `ghcr.io/abdulrashidreshamwala/paperseal-tee` directly | A fork can't publish its own image without an edit |
| `stop-tee.sh` and `teardown.sh` don't check the exam's stage | Stopping the VM early destroys the in-memory question bank and keys |
| `chain.readBlock` is `latest` and `requireHardwareAttestation` is `false`, both compiled into the image | **No published image is suitable for a real exam, and no setting can change that** |
| The TEE rejects any chain but the one in `spec/constants.json` (`settings.go:95`), and the apps use viem's `sepolia` directly | Sepolia is the only possible chain |

## What Can Be Configured

Every setting belongs to one of four tiers. This is the core of the proposal.

| Tier | Examples | How it changes | Who can see it |
| --- | --- | --- | --- |
| **Operator** | Project, region, zone, machine type, DNS, ingress, web hosting, app URLs | `deploy.json` | Nobody needs to, because none of these has a trust role |
| **Exam** | Exam ID, schedule, `Δ`, rounds, criteria, RPC host, registry, storage bucket | Board app, then on-chain or checked in the attestation token | Verifier page |
| **Profile** | `chain.readBlock`, `requireHardwareAttestation` | Choosing a published image | Image digest, on-chain |
| **Protocol** | Crypto, drand network and keys, domain tags, padding, attestation claims | A new version of the spec | Everyone, through the open-source code |

Operator settings are safe to vary because the apps trust the attestation token, not the transport. A bad value breaks the deployment, but it can't fool an app.

**Protocol values stay fixed.** A self-hosted board shouldn't choose its own drand network, padding or attestation audience. Doing so would either change the security design or just create a different protocol.

## Proposed Work

### 1. One Config File

`deploy.json` holds every operator setting, validated by a new `spec/deploy.schema.json`. OpenTofu, the scripts and the apps all read it, so one value can't disagree with another.

```json
{
  "gcp": { "project": "my-board", "region": "asia-south2", "zone": "asia-south2-a", "machineType": "n2d-standard-2" },
  "image": { "repo": "ghcr.io/abdulrashidreshamwala/paperseal-tee", "profile": "production" },
  "ingress": { "kind": "cloudflare", "teeHost": "tee.board.example" },
  "web": { "appHost": "exams.board.example", "verifierHost": "verify.board.example" },
  "chain": { "chainId": 11155111, "rpcUrl": "https://rpc.example.org", "rpcHost": "rpc.example.org", "registry": "0x..." }
}
```

It holds no secrets. `gcloud`, `forge` and `tofu` keep using the operator's own login and keystore, as they do today.

### 2. OpenTofu for Long-Lived Infrastructure

A new `deploy/tofu/` holds what outlives any one exam:

- APIs, bucket, service account and its roles
- Static IP and firewall
- Ingress: `cloudflare`, as today, or `gcp-lb` for boards with no Cloudflare account
- Web hosting: one module for Cloudflare Pages, since the demo already uses Cloudflare. Other hosts just upload the built files

We have `tofu` installed, not `terraform`, so we'd test with `tofu` and keep the code compatible with both. This replaces `enable-apis.sh`, `create-bucket.sh` and `create-service-account.sh`, so there aren't two ways to do the same thing.

**The exam VM stays out of OpenTofu.** Its settings are in its metadata and its state is only in memory, so an `apply` that replaces it would destroy the question bank and keys. `run-tee.sh` already refuses this unless told to, and that protection is worth keeping. It also fits the lifecycle: one VM per exam, not one long-lived server.

The base stack also doesn't deploy `ExamRegistry`. That needs the board's keystore, and a board's key shouldn't go anywhere near infrastructure tooling.

### 3. One Command per Exam

`run-tee.sh --from-chain` takes the registry and exam ID, reads the settings with `getExam`, and starts the VM with exactly those values. This removes the most error-prone manual step.

Two more changes:

- **Stage guard:** `stop-tee.sh` and `teardown.sh` read `GET /v1/status` and refuse to run mid-exam without an explicit override.
- **`doctor`:** a preflight check that reports what would fail before an exam depends on it: config schema, public image, bucket reads and CORS, DNS, RPC host and chain ID, attestation token, and the TEE's reachable status.

`doctor` must check that the RPC host works at `https://<host>/` with no path. The TEE can't use a provider that puts an API key in the URL path.

### 4. Runtime Web Config

The apps read `config.json` next to the static files, with `VITE_` values kept as overrides for development. One published build then works for every board, and hosting your own verifier means adding one small file, not rebuilding.

This doesn't change the trust model. The board already serves the apps, and the verifier page's Connection settings still let viewers override everything except `VITE_TEE_STORAGE_BUCKET`, which should become editable too. With the [ENS proposal](ens.md), a name could supply these same values.

### 5. Fork-Friendly Releases

- `repro.yml` derives the image name from the repository.
- The README's `gh workflow run` line uses the same value.
- Forks keep `IMAGE_REPO` and `VITE_RELEASES_REPO`, which already exist.

A fork gets a different digest and must publish its own reproducible release. Boards should use our image unless they have a reason not to.

### 6. Image Profiles

Each tag builds two reproducible images:

| Profile | `chain.readBlock` | `requireHardwareAttestation` | Use |
| --- | --- | --- | --- |
| `dev` | `latest` | `false` | Demos and testing |
| `production` | `finalized` | `true` | Real exams |

The digest goes on-chain as it does today, so the profile is public and can't be changed after the exam is created. The verifier page shows it plainly. Each release lists both digests, and the board app defaults to `production`.

### 7. Chain Allow-List

`spec/constants.json` replaces its single chain with a list, and the exam's `chainId` must be on it. The list stays attested, so the TEE still rejects anything else, and the apps look up the chain by ID rather than importing `sepolia` directly.

### 8. Per-Exam Threshold (Later)

Move `8 of 10` into the exam settings. The README's guarantees depend on this ratio, so the spec needs floors. For example, `required` must exceed the number of centres, so at least one neutral party is always needed. This touches the contract, the TEE, the apps and the verifier, so it comes last.

## Order

| Order | Work | Touches the protocol? |
| --- | --- | --- |
| 1 | Config file, OpenTofu, fork-friendly releases | No |
| 2 | `--from-chain`, stage guard, `doctor` | No |
| 3 | Runtime web config and hosting | No |
| 4 | Image profiles | Yes, and needed before any real exam |
| 5 | Chain allow-list | Yes |
| 6 | Per-exam threshold | Yes |

Steps 1 to 3 change no image digest, so they can ship without a new TEE release.

## Non-Goals

- **Other clouds:** the design depends on Google Confidential Space, its attestation token and its launcher.
- **A multi-tenant hosted service:** each board runs its own deployment, which is the point of self-hosting.
- **Free-form protocol settings:** see the tiers above.
- **Rebuilding the image per board:** config arrives through attested exam settings, so one digest can serve every board.
- **Secrets in `deploy.json` or OpenTofu state:** anything a tool needs comes from the operator's login or environment.

## Spec Changes

- Add `spec/deploy.schema.json`, and the `config.json` shape for the apps.
- Add the profile rules to `spec/api.md` and `spec/constants.json`, including how the Go and TypeScript code picks a profile. The TEE must read its profile from the image, never from a runtime flag.
- Replace the single chain in `spec/constants.json` with an allow-list.

## Risks and Open Questions

- **Passkeys are tied to the domain:** `rpId` comes from `location.hostname`, so changing `web.appHost` after onboarding locks out every registered key. `doctor` should warn about this, and the guide should say to choose the domain first.
- **A single-exam VM limits reuse:** each new exam needs a new VM or a reboot, which is existing behaviour. This proposal doesn't change it.
- **Production profile testing:** hardware attestation has never run end to end, because the demo only uses Chrome's virtual authenticator. Profiles need testing with a real security key.
- **`gcp-lb` is untested:** we need to confirm a Google load balancer accepts the TEE's self-signed backend certificate on port 8080, and what it costs per month.
- **Multiple hardware types:** `hwModels` allows SEV, SEV-ES and TDX, but `run-tee.sh` always asks for SEV. Should `machineType` be limited to tested types?
- **Existing demo resources:** decide whether to import them into OpenTofu state or recreate them.
- **Cost:** the VM estimate in `deploy/README.md` is unverified. `doctor` could report what's running, but it shouldn't quote prices.
