terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Partial backend — fill in with: terraform init -backend-config=backend.hcl
  # Run terraform/bootstrap/ first to create the S3 bucket and DynamoDB table.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = "lpms"
      Env     = "pilot"
    }
  }
}
