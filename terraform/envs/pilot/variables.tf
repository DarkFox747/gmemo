variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------
variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDRs for the two public subnets (AZ-a and AZ-b)."
  type        = list(string)
  default     = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDRs for the two private subnets (AZ-a and AZ-b)."
  type        = list(string)
  default     = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "alb_ingress_cidrs" {
  description = "CIDR allowlist for inbound ALB traffic (ports 80 and 443). No default — must be set. Use your operator IP(s). 0.0.0.0/0 is defensible with Cognito+TLS but not recommended."
  type        = list(string)
  # Intentionally no default — operators must make a conscious choice.
}

# ---------------------------------------------------------------------------
# Container / service
# ---------------------------------------------------------------------------
variable "image_tag" {
  description = "Docker image tag to deploy."
  type        = string
  default     = "latest"
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "ECS service desired task count. Set to 0 to pause the pilot."
  type        = number
  default     = 0
}

# ---------------------------------------------------------------------------
# Bedrock
# ---------------------------------------------------------------------------
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
  description = "Bedrock model ID for embeddings."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

# ---------------------------------------------------------------------------
# Cognito
# ---------------------------------------------------------------------------
variable "authorized_user_emails" {
  description = "Email addresses to provision as Cognito users. No password in Terraform — operator sets a permanent password out-of-band."
  type        = list(string)
}

# ---------------------------------------------------------------------------
# GitHub OIDC
# ---------------------------------------------------------------------------
variable "github_oidc_audience" {
  description = "GitHub OIDC audience for /promote. Placeholder this pilot (/promote is fail-closed). Must be non-empty to satisfy the prod boot guard."
  type        = string
}

# ---------------------------------------------------------------------------
# DNS + TLS
# ---------------------------------------------------------------------------
variable "domain_name" {
  description = "FQDN the pilot answers on (e.g. lpms-pilot.yourdomain.dev)."
  type        = string
}

variable "route53_zone_name" {
  description = "Route53 parent hosted zone name (e.g. yourdomain.dev)."
  type        = string
}

variable "create_hosted_zone" {
  description = "Create the Route53 hosted zone. When false (default), looks up an existing zone. When true, outputs name_servers for NS delegation at the registrar."
  type        = bool
  default     = false
}
