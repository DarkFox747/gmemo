variable "aws_region" {
  description = "AWS region."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for the ALB and Fargate task (assign_public_ip=true)."
  type        = list(string)
}

variable "alb_sg_id" {
  description = "ALB security group ID."
  type        = string
}

variable "fargate_sg_id" {
  description = "Fargate security group ID."
  type        = string
}

variable "secret_arn" {
  description = "ARN of the Secrets Manager secret containing the DATABASE_URL JSON key."
  type        = string
}

variable "image_tag" {
  description = "Docker image tag to deploy (e.g. 'latest' or a git SHA)."
  type        = string
  default     = "latest"
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU). Minimum for the pilot."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB. Bump to 1024 if OOM."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "ECS service desired task count. Set to 0 to pause the pilot."
  type        = number
  default     = 1
}

variable "bedrock_model_arns" {
  description = "ARNs the task role may invoke via bedrock:InvokeModel / bedrock:Converse. Include the inference-profile ARN and each constituent foundation-model ARN if using a cross-region profile (FLAG 6)."
  type        = list(string)

  validation {
    condition     = length(var.bedrock_model_arns) > 0 && alltrue([for a in var.bedrock_model_arns : can(regex("^arn:aws:bedrock:", a))])
    error_message = "bedrock_model_arns must be non-empty and every element must start with 'arn:aws:bedrock:'. A wildcard [\"*\"] is not allowed — it would grant account-wide Bedrock access."
  }
}

variable "bedrock_model_id" {
  description = "Bedrock model ID for the judge (e.g. us.anthropic.claude-3-5-haiku-20241022-v1:0)."
  type        = string
}

variable "bedrock_embedding_model_id" {
  description = "Bedrock model ID for embeddings (amazon.titan-embed-text-v2:0)."
  type        = string
}

variable "cognito_user_pool_id" {
  description = "Cognito user pool ID → COGNITO_USER_POOL_ID env var."
  type        = string
}

variable "cognito_app_client_id" {
  description = "Cognito app client ID → COGNITO_CLIENT_ID_ALLOWLIST env var."
  type        = string
}

variable "github_oidc_audience" {
  description = "GitHub OIDC audience → GITHUB_OIDC_AUDIENCE env var. Placeholder this pilot (/promote is fail-closed); must be non-empty to satisfy the prod boot guard."
  type        = string
}

variable "node_extra_ca_certs" {
  description = "Path to the RDS CA bundle baked into the image. Node adds it to the trust store at startup so rejectUnauthorized:true succeeds."
  type        = string
  default     = "/etc/ssl/certs/rds-global-bundle.pem"
}

variable "certificate_arn" {
  description = "Validated ACM certificate ARN for the ALB HTTPS listener."
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for the A/AAAA ALIAS records."
  type        = string
}

variable "domain_name" {
  description = "FQDN the pilot answers on (used for the Route53 ALIAS record name and the pilot_url output)."
  type        = string
}
