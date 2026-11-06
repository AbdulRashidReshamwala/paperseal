# What outlives an exam (spec/deploy.md, "OpenTofu"): the APIs, the public
# bucket, the TEE's service account and roles, the static IP, and the firewall
# for the chosen ingress. It replaces deploy/gcp/enable-apis.sh,
# create-bucket.sh and create-service-account.sh, and creates the IP and the
# firewall rule under the names run-tee.sh reuses.
#
# The exam VM is NOT here, and must never be: its state is only in memory, and
# an apply that replaced it would destroy the question bank and keys. Start it
# with deploy/gcp/run-tee.sh --from-chain.

locals {
  deploy_json_path = coalesce(var.deploy_json, "${path.module}/../deploy.json")
  cfg              = jsondecode(file(local.deploy_json_path))

  project      = local.cfg.gcp.project
  region       = local.cfg.gcp.region
  zone         = local.cfg.gcp.zone
  bucket       = try(local.cfg.storage.bucket, "${local.project}-paperseal-exams")
  ingress_kind = local.cfg.ingress.kind

  # The same names deploy/gcp/lib.sh uses, so run-tee.sh finds these.
  sa_name       = "paperseal-tee"
  address_name  = "paperseal-tee-ip"
  firewall_name = "paperseal-tee-cloudflare-8080"
  network_tag   = "paperseal-tee"
  network       = "default"

  # As enable-apis.sh. artifactregistry is not needed: the image is on ghcr.io.
  apis = toset([
    "compute.googleapis.com",
    "confidentialcomputing.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
    "logging.googleapis.com",
  ])

  # As create-service-account.sh: project roles. objectCreator is on the bucket only.
  project_roles = toset([
    "roles/confidentialcomputing.workloadUser",
    "roles/logging.logWriter",
  ])

  cloudflare_ranges = local.ingress_kind == "cloudflare" ? [
    for l in split("\n", trimspace(data.http.cloudflare_ips[0].response_body)) : trimspace(l) if trimspace(l) != ""
  ] : []
}

provider "google" {
  project = local.project
  region  = local.region
  zone    = local.zone
}

# Refuses a plan for what the tooling doesn't support yet. A failed
# precondition stops `plan` and `apply` before anything is created.
resource "terraform_data" "deploy_json_guard" {
  input = local.deploy_json_path

  lifecycle {
    precondition {
      condition     = local.ingress_kind == "cloudflare"
      error_message = "ingress.kind \"${local.ingress_kind}\" is not implemented: only \"cloudflare\" is (spec/deploy.md). \"gcp-lb\" is reserved."
    }
    precondition {
      condition     = startswith(local.zone, "${local.region}-")
      error_message = "gcp.zone (${local.zone}) is not in gcp.region (${local.region})."
    }
  }
}

resource "google_project_service" "api" {
  for_each = local.apis

  project            = local.project
  service            = each.value
  disable_on_destroy = false

  depends_on = [terraform_data.deploy_json_guard]
}

# --- Bucket: public read, uniform access, CORS GET from any origin ----------
# Everything in it is public by design: the files are encrypted and hashed.

resource "google_storage_bucket" "exams" {
  name                        = local.bucket
  project                     = local.project
  location                    = upper(local.region)
  uniform_bucket_level_access = true
  # --no-public-access-prevention. If an organisation policy enforces public
  # access prevention, allow public buckets for this project first.
  public_access_prevention = "inherited"

  cors {
    origin          = ["*"]
    method          = ["GET"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }

  # The bucket holds the published exam files. Deleting it with its objects
  # stays a deliberate step (deploy/gcp/teardown.sh, or set this to true).
  force_destroy = false

  depends_on = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "public_read" {
  bucket = google_storage_bucket.exams.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# --- The TEE's service account ----------------------------------------------

resource "google_service_account" "tee" {
  project      = local.project
  account_id   = local.sa_name
  display_name = "Paper Seal TEE"

  depends_on = [google_project_service.api]
}

resource "google_project_iam_member" "tee" {
  for_each = local.project_roles

  project = local.project
  role    = each.value
  member  = "serviceAccount:${google_service_account.tee.email}"
}

resource "google_storage_bucket_iam_member" "tee_writer" {
  bucket = google_storage_bucket.exams.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.tee.email}"
}

# --- Ingress: cloudflare ----------------------------------------------------

resource "google_compute_address" "tee" {
  project = local.project
  name    = local.address_name
  region  = local.region

  depends_on = [google_project_service.api]
}

data "http" "cloudflare_ips" {
  count = local.ingress_kind == "cloudflare" ? 1 : 0
  url   = var.cloudflare_ips_url

  lifecycle {
    postcondition {
      condition     = self.status_code == 200 && length(regexall("^([0-9]{1,3}(\\.[0-9]{1,3}){3}/[0-9]{1,2}\\s*)+$", self.response_body)) > 0
      error_message = "Could not read Cloudflare's IPv4 ranges from ${var.cloudflare_ips_url}."
    }
  }
}

# Port 8080 from Cloudflare's published IPv4 ranges only.
resource "google_compute_firewall" "cloudflare" {
  count = local.ingress_kind == "cloudflare" ? 1 : 0

  project       = local.project
  name          = local.firewall_name
  network       = local.network
  direction     = "INGRESS"
  source_ranges = local.cloudflare_ranges
  target_tags   = [local.network_tag]

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  depends_on = [google_project_service.api]
}
