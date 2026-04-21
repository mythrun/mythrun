# Read the shared workspace's state so we can reference its outputs.
# shared/ must be applied before staging/ or this returns null outputs.
data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "mythrun-terraform-state"
    key    = "environments/shared/terraform.tfstate"
    region = "us-east-1"
  }
}

locals {
  env = var.environment

  # Secrets populated manually via AWS Console/CLI. Placeholder initial version
  # is OK because app never reads these until values are set.
  manual_secret_names = [
    "anthropic-api-key",
    "stripe-secret-key",
    "stripe-webhook-secret",
    "cognito-client-secret",
  ]

  # Secrets populated by bootstrap-databases.sh (post-MYT-30). NO Terraform-
  # managed version resource — this avoids the landmine where
  # `terraform apply -replace` on a placeholder version would overwrite the
  # real password with PLACEHOLDER.
  bootstrap_secret_names = [
    "rds-password",
  ]
}

resource "aws_secretsmanager_secret" "manual_secrets" {
  for_each                = toset(local.manual_secret_names)
  name                    = "mythrun/${local.env}/${each.key}"
  description             = "Mythrun ${local.env} ${each.key} (value set via AWS Console/CLI out-of-band)"
  recovery_window_in_days = 7

  tags = { Name = "mythrun-${local.env}-${each.key}" }
}

resource "aws_secretsmanager_secret_version" "manual_secrets" {
  for_each      = aws_secretsmanager_secret.manual_secrets
  secret_id     = each.value.id
  secret_string = "PLACEHOLDER — set via AWS Console / CLI"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# rds-password: shell only. bootstrap-databases.sh creates the first version.
resource "aws_secretsmanager_secret" "bootstrap_secrets" {
  for_each                = toset(local.bootstrap_secret_names)
  name                    = "mythrun/${local.env}/${each.key}"
  description             = "Mythrun ${local.env} ${each.key} (value created by bootstrap-databases.sh; no Terraform-managed version to avoid overwrite-on-replace landmine)"
  recovery_window_in_days = 7

  tags = { Name = "mythrun-${local.env}-${each.key}" }
}
