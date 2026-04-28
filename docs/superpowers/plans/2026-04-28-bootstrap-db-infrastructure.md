# Bootstrap-DB Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the `mythrun-bootstrap-db` ECS task family + its container image build pipeline, so the operator can run `aws ecs run-task` invocations of `bootstrap-databases.sh` against staging RDS — unblocking myth-ml8 and every future bootstrap/rotation/recovery operation.

**Architecture:** A new env-agnostic Terraform module (`infra/modules/bootstrap-db/`) produces a Fargate task definition + ARN-scoped IAM roles + dedicated egress-only security group + CloudWatch log group, plus five paste-ready `aws ecs run-task` outputs (one per script mode). The module is instantiated from `infra/environments/staging/main.tf` against the existing shared workspace's network/RDS/cluster outputs. A separate dedicated ECR repo (`mythrun-bootstrap-db`, IMMUTABLE, keep-20) is added to the shared workspace. A path-triggered GitHub Actions workflow (`.github/workflows/bootstrap-db-build.yml`) builds + pushes the alpine-based image on changes to the script, the Dockerfile, or the workflow itself.

**Tech Stack:** Terraform (AWS provider v6.x), Docker (alpine:3.20 + apk; alpine 3.20's `aws-cli` package is v2), GitHub Actions (OIDC to AWS), pnpm wiki authoring.

**Spec:** `docs/superpowers/specs/2026-04-28-bootstrap-db-infrastructure-design.md` (v3, post-Round-2 reviews).

**Bead:** myth-9qgb (precondition for myth-ml8).

---

## Pre-flight notes for the implementer

- **No TDD in the unit-test sense.** Terraform/HCL doesn't have a unit-test culture in this repo. The "test" for each infra change is `terraform fmt -check` + `terraform validate` + `terraform plan` showing the expected diff. For the Dockerfile, the build itself is the test (hadolint + the v2 smoke `RUN`). For the wiki, `pnpm wiki:check`.
- **Operator actions are flagged explicitly.** Several tasks require Miklos to run a command (terraform apply against staging, push the first image, capture the SHA into tfvars). Stop, surface the exact command, and wait for confirmation before continuing.
- **Per CLAUDE.md parallel-agent commit rule:** if the controller dispatches multiple subagents in parallel for non-overlapping tasks, the **controller** stages and commits each task's files. Implementer subagents must NOT run `git add`/`git commit`.
- **`backend/`/`frontend/` are NOT touched.** This plan is pure infra + workflow + wiki.

---

## Task 1: Module skeleton — variables.tf

**Files:**
- Create: `infra/modules/bootstrap-db/variables.tf`

- [ ] **Step 1: Create the module variables file**

```hcl
# infra/modules/bootstrap-db/variables.tf
#
# Inputs for the bootstrap-db module. Consumed from
# infra/environments/{staging,production}/main.tf via terraform_remote_state
# of the shared workspace + per-env secret ARNs.

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
  description = "ECS cluster name. Composed into the run-task command outputs."
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

- [ ] **Step 2: Validate HCL syntax**

Run from repo root:

```bash
terraform -chdir=infra/modules/bootstrap-db fmt -check
```

Expected: exit 0, no output (file already formatted). If it complains, run without `-check` and re-stage.

```bash
terraform -chdir=infra/modules/bootstrap-db init -backend=false
terraform -chdir=infra/modules/bootstrap-db validate
```

Expected: `Success! The configuration is valid.`

(`init -backend=false` skips remote-state — the module isn't a root module; we just want validate to succeed against the variables-only file.)

- [ ] **Step 3: Commit**

```bash
git add infra/modules/bootstrap-db/variables.tf
git commit -m "feat(myt-9qgb): add bootstrap-db module variables"
```

---

## Task 2: Module — security group + ingress/egress rules

**Files:**
- Create: `infra/modules/bootstrap-db/main.tf` (initial — SG block only)

- [ ] **Step 1: Create main.tf with the security group + rules**

```hcl
# infra/modules/bootstrap-db/main.tf

# ======== Security group: bootstrap → AWS APIs + RDS ========
# Egress-only by intent. Pulls the master secret + writes the app secret
# over Secrets Manager (HTTPS to AWS API endpoints) and connects to RDS
# via the existing private-subnet path. NAT Gateway egress to 443/tcp
# 0.0.0.0/0 matches the established pattern in modules/network (ECS SG
# egress 443 also goes to anywhere via NAT).

resource "aws_security_group" "bootstrap" {
  name        = "mythrun-${var.environment}-bootstrap-db"
  description = "Bootstrap-DB task: egress-only -- 443 to AWS APIs, 5432 to RDS."
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
```

- [ ] **Step 2: Validate**

```bash
terraform -chdir=infra/modules/bootstrap-db fmt -check
terraform -chdir=infra/modules/bootstrap-db validate
```

Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add infra/modules/bootstrap-db/main.tf
git commit -m "feat(myt-9qgb): bootstrap-db SG + ingress/egress rules"
```

---

## Task 3: Module — CloudWatch log group

**Files:**
- Modify: `infra/modules/bootstrap-db/main.tf` (append)

- [ ] **Step 1: Append the log group block**

Append to `infra/modules/bootstrap-db/main.tf`:

```hcl
# ======== CloudWatch log group ========

resource "aws_cloudwatch_log_group" "bootstrap" {
  name              = "/ecs/mythrun-${var.environment}-bootstrap-db"
  retention_in_days = var.log_retention_days

  tags = { Name = "mythrun-${var.environment}-bootstrap-db" }
}
```

- [ ] **Step 2: Validate**

```bash
terraform -chdir=infra/modules/bootstrap-db fmt -check
terraform -chdir=infra/modules/bootstrap-db validate
```

Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add infra/modules/bootstrap-db/main.tf
git commit -m "feat(myt-9qgb): bootstrap-db CloudWatch log group"
```

---

## Task 4: Module — task-execution IAM role

**Files:**
- Modify: `infra/modules/bootstrap-db/main.tf` (append)

- [ ] **Step 1: Append the task-execution role block**

Append to `infra/modules/bootstrap-db/main.tf`:

```hcl
# ======== IAM: task-execution role (ECR pull + log writes) ========
# Same pattern as modules/serving — AmazonECSTaskExecutionRolePolicy covers
# ECR pull + base log writes. We attach the managed policy directly; no
# inline KMS-decrypt grant needed because both secrets used by this task
# (RDS master, app password) sit on the AWS-managed `aws/secretsmanager`
# key today. If either is later rekeyed to a CMK, both this role AND the
# task role need a `kms:Decrypt` grant on the new key ARN.

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

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
```

- [ ] **Step 2: Validate**

```bash
terraform -chdir=infra/modules/bootstrap-db fmt -check
terraform -chdir=infra/modules/bootstrap-db validate
```

Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add infra/modules/bootstrap-db/main.tf
git commit -m "feat(myt-9qgb): bootstrap-db task-execution IAM role"
```

---

## Task 5: Module — task IAM role (Secrets Manager)

**Files:**
- Modify: `infra/modules/bootstrap-db/main.tf` (append)

- [ ] **Step 1: Append the task role block**

Append to `infra/modules/bootstrap-db/main.tf`:

```hcl
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

  # GetRandomPassword is an account-level API; resource MUST be "*".
  statement {
    sid       = "GenerateRandomPassword"
    actions   = ["secretsmanager:GetRandomPassword"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "bootstrap-db-permissions"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}
```

- [ ] **Step 2: Validate**

```bash
terraform -chdir=infra/modules/bootstrap-db fmt -check
terraform -chdir=infra/modules/bootstrap-db validate
```

Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add infra/modules/bootstrap-db/main.tf
git commit -m "feat(myt-9qgb): bootstrap-db task IAM role + Secrets Manager grants"
```

---

## Task 6: Module — ECS task definition

**Files:**
- Modify: `infra/modules/bootstrap-db/main.tf` (append)

- [ ] **Step 1: Append the task definition block**

Append to `infra/modules/bootstrap-db/main.tf`:

```hcl
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
    # Environment carries only what the script's required-env-var contract
    # actually reads. The script computes its own APP_SECRET_ID locally as
    # `mythrun/${ENV}/rds-password`; injecting it as an env var would be
    # ignored. The IAM policy on the task role ARN-pins the same secret
    # name → ARN that the script resolves to.
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

- [ ] **Step 2: Validate**

```bash
terraform -chdir=infra/modules/bootstrap-db fmt -check
terraform -chdir=infra/modules/bootstrap-db validate
```

Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add infra/modules/bootstrap-db/main.tf
git commit -m "feat(myt-9qgb): bootstrap-db ECS task definition"
```

---

## Task 7: Module — outputs (run-task commands + scalars)

**Files:**
- Create: `infra/modules/bootstrap-db/outputs.tf`

- [ ] **Step 1: Create outputs.tf**

```hcl
# infra/modules/bootstrap-db/outputs.tf

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
# -raw` is fragile (a previous spec iteration had a literal MODE_FLAG token
# that the operator hit "unknown arg" on). Each output is fully formed and
# pasteable. The shared base composition lives in a local.
#
# Operators MUST invoke these via `eval` (or `bash -c`), not paste raw —
# the `--overrides '{...}'` and `--network-configuration 'awsvpc...'`
# segments are single-quote-wrapped inside the string, and the shell
# re-parses those quotes only when the string passes through `eval`. The
# output description on each output below repeats this requirement so the
# wiki page renders it verbatim.

locals {
  _network_config = format(
    "awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=DISABLED}",
    join(",", var.private_subnet_ids),
    aws_security_group.bootstrap.id,
  )

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
  description = "Read-only mode: prints OK / MISSING / DB_ONLY / SECRET_MISSING. Always safe. Invoke via `eval \"$(terraform output -raw bootstrap_db_run_task_verify)\"` — single-quote wrapping requires shell re-parse."
}

output "run_task_secret_only" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.secret_only }] })),
  )
  description = "Rotates app password + writes to Secrets Manager. Use when --verify prints SECRET_MISSING. Invoke via `eval`."
}

