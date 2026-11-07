output "rds_endpoint" {
  description = "RDS instance endpoint (host:port). Sensitive — not displayed in plan output."
  value       = aws_db_instance.main.endpoint
  sensitive   = true
}

output "secret_arn" {
  description = "ARN of the Secrets Manager secret containing DATABASE_URL. Sensitive — not displayed in plan output."
  value       = aws_secretsmanager_secret.app.arn
  sensitive   = true
}

output "secret_name" {
  description = "Name of the Secrets Manager secret (non-sensitive, for reference)."
  value       = aws_secretsmanager_secret.app.name
}
