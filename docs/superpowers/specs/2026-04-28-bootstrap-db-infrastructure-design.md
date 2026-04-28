# Bootstrap-DB Infrastructure — Design Spec

**Date:** 2026-04-28
**Bead:** myth-9qgb
**Status:** v2 (post-Round-1 blind review by Lagavulin / Hibiki / Ardbeg)
**Author:** Claude (Miklos's instance)

## Goal

Provision durable, production-grade infrastructure for one-off database bootstrap operations against the staging RDS instance (and eventually prod). This is the precondition for myth-ml8 — the consumer ticket that runs `bootstrap-databases.sh --env staging --secret-only` to replace the placeholder `mythrun/staging/rds-password` with a real value — and for every future RDS bootstrap, password rotation, or drift-recovery operation thereafter.

Per CLAUDE.md Foundational Values (quality over speed; never hack core infrastructure), disposable-bastion-EC2 / SSM-port-forward / one-time-script-on-laptop shortcuts are explicitly rejected. We build the path once, properly, and reuse it forever.

## Why this exists

`infra/scripts/README.md` already documents the recipe:

> Post-MYT-30: run via one-shot ECS task… task-definition `mythrun-bootstrap-db`…

But that task definition was never provisioned. MYT-30 shipped the cluster, the API/Worker services, the IAM-and-network plumbing for normal app traffic, and the secret *shells*. It did not ship a way to put values into those shells. myth-ml8 trips on the missing task definition the instant the operator runs the documented command. This bead closes the gap.

## Scope

**In scope:**

1. Container image `mythrun-bootstrap-db` (alpine + bash + aws-cli v2 + postgresql16-client + jq + ca-certificates + the bootstrap script as ENTRYPOINT).
2. ECR repository `mythrun-bootstrap-db` (separate from `mythrun`) with a 5-image lifecycle policy.
3. Path-triggered GitHub Actions workflow that builds and pushes the image on changes to the script, the Dockerfile, or the workflow itself.
4. Terraform module `infra/modules/bootstrap-db/`: ECS task definition (Fargate, 256/512), task-execution role, task role with explicit ARN-scoped IAM, dedicated egress-only security group, ingress rule on the RDS SG referencing the bootstrap SG, and a CloudWatch log group with 30-day retention.
5. Wiring in `infra/environments/shared/main.tf` (ECR repo + lifecycle) and `infra/environments/staging/main.tf` (the bootstrap-db module instantiation, with the staging RDS-password secret ARN and master-secret ARN passed in).
6. **Extension of the staging GitHub Actions IAM role policy** (in `infra/environments/staging/main.tf`) to grant `ecr:*` on `repository/mythrun-bootstrap-db` — without this the build workflow can't push. Lagavulin C2: confirmed by reading the existing policy at `staging/main.tf` lines 196–210, which scopes only to `mythrun` + `ecr-public/*`.
7. Operator-facing Terraform outputs in `infra/environments/staging/outputs.tf`: five discrete paste-ready `aws ecs run-task` commands (one per mode) plus log-group + task-family scalars.
8. New wiki page `docs/wiki/content/data/bootstrap-database.html` with the full operator runbook, cross-linked from `migrations.html` (which currently mentions "bootstrap" without explaining how).
9. Test strategy: `hadolint` on the Dockerfile in CI (fail-on-error), local image build, and a one-time staging `--verify` invocation as the smoke test before the real `--secret-only` run in myth-ml8.

**Out of scope:**

- The actual myth-ml8 password replacement — that's the consumer ticket.
- Production environment composition. The module is environment-agnostic; we instantiate it in `staging/` only this round.
- VPC interface endpoints (ECR, Secrets Manager). Cost/perf optimization for the Observability/Cost milestone.
- CloudWatch alarms on the bootstrap log group.
- `localstack` / fake-AWS test harness. The runtime path through Secrets Manager + RDS is not faithfully reproduced; first real run against staging is a higher-signal smoke test.
- A `--cli-input-json file://...` form of the run-task command (Lagavulin/Ardbeg open question). We ship the inline `--overrides` form, since it's what the existing wiki+README pattern uses; a JSON-file form is a nicety, not a correctness need.

## Locked design decisions

These were settled during brainstorming and (for the items reviewers contested) refined post-Round-1.

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Build pipeline** is a dedicated path-triggered GitHub Actions workflow (`.github/workflows/bootstrap-db-build.yml`), separate from `deploy.yml`. | Bootstrap-image cadence is decoupled from app deploys. Path-triggered means it only fires when a relevant file changes. |
| 2 | **ECR repo** is a new dedicated `mythrun-bootstrap-db` (IMMUTABLE), not a tag-prefix on `mythrun` (MUTABLE). | Different mutability + lifecycle policies; different access patterns. |
| 3 | **Terraform module** is a new `infra/modules/bootstrap-db/`. | `modules/data` is shared-singleton; `modules/serving` is the per-env app stack. Bootstrap is its own per-env operational concern. |
| 4 | **Image base** is `alpine:3.20` pulled via the existing ECR pull-through cache (`ecr-public/docker/library/alpine:3.20`). | apk has the package set we need; pull-through cache avoids Docker Hub rate limits. |
| 5 | **Image tagging** is `bootstrap-db-${git-sha}-${run-attempt}`, no `:latest`. Pinned via TF variable `bootstrap_image_tag`. | SHA + attempt: traceable to source; safe under workflow re-runs against an IMMUTABLE repo (Hibiki H1: same SHA + cancelled push had no escape hatch in v1). The `-1` suffix on the canonical first run is the spec'd expectation. |
| 6 | **IAM scoping** uses two roles (task-execution + task), both ARN-scoped. Task role gets `secretsmanager:GetSecretValue` + `DescribeSecret` on the master secret ARN, and `GetSecretValue` + `DescribeSecret` + `PutSecretValue` on the env-specific app password secret ARN — **NOT** `UpdateSecret` (Lagavulin C4: script only calls `put-secret-value`; `UpdateSecret` mutates secret metadata/KMS config and is over-grant). |
| 7 | **Network** uses a dedicated egress-only security group `mythrun-${env}-bootstrap-db`. New ingress rule on the RDS SG references the bootstrap SG. | Sharing the ECS SG would couple lifecycles and inherit Anthropic/Stripe egress paths the bootstrap doesn't need. |
| 8 | **Image testing** is `hadolint` (fail-on-error) + `docker build` in CI, plus `--verify` against staging RDS as the first real run. No localstack. | Higher-signal than fakes; `--verify` is read-only and idempotent. |
| 9 | **`readonlyRootFilesystem = false`** on the task container (Hibiki H3 + Lagavulin C1 + Ardbeg M3 three-way convergence). | aws-cli v2 (python) writes to `~/.aws/cli/cache`; psql writes `~/.psql_history` unconditionally. RO root either OOMs the task at start or fails psql at exit. The task is one-shot, runs in a fresh ephemeral Fargate container, has no service/listener, and is not network-reachable inbound. RO root buys ~zero defense-in-depth here for a brittleness tax. The "blast-radius is wall-clock-bounded" argument applies. |
| 10 | **No `linuxParameters.tmpfs`** (Lagavulin C1, hard correctness blocker). | `tmpfs` is rejected by `RegisterTaskDefinition` for Fargate (`ClientException: Tmpfs is not supported for tasks using the Fargate launch type`). Decision #9 also makes it unnecessary. |
| 11 | **Dockerfile uses build-arg `ECR_ACCOUNT_ID` only** (Hibiki C1 ambiguity-fix). | One Dockerfile, portable across staging and future prod accounts. `ARG` precedes `FROM`; the arg is `FROM`-scope-only by Docker semantics. |
| 12 | **GitHub Actions OIDC role wiring uses `vars.AWS_ACCOUNT_ID`** matching `deploy.yml` (Hibiki C2; verified by reading `.github/workflows/deploy.yml` lines 71–85). Not `secrets.AWS_ROLE_TO_ASSUME`. |

## File layout

```
.github/workflows/bootstrap-db-build.yml          ── builds + pushes mythrun-bootstrap-db image to ECR

infra/bootstrap-db/Dockerfile                     ── alpine:3.20 + apk packages + script as ENTRYPOINT

infra/environments/shared/main.tf                 ── aws_ecr_repository.bootstrap_db (IMMUTABLE)
                                                    aws_ecr_lifecycle_policy.bootstrap_db (keep last 5)

infra/environments/shared/outputs.tf              ── bootstrap_db_ecr_repository_url

infra/modules/bootstrap-db/                       ── ECS task def + IAM roles + SG + log group + outputs
  ├── main.tf
  ├── variables.tf
  └── outputs.tf

infra/environments/staging/main.tf                ── module "bootstrap_db" {} instantiation
                                                    + extension of GH Actions IAM role policy ECR statement

infra/environments/staging/variables.tf           ── bootstrap_image_tag (no default)

infra/environments/staging/terraform.tfvars       ── bootstrap_image_tag = "bootstrap-db-<sha>-1"

infra/environments/staging/outputs.tf             ── 5 paste-ready run-task commands (one per mode),
                                                    + scalar outputs (log group, task family, SG id)

docs/wiki/content/data/bootstrap-database.html    ── operator runbook (build → push → apply → run-task → verify)
                                                    cross-linked from migrations.html

docs/wiki/content/data/migrations.html            ── add cross-link to bootstrap-database.html
```

## File-by-file design

### 1. `infra/bootstrap-db/Dockerfile` (new)

```dockerfile
# syntax=docker/dockerfile:1
# ARG must precede FROM and is FROM-scope only by Docker semantics — no
# default; the build pipeline supplies it. A typo at build time fails loudly
# at FROM (the URL doesn't resolve to an alpine repo).
ARG ECR_ACCOUNT_ID

FROM ${ECR_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/ecr-public/docker/library/alpine:3.20

# - bash: bootstrap-databases.sh uses bash-only syntax (set -uo pipefail, [[ ]])
# - aws-cli: read RDS master secret + write app password secret
# - postgresql16-client: psql to RDS (matches RDS engine major)
# - jq: parse master-secret JSON
# - ca-certificates: TLS to AWS APIs and rds.force_ssl=1
# Versions intentionally unpinned. Image lifecycle keeps the last 5; alpine
# 3.20 minor security bumps are a feature, not a regression risk, on a
# manually-invoked operator task that never runs unattended.
# hadolint ignore=DL3018
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
# ENTRYPOINT is the script so the operator's --overrides is just
# ["--env","staging","--verify"].
ENTRYPOINT ["/bin/bash", "/app/bootstrap-databases.sh"]
```

The `# hadolint ignore=DL3018` comment suppresses the apk-version-pin warning inline for this Dockerfile only — Hibiki H2's recommendation. Combined with `failure-threshold: error` in the workflow, hadolint warnings still surface but aren't blocking, and DL3018 specifically is muted on the line where it would otherwise red-light every build.

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
  # Each script change should produce its own image; do NOT cancel-in-progress.
  # Re-runs against the same SHA succeed because the tag includes
  # ${github.run_attempt}.
  group: bootstrap-db-build
  cancel-in-progress: false

env:
  AWS_REGION: us-east-1
  ECR_REPO: mythrun-bootstrap-db

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: staging
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2

      - name: Pre-flight — verify required vars are set
        # Matches deploy.yml's pattern. vars.AWS_ACCOUNT_ID lives in the
        # 'staging' GitHub Environment.
        run: |
          if [[ -z "${{ vars.AWS_ACCOUNT_ID }}" ]]; then
            echo "::error::vars.AWS_ACCOUNT_ID is not set. Configure at Settings → Environments → staging → Environment variables."
            exit 1
          fi

      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@ececac1a45f3b08a01d2dd070d28d111c5fe6722  # v4.1.0
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@19d944daaa35f0fa1d3f7f8af1d3f2e5de25c5b7  # v2.1.4

      - name: Lint Dockerfile (hadolint)
        # failure-threshold: error — DL3018 (apk version pin) is suppressed
        # inline in the Dockerfile via `hadolint ignore=DL3018`. Other warnings
        # are advisory; only errors block.
        uses: hadolint/hadolint-action@54c9adbab1582c2ef04b2016b760714a4bfde3cf  # v3.1.0
        with:
          dockerfile: infra/bootstrap-db/Dockerfile
          failure-threshold: error

      - name: Build image
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
          IMAGE_TAG: bootstrap-db-${{ github.sha }}-${{ github.run_attempt }}
        run: |
          set -euo pipefail
          ACCOUNT_ID="${REGISTRY%%.*}"
          docker build \
            --platform linux/amd64 \
            --build-arg ECR_ACCOUNT_ID="$ACCOUNT_ID" \
            --label "org.opencontainers.image.source=https://github.com/mythrun/mythrun" \
            --label "org.opencontainers.image.revision=${{ github.sha }}" \
            --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --label "com.mythrun.workflow_run_url=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            -f infra/bootstrap-db/Dockerfile \
            -t "$REGISTRY/$ECR_REPO:$IMAGE_TAG" \
            .

      - name: Push image
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
          IMAGE_TAG: bootstrap-db-${{ github.sha }}-${{ github.run_attempt }}
        run: docker push "$REGISTRY/$ECR_REPO:$IMAGE_TAG"

      - name: Print operator bump command
        env:
          IMAGE_TAG: bootstrap-db-${{ github.sha }}-${{ github.run_attempt }}
        run: |
          # Print the literal one-line replacement the operator should put
          # into infra/environments/staging/terraform.tfvars. No <placeholders>.
          BUMP_LINE=$(printf 'bootstrap_image_tag = "%s"' "$IMAGE_TAG")
          echo "::notice title=Bootstrap-DB image pushed::$IMAGE_TAG"
          echo "::notice title=To activate — paste this line into infra/environments/staging/terraform.tfvars (replace any existing bootstrap_image_tag line)::$BUMP_LINE"
          echo "$BUMP_LINE" > /tmp/bootstrap_image_tag.line
      - name: Upload bump line as artifact
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02  # v4.6.2
        with:
          name: bootstrap-image-tag-line
          path: /tmp/bootstrap_image_tag.line
          if-no-files-found: error
          retention-days: 30
```

The artifact upload is a belt-and-suspenders safety net: even if the operator scrolls past the `::notice::`, they can `gh run download <run-id> -n bootstrap-image-tag-line && cat bootstrap_image_tag.line` to retrieve the literal line. Hibiki H4: closes the round-trip-on-SHA-typo failure mode.

### 3. `infra/environments/shared/main.tf` — additions

Append after the existing `aws_ecr_repository.mythrun` block:

```hcl
# ======== Bootstrap-DB ECR Repository ========
# Separate from `mythrun` because:
#   - tag policy is IMMUTABLE here (one tag per <git-sha>-<run-attempt>)
#   - lifecycle keeps 5 images instead of 50 (cadence is monthly, not per-PR)
#   - access pattern is operator-pull, not service-pull
# Tag-immutability + ${run_attempt} suffix means workflow re-runs always
# succeed (Hibiki H1).

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
        description  = "Keep 5 most recent bootstrap-db-* tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["bootstrap-db-*"]
          countType      = "imageCountMoreThan"
          countNumber    = 5
        }
        action = { type = "expire" }
      },
    ]
  })
}
```

(Lagavulin L3: narrowed pattern from `["*"]` to `["bootstrap-db-*"]` so a rogue tag-push doesn't bypass the keep-5 rule.)

Append to `infra/environments/shared/outputs.tf`:

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
  description = "ECS cluster name. Consumed by the module's run-task command outputs."
  type        = string
}

variable "ecr_repository_url" {
  description = "ECR URL for mythrun-bootstrap-db (e.g. <acct>.dkr.ecr.us-east-1.amazonaws.com/mythrun-bootstrap-db)."
  type        = string
}

variable "image_tag" {
  description = "Image tag pinned into the task definition (e.g. \"bootstrap-db-abc1234-1\"). Bumped manually after each rebuild."
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

(Lagavulin M2: `ecs_cluster_name` is now used — it composes the run-task outputs colocated in the module.)

### 5. `infra/modules/bootstrap-db/main.tf` (new)

```hcl
# ======== Security group: bootstrap → AWS APIs + RDS ========
# Egress-only by intent. Pulls the master secret + writes the app secret
# over Secrets Manager (HTTPS to AWS API endpoints) and connects to RDS via
# the existing private-subnet path. NAT Gateway egress to 443/tcp 0.0.0.0/0
# matches the established pattern in modules/network (ECS SG egress 443).

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
# Owned by the consumer concern, not the producer SG. Asymmetric pair —
# bootstrap → RDS edge is one rule each side, no cycle.
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
#
# Both the master secret and the app password secret use the AWS-managed
# `aws/secretsmanager` KMS key today, so no explicit `kms:Decrypt` grant is
# needed. If either secret is later rekeyed to a CMK, both this role AND the
# task-execution role need a `kms:Decrypt` grant on the new key ARN.
# (Lagavulin H2: future-proofing comment matches the equivalent block in
# modules/serving/main.tf:76–81.)

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
  # placeholder vs real value before mutating. NO UpdateSecret — the script
  # only calls put-secret-value; UpdateSecret mutates secret metadata
  # (description, KMS key, rotation config) and is over-grant.
  statement {
    sid = "WriteAppPasswordSecret"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:PutSecretValue",
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
    # Environment carries the wiring the script's required-env-var contract
    # expects. APP_SECRET_ID passed for symmetry with RDS_MASTER_SECRET_ARN
    # so a future env-prefix rename doesn't silently break the script's
    # name-resolution → IAM-policy-ARN match.
    environment = [
      { name = "AWS_REGION",            value = "us-east-1" },
      { name = "RDS_MASTER_SECRET_ARN", value = var.rds_master_secret_arn },
      { name = "APP_SECRET_ID",         value = var.rds_password_secret_arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.bootstrap.name
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "bootstrap"
      }
    }

    # readonlyRootFilesystem deliberately NOT set (defaults to false).
    # aws-cli + psql require a writable HOME / cache; the task is one-shot,
    # ephemeral, and not network-reachable inbound. RO root is brittleness
    # without defense-in-depth gain on this surface.
    # No linuxParameters.tmpfs — Fargate rejects it.
  }])

  # MYT-28 + MYT-30 pattern: in-place arg changes on aws_ecs_task_definition
  # produce destroy-then-create by default, which deregisters the old
  # revision before the new one is registered. create_before_destroy keeps
  # the family pointing at a valid revision throughout the apply.
  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "mythrun-${var.environment}-bootstrap-db" }
}
```

### 6. `infra/modules/bootstrap-db/outputs.tf` (new)

```hcl
output "task_definition_family" {
  value       = aws_ecs_task_definition.bootstrap.family
  description = "Family name passed to `aws ecs run-task --task-definition`."
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

# ======== Paste-ready run-task commands (one per script mode) ========
#
# Five discrete outputs because string-substitution inside `terraform output
# -raw` is fragile (Ardbeg C1 — first-round spec had a literal MODE_FLAG
# token that the operator hit "unknown arg" on). Each output is fully formed
# and pasteable. The shared base composition lives in a local.

locals {
  _network_config = format(
    "awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=DISABLED}",
    join(",", var.private_subnet_ids),
    aws_security_group.bootstrap.id,
  )

  # Each entry is the full command-array for one mode.
  _modes = {
    verify         = ["--env", var.environment, "--verify"]
    secret_only    = ["--env", var.environment, "--secret-only"]
    reset_password = ["--env", var.environment, "--reset-password"]
    user_only      = ["--env", var.environment, "--user-only"]
    default        = ["--env", var.environment]
  }

  _run_task_template = "aws ecs run-task --cluster %s --task-definition %s --launch-type FARGATE --network-configuration '%s' --overrides %s"
}

output "run_task_verify" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.verify }] })),
  )
  description = "Read-only mode: prints OK / MISSING / DB_ONLY / SECRET_MISSING. Always safe."
}

