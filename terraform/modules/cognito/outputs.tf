output "user_pool_id" {
  description = "Cognito user pool ID → COGNITO_USER_POOL_ID task env var."
  value       = aws_cognito_user_pool.main.id
}

output "app_client_id" {
  description = "Cognito app client ID → COGNITO_CLIENT_ID_ALLOWLIST task env var."
  value       = aws_cognito_user_pool_client.main.id
}

output "issuer" {
  description = "Cognito token issuer URL (informational — used by aws-jwt-verify internally)."
  value       = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "jwks_uri" {
  description = "Cognito JWKS endpoint (informational — for runbook verification)."
  value       = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.main.id}/.well-known/jwks.json"
}
