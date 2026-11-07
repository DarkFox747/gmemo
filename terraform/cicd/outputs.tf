output "ci_deploy_role_arn" {
  description = "ARN of the CI/CD deploy role. Set this as the GitHub repo variable AWS_CICD_ROLE_ARN (non-secret — OIDC needs no stored keys)."
  value       = aws_iam_role.ci_deploy.arn
}

output "github_oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC provider (informational)."
  value       = aws_iam_openid_connect_provider.github.arn
}
