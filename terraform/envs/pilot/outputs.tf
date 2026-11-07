output "pilot_url" {
  description = "HTTPS URL for the pilot MCP endpoint. Point your MCP client here."
  value       = module.service.pilot_url
}

output "alb_dns_name" {
  description = "ALB DNS name (informational — DNS resolves to this via the Route53 ALIAS record)."
  value       = module.service.alb_dns_name
}

output "ecr_repository_url" {
  description = "ECR repository URL. Push the app image before service will start."
  value       = module.service.ecr_repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name — used in the aws ecs run-task migrate command."
  value       = module.service.ecs_cluster_name
}

output "ecs_task_definition_family" {
  description = "ECS task definition family — used in the aws ecs run-task migrate command."
  value       = module.service.ecs_task_definition_family
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID."
  value       = module.cognito.user_pool_id
}

output "cognito_app_client_id" {
  description = "Cognito app client ID (pass as --client-id to initiate-auth)."
  value       = module.cognito.app_client_id
}

output "cognito_issuer" {
  description = "Cognito issuer URL (informational)."
  value       = module.cognito.issuer
}

output "route53_name_servers" {
  description = "Route53 hosted zone name servers. Non-null only when create_hosted_zone=true. Complete NS delegation at the registrar before ACM validation can succeed."
  value       = module.dns_tls.name_servers
}

output "secret_arn" {
  description = "Secrets Manager secret ARN (contains DATABASE_URL)."
  value       = module.data.secret_arn
  sensitive   = true
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group for the pilot service."
  value       = module.service.cloudwatch_log_group
}

output "public_subnet_ids" {
  description = "Public subnet IDs — use one as SUBNET_ID in the aws ecs run-task migrate command (Step 7)."
  value       = module.network.public_subnet_ids
}

output "fargate_sg_id" {
  description = "Fargate security group ID — use as FARGATE_SG in the aws ecs run-task migrate command (Step 7)."
  value       = module.network.fargate_sg_id
}

output "ecs_service_name" {
  description = "ECS service name — used for Day-2 operations (force-new-deployment, scale)."
  value       = module.service.ecs_service_name
}
