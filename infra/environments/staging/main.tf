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

  # myth-z4f: one retention value for every log group this workspace owns, so a
  # future bump moves them together instead of leaving one group behind. The
  # migrate group (modules/serving/migrate.tf) is deliberately separate — it is
  # already 30 and its lifetime is a schema history, not an incident window.
  log_retention_days = 30

  # Secrets populated manually via AWS Console/CLI. Placeholder initial version
  # is OK because app never reads these until values are set.
  manual_secret_names = [
    "anthropic-api-key",
    # voyage-api-key value is populated out-of-band: Terraform creates the
    # secret shell with a PLACEHOLDER version (app boots, but the first embed
    # call 401s) — set the real value via
    # `aws secretsmanager put-secret-value` as a Task-13 / deploy human-action.
    "voyage-api-key",
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
  alb_arn_suffix         = data.terraform_remote_state.shared.outputs.alb_arn_suffix
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

  # myth-89am: billing alarms page the same destination as everything else.
  alerts_topic_arn = aws_sns_topic.alerts.arn

  # myth-z4f: 30 days, up from the module's 14-day default. Two weeks is shorter
  # than the interval at which a subtle bug gets noticed, so an incident that
  # starts "when did this begin?" runs out of logs before it runs out of
  # questions. At roughly a gigabyte a month this is cents; production passes 90.
  log_retention_days = local.log_retention_days

  # Staging uses module defaults for task sizing (256/512) per Week 0 §7.2.
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

  # Staging App Client points at the deployed staging frontend (MYT-96 hosting,
  # wired in MYT-84). The localhost callback from the MYT-36 buildout is dropped:
  # real OAuth is staging-only; local dev uses the auth bypass seam, never Cognito.
  # Production composition adds the mythrun.com URLs onto a separate prod App Client.
  callback_urls = ["https://staging.mythrun.com/auth/callback"]
  logout_urls   = ["https://staging.mythrun.com"]

  # Four native Cognito test users for staging smoke testing (one owner +
  # three players, per MYT-55). Generated passwords live in Secrets Manager
  # at mythrun/staging/smoke-test-{owner,player_1,player_2,player_3}-credentials.
  # Production composition leaves this at the default (false).
  smoke_test_user_enabled = true

  # myth-s48q: Cognito throttling alarms page the same destination as
  # everything else in this environment.
  alerts_topic_arn = aws_sns_topic.alerts.arn
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

# ======== Frontend Hosting Module (MYT-96) ========
# Private S3 + CloudFront at staging.mythrun.com behind a Basic-Auth CloudFront
# Function. Reuses the shared *.mythrun.com wildcard cert + dns_zone_id (both
# already exported by shared/outputs.tf) — no new cert, no new shared outputs.
# Environment-parameterized: production reuses this module at Launch with the
# apex domain and enable_basic_auth = false.
module "frontend_hosting" {
  source = "../../modules/frontend-hosting"

  environment         = var.environment
  site_domain         = "staging.mythrun.com"
  api_origin_domain   = "${var.environment}-api.mythrun.com"
  acm_certificate_arn = data.terraform_remote_state.shared.outputs.wildcard_cert_arn
  hosted_zone_id      = data.terraform_remote_state.shared.outputs.dns_zone_id
  enable_basic_auth   = true
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
  retention_in_days = local.log_retention_days

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
    name      = "smoke"
    image     = "${data.terraform_remote_state.shared.outputs.ecr_repository_url}:placeholder"
    essential = true
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
      # MYT-64: session-prep (~3.4 min, measured) appends to each campaign's
      # PARALLEL chain — +~3.4 min to the SLOWEST campaign, not ×3 — so the
      # 35min budget still has comfortable headroom; left unchanged.
      { name = "SMOKE_WALL_CLOCK_BUDGET_MS", value = "2100000" },
      # Cap history: $5 covered 3-campaign world-gen + character creation.
      # MYT-64 raised it to $8 for 3 session-prep streams (~$0.52 each, measured).
      #
      # myth-4bpkg raises it to $15. The 2026-07-10 staging run was fully green
      # on every pipeline barrier but spent $11.01 (~$3.67/world: bardsmoot 3.71,
      # haunted-carnival 3.66, mountain-monastery 3.64), so the $8 cap failed a
      # run that was otherwise correct. The growth was investigated before the
      # bump rather than rubber-stamped, and it is ADDITIVE SCOPE, not a runaway —
      # three things landed after the $8 calibration:
      #   1. world_introduction (myth-zaqxh) — a NEW Opus stage, once per campaign.
      #   2. Four characters per campaign, not three: the owner is a member and
      #      gets a character too. That is +33% on both per-character Sonnet
      #      stages (concept + sheet) and one more character inside the Opus
      #      character_integration context.
      #   3. Relationship counts roughly doubled (~110 vs the ~55 observed at
      #      calibration), which inflates INPUT tokens for every downstream stage
      #      that reads the woven graph — including the Opus ones.
      # $15 leaves ~36% headroom over the observed $11.01 (a ~$5/world ceiling),
      # which still trips on a genuine runaway — the reason this cap exists —
      # while not failing a healthy run. Revisit if per-world cost passes ~$4.50.
      { name = "SMOKE_COST_CAP_USD", value = "15.00" },
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

    # myth-651: pin the workflow FILE, not just the repo + environment + branch.
    # Without this, any workflow merged to main can assume this role inside the
    # staging environment; with it, only the three enumerated below can.
    #
    # AWS added provider-specific OIDC claim validation in February 2026 and
    # lists `job_workflow_ref` among the supported GitHub condition keys, so no
    # GitHub-side subject-claim customization is needed — the claim ships by
    # default.
    #
    # Default OFF. See var.pin_job_workflow_ref for how to verify the claim
    # values against a real run before flipping it; a wrong value here takes CI
    # down until someone reverts.
    dynamic "condition" {
      for_each = var.pin_job_workflow_ref ? [1] : []
      content {
        test     = "StringEquals"
        variable = "token.actions.githubusercontent.com:job_workflow_ref"
        values   = local.staging_job_workflow_refs
      }
    }
  }
}