output "run_task_reset_password" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.reset_password }] })),
  )
  description = "Alias of --secret-only. Use when the stored secret is known-wrong (drift), not just missing. Invoke via `eval`."
}

output "run_task_user_only" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.user_only }] })),
  )
  description = "DB exists, user doesn't: create user + write secret. Use when --verify prints DB_ONLY. Invoke via `eval`."
}

output "run_task_default" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.default }] })),
  )
  description = "Default mode: create DB + user + secret. Use when --verify prints MISSING. Invoke via `eval`."
}
```

- [ ] **Step 2: Validate**

```bash
terraform -chdir=infra/modules/bootstrap-db fmt -check
terraform -chdir=infra/modules/bootstrap-db validate
```

Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add infra/modules/bootstrap-db/outputs.tf
git commit -m "feat(myt-9qgb): bootstrap-db module outputs (5 run-task commands + scalars)"
```

---

## Task 8: Shared workspace — ECR repo + lifecycle + output

**Files:**
- Modify: `infra/environments/shared/main.tf` (append two resources)
- Modify: `infra/environments/shared/outputs.tf` (append one output)

- [ ] **Step 1: Append ECR repo + lifecycle to shared/main.tf**

Append to `infra/environments/shared/main.tf`:

```hcl
# ======== Bootstrap-DB ECR Repository ========
# Separate from `mythrun` because:
#   - tag policy is IMMUTABLE here (one tag per <git-sha>-<run-attempt>)
#   - lifecycle keeps 20 images instead of 50 (cadence is monthly, not per-PR)
#   - access pattern is operator-pull, not service-pull
# Tag-immutability + ${run_attempt} suffix means workflow re-runs always
# succeed.

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
        description  = "Keep 20 most recent bootstrap-db-* tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["bootstrap-db-*"]
          countType      = "imageCountMoreThan"
          countNumber    = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}
```

