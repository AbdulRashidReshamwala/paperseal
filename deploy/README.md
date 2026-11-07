# Deploying Paper Seal

Order of steps for a Sepolia demo with the TEE on Google Confidential Space. Nothing here needs a secret in a file: `gcloud`, `tofu` and `forge` use your own login and keystore.

## Quick start with deploy.json

One file holds every operator setting ([spec/deploy.md](../spec/deploy.md)). Deploy `ExamRegistry` and publish a release first (steps 1 and 2 below), then:

```sh
cp deploy/deploy.example.json deploy/deploy.json    # edit it: project, hosts, registry. Not committed
gcloud auth application-default login
(cd deploy/tofu && tofu init && tofu apply)         # APIs, bucket, service account, IP, firewall
deploy/doctor.sh                                    # one ok/fail/skip line per check
# Point the Cloudflare A record for ingress.teeHost at `tofu output tee_ip` (step 4).
# Publish the exam in the board app, then start its TEE with the on-chain settings:
DRY_RUN=1 deploy/gcp/run-tee.sh --from-chain --exam 0x<examId>   # check, then run without DRY_RUN
deploy/web-config.sh > apps/web/dist/config.json
deploy/web-config.sh > apps/verifier/dist/config.json
```

- Choose `web.appHost` before anyone enrols: passkeys are bound to it, and changing it later locks every one out.
- Every script reads `deploy/deploy.json`, or the file in `DEPLOY_JSON`. A variable you export (such as `PROJECT_ID` or `TEE_HOST`) still wins over the file, so the manual steps below keep working.
- `run-tee.sh --from-chain` reads `getExam` from `chain.registry` with `cast` and uses exactly those settings and that image digest. It refuses an exam that isn't on-chain, or whose `rpcHost` is not `chain.rpcHost`.
- `stop-tee.sh` and `teardown.sh` read `https://<teeHost>/v1/status` first and refuse mid-exam, or when the status can't be read, unless given `--force`.
- `doctor.sh --exam 0x<examId>` also pulls that exam's image manifest anonymously.
- `ingress.kind = "gcp-lb"` is not implemented yet. The tooling refuses it.

See [tofu/README.md](tofu/README.md) to bring resources made by the old scripts into OpenTofu. The steps below are the manual way, and still work.

Every GCP script takes `PROJECT_ID`, `REGION` and `ZONE` from the environment and prints its commands instead of running them when `DRY_RUN=1`.

```sh
export PROJECT_ID=<your project> REGION=asia-south2 ZONE=asia-south2-a
export DRY_RUN=1   # unset it to run for real
```

## Before you start

The image must be able to run on Confidential Space. Two things must be true in `tee/Dockerfile` before the first tag (see the report that came with this change):

- `LABEL tee.launch_policy.allow_env_override="STORAGE_BUCKET"` is present. Without it the launcher refuses `tee-env-STORAGE_BUCKET` and the workload does not start. The label changes the image digest, so add it before tagging.
- `tee.launch_policy.allow_cmd_override="true"` and `EXPOSE 8080` are already there.

## 1. Deploy `ExamRegistry` to Sepolia

From `contracts/`, with `.env` filled in from `.env.example` (`BOARD_ADDRESS`, `SEPOLIA_RPC_URL`):

```sh
forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --account <keystore-name>
```

Keep the printed address as `REGISTRY`. A new board address needs a new deployment.

Every reader checks the code at this address against `spec/registry.json`. If the contract's code changed, run `make abi` and commit the result, which updates the pin everywhere, then tag a new TEE version, because the pin is in the attested image. A new board or a comment edit doesn't change the pin. To check a deployment, read-only:

```sh
LIVE_REGISTRY=<REGISTRY> node e2e/live/cli.mjs registry-check
```

### Verify the source on Etherscan

Needs `ETHERSCAN_API_KEY` and `REGISTRY_ADDRESS` in `contracts/.env` (gitignored). Check out the commit that was deployed first; the compiler settings come from `foundry.toml` (solc 0.8.34, optimizer 200 runs, `prague`, no via-ir), and the constructor argument is `BOARD_ADDRESS`.

```sh
contracts/script/verify.sh              # uses REGISTRY_ADDRESS
contracts/script/verify.sh 0x...        # or pass the address
```

It uses the Etherscan V2 API with chain id 11155111, waits for the result and never prints the key. It is safe to run again: an already verified contract is skipped. The current Sepolia deployment (`0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb`) was built from commit `ce53d85` with solc 0.8.34. Two earlier ones are retired: `0x78EB44959E7ed5d6A45Fb2863c0624c8f2ce9c85`, abandoned before the Build had `builtRound`, and the first (`0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8`, commit `2ae6cf3`) is retired and only holds the demo exam used by one verifier test.