output "run_task_secret_only" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.secret_only }] })),
  )
  description = "Rotates app password + writes to Secrets Manager. Use when --verify prints SECRET_MISSING."
}

output "run_task_reset_password" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.reset_password }] })),
  )
  description = "Alias of --secret-only. Use when the stored secret is known-wrong (drift), not just missing."
}

output "run_task_user_only" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.user_only }] })),
  )
  description = "DB exists, user doesn't: create user + write secret. Use when --verify prints DB_ONLY."
}

output "run_task_default" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.default }] })),
  )
  description = "Default mode: create DB + user + secret. Use when --verify prints MISSING."
}
```

`jsonencode` (Lagavulin L3) handles JSON-quote correctness; the outer single-quote wrap survives bash word-splitting because `terraform output -raw` returns a single string.

### 7. `infra/environments/staging/main.tf` — additions

**(a) Module instantiation** — append after `module "serving" {}`:

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

**(b) GH Actions IAM policy ECR statement** — extend the existing statement (lines 196–210 of the current file) to include the bootstrap-db repo. Replace the `resources` block in the ECR push/pull statement:

```hcl
# Existing statement, with one additional ARN:
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
```

(Lagavulin C2 + Ardbeg M3-Q1: closes the open question. Without this, the build workflow fails at first push.)

### 8. `infra/environments/staging/variables.tf` — addition

```hcl
variable "bootstrap_image_tag" {
  description = "Tag of the mythrun-bootstrap-db image to pin into the task definition. Format: bootstrap-db-<sha>-<run-attempt>. Bump after each script edit + image rebuild."
  type        = string
  # No default — terraform.tfvars must supply, so a stale tag never silently sticks.
}
```

`infra/environments/staging/terraform.tfvars` gets one new line:

```hcl
bootstrap_image_tag = "bootstrap-db-<sha>-1"
```

### 9. `infra/environments/staging/outputs.tf` — additions

```hcl
output "bootstrap_db_task_definition_family" {
  value       = module.bootstrap_db.task_definition_family
  description = "ECS task family for staging bootstrap operations."
}

