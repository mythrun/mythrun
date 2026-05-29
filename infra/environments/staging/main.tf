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

# ======== AWS Region (for smoke task env-var injection) ========
# Added MYT-55: the smoke task family injects AWS_REGION + awslogs-region
# from this data source rather than hardcoding "us-east-1" — keeps the
# resource region-portable for the eventual production composition.
data "aws_region" "current" {}

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
  rds_host              = data.terraform_remote_state.shared.outputs.rds_endpoint
  rds_port              = data.terraform_remote_state.shared.outputs.rds_port
  rds_security_group_id = data.terraform_remote_state.shared.outputs.rds_sg_id
  redis_host            = data.terraform_remote_state.shared.outputs.redis_endpoint
  redis_port            = data.terraform_remote_state.shared.outputs.redis_port

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

  # Four native Cognito test users for staging smoke testing (one owner +
  # three players, per MYT-55). Generated passwords live in Secrets Manager
  # at mythrun/staging/smoke-test-{owner,player_1,player_2,player_3}-credentials.
  # Production composition leaves this at the default (false).
  smoke_test_user_enabled = true
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

  rds_host                    = data.terraform_remote_state.shared.outputs.rds_endpoint
  rds_port                    = data.terraform_remote_state.shared.outputs.rds_port
  rds_master_secret_arn       = data.terraform_remote_state.shared.outputs.rds_master_user_secret_arn
  rds_password_secret_arn     = aws_secretsmanager_secret.bootstrap_secrets["rds-password"].arn
  migrate_password_secret_arn = module.serving.migrate_db_credentials_secret_arn

  # MYT-55: wire the --seed-smoke-credits mode. Carries COGNITO_USER_POOL_ID
  # + SMOKE_USER_EMAIL_* env vars + cognito-idp:AdminGetUser IAM into the
  # bootstrap-db task so the seed mode can resolve email → cognito_sub at
  # runtime. Production composition omits these args (defaults are "" / {})
  # so no Cognito surface is bound to the bootstrap role outside staging.
  # Email values mirror local.smoke_test_users in infra/modules/auth/smoke-test.tf
  # — same env + role suffix yields the same email, so duplicating them here
  # is safe and avoids reaching across module boundaries for a 4-entry map.
  cognito_user_pool_id = module.auth.user_pool_id
  smoke_user_emails = {
    owner    = "mythrun-${var.environment}-smoke-owner@example.com"
    player_1 = "mythrun-${var.environment}-smoke-player-1@example.com"
    player_2 = "mythrun-${var.environment}-smoke-player-2@example.com"
    player_3 = "mythrun-${var.environment}-smoke-player-3@example.com"
  }
}

# ======== Smoke Prep-Pipeline Task Family (MYT-55) ========
# Provisions the one-shot ECS task family `mythrun-staging-smoke-prep-pipeline`
# for running the prep-pipeline end-to-end smoke (backend/scripts/smoke/prep-pipeline.ts)
# from inside the staging VPC. Mirrors the bootstrap-db pattern (separate
# task-execution role + separate task role + dedicated log group + dedicated
# task definition) but uses the backend image (which carries tsx + the smoke
# script source) rather than a purpose-built shell+psql image.
#
# Reused from existing infra (no duplication):
#   - SG egress shape: module.bootstrap_db.security_group_id (already permits
#     443 to AWS APIs via NAT + 5432 to RDS — exactly what the smoke needs).
#   - Backend ECR repo: shared workspace's ecr_repository_url (same image the
#     api + worker services consume; carries the smoke script under /app/backend).
#
# Operator invocation: see output `smoke_prep_pipeline_run_task_command`.

resource "aws_cloudwatch_log_group" "smoke_prep_pipeline" {
  name              = "/ecs/mythrun-${var.environment}-smoke-prep-pipeline"
  retention_in_days = 14

  tags = { Name = "mythrun-${var.environment}-smoke-prep-pipeline" }
}

# Task-execution role: pulls the backend image from ECR + ships container
# logs + reads the `secrets` array (DB_PASSWORD) at container start. Same
# managed-policy + explicit-per-ARN-secret pattern as modules/serving.
data "aws_iam_policy_document" "smoke_prep_pipeline_task_execution_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "smoke_prep_pipeline_task_execution" {
  name               = "mythrun-${var.environment}-smoke-prep-pipeline-exec"
  assume_role_policy = data.aws_iam_policy_document.smoke_prep_pipeline_task_execution_trust.json

  tags = { Name = "mythrun-${var.environment}-smoke-prep-pipeline-exec" }
}

# AWS-managed baseline: ECR pull + CloudWatch Logs write.
resource "aws_iam_role_policy_attachment" "smoke_prep_pipeline_task_execution_managed" {
  role       = aws_iam_role.smoke_prep_pipeline_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Per-ARN GetSecretValue for the secrets pulled into the container env at
# start time. The smoke task carries one `secrets` entry today (DB_PASSWORD
# from rds-password); extend this list if the secrets array grows.
data "aws_iam_policy_document" "smoke_prep_pipeline_task_execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.bootstrap_secrets["rds-password"].arn]
  }
}

