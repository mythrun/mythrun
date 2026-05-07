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

# ======== AWS Caller Identity (for account ID in ARNs) ========

data "aws_caller_identity" "current" {}

# ======== Serving Module (per-env ECS services, task defs, IAM, ALB target) ========
# Reads all shared-workspace outputs via data.terraform_remote_state.shared
# (the data source already exists at line 3 of this file).

module "serving" {
  source = "../../modules/serving"

  environment = var.environment

  # Network (from shared workspace's network module, passed through shared outputs)
  vpc_id             = data.terraform_remote_state.shared.outputs.vpc_id
  private_subnet_ids = data.terraform_remote_state.shared.outputs.private_subnet_ids
  ecs_sg_id          = data.terraform_remote_state.shared.outputs.ecs_sg_id

  # Compute platform (from shared workspace's MYT-30 additions)
  ecs_cluster_name       = data.terraform_remote_state.shared.outputs.ecs_cluster_name
  ecr_repository_url     = data.terraform_remote_state.shared.outputs.ecr_repository_url
  alb_arn                = data.terraform_remote_state.shared.outputs.alb_arn
  alb_listener_https_arn = data.terraform_remote_state.shared.outputs.alb_listener_https_arn
  alb_dns_name           = data.terraform_remote_state.shared.outputs.alb_dns_name
  alb_zone_id            = data.terraform_remote_state.shared.outputs.alb_zone_id

  # DNS
  dns_zone_id       = data.terraform_remote_state.shared.outputs.dns_zone_id
  dns_zone_name     = data.terraform_remote_state.shared.outputs.dns_zone_name
  wildcard_cert_arn = data.terraform_remote_state.shared.outputs.wildcard_cert_arn

  # Data-layer refs (from shared workspace's data module)
  rds_host   = data.terraform_remote_state.shared.outputs.rds_endpoint
  rds_port   = data.terraform_remote_state.shared.outputs.rds_port
  redis_host = data.terraform_remote_state.shared.outputs.redis_endpoint
  redis_port = data.terraform_remote_state.shared.outputs.redis_port

  # Secret ARNs
  shared_redis_auth_secret_arn = data.terraform_remote_state.shared.outputs.redis_auth_secret_arn
  manual_secret_arns           = { for k, v in aws_secretsmanager_secret.manual_secrets : k => v.arn }
  rds_password_secret_arn      = aws_secretsmanager_secret.bootstrap_secrets["rds-password"].arn

  # MYT-35: flip the boot gate ON in staging. MYT-37 promoted BOOT_GATE_ENABLED
  # from a free-form extra_env entry to a dedicated module variable
  # (boot_gate_enabled) — the module default is "1" so this is technically
  # redundant, but stating it explicitly here makes the staging contract
  # legible at the composition layer.
  boot_gate_enabled = "1"

  # MYT-36 / MYT-37: Cognito values, promoted from free-form extra_env entries
  # (now rejected by serving module's reserved-name validation) to dedicated
  # module inputs wired from the auth module's outputs.
  cognito_user_pool_id     = module.auth.user_pool_id
  cognito_app_client_id    = module.auth.app_client_id
  cognito_issuer_url       = module.auth.issuer_url
  cognito_hosted_ui_domain = module.auth.hosted_ui_domain

  # MYT-38: frontend SPA origin. The app validator allowlists
  # staging.mythrun.com when NODE_ENV=production, so this is the canonical
  # value for the staging environment.
  frontend_base_url = "https://staging.mythrun.com"

  # Staging uses module defaults (256/512, 14-day log retention) per Week 0 §7.2.
}

# ======== Auth Module (Cognito User Pool + Google + Discord IdPs) ========
# MYT-36. Two-pass apply: cognito_idps_enabled=false initially creates the
# Pool, App Client, Hosted UI domain, and OAuth secret shells with PLACEHOLDER
# values. Human-action registers OAuth apps and pastes {client_id, client_secret}
# JSON via aws secretsmanager put-secret-value. Flipping cognito_idps_enabled=true
# in terraform.tfvars and re-applying creates the IdPs reading the secrets.

module "auth" {
  source = "../../modules/auth"

  environment  = var.environment
  idps_enabled = var.cognito_idps_enabled

  # Staging is intentionally local-frontend-only per MYT-36 spec §6.
  # Production composition (myth-prod-auth-compose follow-up bead) adds the
  # production mythrun.com URLs onto a separate prod App Client.
  callback_urls = ["http://localhost:5173/auth/callback"]
  logout_urls   = ["http://localhost:5173"]
}

# ======== Bootstrap-DB Task Definition ========
# Provisions the one-shot ECS task family `mythrun-staging-bootstrap-db` for
# bootstrap / password-rotation / drift-recovery operations against the
# staging RDS instance. See docs/wiki/content/data/bootstrap-database.html.

module "bootstrap_db" {
  source = "../../modules/bootstrap-db"

  environment = var.environment

  vpc_id             = data.terraform_remote_state.shared.outputs.vpc_id
  private_subnet_ids = data.terraform_remote_state.shared.outputs.private_subnet_ids
  rds_sg_id          = data.terraform_remote_state.shared.outputs.rds_sg_id
  ecs_cluster_name   = data.terraform_remote_state.shared.outputs.ecs_cluster_name

  ecr_repository_url = data.terraform_remote_state.shared.outputs.bootstrap_db_ecr_repository_url
  image_tag          = var.bootstrap_image_tag

  rds_host                = data.terraform_remote_state.shared.outputs.rds_endpoint
  rds_port                = data.terraform_remote_state.shared.outputs.rds_port
  rds_master_secret_arn   = data.terraform_remote_state.shared.outputs.rds_master_user_secret_arn
  rds_password_secret_arn = aws_secretsmanager_secret.bootstrap_secrets["rds-password"].arn
}