output "bootstrap_db_security_group_id" {
  value       = module.bootstrap_db.security_group_id
  description = "Bootstrap task security group (audit / debugging)."
}

output "bootstrap_db_log_group_name" {
  value       = module.bootstrap_db.log_group_name
  description = "CloudWatch log group for staging bootstrap runs."
}

output "bootstrap_db_run_task_verify" {
  value       = module.bootstrap_db.run_task_verify
  description = "Paste-ready: read-only verify."
}
output "bootstrap_db_run_task_secret_only" {
  value       = module.bootstrap_db.run_task_secret_only
  description = "Paste-ready: rotate password + write secret."
}
output "bootstrap_db_run_task_reset_password" {
  value       = module.bootstrap_db.run_task_reset_password
  description = "Paste-ready: alias of secret-only for drift-rotation."
}
output "bootstrap_db_run_task_user_only" {
  value       = module.bootstrap_db.run_task_user_only
  description = "Paste-ready: DB exists, create user + write secret."
}
output "bootstrap_db_run_task_default" {
  value       = module.bootstrap_db.run_task_default
  description = "Paste-ready: full bootstrap (create DB + user + secret)."
}
```

### 10. `docs/wiki/content/data/bootstrap-database.html` (new)

Outline (full body authored at implementation, all reviewer-flagged sections explicit):

- Header with `<!-- source: -->` lines pointing at `infra/scripts/bootstrap-databases.sh`, `infra/bootstrap-db/Dockerfile`, `infra/modules/bootstrap-db/main.tf`, and the staging `outputs.tf` so `pnpm wiki:check` gates freshness on those files.
- Lead — what bootstrap is, why it's a one-shot ECS task, when an operator runs it.
- **The verify→mode mapping table** (Ardbeg M1, lifted inline so the spec reviewer can verify it without leaving the page):

| `--verify` output | Run with | Why |
|---|---|---|
| `OK` | nothing — already bootstrapped | All three artifacts exist |
| `MISSING` | `bootstrap_db_run_task_default` | Creates DB + user + secret |
| `DB_ONLY` | `bootstrap_db_run_task_user_only` | DB exists; create user + write secret |
| `SECRET_MISSING` | `bootstrap_db_run_task_secret_only` | DB + user exist; rotate password + write secret |

- **First-time setup runbook** — steps 1–5 below.
- **Failure-modes diagnostic table** (Ardbeg H2):

| `stoppedReason` substring | Likely cause | First check |
|---|---|---|
| `CannotPullContainerError` | Image tag pinned in TF doesn't exist in ECR (stale `bootstrap_image_tag` or build hadn't completed) | `aws ecr describe-images --repository-name mythrun-bootstrap-db --image-ids imageTag="$TAG"` |
| `ResourceInitializationError: ... secrets or registry auth` | Task-execution role missing ECR pull or KMS decrypt | Check `aws_iam_role.task_execution` policy attachments |
| `Essential container ... exited with code 1` + log line `RDS master secret missing 'X'` | Master secret payload is malformed or rotated to an unexpected schema | `aws secretsmanager get-secret-value --secret-id <master-arn>` and inspect the JSON shape |
| `Essential container ... exited with code 1` + log line `psql: could not connect` | RDS SG ingress rule didn't apply, or RDS endpoint changed | `aws ec2 describe-security-groups --group-ids $RDS_SG_ID` looking for an ingress from the bootstrap SG |
| Task stays in `PROVISIONING` >2 min then stops | Subnets have no NAT route OR SG egress 443 missing | Check route table on the subnets; check `bootstrap_https` egress rule |
| `Essential container exited with code 2` + `unknown arg` | The run-task command used a placeholder token instead of one of the five discrete outputs | Use `terraform output -raw bootstrap_db_run_task_verify` (or one of the four other discrete outputs), don't substitute strings |

- **Recovery from partial failure during `--secret-only`** (Ardbeg H3):

> If `--secret-only` exits non-zero between the `ALTER USER` (logged as the SQL line) and the secret write (logged as `Rotated password`), the database password and Secrets Manager are divergent and the app can't connect. **Re-run the same `--secret-only` invocation** — the script generates a new password, runs `ALTER USER` again, and re-writes the secret. The script is idempotent for this. Do *not* manually paste the password from CloudWatch logs (passwords are not logged by design).

- **`--verify` itself errored** (Ardbeg M4):

> `--verify` is read-only but it can exit 1 for three reasons: master-secret read failure (IAM denial — check task role), malformed master secret (master rotated to an unexpected schema — escalate), or psql connectivity (network path missing — see the failure-modes table above).

- **Updating the script** — push a change to `infra/scripts/bootstrap-databases.sh` to `main`; the path-trigger fires `bootstrap-db-build.yml`; **wait for the workflow to succeed**; copy the literal `bootstrap_image_tag = "..."` line from the workflow's `notice` output (or `gh run download <run-id> -n bootstrap-image-tag-line`); replace the existing line in `terraform.tfvars`; commit + push; `terraform apply`.
- Cross-link from the `<h2>Integration points</h2>` paragraph in `migrations.html` (Ardbeg M2): "The migration runner assumes the per-env app password secret has been populated — see [Bootstrap Database](./bootstrap-database.html) for that one-time setup." And from this page, link back to `migrations.html#run-migrations-locally`.

