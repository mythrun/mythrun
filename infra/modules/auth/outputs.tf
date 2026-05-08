# infra/modules/auth/outputs.tf

output "user_pool_id" {
  description = "Cognito User Pool ID. Consumed by backend env var COGNITO_USER_POOL_ID and aws cognito-idp CLI commands."
  value       = aws_cognito_user_pool.main.id
}

output "app_client_id" {
  description = "Cognito App Client ID. Consumed by backend env var COGNITO_APP_CLIENT_ID and OAuth flow URLs."
  value       = aws_cognito_user_pool_client.main.id
}

output "hosted_ui_domain" {
  description = "Fully-qualified Hosted UI domain (e.g. mythrun-staging.auth.us-east-1.amazoncognito.com). Backend constructs /oauth2/* paths from this. Built from the AWS region data source so the module is region-portable."
  value       = "${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}

output "issuer_url" {
  description = "OIDC issuer URL for JWT validation in MYT-37. Constructed from data.aws_region.current.region + the User Pool ID. JWT middleware verifies the iss claim against this exact string and derives the JWKS URL as $${issuer_url}/.well-known/jwks.json."
  value       = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "user_pool_arn" {
  description = "Cognito User Pool ARN. Consumed by IAM policies that need to scope cognito-idp actions (e.g., the GitHub Actions smoke role)."
  value       = aws_cognito_user_pool.main.arn
}

output "smoke_test_credentials_secret_arn" {
  description = "Secrets Manager ARN for the smoke-test user's credentials JSON. Null when smoke_test_user_enabled = false."
  value       = var.smoke_test_user_enabled ? aws_secretsmanager_secret.smoke_test_credentials[0].arn : null
}
