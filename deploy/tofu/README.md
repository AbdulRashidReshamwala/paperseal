# OpenTofu: what outlives an exam

This creates, from `deploy/deploy.json`, the parts of a board's Google Cloud project that last longer than one exam (spec/deploy.md, "OpenTofu"):

- the APIs that `enable-apis.sh` enabled
- the public bucket: uniform access, `allUsers` can read, CORS `GET` from any origin
- the TEE's service account `paperseal-tee`, with `workloadUser` and `logWriter` on the project and `objectCreator` on the bucket only
- the static IP `paperseal-tee-ip`
- for `ingress.kind = "cloudflare"`, the firewall rule `paperseal-tee-cloudflare-8080`: port 8080 from Cloudflare's published IPv4 ranges only, read from <https://www.cloudflare.com/ips-v4> on each plan

It replaces `deploy/gcp/enable-apis.sh`, `create-bucket.sh` and `create-service-account.sh`, which still work but are deprecated.

`ingress.kind = "gcp-lb"` is reserved. A plan with it fails with a not-implemented error before anything is created.

**The exam VM is not here, and must never be.** Its state is only in memory, and an apply that replaced it would destroy the question bank and keys. Start it with `deploy/gcp/run-tee.sh --from-chain --exam <examId>`, which reuses the IP, firewall rule and service account by name.

It works with `tofu` and `terraform`; replace one with the other in the commands below. Nothing here needs a secret. The Google provider uses your own login:

```sh
gcloud auth application-default login
```

## Plan and apply

From `deploy/tofu/`, with `deploy/deploy.json` copied from `deploy/deploy.example.json` and edited:

```sh
tofu init
tofu plan
tofu apply
tofu output            # tee_ip, bucket, service_account_email, storage_url
```

To use another file: `tofu plan -var deploy_json=/path/to/deploy.json`.

State is local (`terraform.tfstate` here, gitignored). It holds no secret, but keep it: without it, OpenTofu no longer knows it manages these resources. To share it with other operators, add a `gcs` backend in `versions.tf`.

If an organisation policy enforces public access prevention, the bucket's public read fails until you allow public buckets for this project.

`tofu destroy` keeps the bucket if it holds any file (`force_destroy = false`), because the published exam files live there. Stop the VM with `deploy/gcp/stop-tee.sh` before destroying the IP and firewall rule.

## Bringing in resources made by the old scripts

The upstream demo, and any project set up with the scripts, already has these resources. Import them instead of creating them again, then check that `tofu plan` shows no changes you don't expect. Set the names from your `deploy.json` first:

```sh
P=paperseal-demo                       # gcp.project
R=asia-south2                          # gcp.region
B=paperseal-demo-paperseal-exams       # storage.bucket, or $P-paperseal-exams
SA=paperseal-tee@$P.iam.gserviceaccount.com

tofu init

for api in compute confidentialcomputing iamcredentials sts storage logging; do
  tofu import "google_project_service.api[\"$api.googleapis.com\"]" "$P/$api.googleapis.com"
done

tofu import google_storage_bucket.exams "$P/$B"
tofu import google_storage_bucket_iam_member.public_read "b/$B roles/storage.objectViewer allUsers"

tofu import google_service_account.tee "projects/$P/serviceAccounts/$SA"
tofu import 'google_project_iam_member.tee["roles/confidentialcomputing.workloadUser"]' \
  "$P roles/confidentialcomputing.workloadUser serviceAccount:$SA"
tofu import 'google_project_iam_member.tee["roles/logging.logWriter"]' \
  "$P roles/logging.logWriter serviceAccount:$SA"
tofu import google_storage_bucket_iam_member.tee_writer "b/$B roles/storage.objectCreator serviceAccount:$SA"

tofu import google_compute_address.tee "projects/$P/regions/$R/addresses/paperseal-tee-ip"
tofu import 'google_compute_firewall.cloudflare[0]' "projects/$P/global/firewalls/paperseal-tee-cloudflare-8080"

tofu plan
```

`terraform_data.deploy_json_guard` has nothing to import: it only holds the checks. The running exam VM is never imported.

`run-tee.sh` still updates the firewall rule's source ranges each run, from the same Cloudflare list, so the two agree. If Cloudflare changes its ranges, the next `tofu plan` shows the update.