# ======== GitHub Actions IAM Role (staging-scoped) ========
# Trust policy hardens against:
#   - missing audience (aud must be sts.amazonaws.com)
#   - wrong repo (repository must be mythrun/mythrun)
#   - repo-rename AND org-rename/reclaim attacks (repository_id is the numeric
#     repo ID, immutable across renames — see MYT-28 debugging history)
#   - wrong GitHub Environment (must be 'staging')
#   - wrong branch (must be main)
# All conditions are StringEquals — StringLike with no wildcards would behave
# identically today but invite silent broadening on a future refactor.
#
# Historical note (MYT-28, 2026-04-24): we originally pinned `repository_owner_id`
# but AWS silently rejects that key — it's not in the IAM allowlist of supported
# GitHub OIDC condition keys. Swapped to `repository_id` (strictly stronger: a
# specific repo ID implies a specific owner).

data "aws_iam_policy_document" "gh_actions_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.terraform_remote_state.shared.outputs.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository"
      values   = ["mythrun/mythrun"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }

    # Requires a GitHub Environment named "staging" on the mythrun/mythrun
    # repo. MYT-28 configures this (Settings → Environments).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:environment"
      values   = ["staging"]
    }

    # Belt-and-suspenders on top of the GitHub Environment's own
    # Deployment-branches rule.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/main"]
    }

    # AWS IAM requires the trust policy to pin `:sub` (not just the split
    # claims above) — rejects CreateRole otherwise with
    # "must evaluate, using StringEquals/StringLike/StringEqualsIgnoreCase,
    # token.actions.githubusercontent.com:sub which is not scoped to all".
    # The `sub` claim is constructed by GitHub as
    # "repo:<owner>/<name>:environment:<env>", so pinning it is redundant
    # with `repository` + `environment` above — but AWS insists.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:mythrun/mythrun:environment:staging"]
    }
  }
}

resource "aws_iam_role" "github_actions_staging" {
  name               = "mythrun-github-actions-staging"
  assume_role_policy = data.aws_iam_policy_document.gh_actions_trust.json

  tags = { Name = "mythrun-github-actions-staging" }
}

data "aws_iam_policy_document" "gh_actions_staging" {
  # ECR auth token — account-wide by AWS design (can't be ARN-scoped).
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # ECR push/pull — scoped to the mythrun repo.
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = [
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun",
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun-bootstrap-db",
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/ecr-public/*",
    ]
  }

  # Pull-through cache: auto-create cache repos + trigger upstream pulls.
  # Scoped to the ecr-public/* prefix (set by the shared workspace's
  # aws_ecr_pull_through_cache_rule.ecr_public pointing at public.ecr.aws).
  # Without these, the first `docker pull` through the cache fails at ECR authz.
  statement {
    actions = [
      "ecr:CreateRepository",
      "ecr:BatchImportUpstreamImage",
    ]
    resources = [
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/ecr-public/*",
    ]
  }

  # ECS mutating actions scoped to the mythrun cluster via the ecs:cluster
  # condition key (supported on UpdateService / DescribeServices / task list).
  statement {
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ecs:cluster"
      values = [
        "arn:aws:ecs:us-east-1:${data.aws_caller_identity.current.account_id}:cluster/mythrun",
      ]
    }
  }

  # RegisterTaskDefinition + DeregisterTaskDefinition support resource-ARN
  # scoping on family patterns. Lock to this env's family.
  statement {
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DeregisterTaskDefinition",
    ]
    resources = [
      "arn:aws:ecs:us-east-1:${data.aws_caller_identity.current.account_id}:task-definition/mythrun-${var.environment}-*:*",
    ]
  }

  # DescribeTaskDefinition cannot be ARN-scoped or cluster-scoped per AWS
  # Service Authorization Reference — requires "*".
  statement {
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  # PassRole limited to the two task roles AND conditioned on the service
  # being ECS. Defense against chain-assume into another service.
  statement {
    actions = ["iam:PassRole"]
    resources = [
      module.serving.task_execution_role_arn,
      module.serving.task_role_arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # rds:CreateDBSnapshot intentionally omitted. Infra §5.5 specifies pre-deploy
  # snapshots for production only; staging has deletion_protection disabled.
  # The production GH role (at Launch) will carry this permission.
}

resource "aws_iam_role_policy" "github_actions_staging" {
  name   = "deploy-permissions"
  role   = aws_iam_role.github_actions_staging.id
  policy = data.aws_iam_policy_document.gh_actions_staging.json
}

# ======== SNS Alerts Topic ========
# Topic lands here; alarms (Week 0 §6.3) land in the Observability milestone.
# Email subscription starts in PendingConfirmation — recipient must click the
# AWS-sent confirmation link before alarms will deliver. Re-running terraform
# apply while pending is a no-op; confirmation isn't a Terraform-managed attr.

resource "aws_sns_topic" "alerts" {
  name              = "mythrun-staging-alerts"
  kms_master_key_id = "alias/aws/sns" # AWS-managed KMS for encryption-at-rest; zero additional cost

  tags = { Name = "mythrun-staging-alerts" }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alerts_email

  # The subscription resource lands with SubscriptionArn = "PendingConfirmation"
  # until Miklos clicks the email link. "Done-when" for MYT-30 splits into
  # apply-time (this resource exists) and post-apply-confirmation (ARN is
  # no longer the literal "PendingConfirmation" string) — verified with:
  #   aws sns list-subscriptions-by-topic --topic-arn <arn> \
  #     --query 'Subscriptions[0].SubscriptionArn'
}