## Operator workflow (the runbook)

```bash
# === Step 1: Land the Terraform ===
cd infra/environments/shared
terraform plan       # Should show: aws_ecr_repository.bootstrap_db + lifecycle. No other diffs.
terraform apply

cd ../staging
terraform plan       # Show: bootstrap module (SG + 2 SG rules + 2 IAM roles + log group + task def)
                     # AND the GH Actions IAM policy diff adding bootstrap-db ECR resources.
                     # No diffs in `serving` or `data`.
terraform apply

# === Step 2: Build + push the bootstrap image ===
git push             # Triggers .github/workflows/bootstrap-db-build.yml

# === Step 3: WAIT for the build to succeed (Ardbeg H1: do NOT skip) ===
RUN_ID=$(gh run list --workflow=bootstrap-db-build.yml --limit=1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status   # Blocks until success; non-zero on failure.

# === Step 4: Pin the new tag (the workflow prints a literal one-liner) ===
gh run view "$RUN_ID" --log | grep '::notice title=To activate'
# Or for guaranteed delivery:
gh run download "$RUN_ID" -n bootstrap-image-tag-line && cat bootstrap_image_tag.line
# Replace the existing bootstrap_image_tag line in infra/environments/staging/terraform.tfvars
# with the literal line above. Commit + push.

# === Step 5: Apply the new task-definition revision ===
cd infra/environments/staging
terraform apply      # Task def revision N+1 created via create_before_destroy.

# === Step 6: Verify network + IAM + image execute (no mutations) ===
RUN_TASK_CMD=$(terraform output -raw bootstrap_db_run_task_verify)
TASK_ARN=$(eval "$RUN_TASK_CMD" --query 'tasks[0].taskArn' --output text)
echo "Task: $TASK_ARN"

# Wait for the task to finish (cold-start can be 60–120s).
aws ecs wait tasks-stopped --cluster mythrun --tasks "$TASK_ARN"

# Check exit code.
aws ecs describe-tasks --cluster mythrun --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].{exitCode:exitCode,reason:reason,stoppedReason:stoppedReason}'
# Expect: exitCode 0, reason null

# Read THIS task's logs only (Ardbeg C2: stream prefix prevents
# interleaved historical output).
TASK_ID="${TASK_ARN##*/}"
aws logs tail /ecs/mythrun-staging-bootstrap-db \
  --since 30m --format short \
  --log-stream-name-prefix "bootstrap/bootstrap/$TASK_ID"
# Expect: one of OK / MISSING / DB_ONLY / SECRET_MISSING printed on a line by itself.

# === Step 7: Run the appropriate mode based on --verify result ===
# Use the verify→mode mapping table on the wiki page. For the myth-ml8 case
# (SECRET_MISSING), the consumer ticket runs:
#   eval "$(terraform output -raw bootstrap_db_run_task_secret_only)"
# Same wait + describe + log-tail flow as step 6.
```