## 2. Tag a version

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/repro.yml` builds the image twice on clean runners. If the digests match, the release job pushes the image by digest to `ghcr.io/<owner>/paperseal-tee` (no tag), checks the registry holds the same digest, checks an anonymous pull works, then publishes the GitHub release. `<owner>` is your repository's owner in lowercase, so a fork publishes its own image without editing anything (upstream's is `ghcr.io/abdulrashidreshamwala/paperseal-tee`). The GCP scripts default `IMAGE_REPO` to the same name, read from your `origin` remote; export `IMAGE_REPO` to use another image. A fork's image has a different digest, so it needs its own release.

A new GHCR package starts private and Actions cannot change that. The first time, open the package's settings on GitHub, set visibility to public, and re-run the release job. Then read the release notes: they hold `commit` and `imageDigest` for `createExam`, and the image reference as `ghcr.io/<owner>/paperseal-tee@sha256:<digest>`.

## 3. Google Cloud

`deploy/tofu` now does this from `deploy.json` (see the quick start). The scripts still work, and print a deprecation note. Run in this order. Each is safe to run again.

```sh
cd deploy/gcp
./enable-apis.sh
./create-bucket.sh            # public-read, uniform access, CORS GET from any origin
./create-service-account.sh   # workloadUser, logWriter, and objectCreator on the bucket only
```

The bucket is `${PROJECT_ID}-paperseal-exams` unless you set `BUCKET`. If an organisation policy blocks public buckets, allow them for this project first.

Publish the exam in the board app first, so the on-chain settings exist. Then start the TEE with `./run-tee.sh --from-chain --exam 0x...`, which reads them from the chain, or give the same settings and the release's image digest by hand:

```sh
./run-tee.sh \
  --exam-id=0x... --exam-start=<secs> --delta=<secs> \
  --lock-round=<n> --unlock-round=<n> --end-round=<n> \
  --criteria-hash=0x... --rpc-host=<host> \
  --registry=0x... --chain-id=11155111 \
  --image-digest=sha256:<digest>
```

It reserves a static IP, opens port 8080 to Cloudflare's published IPv4 ranges only (read from `https://www.cloudflare.com/ips-v4` each run), and starts one `n2d-standard-2` Confidential VM (AMD SEV) on the production `confidential-space` image family, not debug. `tee-cmd` carries the ten arguments in the order of `spec/api.md`, "Exam Settings". Check with `DRY_RUN=1` first and compare the arguments with the chain. It prints the IP.

Wait a minute or two, then check `curl -k https://<ip>:8080/v1/status` (`-k` because the certificate is self-signed) from an allowed source (or through Cloudflare once step 4 is done). The production image doesn't send container logs anywhere, so check the TEE through `/v1/status`.

### Cost, and stopping it

Estimated cost of one `n2d-standard-2` Confidential VM in `asia-south2` running all month: roughly 75 to 100 US dollars, plus a few dollars for the static IP and disk. This is **not verified against Google's pricing page**: the page is rendered by script and could not be read when this was written. Check the [pricing calculator](https://cloud.google.com/products/calculator) (Compute Engine, N2D, Confidential VM, 2 vCPU, 8 GB) before you rely on the number.

**Stop the VM after a demo:** `./stop-tee.sh`. Stopping ends the instance, so its in-memory question bank and keys are gone. Only stop it once the exam is released: it reads `GET /v1/status` on `TEE_HOST` and refuses from the first registration until the stage is `released` or `failed`, or when the status can't be read, unless given `--force`. `teardown.sh` checks the same way. The static IP is billed while reserved. `./teardown.sh` removes everything (VM, firewall rule, IP, bucket with all its files, service account). It prints the list and needs you to type the project ID.

## 4. DNS: `<your-tee-host>`

Pick a host in a zone you control, such as `tee.example.org` (the upstream demo uses `tee.abdulrashid.dev`). In Cloudflare, add an `A` record for it pointing to the static IP, with the proxy on (orange cloud). The TEE serves HTTPS on port 8080 with a self-signed certificate it generates in memory at startup, so keep the zone's SSL/TLS encryption mode on **Full** (not Full strict, which would reject that certificate, and not Flexible, which would use plain HTTP). Add a Cloudflare Origin Rule (rewrite destination port to 8080) because Cloudflare otherwise connects to the origin on 443.

The certificate has no trust role. Apps do not trust the transport: they verify the TEE's attestation token against Google's root and the on-chain settings, and encrypt to the key that token binds. Cloudflare can block the TEE but cannot make an app trust a fake one.

## 5. App environment values

Set at build time for `apps/web` and `apps/verifier` (viewers can change them in the verifier under Connection):

