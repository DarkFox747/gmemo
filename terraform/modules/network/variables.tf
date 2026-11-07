variable "aws_region" {
  description = "AWS region (used to construct AZ names)."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDRs for the two public subnets (index 0 = AZ-a, index 1 = AZ-b)."
  type        = list(string)
  default     = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDRs for the two private subnets (index 0 = AZ-a, index 1 = AZ-b)."
  type        = list(string)
  default     = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "alb_ingress_cidrs" {
  description = "CIDR allowlist for inbound ALB traffic (ports 80 and 443). No default — must be set explicitly. Use at least your operator IP(s); 0.0.0.0/0 is defensible but not recommended."
  type        = list(string)
  # Intentionally no default — operators must make a conscious choice.
}