If any step fails, consult the failure-modes table on the wiki page.

## Test strategy

| What | How | When |
|------|-----|------|
| Dockerfile lint | `hadolint` in CI, fail-on-error, `DL3018` muted inline | Per push to relevant paths |
| Image build sanity | `docker build` in CI; failure blocks the workflow | Per push to relevant paths |
| Image runtime smoke | Locally: `docker build` and verify packages: `docker run --rm --entrypoint /bin/sh <image> -c "command -v aws psql jq bash"` | Implementation-time, not CI-gated |
| Terraform plan determinism | `terraform plan` in `infra/environments/staging/` after the module change | Before merge |
| End-to-end | `--verify` against staging RDS as the smoke test before myth-ml8's `--secret-only` | First post-merge run, manual |

## Risks + mitigations

| Risk | Mitigation |
|------|-----------|
| Image grows beyond ~50MB and slows cold-start | Accepted; not mitigated. Bootstrap runs at most every few weeks; 30–90s cold start is below the operator-friction threshold. |
| Operator pins `bootstrap_image_tag` to a non-existent tag (build still running) | The `gh run watch --exit-status` gate in step 3 of the runbook blocks until the workflow succeeds. The artifact upload provides a second retrieval path beyond the `::notice::` console scrollback. |
| `aws ecs run-task` succeeds but the task fails to start (image pull error, IAM denial) | Runbook step 6 has explicit `aws ecs wait` + `describe-tasks` to surface `stoppedReason` immediately. Failure-modes table maps the common reasons to the diagnostic command. |
| Master secret rotates between `terraform apply` and `run-task` | The task reads the master secret at task-start. No memoization. Rotation race window is one task run. |
| Two operators run-task simultaneously and both do `--secret-only` | Last-write-wins on Secrets Manager; the script's idempotency covers single-operator partial-failure replay, not concurrent operator races. Operators must coordinate. |
| `--secret-only` exits between `ALTER USER` and the secret write | DB password and Secrets Manager are divergent; the app can't connect. Re-run `--secret-only`; the script is idempotent for this. (See wiki page recovery section.) |
| Workflow re-run on the same SHA | Tag includes `${github.run_attempt}`; first run is `…-1`, retries are `…-2`. `IMMUTABLE` ECR + run-attempt = no `tag already exists` collision. |
| ECR pull-through cache cold (alpine repo not yet materialized in `ecr-public/docker/library/alpine`) | First `docker build` in the workflow may fail with `RepositoryNotFoundException` if the cache repo doesn't exist yet. Pre-warm by triggering any prior pull through the cache, or accept the first-run failure and re-run (the cache repo materializes on the failed attempt's IAM-permitted `BatchImportUpstreamImage` call, and the subsequent run succeeds). The MYT-28 GH Actions role already has the required `ecr:CreateRepository` + `ecr:BatchImportUpstreamImage` on `ecr-public/*`. |

