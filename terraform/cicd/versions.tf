terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    # tls is used ONLY to fetch GitHub's OIDC endpoint certificate thumbprint at
    # plan time, so we never hardcode a thumbprint that can go stale (GitHub has
    # rotated it before). This is a Terraform-time provider, not an app runtime
    # dependency.
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # Partial backend — same S3 bucket + DynamoDB lock table as the pilot root,
  # but a DISTINCT state key (cicd/…) so CI/CD IAM state never collides with the
  # infra state. Fill in with: terraform init -backend-config=backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = "gmemo"
      Env     = "cicd"
    }
  }
}