resource "aws_iam_role_policy" "smoke_prep_pipeline_task_execution_secrets" {
  name   = "secrets-access"
  role   = aws_iam_role.smoke_prep_pipeline_task_execution.id
  policy = data.aws_iam_policy_document.smoke_prep_pipeline_task_execution_secrets.json
}

# Task role: assumed by the smoke script's AWS SDK calls in-container. The
# script fetches the 4 Cognito-credential secrets (one per user) via the
# Secrets Manager SDK, then exchanges them for Cognito access tokens via
# InitiateAuth (USER_AUTH flow, which is account-public and requires no IAM
# grant). Scope is ARN-pinned to the 4 smoke-user secrets.
resource "aws_iam_role" "smoke_prep_pipeline_task_role" {
  name = "mythrun-${var.environment}-smoke-prep-pipeline-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "mythrun-${var.environment}-smoke-prep-pipeline-task" }
}

resource "aws_iam_role_policy" "smoke_prep_pipeline_task_role_policy" {
  name = "smoke-credentials-access"
  role = aws_iam_role.smoke_prep_pipeline_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = values(module.auth.smoke_test_credentials_secret_arns)
    }]
  })
}

# ECS task definition. cpu=1024 / memory=2048 per pivot spec §4.2 (1 vCPU /
# 2 GB — sized for 8 in-flight Anthropic streams + 3 concurrent campaigns).
#
# Image: backend ECR repo, same `:placeholder` tag mechanism as the api +
# worker services (CI flip swaps in the real git-SHA tag at deploy time;
# task-def revision is registered with the placeholder, services point at
# the real revision after CI runs). The smoke is invoked manually via
# `aws ecs run-task`, not via a service — but it still benefits from the
# same image-tag rotation flow when the backend rebuilds.
#
# Network: run-task --network-configuration supplies subnets + SG at
# invocation time. The output `smoke_prep_pipeline_run_task_command`
# composes a paste-ready command that pins both. The SG reuses the bootstrap
# module's SG (egress 443 to AWS APIs + 5432 to RDS — exactly the smoke's
# network needs: Cognito + Secrets Manager + the staging API + Postgres).
#
# create_before_destroy keeps the family pointing at a valid revision
# through in-place arg changes — same lifecycle pattern as bootstrap-db
# and the serving task defs (MYT-28 / MYT-30 history).
resource "aws_ecs_task_definition" "smoke_prep_pipeline" {
  family                   = "mythrun-${var.environment}-smoke-prep-pipeline"
  cpu                      = "1024"
  memory                   = "2048"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = aws_iam_role.smoke_prep_pipeline_task_execution.arn
  task_role_arn      = aws_iam_role.smoke_prep_pipeline_task_role.arn

  container_definitions = jsonencode([{
    name             = "smoke"
    image            = "${data.terraform_remote_state.shared.outputs.ecr_repository_url}:placeholder"
    essential        = true
    # The production runtime image places the pnpm-deployed payload at
    # /app (Dockerfile WORKDIR), so scripts/smoke and node_modules sit at
    # /app/scripts and /app/node_modules. Invoke tsx via its node_modules
    # bin entry (PATH for the mythrun user does not include it).
    command          = ["node_modules/.bin/tsx", "scripts/smoke/prep-pipeline.ts"]
    workingDirectory = "/app"

    environment = [
      { name = "AWS_REGION", value = data.aws_region.current.region },
      { name = "API_BASE", value = "https://${var.environment}-api.mythrun.com" },
      { name = "COGNITO_USER_POOL_ID", value = module.auth.user_pool_id },
      # Smoke script reads COGNITO_CLIENT_ID; the auth module's output is
      # named app_client_id. Inject under the script's expected key.
      { name = "COGNITO_CLIENT_ID", value = module.auth.app_client_id },
      # Per-user Cognito-credential secret names (T1 provisioned these via
      # the auth module's for_each over local.smoke_test_users — names are
      # deterministic from the env + user-key, so inlining them here is
      # safe and avoids a needless output round-trip).
      { name = "SMOKE_OWNER_SECRET_ID", value = "mythrun/${var.environment}/smoke-test-owner-credentials" },
      { name = "SMOKE_PLAYER_1_SECRET_ID", value = "mythrun/${var.environment}/smoke-test-player_1-credentials" },
      { name = "SMOKE_PLAYER_2_SECRET_ID", value = "mythrun/${var.environment}/smoke-test-player_2-credentials" },
      { name = "SMOKE_PLAYER_3_SECRET_ID", value = "mythrun/${var.environment}/smoke-test-player_3-credentials" },
      # 35 min wall-clock — observed real-LLM stage timings: each Opus
      # stream is 150-235s, 7 world-gen stages + character-creation +
      # post-creation integration. Three campaigns burst-concurrent share
      # 3-worker concurrency so the wall clock is dominated by the slowest
      # campaign's full pipeline. 35min absorbs that + repair-chain headroom.
      { name = "SMOKE_WALL_CLOCK_BUDGET_MS", value = "2100000" },
      { name = "SMOKE_COST_CAP_USD", value = "5.00" },
      # DB connection inputs. The smoke composes DATABASE_URL at startup
      # from these (T8' wires this in the script); pattern parallels the
      # serving module's common_env / common_secrets split.
      { name = "DB_HOST", value = data.terraform_remote_state.shared.outputs.rds_endpoint },
      { name = "DB_PORT", value = tostring(data.terraform_remote_state.shared.outputs.rds_port) },
      { name = "DB_USER", value = "mythrun_${var.environment}" },
      { name = "DB_NAME", value = "mythrun_${var.environment}" },
    ]

    secrets = [
      # rds-password is a plain-string secret (no JSON wrapper) — see
      # local.common_secrets in modules/serving/main.tf for the established
      # read-as-is pattern. The smoke script composes DATABASE_URL from
      # DB_HOST + DB_PORT + DB_USER + DB_NAME + DB_PASSWORD at startup.
      { name = "DB_PASSWORD", valueFrom = aws_secretsmanager_secret.bootstrap_secrets["rds-password"].arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.smoke_prep_pipeline.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "mythrun-${var.environment}-smoke-prep-pipeline" }
}

# Paste-ready run-task command. Subnets come from the shared workspace's
# private_subnet_ids; SG reuses the bootstrap module's SG (egress shape
# matches). assignPublicIp=DISABLED — task runs in private subnets and
# reaches AWS APIs over the NAT gateway, same as the API + worker services.
#
# Operator invocation:
#   aws_cmd=$(terraform output -raw smoke_prep_pipeline_run_task_command)
#   eval "$aws_cmd"
#   aws logs tail /ecs/mythrun-staging-smoke-prep-pipeline --follow
output "smoke_prep_pipeline_run_task_command" {
  description = "Paste-ready: aws ecs run-task command to invoke the prep-pipeline smoke against staging. Invoke via `eval` (single-quote wrapping around --network-configuration requires shell re-parse). Tail logs via: aws logs tail /ecs/mythrun-staging-smoke-prep-pipeline --follow"
  value = format(
    "aws ecs run-task --cluster %s --task-definition %s --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=DISABLED}'",
    data.terraform_remote_state.shared.outputs.ecs_cluster_name,
    aws_ecs_task_definition.smoke_prep_pipeline.family,
    join(",", data.terraform_remote_state.shared.outputs.private_subnet_ids),
    module.bootstrap_db.security_group_id,
  )
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

  # ecs:RunTask scoped to the migrate task definition family + cluster.
  # The existing UpdateService/RegisterTaskDefinition grants do NOT
  # imply RunTask — this is a meaningful new privilege class on the
  # OIDC role. Scoped tightly so it can only launch migrate tasks in
  # the mythrun cluster.
  statement {
    actions = ["ecs:RunTask"]
    resources = [
      "arn:aws:ecs:us-east-1:${data.aws_caller_identity.current.account_id}:task-definition/mythrun-${var.environment}-migrate:*",
    ]
    condition {
      test     = "StringEquals"
      variable = "ecs:cluster"
      values = [
        "arn:aws:ecs:us-east-1:${data.aws_caller_identity.current.account_id}:cluster/mythrun",
      ]
    }
  }

  # iam:PassRole for the new migrate roles. The existing PassRole
  # statement covers the shared serving roles; the migrate task uses
  # dedicated roles for blast-radius isolation, so they need their own
  # PassRole grant.
  statement {
    actions = ["iam:PassRole"]
    resources = [
      module.serving.migrate_task_execution_role_arn,
      module.serving.migrate_task_role_arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # MYT-55 T10': iam:PassRole for the smoke prep-pipeline task / exec
  # roles. The deploy workflow's deploy-staging-smoke-task-def job
  # registers a new task-def revision after every code build; that call
  # to ecs:RegisterTaskDefinition requires PassRole on whatever roles
  # the new revision references. Same ECS-only condition as the api +
  # worker PassRole statements above.
  statement {
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.smoke_prep_pipeline_task_execution.arn,
      aws_iam_role.smoke_prep_pipeline_task_role.arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # CloudWatch log reads for the migrate workflow's "tail + surface" step.
  # Scoped to the migrate log group only.
  statement {
    actions = ["logs:DescribeLogStreams", "logs:GetLogEvents"]
    resources = [
      "${module.serving.migrate_log_group_arn}:*",
    ]
  }

  # ECR describe-images for resolving the SHA-pinned digest at run time.
  statement {
    actions = ["ecr:DescribeImages"]
    resources = [
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun",
    ]
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