## Acceptance criteria (paste-runnable)

```bash
# 1. hadolint passes (errors only — DL3018 muted inline).
hadolint --failure-threshold error infra/bootstrap-db/Dockerfile

# 2. Shared workspace plan shows only the new ECR repo + lifecycle.
cd infra/environments/shared && terraform plan -no-color | grep -E '^(  #|Plan:)'

# 3. Staging plan shows the bootstrap module + the GH Actions policy diff.
cd ../staging && terraform plan -no-color | grep -E '^(  #|Plan:)'

# 4. ECR repo exists.
aws ecr describe-repositories --repository-names mythrun-bootstrap-db --query 'repositories[0].repositoryName'

# 5. The build workflow runs to completion on a no-op edit to infra/scripts/bootstrap-databases.sh.
git commit --allow-empty -m "noop: trigger bootstrap-db-build" && git push
# (gh run watch the resulting workflow run; expect success.)

# 6. Task definition is ACTIVE.
aws ecs describe-task-definition --task-definition mythrun-staging-bootstrap-db --query 'taskDefinition.status'
# Expect: "ACTIVE"

# 7. First --verify exits 0 and prints one of OK / MISSING / DB_ONLY / SECRET_MISSING.
RUN_TASK_CMD=$(terraform output -raw bootstrap_db_run_task_verify)
TASK_ARN=$(eval "$RUN_TASK_CMD" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster mythrun --tasks "$TASK_ARN"
EXIT=$(aws ecs describe-tasks --cluster mythrun --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)
[[ "$EXIT" == "0" ]] || { echo "FAIL: exitCode=$EXIT"; exit 1; }
TASK_ID="${TASK_ARN##*/}"
aws logs tail /ecs/mythrun-staging-bootstrap-db --since 30m \
  --log-stream-name-prefix "bootstrap/bootstrap/$TASK_ID" \
  | grep -E '^(OK|MISSING|DB_ONLY|SECRET_MISSING)$' \
  || { echo "FAIL: expected one of OK/MISSING/DB_ONLY/SECRET_MISSING"; exit 1; }

# 8. Wiki page passes pnpm wiki:check.
pnpm wiki:check

# 9. migrations.html cross-links to bootstrap-database.html.
grep 'bootstrap-database.html' docs/wiki/content/data/migrations.html

# 10. Closing this bead unblocks myth-ml8.
bd show myth-9qgb | grep -E 'BLOCKS.*myth-ml8'
```

