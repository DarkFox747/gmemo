output "alb_dns_name" {
  description = "ALB DNS name (used as the ALIAS target in the Route53 records)."
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID (for Route53 ALIAS records — informational)."
  value       = aws_lb.main.zone_id
}

output "pilot_url" {
  description = "HTTPS URL for the pilot MCP endpoint."
  value       = "https://${var.domain_name}/mcp"
}

output "ecr_repository_url" {
  description = "ECR repository URL. Push the app image here before running the ECS service."
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name (used in the aws ecs run-task migrate command)."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.app.name
}

output "ecs_task_definition_family" {
  description = "ECS task definition family (used in the aws ecs run-task migrate command)."
  value       = aws_ecs_task_definition.app.family
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group name for the pilot service."
  value       = aws_cloudwatch_log_group.app.name
}
