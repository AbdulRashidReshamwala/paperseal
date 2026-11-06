# The values deploy/gcp/run-tee.sh needs. It finds the IP, service account and
# firewall by name, and the bucket from deploy.json, so nothing must be copied.

output "tee_ip" {
  description = "The static IP. Point the proxied Cloudflare A record for ingress.teeHost at it."
  value       = google_compute_address.tee.address
}

output "bucket" {
  description = "The public bucket, passed to the TEE as STORAGE_BUCKET."
  value       = google_storage_bucket.exams.name
}

output "service_account_email" {
  description = "The TEE VM's service account."
  value       = google_service_account.tee.email
}

output "storage_url" {
  description = "storageUrl for the apps' config.json."
  value       = "https://storage.googleapis.com/${google_storage_bucket.exams.name}"
}
