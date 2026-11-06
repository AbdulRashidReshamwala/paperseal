variable "deploy_json" {
  description = "Path to deploy.json (spec/deploy.md). Defaults to deploy/deploy.json."
  type        = string
  default     = null
}

variable "cloudflare_ips_url" {
  description = "Cloudflare's published IPv4 ranges, one per line. The firewall allows port 8080 from these only."
  type        = string
  default     = "https://www.cloudflare.com/ips-v4"
}
