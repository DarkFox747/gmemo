# Non-secret backend configuration — safe to commit.
# Fill in before `terraform init`
# Reuses the existing state bucket + lock table created by terraform/bootstrap/,
# with a DISTINCT key so the CI/CD IAM state is isolated from the pilot infra state.
#
# Usage: terraform init -backend-config=backend.hcl

bucket         = "<TFSTATE_BUCKET>"
key            = "cicd/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "<TFLOCK_TABLE>"
encrypt        = true
