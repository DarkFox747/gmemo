terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # No backend block — bootstrap uses local state by design (chicken-and-egg).
  # The operator retains terraform.tfstate from this root locally.
  # Recovery: deterministic resource names → `terraform import` if state is lost.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = "gmemo"
      Env     = "bootstrap"
    }
  }
}
