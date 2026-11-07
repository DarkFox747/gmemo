variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Allocated storage in GB."
  type        = number
  default     = 20
}

variable "db_engine_version" {
  description = "PostgreSQL engine version prefix (e.g. '16')."
  type        = string
  default     = "16"
}

variable "db_parameter_group_family" {
  description = "DB parameter group family (must match the engine version)."
  type        = string
  default     = "postgres16"
}

variable "private_subnet_ids" {
  description = "IDs of the private subnets for the DB subnet group (≥2 AZs required)."
  type        = list(string)
}

variable "rds_sg_id" {
  description = "Security group ID that allows inbound 5432 from the Fargate SG."
  type        = string
}

variable "secret_name" {
  description = "Secrets Manager secret name for the app credentials (DATABASE_URL JSON key)."
  type        = string
  default     = "gmemo/pilot/app"
}
