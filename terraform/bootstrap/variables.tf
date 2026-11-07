variable "aws_region" {
  description = "AWS region for the state backend resources."
  type        = string
  default     = "us-east-1"
}

variable "state_bucket_name" {
  description = "S3 bucket name for Terraform state. Must be globally unique (e.g. lpms-pilot-tfstate-<account-id-suffix>)."
  type        = string
}

variable "lock_table_name" {
  description = "DynamoDB table name for Terraform state locking. Written into backend.hcl."
  type        = string
  default     = "lpms-pilot-tflock"
}
