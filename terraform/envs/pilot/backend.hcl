# Non-secret backend configuration — safe to commit.
# Fill in before `terraform init`
#
# Usage: terraform init -backend-config=backend.hcl

bucket         = "<TFSTATE_BUCKET>"
key            = "envs/pilot/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "<TFLOCK_TABLE>"
encrypt        = true