- [ ] **Step 2: Append output to shared/outputs.tf**

Append to `infra/environments/shared/outputs.tf`:

```hcl
output "bootstrap_db_ecr_repository_url" {
  value       = aws_ecr_repository.bootstrap_db.repository_url
  description = "ECR repo URL for the bootstrap-db image (consumed by per-env workspaces)."
}
```

- [ ] **Step 3: Validate**

```bash
terraform -chdir=infra/environments/shared fmt -check
terraform -chdir=infra/environments/shared validate
```

Expected: both succeed. Note: `validate` requires `init` to have been run against the real backend at least once; if it errors with "missing init", run `terraform -chdir=infra/environments/shared init` first (this is a one-time per-clone action, not a code change).

- [ ] **Step 4: Plan**

```bash
terraform -chdir=infra/environments/shared plan
```

Expected diff:
- `+ aws_ecr_repository.bootstrap_db`
- `+ aws_ecr_lifecycle_policy.bootstrap_db`
- No other resources changed.

- [ ] **Step 5: Operator action — apply the shared workspace**

Surface this command for Miklos to run:

```bash
terraform -chdir=infra/environments/shared apply
```

Confirm with the operator that the apply succeeded and the new repo exists:

```bash
aws ecr describe-repositories --repository-names mythrun-bootstrap-db --query 'repositories[0].repositoryName'
```

Expected: `"mythrun-bootstrap-db"`.

- [ ] **Step 6: Commit**

```bash
git add infra/environments/shared/main.tf infra/environments/shared/outputs.tf
git commit -m "feat(myt-9qgb): bootstrap-db ECR repo (IMMUTABLE, keep-20) + output"
```

---

## Task 9: Dockerfile

**Files:**
- Create: `infra/bootstrap-db/Dockerfile`

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
# ARG must precede FROM and is FROM-scope only by Docker semantics — no
# default; the build pipeline supplies it. A typo at build time fails loudly
# at FROM (the URL doesn't resolve to an alpine repo).
ARG ECR_ACCOUNT_ID

