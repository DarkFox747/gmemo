variable "aws_region" {
  description = "AWS region hosting the pilot ECR repo + ECS cluster."
  type        = string
  default     = "us-east-1"
}

variable "account_id" {
  description = "AWS account ID that owns the pilot resources. Used to build tightly-scoped resource ARNs."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "github_repo" {
  description = "GitHub repository (owner/name) whose Actions may assume the deploy role. Matches the OIDC 'sub' claim exactly."
  type        = string
}

variable "github_branch" {
  description = "The ONLY branch allowed to assume the deploy role. Enforced via the OIDC sub = repo:<repo>:ref:refs/heads/<branch> condition."
  type        = string
  default     = "main"
}

variable "role_name" {
  description = "Name of the CI/CD deploy role."
  type        = string
  default     = "lpms-pilot-ci-deploy"
}

variable "ecr_repository_name" {
  description = "ECR repository the pipeline may push to."
  type        = string
  default     = "lpms-pilot-app"
}

variable "ecs_cluster_name" {
  description = "ECS cluster hosting the pilot service."
  type        = string
  default     = "lpms-pilot"
}

variable "ecs_service_name" {
  description = "ECS service the pipeline may update + wait on."
  type        = string
  default     = "lpms-pilot-app"
}

variable "execution_role_name" {
  description = "Existing ECS task EXECUTION role. iam:PassRole is scoped to exactly this ARN (task defs reference it)."
  type        = string
  default     = "lpms-pilot-execution-role"
}

variable "task_role_name" {
  description = "Existing ECS TASK role. iam:PassRole is scoped to exactly this ARN (task defs reference it)."
  type        = string
  default     = "lpms-pilot-task-role"
}