locals {
  # Every workflow whose jobs assume the staging deploy role. StringEquals over
  # a list is an OR. _db-migrate-job.yml is a REUSABLE workflow: its jobs report
  # their own file as job_workflow_ref, not the caller's, so it needs its own
  # entry and deploy.yml's entry does not cover it.
  #
  # Once the myth-jnb build-role cutover lands, deploy.yml's `build` job assumes
  # the BUILD role instead and its ref belongs on that list (it is already
  # there); deploy.yml stays here for its three deploy jobs.
  #
  # This list is derived from `grep -rn role-to-assume .github/workflows/`, which
  # is the only honest way to build it — every file naming
  # mythrun-github-actions-staging must appear here or it loses AWS access the
  # moment pin_job_workflow_ref flips.
  #
  # bootstrap-db-build.yml is on the list because it assumes the STAGING role
  # TODAY (its build-and-push job), and the two gate variables are independent:
  # nothing stops pin_job_workflow_ref being flipped before
  # github_build_role_cutover. Omitting it would mean flipping the pin first
  # silently breaks the bootstrap-db image build. After the cutover that job
  # assumes the build role instead and this entry becomes inert — StringEquals
  # over a list is an OR, so an entry nothing matches costs nothing — and it can
  # be dropped then, or left as a no-op.
  staging_job_workflow_refs = [
    "mythrun/mythrun/.github/workflows/deploy.yml@refs/heads/main",
    "mythrun/mythrun/.github/workflows/_db-migrate-job.yml@refs/heads/main",
    "mythrun/mythrun/.github/workflows/deploy-frontend.yml@refs/heads/main",
    "mythrun/mythrun/.github/workflows/bootstrap-db-build.yml@refs/heads/main",
  ]
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

  # ECR pull — kept on this role after the myth-jnb split. The deploy jobs do
  # not pull images themselves (the ECS task execution role does that), but the
  # migrate workflow resolves a SHA to a digest before running its task, and
  # keeping read access here means an operator debugging a deploy is not blocked
  # on a role they do not have.
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = [
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun",
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun-bootstrap-db",
    ]
  }

  # ---- ECR WRITE. Held by this role only until the build-role cutover
  # (myth-jnb) completes. These are the permissions that make a compromised
  # build step able to do more than build: with them, the same credentials that
  # run a Dockerfile can also roll a service. They move wholesale to
  # mythrun-github-actions-build, which has no ECS or PassRole authority at all.
  #
  # Gated rather than deleted because the cutover has to be sequenced against a
  # GitHub-side change (a new `build` environment) and a workflow edit. Flipping
  # github_build_role_cutover = true BEFORE the build jobs assume the new role
  # breaks every image push. See the ordered steps in
  # infra/environments/shared/github-actions-build-role.tf.
  dynamic "statement" {
    for_each = var.github_build_role_cutover ? [] : [1]
    content {
      actions = [
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
  }

  # Pull-through cache: auto-create cache repos + trigger upstream pulls.
  # Scoped to the ecr-public/* prefix (set by the shared workspace's
  # aws_ecr_pull_through_cache_rule.ecr_public pointing at public.ecr.aws).
  # Without these, the first `docker pull` through the cache fails at ECR authz.
  # Build-time only, so it goes with the write permissions above.
  dynamic "statement" {
    for_each = var.github_build_role_cutover ? [] : [1]
    content {
      actions = [
        "ecr:CreateRepository",
        "ecr:BatchImportUpstreamImage",
      ]
      resources = [
        "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/ecr-public/*",
      ]
    }
  }

  # The pre-cutover role also needs pull on the cache namespace, since the same
  # role runs the docker build. Post-cutover that moves to the build role.
  dynamic "statement" {
    for_each = var.github_build_role_cutover ? [] : [1]
    content {
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ]
      resources = [
        "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/ecr-public/*",
      ]
    }
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

  # MYT-96: frontend deploy — additive S3 sync + index.html cp + trailing prune
  # to the SPA bucket. Resource-scoped to the new bucket (ListBucket on the
  # bucket arn; object actions on /*). S3 ARNs are partition-global, so
  # constructing from bucket_name is exact — no new module output needed.
  statement {
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${module.frontend_hosting.bucket_name}"]
  }
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = ["arn:aws:s3:::${module.frontend_hosting.bucket_name}/*"]
  }

  # MYT-96: CloudFront /index.html invalidation after each deploy.
  # Resource-scoped to the new distribution.
  statement {
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]
    resources = [module.frontend_hosting.distribution_arn]
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
# Topic lands here. The billing alarms (myth-89am) publish to it from the
# serving module via its alerts_topic_arn input; the broader infra alarm suite
# (ECS/RDS/Redis/ALB/ACM/spend, Week 0 §6.3) lands in the Observability
# milestone and should attach to this same topic.
# Email subscription starts in PendingConfirmation — recipient must click the
# AWS-sent confirmation link before alarms will deliver. Re-running terraform
# apply while pending is a no-op; confirmation isn't a Terraform-managed attr.

resource "aws_sns_topic" "alerts" {
  name = "mythrun-staging-alerts"

  # Customer-managed key from the shared workspace, NOT alias/aws/sns.
  # Encrypting with the AWS-managed key silently breaks every alarm on this
  # topic: a CloudWatch alarm publishes as the service principal
  # cloudwatch.amazonaws.com, the AWS-managed key's policy cannot be edited to
  # authorize it, and the result is an alarm that goes red and delivers nothing.
  # The only trace is a "Failed to execute action" line in the alarm's History
  # tab. See infra/environments/shared/alerts-kms.tf for the full account.
  kms_master_key_id = data.terraform_remote_state.shared.outputs.alerts_kms_key_arn

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

# ---- Topic policy (myth-gb0).
#
# Until now this topic carried SNS's default policy, which allows sns:Publish
# from ANY principal in account 862127484110. Cross-account publishing was
# already blocked by that default's SourceOwner condition; what this closes is
# the in-account case, where any role that happens to hold sns:Publish could
# push a fake alarm into the operator's inbox. Declaring a policy replaces the
# default outright, which is the point.
#
# Nothing here grants management. Same-account access is satisfied by an
# identity policy OR a resource policy, so Terraform and anyone with sns:*
# continue to administer the topic normally.
#
# budgets.amazonaws.com is authorized alongside CloudWatch even though nothing
# publishes budget notifications to THIS topic today. AWS Budgets fails closed
# and silently against a policy that omits it — notifications simply stop, with
# no error surfaced anywhere — so pre-authorizing it turns a future wiring
# change into a change that works rather than one that appears to.
#
# Mirrors infra/environments/shared/alarms.tf, which does the same for the
# shared topic. Both should move together.

# The two statements carry different conditions on purpose — see the matching
# comment in infra/environments/shared/alarms.tf. Short version: the Budgets
# statement is AWS-published verbatim, conditions and all; the CloudWatch one
# carries only aws:SourceAccount, because pinning aws:SourceArn is undocumented
# for CloudWatch and an unpopulated condition key denies the publish, which
# looks identical to the encryption defect this change exists to fix.

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid     = "AllowCloudWatchAlarmsToPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    resources = [aws_sns_topic.alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid     = "AWSBudgetsSNSPublishingPermissions"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    resources = [aws_sns_topic.alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    # Budgets ARNs are region-less — note the double colon. The service is
    # global and notifications originate from us-east-1 regardless of where the
    # budget is viewed.
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:budgets::${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}