## Resolved open questions (post-Round-1)

| # | Question | Resolution |
|---|---|---|
| 1 | Does the MYT-28 GH role need extension for ECR push on `mythrun-bootstrap-db`? | **Yes — confirmed by Lagavulin reading staging/main.tf:196–210.** Extension is now a required spec item (file 7b above). |
| 2 | IMMUTABLE ECR + workflow re-runs on the same SHA | **Resolved**: tag is `bootstrap-db-${sha}-${run_attempt}`. `…-1` is canonical, retries are `…-2`. No collision. |
| 3 | `readonlyRootFilesystem = true` + psql/aws-cli writes | **Resolved**: set to `false`. Three-way reviewer convergence + the safety margin on a one-shot ephemeral task. Decision #9. |
| 4 | `--cli-input-json file://` form vs inline `--overrides` | **Out of scope** for this round. Inline form ships; JSON-file form is a future ergonomics improvement, not a correctness need. |
| 5 | Production env composition | **Deferred** to Launch milestone when the prod stack lands. Module is generic; `production/main.tf` will instantiate it the same way `staging/main.tf` does. |
| 6 | `ECR_ACCOUNT_ID` build-arg default | **No default** — typo at build time fails loudly at `FROM` (URL doesn't resolve). Decision #11 makes this explicit. |

## Memory pointers

- `feedback_context_coherence.md` — bootstrap-db's only consumer is myth-ml8 + future password rotations; everything in scope here has a real consumer in flight.
- `feedback_blind_review_pendulum.md` — Round 1 surfaced 4 CRITICAL + 10 HIGH findings, all real correctness blockers. v2 above applies all of them. Severity-based stopping rule: if Round 2 returns mostly LOW + a stray MEDIUM, ship.
- `feedback_production_lens.md` — production-grade defaults: structured logging via awslogs, IAM ARN-scoped, dedicated SG, lifecycle policies on ECR, tag-immutable, `create_before_destroy`, KMS future-proofing.
- `feedback_push_and_close.md` — standing auth to push + flip Linear when verified.
