# Bootstrap-DB Infrastructure — Design Spec

**Date:** 2026-04-28
**Bead:** myth-9qgb
**Status:** Draft (pre-blind-review)
**Author:** Claude (Miklos's instance)

## Goal

Provision durable, production-grade infrastructure for one-off database bootstrap operations against the staging RDS instance (and eventually prod). This is the precondition for myth-ml8 — the consumer ticket that runs `bootstrap-databases.sh --env staging --secret-only` to replace the placeholder `mythrun/staging/rds-password` with a real value — and for every future RDS bootstrap, password rotation, or drift-recovery operation thereafter.

Per CLAUDE.md Foundational Values (quality over speed; never hack core infrastructure), disposable-bastion-EC2 / SSM-port-forward / one-time-script-on-laptop shortcuts are explicitly rejected. We build the path once, properly, and reuse it forever.

## Why this exists

`infra/scripts/README.md` already documents the recipe:

> Post-MYT-30: run via one-shot ECS task… task-definition `mythrun-bootstrap-db`…

But that task definition was never provisioned. MYT-30 shipped the cluster, the API/Worker services, the IAM-and-network plumbing for normal app traffic, and the secret *shells*. It did not ship a way to put values into those shells. myth-ml8 trips on the missing task definition the instant the operator runs the documented command.

This bead closes the gap with a versioned, auditable, reusable container image + Terraform module + GitHub Actions build workflow.

## Scope

**In scope (this spec):**

1. Container image: `mythrun-bootstrap-db` (alpine + bash + aws-cli v2 + postgresql16-client + jq + ca-certificates + the bootstrap script as ENTRYPOINT).
2. ECR repository `mythrun-bootstrap-db` (separate from `mythrun`) with a 5-image lifecycle policy.
3. Path-triggered GitHub Actions workflow that builds and pushes the image on changes to the script, the Dockerfile, or the workflow itself.
4. Terraform module `infra/modules/bootstrap-db/`: ECS task definition (Fargate, 256/512), task-execution role, task role with explicit ARN-scoped IAM, dedicated egress-only security group, ingress rule on the RDS SG referencing the bootstrap SG, and a CloudWatch log group with 30-day retention.
5. Wiring in `infra/environments/shared/main.tf` (ECR repo + lifecycle) and `infra/environments/staging/main.tf` (the bootstrap-db module instantiation, with the staging RDS-password secret ARN and master-secret ARN passed in).
6. Outputs in `infra/environments/staging/outputs.tf` so the operator gets a copy-paste-ready `aws ecs run-task` command.
7. New wiki page `docs/wiki/content/data/bootstrap-database.html` with the full operator runbook, cross-linked from `migrations.html` (which currently mentions "bootstrap" without explaining how).
8. Test strategy: `hadolint` on the Dockerfile in CI, local image build verifies the layer set is sound, and a one-time staging `--verify` invocation as the smoke test before the real `--secret-only` run in myth-ml8.

**Out of scope:**

- The actual myth-ml8 password replacement — that's the consumer ticket.
- Production environment composition. The module is environment-agnostic; we instantiate it in `staging/` only this round. `production/` will instantiate the same module when the prod stack lands at the Launch milestone.
- VPC endpoints (ECR Interface, Secrets Manager Interface, S3 Gateway). Today the bootstrap task egresses to AWS APIs over the existing NAT Gateway, same as the API/Worker services. Adding interface endpoints is a cost/perf optimization that belongs in the Observability/Cost milestone, not here.
- Observability alarms on bootstrap failures. Bootstrap is a manual operator-triggered action; failure surfaces through `aws ecs describe-tasks` exit code and the CloudWatch log group. CW alarms on this log group can ship later if we operate it often enough that proactive alerting matters.
- `localstack` or any pretend-AWS test harness for the image. The runtime path through Secrets Manager + RDS is not a thing localstack reproduces faithfully — first real run against staging is a higher-signal smoke test than a fake one.

## Eight design decisions (pre-locked)

These were settled during brainstorming via AskUserQuestion. Restated here so the spec is self-contained and reviewable without the brainstorm transcript.

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Build pipeline** is a dedicated path-triggered GitHub Actions workflow (`.github/workflows/bootstrap-db-build.yml`), separate from `deploy.yml` | The bootstrap image cadence is decoupled from app deploys (it changes when the script changes; the app changes constantly). A dedicated workflow means a deploy doesn't rebuild this image and a script edit doesn't ripple into a deploy. Path-triggered keeps it dormant when nothing relevant changes. |
| 2 | **ECR repo** is a new dedicated `mythrun-bootstrap-db` (not a tag-prefix on `mythrun`) | The app repo is `MUTABLE` to support `:latest` for app deploys. The bootstrap image wants tag-immutability (one tag per git SHA, never re-pushed). Different policies → different repos. Lifecycle is also different: app keeps 50 images, bootstrap keeps 5. |
| 3 | **Terraform module** is a new `infra/modules/bootstrap-db/` (not bolted onto `modules/data` or `modules/serving`) | `modules/data` is the shared-RDS+Redis layer (per-environment-singleton, lives in the shared workspace). `modules/serving` is the per-env app stack. Bootstrap-db is per-env (subnets + RDS-password secret are env-scoped) and operationally distinct (no service, no ALB, manually invoked). It's its own concern. |
| 4 | **Image base** is `alpine:3.20` pulled via the existing ECR pull-through cache (`ecr-public/docker/library/alpine:3.20`) | alpine:3.20 ships with apk-installable `aws-cli`, `bash`, `postgresql16-client`, `jq`, `ca-certificates` — the exact set we need. Pull-through cache avoids Docker Hub rate limits (already paid for under MYT-28) and keeps base-image pulls in-region. |
| 5 | **Image tagging** is git-SHA-pinned (`bootstrap-db-<git-sha>`), no `:latest`. The task-def's `image` is parameterized by a Terraform variable `bootstrap_image_tag` defaulted to a known-good SHA after the first build. | Immutability + auditability: a `run-task` command at any point in time can be traced to the exact source of the script that ran. Bumping the tag is a deliberate `terraform apply` with a one-line variable change. No `:latest` race between push-and-run. |
| 6 | **IAM scoping** uses two roles (task-execution + task), both with ARN-scoped policies, no wildcards beyond what AWS enforces (`ecr:GetAuthorizationToken` is account-wide by AWS design). The task role grants `secretsmanager:GetSecretValue` on the RDS master secret ARN, and `secretsmanager:PutSecretValue` + `secretsmanager:UpdateSecret` + `secretsmanager:DescribeSecret` on the env-specific app password secret ARN — nothing else. | Least privilege at the level the auditor will check (ARN-by-ARN). The two-role split mirrors `modules/serving` so future readers see the same shape and the same boundary semantics. |
| 7 | **Network** uses a dedicated egress-only security group `mythrun-bootstrap-db` (not the shared `mythrun-ecs` SG). New ingress rule on the RDS SG that references the bootstrap SG. | Sharing the ECS SG would silently grant the bootstrap task all the egress paths the API has (Anthropic, Stripe, etc.) and would couple the two SGs' lifecycles. A dedicated SG keeps the auditor's blast-radius answer crisp: bootstrap can reach RDS:5432 and AWS APIs (443/tcp), nothing else. |
| 8 | **Image testing** is build-only locally (`docker build` to verify the layer graph + `hadolint` for Dockerfile lint in CI) plus `--verify` against staging RDS as the first real run, before myth-ml8's `--secret-only` invocation. No localstack. | `--verify` is read-only and idempotent (`SELECT FROM pg_database`, `aws secretsmanager describe-secret`). A pass demonstrates the network path, the IAM grants, the image execution, and the script's mode-detection logic in one shot — strictly higher-signal than a localstack roundtrip. |

## Architecture

```
.github/workflows/bootstrap-db-build.yml          ── builds + pushes mythrun-bootstrap-db image to ECR
                                                    triggers on changes to:
                                                      infra/scripts/bootstrap-databases.sh
                                                      infra/bootstrap-db/Dockerfile
                                                      .github/workflows/bootstrap-db-build.yml
                                                                │
                                                                ▼
infra/bootstrap-db/Dockerfile                     ── alpine:3.20 + apk add bash aws-cli postgresql16-client jq ca-certificates
                                                    COPY infra/scripts/bootstrap-databases.sh → /app/bootstrap-databases.sh
                                                    ENTRYPOINT ["/bin/bash","/app/bootstrap-databases.sh"]
                                                    (CMD intentionally unset — task-def overrides supplies args)

infra/environments/shared/main.tf                 ── aws_ecr_repository.bootstrap_db (IMMUTABLE)
                                                    aws_ecr_lifecycle_policy.bootstrap_db (keep last 5)

infra/modules/bootstrap-db/                       ── ECS task def + IAM roles + SG + log group
  ├── main.tf                                       Inputs: env, vpc_id, private_subnet_ids,
  ├── variables.tf                                            rds_sg_id, ecs_cluster_name,
  ├── outputs.tf                                              ecr_repo_url, image_tag,
  └── README.md                                               rds_master_secret_arn,
                                                              rds_password_secret_arn

infra/environments/staging/main.tf                ── module "bootstrap_db" {} instantiation,
                                                    wires staging-specific ARNs

infra/environments/staging/outputs.tf             ── bootstrap_run_task_command (paste-ready, sensitive=false)
                                                    bootstrap_log_group_name

docs/wiki/content/data/bootstrap-database.html    ── operator runbook (build → push → apply → run-task → verify)
                                                    cross-linked from migrations.html

docs/wiki/content/data/migrations.html            ── add cross-link to bootstrap-database.html
```

## File-by-file design

### 1. `infra/bootstrap-db/Dockerfile` (new)

```dockerfile
# syntax=docker/dockerfile:1
# Pull-through cache rule routes this to public.ecr.aws/docker/library/alpine.
# Pin to a digest? Not yet — alpine:3.20 is the line we want, and the cache
# repo + lifecycle policy give us point-in-time replay if we need it. Revisit
# at first prod-bootstrap.
FROM <ecr-account>.dkr.ecr.us-east-1.amazonaws.com/ecr-public/docker/library/alpine:3.20

# - bash: bootstrap-databases.sh uses bash-only syntax (set -uo pipefail, [[ ]])
# - aws-cli: read RDS master secret + write app password secret
# - postgresql16-client: psql to RDS (matches RDS engine major)
# - jq: parse master-secret JSON
# - ca-certificates: TLS to AWS APIs and rds.force_ssl=1
RUN apk add --no-cache \
      bash \
      aws-cli \
      postgresql16-client \
      jq \
      ca-certificates

WORKDIR /app
COPY infra/scripts/bootstrap-databases.sh /app/bootstrap-databases.sh
RUN chmod +x /app/bootstrap-databases.sh

# CMD intentionally unset — the ECS run-task --overrides supplies the args.
# ENTRYPOINT is the script so the operator's --overrides is just ["--env","staging","--verify"].
ENTRYPOINT ["/bin/bash", "/app/bootstrap-databases.sh"]
```

The `<ecr-account>` is left as a literal placeholder in the Dockerfile and resolved at build time via a `build-arg`, OR (better) we use the staging account's ECR pull-through-cache URL directly. The build workflow's `docker build --build-arg` pattern is shown below.

> Build-arg vs literal: literals are simpler but require regenerating the Dockerfile per account. The build-arg pattern keeps the Dockerfile portable across staging and future prod accounts. We go with build-arg.

```dockerfile
# Final form:
ARG ECR_ACCOUNT_ID
FROM ${ECR_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/ecr-public/docker/library/alpine:3.20
```

### 2. `.github/workflows/bootstrap-db-build.yml` (new)

```yaml
name: bootstrap-db-build

on:
  push:
    branches: [main]
    paths:
      - 'infra/scripts/bootstrap-databases.sh'
      - 'infra/bootstrap-db/Dockerfile'
      - '.github/workflows/bootstrap-db-build.yml'
  workflow_dispatch:

permissions:
  id-token: write           # OIDC to AWS
  contents: read

concurrency:
  group: bootstrap-db-build
  cancel-in-progress: false  # we want each script change to produce its own image

jobs:
  build-and-push:
    runs-on: ubuntu-24.04
    environment: staging
    steps:
      - uses: actions/checkout@v5

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
          aws-region: us-east-1

      - name: Login to Amazon ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2

      - name: Lint Dockerfile (hadolint)
        uses: hadolint/hadolint-action@v3.1.0
        with:
          dockerfile: infra/bootstrap-db/Dockerfile
          failure-threshold: warning

      - name: Build image
        env:
          ECR_REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          IMAGE_TAG: bootstrap-db-${{ github.sha }}
        run: |
          docker build \
            --build-arg ECR_ACCOUNT_ID="${ECR_REGISTRY%%.*}" \
            -f infra/bootstrap-db/Dockerfile \
            -t "$ECR_REGISTRY/mythrun-bootstrap-db:$IMAGE_TAG" \
            .

      - name: Push image
        env:
          ECR_REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          IMAGE_TAG: bootstrap-db-${{ github.sha }}
        run: docker push "$ECR_REGISTRY/mythrun-bootstrap-db:$IMAGE_TAG"

      - name: Echo bump command
        env:
          IMAGE_TAG: bootstrap-db-${{ github.sha }}
        run: |
          echo "::notice title=Bootstrap-DB image pushed::Tag: $IMAGE_TAG"
          echo "::notice title=To activate::Set var bootstrap_image_tag = \"$IMAGE_TAG\" in infra/environments/staging/terraform.tfvars and apply."
```

The `staging` GitHub environment already gates the staging IAM role via OIDC (MYT-28). We reuse it. The role's existing IAM policy already permits `ecr:PutImage` on `mythrun-*` repos via the wildcarded clause we audited; if it doesn't, MYT-28's role policy gets one extra `Resource` ARN — `repository/mythrun-bootstrap-db`. (Reviewer: please double-check.)

### 3. `infra/environments/shared/main.tf` — additions

Append after the existing `aws_ecr_repository.mythrun` block:

```hcl
# ======== Bootstrap-DB ECR Repository ========
# Separate from `mythrun` because:
#   - tag policy is IMMUTABLE here (one tag per git SHA, never re-pushed)
#   - lifecycle keeps 5 images instead of 50 (cadence is monthly, not per-PR)
#   - access pattern is different (operator-pull, not service-pull)

resource "aws_ecr_repository" "bootstrap_db" {
  name                 = "mythrun-bootstrap-db"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "mythrun-bootstrap-db" }
}

resource "aws_ecr_lifecycle_policy" "bootstrap_db" {
  repository = aws_ecr_repository.bootstrap_db.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep 5 most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 5
        }
        action = { type = "expire" }
      },
    ]
  })
}
```

Append a corresponding output:

```hcl
output "bootstrap_db_ecr_repository_url" {
  value       = aws_ecr_repository.bootstrap_db.repository_url
  description = "ECR repo URL for the bootstrap-db image."
}
```

### 4. `infra/modules/bootstrap-db/variables.tf` (new)

```hcl
variable "environment" {
  description = "Env name (e.g. \"staging\")."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID — used as parent for the bootstrap security group."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the bootstrap task to run in (must have RDS network reachability)."
  type        = list(string)
}

variable "rds_sg_id" {
  description = "RDS security group ID — receives an ingress rule from the bootstrap SG on 5432."
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster name (the cluster is shared)."
  type        = string
}

variable "ecr_repository_url" {
  description = "ECR URL for mythrun-bootstrap-db (e.g. <acct>.dkr.ecr.us-east-1.amazonaws.com/mythrun-bootstrap-db)."
  type        = string
}

variable "image_tag" {
  description = "Image tag to pin into the task definition (e.g. \"bootstrap-db-abc1234\"). Bumped manually after each rebuild."
  type        = string
}

variable "rds_master_secret_arn" {
  description = "ARN of the RDS master user secret (read-only by the bootstrap task)."
  type        = string
}

variable "rds_password_secret_arn" {
  description = "ARN of the env-specific app password secret (read+write by the bootstrap task)."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch log group retention for bootstrap operations."
  type        = number
  default     = 30
}
```

### 5. `infra/modules/bootstrap-db/main.tf` (new)

```hcl
# ======== Security group: bootstrap → AWS APIs + RDS ========
# Egress-only by intent. The task pulls the master secret + writes the app
# secret over Secrets Manager (HTTPS to AWS API endpoints) and connects to
# RDS via the existing private-subnet path.

resource "aws_security_group" "bootstrap" {
  name        = "mythrun-${var.environment}-bootstrap-db"
  description = "Bootstrap-DB task: egress-only — 443 to AWS APIs, 5432 to RDS."
  vpc_id      = var.vpc_id

  tags = { Name = "mythrun-${var.environment}-bootstrap-db" }
}

# Egress: 443/tcp anywhere (Secrets Manager + ECR + STS over NAT, like ECS).
resource "aws_vpc_security_group_egress_rule" "bootstrap_https" {
  security_group_id = aws_security_group.bootstrap.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS to AWS APIs (Secrets Manager, ECR, STS) via NAT"
}

# Egress: 5432/tcp to RDS SG.
resource "aws_vpc_security_group_egress_rule" "bootstrap_to_rds" {
  security_group_id            = aws_security_group.bootstrap.id
  referenced_security_group_id = var.rds_sg_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS"
}

# Ingress on RDS SG: accept 5432 from the bootstrap SG.
# This sits in the bootstrap module (not the network module) deliberately —
# the rule is owned by the consumer concern, not the producer SG.
resource "aws_vpc_security_group_ingress_rule" "rds_from_bootstrap" {
  security_group_id            = var.rds_sg_id
  referenced_security_group_id = aws_security_group.bootstrap.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from bootstrap-db task (${var.environment})"
}

# ======== CloudWatch log group ========

resource "aws_cloudwatch_log_group" "bootstrap" {
  name              = "/ecs/mythrun-${var.environment}-bootstrap-db"
  retention_in_days = var.log_retention_days

  tags = { Name = "mythrun-${var.environment}-bootstrap-db" }
}

# ======== IAM: task-execution role (ECR pull + log writes) ========

data "aws_iam_policy_document" "task_execution_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "mythrun-${var.environment}-bootstrap-db-exec"
  assume_role_policy = data.aws_iam_policy_document.task_execution_trust.json
  tags               = { Name = "mythrun-${var.environment}-bootstrap-db-exec" }
}

# AmazonECSTaskExecutionRolePolicy covers ECR pull + base log writes.
resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ======== IAM: task role (Secrets Manager) ========

data "aws_iam_policy_document" "task_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task" {
  name               = "mythrun-${var.environment}-bootstrap-db-task"
  assume_role_policy = data.aws_iam_policy_document.task_trust.json
  tags               = { Name = "mythrun-${var.environment}-bootstrap-db-task" }
}

data "aws_iam_policy_document" "task" {
  # Read the AWS-managed RDS master secret to get the master password.
  statement {
    sid       = "ReadRdsMasterSecret"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [var.rds_master_secret_arn]
  }

  # Write the env-scoped app password secret. DescribeSecret first to detect
  # placeholder vs real value before mutating.
  statement {
    sid = "WriteAppPasswordSecret"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
    ]
    resources = [var.rds_password_secret_arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "bootstrap-db-permissions"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ======== ECS task definition ========

resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "mythrun-${var.environment}-bootstrap-db"
  cpu                      = "256"
  memory                   = "512"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = aws_iam_role.task_execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "bootstrap"
    image     = "${var.ecr_repository_url}:${var.image_tag}"
    essential = true

    # No `command` here — the operator's run-task --overrides supplies it.
    # Environment carries the wiring the script's required-env-var contract expects.
    environment = [
      { name = "AWS_REGION",            value = "us-east-1" },
      { name = "RDS_MASTER_SECRET_ARN", value = var.rds_master_secret_arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.bootstrap.name
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "bootstrap"
      }
    }

    # Read-only root FS for blast radius; /tmp scratch via tmpfs.
    readonlyRootFilesystem = true
    linuxParameters = {
      tmpfs = [{ containerPath = "/tmp", size = 64 }]
    }
  }])

  tags = { Name = "mythrun-${var.environment}-bootstrap-db" }
}
```

### 6. `infra/modules/bootstrap-db/outputs.tf` (new)

```hcl
output "task_definition_family" {
  value       = aws_ecs_task_definition.bootstrap.family
  description = "Family name passed to `aws ecs run-task --task-definition`."
}

output "task_definition_arn" {
  value       = aws_ecs_task_definition.bootstrap.arn
  description = "ARN (revision-pinned) of the active task definition."
}

output "security_group_id" {
  value       = aws_security_group.bootstrap.id
  description = "SG ID for run-task --network-configuration."
}

output "log_group_name" {
  value       = aws_cloudwatch_log_group.bootstrap.name
  description = "CloudWatch log group — view results via `aws logs tail`."
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "Task role ARN (for audit / IAM-policy-simulator)."
}
```

### 7. `infra/environments/staging/main.tf` — module instantiation

Append after the existing `module "serving" {}` block:

```hcl
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

  rds_master_secret_arn   = data.terraform_remote_state.shared.outputs.rds_master_user_secret_arn
  rds_password_secret_arn = aws_secretsmanager_secret.bootstrap_secrets["rds-password"].arn
}
```

### 8. `infra/environments/staging/variables.tf` — addition

```hcl
variable "bootstrap_image_tag" {
  description = "Tag of the mythrun-bootstrap-db image to pin into the task definition. Bump after each script edit + image rebuild."
  type        = string
  # No default — terraform.tfvars must supply, so a stale tag never silently sticks.
}
```

`infra/environments/staging/terraform.tfvars` gets one new line:

```hcl
bootstrap_image_tag = "bootstrap-db-<sha-after-first-build>"
```

This stays in git (the value is public — git SHAs aren't sensitive).

### 9. `infra/environments/staging/outputs.tf` — additions

```hcl
output "bootstrap_db_task_definition_family" {
  value       = module.bootstrap_db.task_definition_family
  description = "ECS task family for staging bootstrap operations."
}

output "bootstrap_db_security_group_id" {
  value       = module.bootstrap_db.security_group_id
  description = "Bootstrap task security group (for run-task --network-configuration)."
}

output "bootstrap_db_log_group_name" {
  value       = module.bootstrap_db.log_group_name
  description = "CloudWatch log group for staging bootstrap runs."
}

# Paste-ready run-task command. Three placeholders intentionally left as
# uppercase tokens for the operator to replace per invocation:
#   MODE_FLAG   one of --verify | --secret-only | --reset-password | --user-only | (omit for default)
output "bootstrap_db_run_task_command" {
  value = format(
    "aws ecs run-task --cluster %s --task-definition %s --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=DISABLED}' --overrides '{\"containerOverrides\":[{\"name\":\"bootstrap\",\"command\":[\"--env\",\"%s\",\"MODE_FLAG\"]}]}'",
    data.terraform_remote_state.shared.outputs.ecs_cluster_name,
    module.bootstrap_db.task_definition_family,
    join(",", data.terraform_remote_state.shared.outputs.private_subnet_ids),
    module.bootstrap_db.security_group_id,
    var.environment,
  )
  description = "Paste-ready aws ecs run-task command. Replace MODE_FLAG with one of --verify, --secret-only, --reset-password, --user-only, or remove the slot for default mode."
}
```

### 10. `docs/wiki/content/data/bootstrap-database.html` (new)

Short structure (full body authored when implementing, not in spec):

- **Header** with `<!-- source: -->` lines pointing at `infra/scripts/bootstrap-databases.sh`, `infra/bootstrap-db/Dockerfile`, `infra/modules/bootstrap-db/main.tf`, and the staging `outputs.tf` section, so `pnpm wiki:check` will gate freshness on those files.
- **Lead paragraph** — what bootstrap is, when an operator runs it, why it's a one-shot ECS task instead of a script-on-laptop or a bastion EC2.
- **The four modes table** — `default` / `--verify` / `--user-only` / `--secret-only` (alias `--reset-password`), with the state each one assumes and the state each one leaves.
- **First-time setup runbook** — bump the image tag, terraform apply, run-task with `--verify`, expected output (`OK` / `MISSING` / `DB_ONLY` / `SECRET_MISSING`), then run the appropriate mode based on the verify result.
- **Recovery from partial failures** — the same matrix as the existing `infra/scripts/README.md`, but rendered as wiki content.
- **Updating the script** — push a change to `infra/scripts/bootstrap-databases.sh`, the build workflow auto-builds + pushes, copy the new tag from the workflow's `notice`, set `bootstrap_image_tag` in `terraform.tfvars`, apply.
- **Cross-link** to `migrations.html` (since the migration runner is the next thing the operator runs after bootstrap puts the password in place).

Add a one-line cross-link from `migrations.html` back to this page.

## Operator workflow (the runbook the wiki will document)

```
# 1. Land the Terraform.
cd infra/environments/staging
terraform plan       # Should show: SG, two IAM roles, log group, task def. No app changes.
terraform apply

# 2. Build + push the bootstrap image.
git push             # path-trigger fires bootstrap-db-build.yml
                     # workflow's `Echo bump command` step prints the new tag

# 3. Pin the new tag.
echo 'bootstrap_image_tag = "bootstrap-db-<sha>"' >> infra/environments/staging/terraform.tfvars
git add infra/environments/staging/terraform.tfvars
git commit -m "chore(myt-9qgb): pin bootstrap-db image tag <sha>"
git push
terraform apply      # task def revision N+1 created

# 4. Verify network + IAM + image execute (no mutations).
$(terraform output -raw bootstrap_db_run_task_command)   # with MODE_FLAG=--verify
aws ecs describe-tasks --cluster mythrun --tasks <task-id> --query 'tasks[0].containers[0].{exitCode:exitCode,reason:reason}'
aws logs tail /ecs/mythrun-staging-bootstrap-db --since 5m --format short
# Expect: exitCode 0; logs print one of OK / MISSING / DB_ONLY / SECRET_MISSING

# 5. The actual fix (myth-ml8) is the consumer ticket. With --verify=SECRET_MISSING:
$(terraform output -raw bootstrap_db_run_task_command)   # with MODE_FLAG=--secret-only
```

## What's deliberately not in this round

- Running `--verify` from inside the bootstrap-db build workflow against staging RDS (auto-smoke). It'd require the workflow to assume the bootstrap task role *and* the OIDC role to wire ECS run-task. It's worth doing — but it's a quality-of-life addition, not a precondition for myth-ml8. Filed as a follow-up bead on completion of this one.
- `aws_ecs_task_set` or any blue/green machinery. Bootstrap is one-shot run-task, not a service.
- Cost/usage metric filters or alarms on the log group. SNS alerts on `--verify` returning anything other than `OK` is the obvious follow-up if we operate this often.

## Test strategy

| What | How | When |
|------|-----|------|
| Dockerfile lint | `hadolint` in CI on every workflow run | Per push to relevant paths |
| Image build sanity | `docker build` in CI; failure blocks merge | Per push to relevant paths |
| Image runtime smoke | Locally: `docker run --rm <image> --help` (the script's `--help` doesn't exit non-zero, so this exercises the entrypoint + bash + apk-installed deps) | Implementation-time, not gated |
| Terraform plan determinism | `terraform plan` in `infra/environments/staging/` after the module change | Before merge |
| End-to-end | `--verify` against staging RDS as the smoke test before myth-ml8's `--secret-only` | First post-merge run, manual |

`localstack` is *not* in the test plan — see Decision #8.

## Risks + mitigations

| Risk | Mitigation |
|------|-----------|
| Image grows beyond ~50MB and slows cold-start | apk packages chosen are minimal; we accept Fargate cold-start of ~30-90s for a one-shot task that runs at most every few weeks. Not optimizing further. |
| Operator forgets to bump `bootstrap_image_tag` after a script edit and runs old code | The build workflow's `Echo bump command` step in CI prints the exact new tag at the top of the workflow run summary. The runbook in the wiki repeats the step. We accept this as discipline-enforced rather than gate-enforced; a CI gate would require the workflow to mutate `terraform.tfvars`, which crosses workflow concerns. |
| `aws ecs run-task` succeeds but the task fails to start (image-pull error, IAM denial) — silent failure | The runbook tells the operator to `describe-tasks` immediately and tail logs. The task failing to start surfaces as `lastStatus=STOPPED` with a non-empty `stoppedReason` within ~30s. |
| Master secret rotates between `terraform apply` and `run-task` | The task reads it at task-start, so rotation has at most a single-task-run race window and the secret is read fresh each time. No memoization. |
| RDS SG ingress rule cycle (rds_sg ↔ bootstrap_sg) | Asymmetric: bootstrap egresses to rds_sg (rule on bootstrap SG), rds_sg ingresses from bootstrap_sg (rule on RDS SG). Both rules live in this module and reference the existing `rds_sg_id` — Terraform creates the bootstrap SG first, then both rules. No cycle. |
| Two operators run-task simultaneously and both attempt `--secret-only` | The script handles its own concurrency: the second `aws secretsmanager update-secret` call wins; the LAST password written is the one in Secrets Manager. We accept this — the operator should coordinate, and the script's idempotency guarantee covers single-operator partial-failure replay, not concurrent operator races. |

## Open questions for blind reviewers

1. **MYT-28 IAM role — does it grant `ecr:PutImage` on `mythrun-bootstrap-db`?** The current policy scopes ECR push/pull to `repository/mythrun` and `repository/ecr-public/*`. The bootstrap-db build workflow needs the same set of `ecr:*` actions (CompleteLayerUpload, etc.) on `repository/mythrun-bootstrap-db`. Either we extend the policy or we accept that this spec ships a follow-up TF diff to MYT-28's role policy. *Reviewer: please confirm whether the policy needs to grow, and if so, that the diff is mechanical.*
2. **Image-tag immutability vs. operator UX.** `IMMUTABLE` means the operator cannot re-push the same SHA — which is what we want. But it also means a workflow re-run on the same SHA fails at push time. Is that acceptable, or do we want a small `_<run-attempt>` suffix to make re-runs always succeed?
3. **`readonlyRootFilesystem = true` + `apk` installed packages.** The packages are baked into the image at build time, not runtime, so the read-only root FS at runtime is fine. `psql` writes to `~/.psql_history` by default — is that a problem? (`PSQL_HISTORY=/dev/null` set in env or `--no-psqlrc` flag in the script's psql calls would neutralize.)
4. **`aws ecs run-task` and the `--cli-input-json` form.** The paste-ready output uses inline `--overrides` JSON. Some operators prefer `--cli-input-json file://overrides.json`. Worth offering both, or keep the spec lean?
5. **Production environment composition.** Spec is silent on prod. The module is generic enough to be re-instantiated from `infra/environments/production/main.tf` when prod lands. Should the spec lock that future shape (e.g., name the prod task family) or stay deferred?
6. **Build-arg `ECR_ACCOUNT_ID` in the Dockerfile.** `FROM ${VAR}.dkr.ecr.us-east-1.amazonaws.com/...` works — but the build-arg has no default. A typo at build time produces a confusing error. Worth a default that's "obviously a placeholder" so the failure mode is "alpine pull from upstream fails" instead of "weird URL"? Or keep undefaulted to force the build pipeline to wire it explicitly?

## Acceptance criteria

- [ ] Dockerfile passes `hadolint` at the warning threshold.
- [ ] `infra/environments/shared/` `terraform plan` shows the new ECR repo + lifecycle, no other diffs.
- [ ] `infra/environments/staging/` `terraform plan` shows the bootstrap module's resources (SG + 2 SG rules + 2 IAM roles + log group + task def), no diffs in `serving` or `data`.
- [ ] `aws ecr describe-repositories --repository-names mythrun-bootstrap-db` returns the repo.
- [ ] `bootstrap-db-build.yml` runs to completion on a no-op `docs:` change to a triggering path and pushes a tagged image.
- [ ] `aws ecs describe-task-definition --task-definition mythrun-staging-bootstrap-db` returns ACTIVE.
- [ ] First `--verify` run-task exits 0 and CloudWatch logs print one of `OK` / `MISSING` / `DB_ONLY` / `SECRET_MISSING`.
- [ ] `docs/wiki/content/data/bootstrap-database.html` passes `pnpm wiki:check` (source-hash matches).
- [ ] `docs/wiki/content/data/migrations.html` cross-links to bootstrap-database.html.
- [ ] myth-9qgb is closed; myth-ml8 is unblocked.

## Memory pointers

- `feedback_context_coherence.md` — bootstrap-db's only consumer is myth-ml8 + future password rotations; everything in scope here has a real consumer in flight.
- `feedback_blind_review_pendulum.md` — cap reviews at ~3 rounds, severity-based stopping rule.
- `feedback_production_lens.md` — production-grade defaults: structured logging via awslogs, IAM ARN-scoped, dedicated SG, lifecycle policies on ECR, tag-immutable.
- `feedback_push_and_close.md` — standing auth to push + flip Linear when verified.