FROM ${ECR_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/ecr-public/docker/library/alpine:3.20

# - bash: bootstrap-databases.sh uses bash-only syntax (set -uo pipefail, [[ ]])
# - aws-cli: on alpine 3.20 community the `aws-cli` package IS v2 (verified
#   2.15.57 at image build). There is NO separate `aws-cli-v2` package on
#   this release — earlier spec drafts assumed there was. We want v2
#   specifically (faster start, current AWS stewardship); the smoke-check
#   `RUN` below fails the build if alpine ever shuffles `aws-cli` back
#   to v1 — that's a regression we want to notice loudly.
# - postgresql16-client: psql to RDS (matches RDS engine major)
# - jq: parse master-secret JSON
# - ca-certificates: TLS to AWS APIs and rds.force_ssl=1
# Versions intentionally unpinned beyond major. Image lifecycle keeps the
# last 20; alpine 3.20 minor security bumps are a feature, not a regression
# risk, on a manually-invoked operator task that never runs unattended.
# hadolint ignore=DL3018
RUN apk add --no-cache \
      bash \
      aws-cli \
      postgresql16-client \
      jq \
      ca-certificates

# Belt-and-suspenders: fail the build if the apk repo ever drifts and gives
# us v1 under this package name. Also prints the version into build logs
# for forensic clarity.
RUN aws --version 2>&1 | tee /dev/stderr | grep -q 'aws-cli/2'

WORKDIR /app
COPY infra/scripts/bootstrap-databases.sh /app/bootstrap-databases.sh
RUN chmod +x /app/bootstrap-databases.sh

# CMD intentionally unset — the ECS run-task --overrides supplies the args.
# ENTRYPOINT is the script so the operator's --overrides is just
# ["--env","staging","--verify"].
ENTRYPOINT ["/bin/bash", "/app/bootstrap-databases.sh"]
```

- [ ] **Step 2: Empirical package-name confirmation (already resolved)**

During the original T9 implementation pass, the implementer ran:

```bash
docker run --rm alpine:3.20 sh -c 'apk update >/dev/null 2>&1 && apk search "aws-cli*" 2>&1' | grep -i 'aws-cli'
```

and confirmed alpine 3.20 community ships exactly ONE package named `aws-cli`, which is **v2** (verified `aws-cli/2.15.57` at image build). There is no separate `aws-cli-v2` package on this release. The Dockerfile above pins to `aws-cli` accordingly; the smoke-check `RUN` defends against a future apk-repo state where this name shifts back to v1.

If you're re-implementing this task fresh (different alpine release, different ECR account, etc.), re-run the search above and reconcile if the empirical answer differs.

- [ ] **Step 3: Lint locally**

```bash
docker run --rm -i hadolint/hadolint:latest hadolint --failure-threshold error - < infra/bootstrap-db/Dockerfile
```

Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add infra/bootstrap-db/Dockerfile
git commit -m "feat(myt-9qgb): bootstrap-db Dockerfile (alpine + aws-cli v2 + smoke check)"
```

---

## Task 10: GitHub Actions build workflow

**Files:**
- Create: `.github/workflows/bootstrap-db-build.yml`

- [ ] **Step 1: Verify pinned action SHAs against upstream tags**

Before authoring the workflow, confirm the SHAs the spec pins. Run:

```bash
gh api repos/hadolint/hadolint-action/git/refs/tags/v3.1.0 --jq '.object.sha'
gh api repos/actions/upload-artifact/git/refs/tags/v4.6.2 --jq '.object.sha'
```

Expected output:
```
54c9adbab1582c2ef04b2016b760714a4bfde3cf
ea165f8d65b6e75b540449e92b4886f43607fa02
```

If they differ: update the SHAs in the workflow below to match the actual upstream tag SHAs, and note the mismatch in the commit message. Reused SHAs (`actions/checkout@v6.0.2`, `aws-actions/configure-aws-credentials@v4.1.0`, `aws-actions/amazon-ecr-login@v2.1.4`) are already in production via `.github/workflows/deploy.yml` — no need to re-verify.

- [ ] **Step 2: Create the workflow**

```yaml
# .github/workflows/bootstrap-db-build.yml
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
    # IMAGE_TAG is computed once per job from contexts that don't mutate
    # mid-run, so all steps reference the same value.
    env:
      IMAGE_TAG: bootstrap-db-${{ github.sha }}-${{ github.run_attempt }}
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

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@19d944daaa35f0fa1d3f7f8af1d3f2e5de25c5b7  # v2.1.4

      - name: Lint Dockerfile (hadolint)
        # failure-threshold: error — DL3018 (apk version pin) is suppressed
        # inline in the Dockerfile via `hadolint ignore=DL3018`. Other
        # warnings are advisory; only errors block.
        uses: hadolint/hadolint-action@54c9adbab1582c2ef04b2016b760714a4bfde3cf  # v3.1.0
        with:
          dockerfile: infra/bootstrap-db/Dockerfile
          failure-threshold: error

      - name: Build image
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
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
        run: docker push "$REGISTRY/$ECR_REPO:$IMAGE_TAG"

      - name: Print operator bump command
        run: |
          # Print the literal one-line replacement the operator should put
          # into infra/environments/staging/terraform.tfvars. No <placeholders>.
          BUMP_LINE=$(printf 'bootstrap_image_tag = "%s"' "$IMAGE_TAG")
          echo "::notice title=Bootstrap-DB image pushed::$IMAGE_TAG"
          # Title kept short so GitHub's Checks UI doesn't truncate it; the
          # actionable line lives in the message body.
          echo "::notice title=Operator: bump terraform.tfvars::Paste into infra/environments/staging/terraform.tfvars (replace existing bootstrap_image_tag line):%0A$BUMP_LINE"
          echo "$BUMP_LINE" > /tmp/bootstrap_image_tag.line

      - name: Upload bump line as artifact
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02  # v4.6.2
        with:
          name: bootstrap-image-tag-line
          path: /tmp/bootstrap_image_tag.line
          if-no-files-found: error
          retention-days: 30
```

- [ ] **Step 3: Lint the YAML locally**

```bash
yamllint .github/workflows/bootstrap-db-build.yml 2>&1 || echo "(yamllint not installed; skip — actions parser is the real gate)"
```

If `yamllint` isn't installed, that's fine — the actions parser on GitHub is the real gate, surfaced when the workflow is dispatched.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/bootstrap-db-build.yml
git commit -m "feat(myt-9qgb): bootstrap-db image build workflow (path-triggered, OIDC)"
```

---

## Task 11: Operator action — first image build + tag capture

**Files:**
- (None — operator action only)

- [ ] **Step 1: Surface the build trigger to Miklos**

After the previous commits land on `main` and are pushed, the path-triggered workflow won't fire automatically (the commits modified files OTHER than the three triggering paths). Surface this exact instruction:

> Push the current `main` branch to GitHub. Then trigger the build workflow manually:
> ```bash
> gh workflow run bootstrap-db-build.yml
> RUN_ID=$(gh run list --workflow=bootstrap-db-build.yml --limit=1 --json databaseId -q '.[0].databaseId')
> gh run watch "$RUN_ID" --exit-status
> ```
> When it succeeds, capture the literal `bootstrap_image_tag = "..."` line from the run's notice output:
> ```bash
> gh run download "$RUN_ID" -n bootstrap-image-tag-line && cat bootstrap_image_tag.line
> ```

Wait for Miklos to confirm the image was built and to share the literal line.

- [ ] **Step 2: Record the image tag for the next task**

Note the captured tag (e.g. `bootstrap-db-abc1234567890abcdef-1`) — Task 13 needs it.

---

## Task 12: Module instantiation in staging + GH Actions IAM extension

**Files:**
- Modify: `infra/environments/staging/main.tf` (append module + extend existing IAM policy doc)

- [ ] **Step 1: Append the module instantiation**

Append to `infra/environments/staging/main.tf`, after the existing `module "serving" {}` block:

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

- [ ] **Step 2: Extend the GH Actions IAM policy ECR statement**

In `infra/environments/staging/main.tf`, find the existing `data "aws_iam_policy_document" "gh_actions_staging"` block (around lines 188–284 of the current file). Locate the statement with `actions = ["ecr:BatchCheckLayerAvailability", ...]` (lines ~196–210). Modify its `resources` list to add the new ARN:

```hcl
# In the existing data.aws_iam_policy_document.gh_actions_staging,
# the ECR push/pull statement's resources block becomes:
resources = [
  "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun",
  "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun-bootstrap-db",
  "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/ecr-public/*",
]
```

That is, the surrounding `statement {}` block remains unchanged — only the `resources = [...]` list gains the `mythrun-bootstrap-db` ARN as the second element. Do NOT touch other statements (PassRole, ECS, etc.).

- [ ] **Step 3: Validate**

```bash
terraform -chdir=infra/environments/staging fmt -check
terraform -chdir=infra/environments/staging validate
```

Expected: both succeed. (You may need to run `terraform -chdir=infra/environments/staging init` first if you haven't initialized this workspace in this clone.)

- [ ] **Step 4: Commit**

```bash
git add infra/environments/staging/main.tf
git commit -m "feat(myt-9qgb): instantiate bootstrap-db module in staging + extend GH ECR scope"
```

---

## Task 13: Staging variables, tfvars, and outputs

**Files:**
- Modify: `infra/environments/staging/variables.tf` (append)
- Modify: `infra/environments/staging/terraform.tfvars` (append the captured tag from Task 11)
- Modify: `infra/environments/staging/outputs.tf` (append 8 outputs)

- [ ] **Step 1: Append the variable**

Append to `infra/environments/staging/variables.tf`:

```hcl
variable "bootstrap_image_tag" {
  description = "Tag of the mythrun-bootstrap-db image to pin into the task definition. Format: bootstrap-db-<sha>-<run-attempt>. Bump after each script edit + image rebuild."
  type        = string
  # No default — terraform.tfvars must supply, so a stale tag never silently sticks.
}
```

- [ ] **Step 2: Append the tag to tfvars**

Append to `infra/environments/staging/terraform.tfvars` (use the exact value captured from Task 11):

```hcl
bootstrap_image_tag = "<paste captured value here>"
```

If `infra/environments/staging/terraform.tfvars` doesn't yet exist, create it with just that line. (Look at `git log -- infra/environments/staging/terraform.tfvars` to confirm — if the file is gitignored, the tfvars line goes elsewhere; check `.gitignore` and the existing variable wiring before assuming.)

> If `terraform.tfvars` is gitignored: the `bootstrap_image_tag` value still needs to be pinned somewhere committed for reproducibility. In that case, add it to whatever the existing committed mechanism is (e.g. environment-variable-injected `TF_VAR_bootstrap_image_tag`, or a committed `bootstrap_image_tag.auto.tfvars`). Surface the gitignore situation to Miklos before improvising.

- [ ] **Step 3: Append outputs**

Append to `infra/environments/staging/outputs.tf`:

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
  description = "Paste-ready: read-only verify. Invoke via `eval`."
}

output "bootstrap_db_run_task_secret_only" {
  value       = module.bootstrap_db.run_task_secret_only
  description = "Paste-ready: rotate password + write secret. Invoke via `eval`."
}

output "bootstrap_db_run_task_reset_password" {
  value       = module.bootstrap_db.run_task_reset_password
  description = "Paste-ready: alias of secret-only for drift-rotation. Invoke via `eval`."
}

output "bootstrap_db_run_task_user_only" {
  value       = module.bootstrap_db.run_task_user_only
  description = "Paste-ready: DB exists, create user + write secret. Invoke via `eval`."
}

output "bootstrap_db_run_task_default" {
  value       = module.bootstrap_db.run_task_default
  description = "Paste-ready: full bootstrap (create DB + user + secret). Invoke via `eval`."
}
```

- [ ] **Step 4: Validate**

```bash
terraform -chdir=infra/environments/staging fmt -check
terraform -chdir=infra/environments/staging validate
```

Expected: both succeed.

- [ ] **Step 5: Plan**

```bash
terraform -chdir=infra/environments/staging plan
```

Expected diff:
- `+ module.bootstrap_db.aws_security_group.bootstrap`
- `+ module.bootstrap_db.aws_vpc_security_group_egress_rule.bootstrap_https`
- `+ module.bootstrap_db.aws_vpc_security_group_egress_rule.bootstrap_to_rds`
- `+ module.bootstrap_db.aws_vpc_security_group_ingress_rule.rds_from_bootstrap`
- `+ module.bootstrap_db.aws_cloudwatch_log_group.bootstrap`
- `+ module.bootstrap_db.aws_iam_role.task_execution`
- `+ module.bootstrap_db.aws_iam_role_policy_attachment.task_execution_managed`
- `+ module.bootstrap_db.aws_iam_role.task`
- `+ module.bootstrap_db.aws_iam_role_policy.task`
- `+ module.bootstrap_db.aws_ecs_task_definition.bootstrap`
- `~ aws_iam_role_policy.github_actions_staging` (resources list grows by one ARN)
- No diffs in `module.serving`, `data` block, or other resources.

`Plan: 10 to add, 1 to change, 0 to destroy.`

If the plan diff doesn't match, stop and reconcile before applying.

- [ ] **Step 6: Operator action — apply staging**

Surface for Miklos:

```bash
terraform -chdir=infra/environments/staging apply
```

Confirm with the operator that the apply succeeded. Verify the task definition is ACTIVE:

```bash
aws ecs describe-task-definition --task-definition mythrun-staging-bootstrap-db --query 'taskDefinition.status'
```

Expected: `"ACTIVE"`.

- [ ] **Step 7: Commit**

```bash
git add infra/environments/staging/variables.tf infra/environments/staging/terraform.tfvars infra/environments/staging/outputs.tf
git commit -m "feat(myt-9qgb): staging bootstrap-db variable + tfvars pin + 8 outputs"
```

---

## Task 14: Wiki page — bootstrap-database.html

**Files:**
- Create: `docs/wiki/content/data/bootstrap-database.html`

- [ ] **Step 1: Create the wiki page**

```html
<!-- source: infra/scripts/bootstrap-databases.sh -->
<!-- source: infra/bootstrap-db/Dockerfile -->
<!-- source: infra/modules/bootstrap-db/main.tf -->
<!-- source: infra/modules/bootstrap-db/outputs.tf -->
<!-- source: infra/environments/staging/outputs.tf -->
<!-- source-hash: <auto> -->
<!-- last-ticket: MYT-9qgb -->

<h1>Bootstrap Database</h1>

<p class="lead">
  How an operator brings a new RDS instance from "shell secret only" to "app
  password populated" — by running <code>bootstrap-databases.sh</code>
  inside a one-shot ECS task. Same path is used for password rotation and
  drift recovery.
</p>

<h2>Why a one-shot ECS task</h2>

<p>
  RDS is in private subnets and not publicly accessible, so the script can't
  run from a laptop. We don't keep a bastion EC2 because that's an
  always-on cost surface for an operation that runs at most every few weeks.
  Instead, we ship a dedicated container image with the script baked in and
  execute it as an <code>aws ecs run-task</code> against the existing
  Mythrun ECS cluster. The task definition + image build pipeline are
  versioned Terraform + GitHub Actions; nothing is ad-hoc.
</p>

<h2>The four script modes</h2>

<table class="wiki-table">
  <thead>
    <tr><th><code>--verify</code> output</th><th>Run with</th><th>Why</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><code>OK</code></td>
      <td>nothing — already bootstrapped</td>
      <td>DB + user + secret all present</td>
    </tr>
    <tr>
      <td><code>MISSING</code></td>
      <td><code>bootstrap_db_run_task_default</code></td>
      <td>Creates DB + user + secret</td>
    </tr>
    <tr>
      <td><code>DB_ONLY</code></td>
      <td><code>bootstrap_db_run_task_user_only</code></td>
      <td>DB exists; create user + write secret</td>
    </tr>
    <tr>
      <td><code>SECRET_MISSING</code></td>
      <td><code>bootstrap_db_run_task_secret_only</code></td>
      <td>DB + user exist; rotate password + write secret</td>
    </tr>
  </tbody>
</table>

<h2>First-time setup runbook</h2>

<ol>
  <li>
    <p><strong>Land the Terraform.</strong></p>
    <pre><code>cd infra/environments/shared &amp;&amp; terraform apply
cd ../staging &amp;&amp; terraform apply</code></pre>
  </li>

  <li>
    <p><strong>Build + push the bootstrap image.</strong> Path-triggered on script/Dockerfile edits, or dispatch manually:</p>
    <pre><code>gh workflow run bootstrap-db-build.yml
RUN_ID=$(gh run list --workflow=bootstrap-db-build.yml --limit=1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status</code></pre>
  </li>

  <li>
    <p><strong>Pin the new image tag.</strong> Capture the literal one-liner from the workflow's output:</p>
    <pre><code>gh run download "$RUN_ID" -n bootstrap-image-tag-line &amp;&amp; cat bootstrap_image_tag.line</code></pre>
    <p>Replace the existing <code>bootstrap_image_tag</code> line in <code>infra/environments/staging/terraform.tfvars</code> with the captured line. Commit + push, then:</p>
    <pre><code>cd infra/environments/staging &amp;&amp; terraform apply</code></pre>
  </li>

  <li>
    <p><strong>Verify network + IAM + image.</strong> Read-only — always safe:</p>
    <pre><code>RUN_TASK_CMD=$(terraform output -raw bootstrap_db_run_task_verify)
TASK_ARN=$(eval "$RUN_TASK_CMD" --query 'tasks[0].taskArn' --output text)
echo "Task: $TASK_ARN"

# Wait. Cold-start is 60–120s; cold pull-through cache can stretch this.
# `wait tasks-stopped` polls every 6s up to 100 attempts = 10 min ceiling.
# If you hit that ceiling, check lastStatus before concluding failure.
aws ecs wait tasks-stopped --cluster mythrun --tasks "$TASK_ARN"

# Exit code + reason.
aws ecs describe-tasks --cluster mythrun --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].{exitCode:exitCode,reason:reason,stoppedReason:stoppedReason}'

# Read THIS task's logs (stream-name-prefix avoids interleaved historical output).
TASK_ID="${TASK_ARN##*/}"
aws logs tail /ecs/mythrun-staging-bootstrap-db \
  --since 30m --format short \
  --log-stream-name-prefix "bootstrap/bootstrap/$TASK_ID"</code></pre>
    <p>Expect: <code>exitCode 0</code>; the log prints one of <code>OK</code>, <code>MISSING</code>, <code>DB_ONLY</code>, or <code>SECRET_MISSING</code> on a line by itself.</p>
  </li>

  <li>
    <p><strong>Run the appropriate mode.</strong> Use the verify→mode table above, then the same wait + describe + log-tail flow as step 4. For example, on <code>SECRET_MISSING</code>:</p>
    <pre><code>eval "$(terraform output -raw bootstrap_db_run_task_secret_only)"</code></pre>
  </li>
</ol>

<h2>Failure modes</h2>

<p>
  Match by substring — AWS's literal <code>stoppedReason</code> strings drift
  across releases. The diagnostic command in the third column is the fastest
  next step.
</p>

<table class="wiki-table">
  <thead>
    <tr>
      <th>ECS <code>stoppedReason</code> substring</th>
      <th>Container log line</th>
      <th>Likely cause</th>
      <th>First check</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>CannotPullContainerError</code></td>
      <td>(no container log — task never started)</td>
      <td>Image tag pinned in TF doesn't exist in ECR (stale <code>bootstrap_image_tag</code> or build hadn't completed)</td>
      <td><code>aws ecr describe-images --repository-name mythrun-bootstrap-db --image-ids imageTag="$TAG"</code></td>
    </tr>
    <tr>
      <td><code>ResourceInitializationError: ... secrets or registry auth</code></td>
      <td>(no container log)</td>
      <td>Task-execution role missing ECR pull or KMS decrypt</td>
      <td>Check <code>aws_iam_role.task_execution</code> policy attachments</td>
    </tr>
    <tr>
      <td><code>Essential container in task exited</code> (exit code 1)</td>
      <td><code>RDS master secret missing 'X'</code></td>
      <td>Master secret payload is malformed or rotated to an unexpected schema</td>
      <td><code>aws secretsmanager get-secret-value --secret-id &lt;master-arn&gt;</code> and inspect the JSON shape</td>
    </tr>
    <tr>
      <td><code>Essential container in task exited</code> (exit code 1)</td>
      <td><code>psql: could not connect</code></td>
      <td>RDS SG ingress rule didn't apply, or RDS endpoint changed</td>
      <td><code>aws ec2 describe-security-groups --group-ids $RDS_SG_ID</code> looking for an ingress from the bootstrap SG</td>
    </tr>
    <tr>
      <td>Task stuck in <code>PROVISIONING</code> for &gt;2 min then stops with <code>Network Configuration</code> error</td>
      <td>(no container log)</td>
      <td>Subnets have no NAT route OR SG egress 443 missing</td>
      <td>Check route table on the subnets; check <code>bootstrap_https</code> egress rule</td>
    </tr>
    <tr>
      <td><code>Essential container in task exited</code> (exit code 2)</td>
      <td>Log line starting with <code>unknown arg:</code></td>
      <td>The run-task command had a placeholder token instead of one of the five discrete outputs</td>
      <td>Use <code>terraform output -raw bootstrap_db_run_task_verify</code> (or one of the four other discrete outputs); don't string-substitute</td>
    </tr>
  </tbody>
</table>

<h2>Recovery from a half-applied <code>--secret-only</code></h2>

<p>
  If <code>--secret-only</code> exits non-zero between the <code>ALTER USER</code>
  (logged as the SQL line) and the secret write (logged as <code>Rotated password</code>),
  the database password and Secrets Manager are divergent and the app can't
  connect. <strong>Re-run the same <code>--secret-only</code> invocation</strong>
  — the script generates a new password, runs <code>ALTER USER</code> again, and
  re-writes the secret. The script is idempotent for this. Do <em>not</em>
  manually paste the password from CloudWatch logs (passwords are not
  logged by design).
</p>

<h2>If <code>--verify</code> itself errored</h2>

<p>
  <code>--verify</code> is read-only but it can still exit 1 for three reasons:
</p>

<ul>
  <li><strong>Master-secret read failure</strong> — IAM denial. Check the task role policy attachments.</li>
  <li><strong>Malformed master secret</strong> — the master was rotated to an unexpected JSON schema. Inspect with <code>aws secretsmanager get-secret-value</code> and escalate; do not run any non-verify mode against a malformed master.</li>
  <li><strong>psql connectivity</strong> — network path missing. See the failure-modes table above.</li>
</ul>

<h2>Updating the script</h2>

<p>
  Edit <code>infra/scripts/bootstrap-databases.sh</code>, push to <code>main</code>; the path-trigger fires <code>bootstrap-db-build.yml</code>; <strong>wait for the workflow to succeed</strong>; copy the literal <code>bootstrap_image_tag = "..."</code> line from the workflow's <code>::notice::</code> output (or the <code>bootstrap-image-tag-line</code> artifact); replace the existing line in <code>terraform.tfvars</code>; commit + push; <code>terraform apply</code>.
</p>

<p>
  See also: <a href="./migrations.html#run-migrations-locally">Migrations</a> — the migration runner is what runs <em>after</em> bootstrap puts the password in place.
</p>
```

- [ ] **Step 2: Run wiki check**

```bash
DATABASE_URL=postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun pnpm wiki:check
```

Expected: passes (the page is new, so it has no source-hash drift). If it fails with "no source-hash on bootstrap-database.html", the wiki tooling will print the expected hash; replace `<auto>` in the source-hash line with the printed value and re-run.

- [ ] **Step 3: Commit**

```bash
git add docs/wiki/content/data/bootstrap-database.html
git commit -m "docs(myt-9qgb): bootstrap-database wiki page (runbook + failure modes)"
```

---

## Task 15: Cross-link from migrations.html

**Files:**
- Modify: `docs/wiki/content/data/migrations.html`

- [ ] **Step 1: Find the Integration points section**

Run:

```bash
grep -n "Integration points" docs/wiki/content/data/migrations.html
```

Expected: at least one match (the section header). Note the line number.

- [ ] **Step 2: Add the cross-link sentence**

Find the paragraph immediately following the `<h2>Integration points</h2>` heading. Insert this sentence at the end of that paragraph (before the closing `</p>`):

```html
The migration runner assumes the per-env app password secret has been populated — see <a href="./bootstrap-database.html">Bootstrap Database</a> for that one-time setup.
```

If `migrations.html` doesn't have an `Integration points` section, place the link at the end of the lead paragraph or in whatever section discusses the runtime preconditions (the `<h2>How it fits together</h2>` paragraph is a reasonable fallback). Surface to Miklos if the structure has changed and you can't find a natural insertion point.

- [ ] **Step 3: Run wiki check**

```bash
DATABASE_URL=postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun pnpm wiki:check
```

Expected: passes. The source-hash on `migrations.html` doesn't change because we only edited HTML body, not a `<!-- source: -->` line — but if the page has a content-hash gate that DOES change, the tool will print the new expected value and the implementer updates it inline.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/content/data/migrations.html
git commit -m "docs(myt-9qgb): cross-link from migrations.html to bootstrap-database.html"
```

---

## Task 16: End-to-end verification (operator action)

**Files:**
- (None — operator action only.)

This task validates the spec's acceptance criteria against the actually-deployed infrastructure. All steps run against staging by Miklos.

- [ ] **Step 1: Pinned action SHAs match upstream tags**

```bash
gh api repos/hadolint/hadolint-action/git/refs/tags/v3.1.0 --jq '.object.sha'
gh api repos/actions/upload-artifact/git/refs/tags/v4.6.2 --jq '.object.sha'
```

Expected: outputs match the SHAs in `.github/workflows/bootstrap-db-build.yml`.

- [ ] **Step 2: hadolint passes locally**

```bash
docker run --rm -i hadolint/hadolint:latest hadolint --failure-threshold error - < infra/bootstrap-db/Dockerfile
```

Expected: no output, exit 0.

- [ ] **Step 3: ECR repo exists**

```bash
aws ecr describe-repositories --repository-names mythrun-bootstrap-db --query 'repositories[0].repositoryName'
```

Expected: `"mythrun-bootstrap-db"`.

- [ ] **Step 4: Build workflow runs to completion**

Already validated in Task 11. If a re-run is desired:

```bash
gh workflow run bootstrap-db-build.yml
RUN_ID=$(gh run list --workflow=bootstrap-db-build.yml --limit=1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

Expected: exit 0.

- [ ] **Step 5: Task definition is ACTIVE**

```bash
aws ecs describe-task-definition --task-definition mythrun-staging-bootstrap-db --query 'taskDefinition.status'
```

Expected: `"ACTIVE"`.

- [ ] **Step 6: First `--verify` exits 0 and prints an expected token**

```bash
cd infra/environments/staging
RUN_TASK_CMD=$(terraform output -raw bootstrap_db_run_task_verify)
TASK_ARN=$(eval "$RUN_TASK_CMD" --query 'tasks[0].taskArn' --output text)
echo "Task: $TASK_ARN"

aws ecs wait tasks-stopped --cluster mythrun --tasks "$TASK_ARN"

EXIT=$(aws ecs describe-tasks --cluster mythrun --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)
[[ "$EXIT" == "0" ]] || { echo "FAIL: exitCode=$EXIT"; exit 1; }

TASK_ID="${TASK_ARN##*/}"
aws logs tail /ecs/mythrun-staging-bootstrap-db --since 30m --format short \
  --log-stream-name-prefix "bootstrap/bootstrap/$TASK_ID" \
  | grep -E '^(OK|MISSING|DB_ONLY|SECRET_MISSING)$' \
  || { echo "FAIL: expected one of OK/MISSING/DB_ONLY/SECRET_MISSING in logs"; exit 1; }
```

Expected: exit 0; the log line matches.

- [ ] **Step 7: Wiki check passes against current state**

```bash
DATABASE_URL=postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun pnpm wiki:check
```

Expected: exit 0.

- [ ] **Step 8: Cross-link is in place**

```bash
grep 'bootstrap-database.html' docs/wiki/content/data/migrations.html
```

Expected: one match.

- [ ] **Step 9: Closing this bead unblocks myth-ml8**

```bash
bd show myth-9qgb | grep -E 'BLOCKS.*myth-ml8'
```

Expected: a line indicating myth-ml8 is blocked-by myth-9qgb.

- [ ] **Step 10: Close the bead**

```bash
bd close myth-9qgb
```

Then surface to Miklos that myth-ml8 is now ready to pick up.

---

## Self-review notes (controller — completed before plan was saved)

**Spec coverage check:** every numbered file in the spec's "File layout" section has a task that creates or modifies it. Every item in "Acceptance criteria (paste-runnable)" has a verification step in Task 16. The five paste-ready run-task outputs land in Task 7 (module) and Task 13 (staging). The IAM policy extension lands in Task 12. The wiki page + cross-link land in Tasks 14–15. No gaps.

**Placeholder check:** every code block contains the actual content the implementer types. Operator-action tasks (8 step 5, 11, 13 step 6, 16) contain the exact commands. The `<auto>` source-hash placeholder in the wiki page is a real wiki-toolchain convention — Task 14 step 2 says how to resolve it.

**Type/name consistency:** the module variable names (`environment`, `vpc_id`, `private_subnet_ids`, `rds_sg_id`, `ecs_cluster_name`, `ecr_repository_url`, `image_tag`, `rds_master_secret_arn`, `rds_password_secret_arn`, `log_retention_days`) are consistent across Task 1 (declaration), Tasks 2–7 (consumption), and Task 12 (instantiation). The output names (`task_definition_family`, `security_group_id`, `log_group_name`, `task_role_arn`, `run_task_verify`/`secret_only`/`reset_password`/`user_only`/`default`) are consistent between Task 7 (module-level) and Task 13 (staging passthrough). The IAM resource names (`mythrun-${env}-bootstrap-db-exec`, `mythrun-${env}-bootstrap-db-task`) match the spec.