| Variable | Value |
| --- | --- |
| `VITE_TEE_URL` | `https://<your-tee-host>`, from step 4 |
| `VITE_RPC_URL` | your Sepolia RPC URL (a public one, because it is not secret here) |
| `VITE_REGISTRY_ADDRESS` | `REGISTRY` from step 1 |
| `VITE_EXAM_ID` | the published exam ID, as a fallback |
| `VITE_STORAGE_URL` | `https://storage.googleapis.com/<BUCKET>` |
| `VITE_TEE_STORAGE_BUCKET` | `<BUCKET>`, the one environment value the token check allows |
| `VITE_ARKIV_WRITERS` | the relay addresses that mirror the unlock to Arkiv, separated by commas. The board app writes them to each exam's ENS name, and the verifier uses them as its default |
| `VITE_SWARM_API_URL` | a read-only Swarm gateway for backups (`swarm.defaultApiUrl` in `spec/arkiv.json`, the viewer's own Bee node, when unset). The verifier only reads `GET /bzz/...` from it |
| `VITE_RELEASES_REPO` | your fork as `owner/name`, so the apps read TEE releases from it (upstream's `AbdulRashidReshamwala/paperseal` when unset) |
| `VITE_RELEASE_TAG` | verifier only: the release tag this build comes from, such as `v1.2.3`. The "Check with your own AI" prompt names it as the checker version. Unset or not `vX.Y.Z`, that button is disabled |

Demo ENS name on Sepolia: `paperseal-demo.eth`, owned by the board wallet, with a placeholder exam name `demo.paperseal-demo.eth` that carries the registry, TEE and storage records.

## Party names

`deploy/ens/records.mjs` prints the `cast send` commands that put a key card on a name and list the names in the directory. It sends nothing. See section 4 of [docs/ens-setup.md](../docs/ens-setup.md).

## One-machine demo

`pnpm demo:keys` shows a whole exam in one tab of your normal Chrome, with MetaMask for the board. It is the web app on <http://localhost:5171>, pointed at the deployed sealed machine and Sepolia (`apps/web/.env.demo-keys`), with a bar across the top: **Acting as** picks who you are. Use this to present. `pnpm demo` is the older way: one Chrome window per person, with keys that die with the browser. Use it only to try enrolment with a virtual key.

Each person has a planted key, fixed and derived from a public seed in `packages/keys/src/demo.ts`, so reloads and restarts lose nothing. The keys are simulated. The WebAuthn answers and signatures are real and the sealed machine checks them as it checks any key, but anyone can derive these keys, so they must never be on a real exam. The mode cannot reach a production build: see `apps/web/src/shared/demoKeys.ts`.

1. Put the planted keys on the names, once. They never change, so this does not need repeating. `node e2e/demo/cli.mjs names` prints the 11 key holder and centre cards and sends nothing. `node e2e/demo/cli.mjs names write` sends the records from the board keystore, as `node e2e/live/cli.mjs run` does, and replaces whatever is on those names.
2. Start the sealed machine for a new exam, as in step 3, and run `pnpm demo:keys`. It needs port 5171 free, so stop any other dev server first.
3. As **Exam board**, connect MetaMask and publish the exam. Copy the exam's setter links.
4. Switch to **Setter 1**, paste that setter's link in the address bar and register. Do the same for **Setter 2**.
5. Switch to each **Key holder** and **Centre**. Their page has their name filled in, and one click registers them.
6. Carry on as each person when the exam needs them. Switching reloads the page. Each tab has its own person, so you can keep one tab per person. Each person has their own browser storage, the exam board's drafts stay with the exam board, and only the current exam is shared.

There are five setters, because a limit of 20 percent per setter needs five. To present, do one setter and one centre by hand and let the exam board do the rest, from the **Everyone else** card on its exam page. It has one button per stage, shown only when the sealed machine is at that stage:

- **Register everyone else**, before the list is posted. Add the setter invites first: each remaining setter takes the next unused invite, and the card says if the exam needs more. Key holders and centres the board chose register by name.
- **Add questions for everyone else**, while questions are open. It seals plain sample questions so each topic meets its bank size and nobody passes the limit. A setter who wrote some by hand is left alone unless the limit needs them topped up. At 20 percent it does, because all five must hold the same share.
- **Release the rest**, at unlock. It releases up to the 8 needed. Centres still open the paper on their own pages.

Each button works one person at a time, with that person's planted key and through the same code as their own page, so the sealed machine checks every request as usual. Whatever comes back, such as a setter's receipts, is kept in that person's storage. Anyone already done is skipped, so pressing a button again is safe. If someone fails, the rest carry on, and that person's row says why and has **Try again**. The touch is asked at most once per click.

**Ask for a touch** in the bar asks a plugged-in security key for a touch, at most once per click. The first touch makes a throwaway credential on it. The touch is only for show: its result is thrown away and never used for any key. If no key answers or you press Cancel, the planted key carries on, after 30 seconds at most. Untick it to skip the touch.

For a four minute demo, publish off camera, then run `pnpm demo:vm <exam name>` to start the machine on it. New exams default to two small topics and a four minute window.

`pnpm --filter @paperseal/e2e ui:demo` runs whole exams this way in one tab, on the local mock world, without Sepolia: one person by person, and one with the **Everyone else** buttons.
