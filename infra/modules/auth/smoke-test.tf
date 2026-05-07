# infra/modules/auth/smoke-test.tf
#
# Native Cognito test user for staging smoke testing. Provisioned alongside
# the federated (Google / Discord) flow and gated by var.smoke_test_user_enabled
# so production never carries a test user.
#
# Why this exists rather than a throwaway user provisioned at smoke time:
# pre-provisioning means the smoke script has zero AWS write operations; it
# just authenticates and exercises the API. That keeps the script's IAM
# footprint small and makes the smoke runnable from any role with read-only
# access to the secret + the API.
#
# Why a native user (not federated): we don't have Mythrun-controlled Google
# or Discord test accounts. Native Cognito users let us own the credential
# end-to-end. The user pool's `username_attributes = ["email"]` means the
# username must be a valid email shape; smoke-test@mythrun.com works fine
# even though no mailbox actually exists at that address (email_verified is
# set to true at provisioning time so Cognito doesn't try to validate).
#
# Implementation note: the hashicorp/aws Terraform provider does not have
# an `aws_cognito_user_pool_user` resource — Cognito user CRUD lives in the
# SDK / CLI only. We use a `null_resource` with `local-exec` running
# `aws cognito-idp admin-create-user` + `admin-set-user-password --permanent`.
# The script is idempotent (admin-create-user errors with UsernameExistsException
# if the user already exists; we swallow that and proceed to set-password).

resource "random_password" "smoke_test" {
  count            = var.smoke_test_user_enabled ? 1 : 0
  length           = 32
  special          = true
  override_special = "!@#$%^&*-_=+"

  # Cognito user pools enforce a default password policy: ≥8 chars, with at
  # least one uppercase, lowercase, number, and symbol. random_password's
  # defaults satisfy uppercase + lowercase + number; override_special pins
  # the symbol set to characters Cognito accepts (Cognito rejects some
  # exotic Unicode symbols that random_password's default set may include).
  min_lower   = 1
  min_upper   = 1
  min_numeric = 1
  min_special = 1
}

resource "aws_secretsmanager_secret" "smoke_test_credentials" {
  count                   = var.smoke_test_user_enabled ? 1 : 0
  name                    = "mythrun/${var.environment}/smoke-test-credentials"
  description             = "Native Cognito test-user credentials for staging smoke testing. JSON-encoded {username, password}."
  recovery_window_in_days = 0
  tags                    = { Name = "mythrun-${var.environment}-smoke-test-credentials" }
}

locals {
  smoke_test_username = "smoke-test@mythrun.com"
}

resource "aws_secretsmanager_secret_version" "smoke_test_credentials" {
  count     = var.smoke_test_user_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.smoke_test_credentials[0].id
  secret_string = jsonencode({
    username = local.smoke_test_username
    password = random_password.smoke_test[0].result
  })
}

# Cognito user CRUD via AWS CLI. Idempotent: admin-create-user fails with
# UsernameExistsException on re-runs (we ignore via `|| true`); admin-set-user-password
# succeeds whether the user was just created or already existed. Triggers
# rerun on password rotation OR username change.
resource "null_resource" "smoke_test_user" {
  count = var.smoke_test_user_enabled ? 1 : 0

  triggers = {
    user_pool_id = aws_cognito_user_pool.main.id
    username     = local.smoke_test_username
    password_sha = sha256(random_password.smoke_test[0].result)
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      aws cognito-idp admin-create-user \
        --user-pool-id ${aws_cognito_user_pool.main.id} \
        --username '${local.smoke_test_username}' \
        --user-attributes Name=email,Value='${local.smoke_test_username}' Name=email_verified,Value=true \
        --message-action SUPPRESS \
        --region ${data.aws_region.current.region} 2>&1 | grep -v UsernameExistsException || true
      aws cognito-idp admin-set-user-password \
        --user-pool-id ${aws_cognito_user_pool.main.id} \
        --username '${local.smoke_test_username}' \
        --password '${random_password.smoke_test[0].result}' \
        --permanent \
        --region ${data.aws_region.current.region}
    EOT
  }

  # On terraform destroy, remove the Cognito user. Without this, destroying
  # the auth module leaves an orphan user (Cognito's user-pool delete would
  # cascade, but if we ever destroy just the smoke-test resources without
  # deleting the pool, the user lingers).
  provisioner "local-exec" {
    when = destroy
    command = <<-EOT
      aws cognito-idp admin-delete-user \
        --user-pool-id ${self.triggers.user_pool_id} \
        --username '${self.triggers.username}' \
        --region us-east-1 2>&1 | grep -v UserNotFoundException || true
    EOT
  }
}
