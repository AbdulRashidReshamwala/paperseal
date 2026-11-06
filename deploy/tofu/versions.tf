# Works with OpenTofu and Terraform (>= 1.4, for terraform_data).
terraform {
  required_version = ">= 1.4.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
    http = {
      source  = "hashicorp/http"
      version = ">= 3.4, < 4.0"
    }
  }

  # State is local (terraform.tfstate here, gitignored) unless you add a
  # backend. It holds no secret: nothing here creates a key.
}
