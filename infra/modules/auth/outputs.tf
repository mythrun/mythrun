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

# MYT-55: the staging smoke-prep-pipeline task family's task role needs
# secretsmanager:GetSecretValue on these four ARNs. Surfacing them as a map
# keyed by user-name (owner | player_1 | player_2 | player_3) lets the
# environment-level composition wire them into an IAM policy without
# reaching across module boundaries via a name convention. Empty map when
# smoke_test_user_enabled = false (production), so production compositions
# can reference this output unconditionally — they just get nothing.
output "smoke_test_credentials_secret_arns" {
  description = "ARNs of the four smoke-test user Secrets Manager entries, keyed by user-name (owner | player_1 | player_2 | player_3). Empty map when smoke_test_user_enabled = false."
  value = var.smoke_test_user_enabled ? {
    for k, v in aws_secretsmanager_secret.smoke_test_credentials : k => v.arn
  } : {}
}
