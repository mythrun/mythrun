# Serving Infra + First-Deploy Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Terraform stack (shared + staging workspaces) with the compute + delivery layer — ECS cluster, ECR repo, API + Worker task definitions at `desired_count=0`, IAM roles, GitHub Actions OIDC, ALB with host-based routing, CloudWatch log groups, SNS alerts topic. Ready for MYT-28 to push the first image and flip `desired_count` to 1.

**Architecture:** Two-workspace layout (already established by MYT-25/MYT-26). Shared workspace gets inline additions (single-instance resources: ECR, OIDC provider, ECS cluster, ALB, listeners). Staging workspace gets a call to a new per-env `infra/modules/serving/` module + GitHub Actions IAM role + SNS topic. Cross-workspace plumbing via `data.terraform_remote_state.shared`.

**Tech Stack:** Terraform ≥1.10, AWS provider `~> 6.0`, native S3 state locking (`use_lockfile`). No new provider dependencies.

**Linear issue:** MYT-30
**Design spec:** `docs/superpowers/specs/2026-04-22-serving-infra-design.md` (v3, post-two-round agent-team review)

---

## Pre-flight notes

- **Billing inflection:** adds ~$16/mo (ALB) to MYT-25's ~$67/mo baseline. Total idle after MYT-30 apply: **~$83/mo**. When MYT-28 flips `desired_count=1`, add another ~$17/mo (0.5 vCPU / 1 GB Fargate task 24/7).
- **Miklos approval gates:** Task 3 (`terraform apply` on shared — adds ALB + ECR + OIDC + cluster + listeners) and Task 5 (`terraform apply` on staging — adds serving module resources + GH Actions role + SNS topic). Both applies are fast (<1 min each); ALB creation is the long pole on shared (~30s).
- **GitHub org numeric ID:** `274691930` (mythrun). Used inline in the OIDC trust policy's `repository_owner_id` condition. Looked up via `curl -s https://api.github.com/orgs/mythrun | jq .id` at plan-writing time (2026-04-22).
- **AWS CLI session:** apply requires SSO/IAM creds authenticated for account `862127484110`. Verify with `aws sts get-caller-identity` before Task 3.
- **No GitHub Environment yet:** the OIDC trust policy's `environment = "staging"` condition requires a GitHub Environment named "staging" on the `mythrun/mythrun` repo. That's MYT-28's work, not MYT-30's. The IAM role applies cleanly without it — it just can't be assumed until the Environment exists.
- **Terraform `backend.tf` already exists** in both workspaces from MYT-25. No backend changes in this plan.
- **`data.terraform_remote_state.shared` already exists** in `infra/environments/staging/main.tf` (line 3). Do NOT re-declare it — add new consumers alongside the existing data source.

---

## File Structure

Files this plan creates or modifies:

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `infra/modules/serving/variables.tf` | Create | Module inputs (env, VPC/SG refs, ECS cluster/ECR refs, DNS zone refs, secret ARN map + ARNs, data endpoints, tunables with Week 0 §7.2 defaults) |
| `infra/modules/serving/main.tf` | Create | Per-env resources: log groups, task exec/task roles, task defs (API + Worker), target group, listener rule, ECS services, Route 53 A-alias |
| `infra/modules/serving/outputs.tf` | Create | `api_service_arn`, `worker_service_arn`, `target_group_arn`, `task_execution_role_arn`, `task_role_arn`, `api_hostname` |
| `infra/environments/shared/main.tf` | Modify | Append ECR, OIDC provider, ECS cluster, ALB, HTTPS listener, HTTP redirect listener |
| `infra/environments/shared/outputs.tf` | Modify | Append `ecr_repository_url`, `ecs_cluster_name`, `alb_arn`, `alb_dns_name`, `alb_zone_id`, `alb_listener_https_arn`, `github_oidc_provider_arn` |
| `infra/environments/staging/variables.tf` | Modify | Append `github_repository_owner_id`, `alerts_email` |
| `infra/environments/staging/main.tf` | Modify | Append `module "serving"` call, GH Actions IAM role + policy, SNS topic + subscription |
| `infra/environments/staging/outputs.tf` | Modify | Append `api_service_arn`, `worker_service_arn`, `github_actions_role_arn`, `alerts_topic_arn`, `api_hostname` |

**Module boundaries rationale (from design):** ECR / OIDC provider / ECS cluster / ALB are single-instance resources — no reuse value in a module, so they live inline in `shared/main.tf`. The per-env bits (ECS service, task def, target group, listener rule, roles, log groups, A-alias) DO have reuse value — production will instantiate this same module at Launch — so they go in `modules/serving/`.

---

## Task 1: Author the serving module

**Goal:** Create `infra/modules/serving/` with variables, main, and outputs. No apply — this task is file-authoring only. The module is validated indirectly when Task 4 wires it into the staging workspace.

**Files:**
- Create: `infra/modules/serving/variables.tf`
- Create: `infra/modules/serving/main.tf`
- Create: `infra/modules/serving/outputs.tf`

### Steps

- [ ] **Step 1: Create the module directory**

```bash
mkdir -p /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/modules/serving
```

- [ ] **Step 2: Write `infra/modules/serving/variables.tf`**

```hcl
# ======== Environment + naming ========

variable "environment" {
  description = "Logical environment label: 'staging' or 'production'. Used for resource naming + tags + log group paths + DB_USER/DB_NAME values."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

# ======== Network inputs (from shared workspace's network module) ========

variable "vpc_id" {
  description = "VPC ID the ECS services run in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks (no public IPs; egress via NAT)."
  type        = list(string)
}

variable "ecs_sg_id" {
  description = "Security group ID for ECS tasks. Ingress 3000 from ALB SG; egress 443, 5432 to RDS SG, 6379 to Redis SG."
  type        = string
}

# ======== Compute-platform inputs (from shared workspace's new additions) ========

variable "ecs_cluster_name" {
  description = "Name of the shared ECS cluster ('mythrun')."
  type        = string
}

variable "ecr_repository_url" {
  description = "ECR repo URL like '862127484110.dkr.ecr.us-east-1.amazonaws.com/mythrun'. Used as the image base in task defs."
  type        = string
}

variable "alb_arn" {
  description = "ARN of the shared ALB (for target group registration)."
  type        = string
}

variable "alb_listener_https_arn" {
  description = "ARN of the ALB's HTTPS listener (the listener_rule attaches here)."
  type        = string
}

variable "alb_dns_name" {
  description = "ALB's public DNS name (for the Route 53 A-alias target)."
  type        = string
}

variable "alb_zone_id" {
  description = "ALB's hosted zone ID (for the Route 53 A-alias; NOT Route 53 zone_id)."
  type        = string
}

# ======== DNS inputs (from shared workspace's dns module) ========

variable "dns_zone_id" {
  description = "Route 53 hosted zone ID for mythrun.com (from shared workspace)."
  type        = string
}

variable "dns_zone_name" {
  description = "Route 53 zone name, e.g. 'mythrun.com' (no trailing dot)."
  type        = string
}

variable "wildcard_cert_arn" {
  description = "ARN of the *.mythrun.com wildcard ACM cert (from shared workspace's dns module). NOT USED by this module — listener is owned by shared; cert is attached there. Kept here for potential future per-env cert attachment."
  type        = string
  default     = ""
}

# ======== Data-layer inputs (from shared workspace's data module) ========

variable "rds_host" {
  description = "RDS endpoint hostname (no port). Injected as DB_HOST env var."
  type        = string
}

variable "rds_port" {
  description = "RDS port. Injected as DB_PORT env var."
  type        = number
}

variable "redis_host" {
  description = "ElastiCache primary endpoint hostname. Injected as REDIS_HOST env var."
  type        = string
}

variable "redis_port" {
  description = "ElastiCache port. Injected as REDIS_PORT env var."
  type        = number
}

# ======== Secret ARN inputs ========

variable "shared_redis_auth_secret_arn" {
  description = "ARN of mythrun/shared/redis-auth (cross-env shared secret). Injected as REDIS_AUTH_TOKEN."
  type        = string
}

variable "manual_secret_arns" {
  description = "Map of per-env manual secrets. Must contain keys: anthropic-api-key, stripe-secret-key, stripe-webhook-secret, cognito-client-secret."
  type        = map(string)

  validation {
    condition = alltrue([
      for k in ["anthropic-api-key", "stripe-secret-key", "stripe-webhook-secret", "cognito-client-secret"] :
      contains(keys(var.manual_secret_arns), k)
    ])
    error_message = "manual_secret_arns must contain all four expected keys: anthropic-api-key, stripe-secret-key, stripe-webhook-secret, cognito-client-secret."
  }
}

variable "rds_password_secret_arn" {
  description = "ARN of mythrun/${var.environment}/rds-password. Injected as DB_PASSWORD. Stored as a plain-string password by bootstrap-databases.sh (no JSON-path suffix on valueFrom)."
  type        = string
}

# rds_master_user_secret_arn is NOT here — the API/Worker tasks run as the
# per-env app user (mythrun_${env}), not the master. Only bootstrap-databases.sh's
# future IAM principal needs the master secret.

# ======== Tunables ========

# Defaults match Week 0 §7.2's staging-size matrix. Production workspace
# overrides to 512/1024 explicitly when instantiating this module at Launch.
variable "api_cpu" {
  description = "CPU units for the API task (256, 512, 1024, etc.)."
  type        = string
  default     = "256"
}

variable "api_memory" {
  description = "Memory (MB) for the API task."
  type        = string
  default     = "512"
}

variable "worker_cpu" {
  description = "CPU units for the Worker task."
  type        = string
  default     = "256"
}

variable "worker_memory" {
  description = "Memory (MB) for the Worker task."
  type        = string
  default     = "512"
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days. Staging defaults to 14; production should pass 30."
  type        = number
  default     = 14
}
```

- [ ] **Step 3: Write `infra/modules/serving/main.tf`**

```hcl
# ======== Hostname helper ========
# Priority-1 production wins host-based-routing collision if both envs ever point
# at the same host; staging uses 'staging-api.mythrun.com', production uses
# 'api.mythrun.com'. Priority range 100-299 reserved for per-env API forward rules.

locals {
  api_hostname = var.environment == "production" ? "api.${var.dns_zone_name}" : "${var.environment}-api.${var.dns_zone_name}"
}

# ======== CloudWatch Log Groups ========

resource "aws_cloudwatch_log_group" "api" {
  name              = "/mythrun/${var.environment}/api"
  retention_in_days = var.log_retention_days

  tags = { Name = "mythrun-${var.environment}-api-logs" }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/mythrun/${var.environment}/worker"
  retention_in_days = var.log_retention_days

  tags = { Name = "mythrun-${var.environment}-worker-logs" }
}

# ======== IAM: Task Execution Role ========
# ECS uses this role to pull images, fetch secrets, and ship logs BEFORE the
# container starts. The app itself uses the task role (see below).

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "mythrun-${var.environment}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = { Name = "mythrun-${var.environment}-task-execution" }
}

# AWS-managed baseline: ECR pull + CloudWatch Logs write.
resource "aws_iam_role_policy_attachment" "task_execution_baseline" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Secrets Manager: explicit per-ARN list (not wildcarded). Captures the
# cross-env shared Redis AUTH secret that a per-env wildcard would miss.
# Master RDS secret (rds!db-*) deliberately NOT in this list — app runs as
# mythrun_${env}, not master.
data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      values(var.manual_secret_arns),
      [
        var.rds_password_secret_arn,
        var.shared_redis_auth_secret_arn,
      ],
    )
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "secrets-access"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

# KMS note: all six referenced secrets use the AWS-managed aws/secretsmanager
# key. AmazonECSTaskExecutionRolePolicy grants GetSecretValue but NOT explicit
# kms:Decrypt. For AWS-managed keys this just works. If anyone later configures
# a customer-managed CMK on any of these secrets, the tasks will fail to start
# with ResourceInitializationError and this policy will need an explicit
# kms:Decrypt statement scoped to that CMK ARN.

# ======== IAM: Task Role ========
# The app itself assumes this role at runtime. Minimal today — grow as features
# need more AWS APIs.

resource "aws_iam_role" "task" {
  name               = "mythrun-${var.environment}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = { Name = "mythrun-${var.environment}-task" }
}

data "aws_iam_policy_document" "task_cloudwatch_metrics" {
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"] # PutMetricData doesn't support resource ARN scoping

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Mythrun/${var.environment}"]
    }
  }
}

resource "aws_iam_role_policy" "task_cloudwatch_metrics" {
  name   = "cloudwatch-metrics"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_cloudwatch_metrics.json
}

# ======== Task Definitions ========
# Container image points at :placeholder — a tag that doesn't exist. Task def
# registration is pure metadata (no image pull). desired_count=0 on the service
# means ECS never tries to pull. MYT-28's first CI run registers a new revision
# pointing at the real git-SHA tag + calls update-service --task-definition :N.
# No lifecycle block: AWS never destroys task-def revisions (they go INACTIVE);
# create_before_destroy would be cosmetic + misleading here.

locals {
  common_env = [
    { name = "NODE_ENV", value = var.environment },
    { name = "PORT", value = "3000" },
    { name = "AWS_REGION", value = "us-east-1" },
    { name = "REGION_PREFIX", value = "use1" },
    { name = "AUTH_MODE", value = "real" },
    # DB_* consistent across HOST/PORT/USER/NAME/PASSWORD. App constructs
    # DATABASE_URL at startup per Infra §2.3.
    { name = "DB_HOST", value = var.rds_host },
    { name = "DB_PORT", value = tostring(var.rds_port) },
    { name = "DB_USER", value = "mythrun_${var.environment}" },
    { name = "DB_NAME", value = "mythrun_${var.environment}" },
    # REDIS_* parallels DB_*.
    { name = "REDIS_HOST", value = var.redis_host },
    { name = "REDIS_PORT", value = tostring(var.redis_port) },
  ]

  # rds-password secret holds a plain string (bootstrap-databases.sh writes
  # --secret-string "$pw" without wrapping in JSON). Read as-is, not via
  # JSON path. Changing the secret to JSON would require a `:password::`
  # suffix on valueFrom.
  common_secrets = [
    { name = "ANTHROPIC_API_KEY", valueFrom = var.manual_secret_arns["anthropic-api-key"] },
    { name = "STRIPE_SECRET_KEY", valueFrom = var.manual_secret_arns["stripe-secret-key"] },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = var.manual_secret_arns["stripe-webhook-secret"] },
    { name = "COGNITO_CLIENT_SECRET", valueFrom = var.manual_secret_arns["cognito-client-secret"] },
    { name = "DB_PASSWORD", valueFrom = var.rds_password_secret_arn },
    { name = "REDIS_AUTH_TOKEN", valueFrom = var.shared_redis_auth_secret_arn },
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "mythrun-${var.environment}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${var.ecr_repository_url}:placeholder"
    essential = true

    command = ["node", "--max-old-space-size=768", "dist/server.js"]

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    environment = local.common_env
    secrets     = local.common_secrets

    stopTimeout = 120

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "ecs"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode===200?0:1))\""]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])

  tags = { Name = "mythrun-${var.environment}-api" }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "mythrun-${var.environment}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${var.ecr_repository_url}:placeholder"
    essential = true

    command = ["node", "--max-old-space-size=768", "dist/worker.js"]

    # No portMappings — worker isn't ALB-registered.

    environment = local.common_env
    secrets     = local.common_secrets

    stopTimeout = 120

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "ecs"
      }
    }
    # No container-level healthCheck — the worker spec calls for an internal
    # BullMQ+Redis pingable HTTP server on :3001, which doesn't exist yet.
    # Add when the worker has an actual implementation (Prep Pipeline milestone).
  }])

  tags = { Name = "mythrun-${var.environment}-worker" }
}

# ======== ALB Target Group ========

resource "aws_lb_target_group" "api" {
  name        = "mythrun-${var.environment}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip" # required for Fargate awsvpc
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    path                = "/health" # current backend endpoint; refactor to /health/ready when Backend Core lands (bead myth-nf3)
    protocol            = "HTTP"
    port                = "traffic-port"
    healthy_threshold   = 1 # per Infra §2.5: reduced from AWS default of 2 to shave ~15s off scale-out
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  deregistration_delay = 120 # matches ECS stopTimeout; in-flight LLM calls get grace
  slow_start           = 0   # explicitly disabled; non-zero slow_start conflicts with health_check_grace_period_seconds semantics
  # stickiness off (default) — session state lives in Redis

  tags = { Name = "mythrun-${var.environment}-api" }
}

# ======== ALB Listener Rule ========

resource "aws_lb_listener_rule" "api" {
  listener_arn = var.alb_listener_https_arn
  # Priority range 100-299 reserved for per-env API forward rules.
  # Lower numeric priority wins ALB rule evaluation. Prod wins if hosts ever
  # collide due to misconfig. Hosts normally don't overlap — priority is a
  # safety default.
  priority = var.environment == "production" ? 100 : 200

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [local.api_hostname]
    }
  }

  tags = { Name = "mythrun-${var.environment}-api-rule" }
}

# ======== ECS Services ========
# desired_count=0 at creation so the :placeholder image never gets pulled.
# MYT-28 flips to 1 with a real task-def revision (see bead myth-bcx runbook).
# ignore_changes = [desired_count, task_definition] keeps Terraform out of
# CI's way after first deploy — CI owns task counts and revisions.

resource "aws_ecs_service" "api" {
  name             = "mythrun-${var.environment}-api"
  cluster          = var.ecs_cluster_name
  task_definition  = aws_ecs_task_definition.api.arn
  launch_type      = "FARGATE"
  platform_version = "LATEST" # explicit per Infra §2.1; matches default
  desired_count    = 0        # MYT-28 bumps to 1 after first image push

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false # private subnet; egress via NAT
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 120s grace matches stopTimeout + deregistration_delay; gives real first-deploy
  # images headroom for startup migrations + secret fetch + DB pool warm-up.
  health_check_grace_period_seconds = 120

  lifecycle {
    ignore_changes = [
      desired_count,   # CI/CD owns task count
      task_definition, # CI/CD registers new revisions
    ]
  }

  depends_on = [aws_lb_listener_rule.api] # service registration fails if listener rule isn't ready

  tags = { Name = "mythrun-${var.environment}-api" }
}

resource "aws_ecs_service" "worker" {
  name             = "mythrun-${var.environment}-worker"
  cluster          = var.ecs_cluster_name
  task_definition  = aws_ecs_task_definition.worker.arn
  launch_type      = "FARGATE"
  platform_version = "LATEST"
  desired_count    = 0 # Prep Pipeline milestone bumps to 1 when real worker exists

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false
  }

  # No load_balancer block — worker isn't ALB-registered.

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }

  tags = { Name = "mythrun-${var.environment}-worker" }
}

# ======== Route 53 A-alias ========

resource "aws_route53_record" "api_alias" {
  zone_id = var.dns_zone_id
  name    = local.api_hostname
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id # NOT the Route 53 zone ID — it's the ALB's hosted zone ID
    evaluate_target_health = false           # ALB owns health; R53 health-checking would double-bill
  }
}
```

- [ ] **Step 4: Write `infra/modules/serving/outputs.tf`**

```hcl
output "api_service_arn" {
  value       = aws_ecs_service.api.id
  description = "ARN of the API ECS service."
}

output "worker_service_arn" {
  value       = aws_ecs_service.worker.id
  description = "ARN of the Worker ECS service."
}

output "target_group_arn" {
  value       = aws_lb_target_group.api.arn
  description = "ARN of the API target group (consumed by anything that needs to attach custom health checks or metrics)."
}

output "task_execution_role_arn" {
  value       = aws_iam_role.task_execution.arn
  description = "ARN of the task execution role (the role ECS uses to pull images + fetch secrets)."
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "ARN of the task role (the role the app itself runs as)."
}

output "api_hostname" {
  value       = local.api_hostname
  description = "Resolved hostname for this env's API (e.g. 'staging-api.mythrun.com')."
}
```

- [ ] **Step 5: Format the module**

Run from the repo root:

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && terraform -chdir=infra/modules/serving fmt
```

Expected: no output (files should already be canonical). If it prints filenames, those files were reformatted — fine.

- [ ] **Step 6: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add infra/modules/serving/
git commit -m "$(cat <<'EOF'
feat(infra): serving module — per-env ECS services + IAM + ALB target + DNS

New module infra/modules/serving/ for the per-env compute layer. Creates:

- CloudWatch log groups /mythrun/${env}/api + /mythrun/${env}/worker
- Task execution role with explicit per-ARN secret list (captures the
  cross-env mythrun/shared/redis-auth that a per-env wildcard would miss;
  explicitly excludes the rds!db-* master user secret since the app runs
  as the per-env mythrun_${env} user)
- Task role scoped to cloudwatch:PutMetricData on namespace Mythrun/${env}
- API + Worker task definitions (image pinned at :placeholder; CI owns
  the real revisions via ignore_changes=[task_definition] on services)
- ALB target group (target_type=ip for Fargate, healthy_threshold=1 per
  Infra §2.5, deregistration 120s, slow_start 0)
- Listener rule priority 100 (prod) / 200 (staging) with host-based
  routing (${env}-api.mythrun.com → target group)
- ECS services at desired_count=0 with ignore_changes=[desired_count,
  task_definition], deployment circuit breaker + rollback
- Route 53 A-alias ${env}-api.mythrun.com → ALB

Defaults match Week 0 §7.2's staging-size matrix (256/512). Production
workspace will override to 512/1024 explicitly at Launch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Do NOT push yet — the full MYT-30 sequence pushes once after Task 6.

---

## Task 2: Shared workspace additions (ECR + OIDC + ECS cluster + ALB + listeners)

**Goal:** Append the single-instance compute-platform resources to `infra/environments/shared/main.tf` and their outputs to `shared/outputs.tf`. `terraform init` + `terraform validate` should succeed.

**Files:**
- Modify: `infra/environments/shared/main.tf` (append to end)
- Modify: `infra/environments/shared/outputs.tf` (append to end)

### Steps

- [ ] **Step 1: Append compute-platform resources to `infra/environments/shared/main.tf`**

Open the file. It currently ends at line 23 (`module "dns"` close + blank). Append this block:

```hcl

# ======== ECR Repository ========
# Single repo for both envs (tag-based differentiation per Infra §4.2). Image
# is shared between API + Worker — they use the same image with different CMD
# overrides in task defs. MUTABLE, not IMMUTABLE, because CI pushes :latest
# alongside :$GIT_SHA; IMMUTABLE would reject the second :latest push.
# Git-SHA tag immutability is a CI-discipline concern (never re-push the
# same SHA tag).

resource "aws_ecr_repository" "mythrun" {
  name                 = "mythrun"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "mythrun" }
}

resource "aws_ecr_lifecycle_policy" "mythrun" {
  repository = aws_ecr_repository.mythrun.name

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
        description  = "Keep 20 most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}

# ======== GitHub Actions OIDC Provider ========
# One per AWS account. Both staging and future prod IAM roles trust this
# provider. thumbprint_list is omitted — it's Optional in AWS provider v6.x,
# and AWS has done native JWK discovery for GitHub's OIDC endpoint since 2023.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  tags = { Name = "github-actions-oidc" }
}

# ======== ECS Cluster ========
# One cluster shared across envs — per-env services live inside it.
# containerInsights disabled — saves ~$2.50/task/month. MYT-28 first-deploy
# debugging will rely on raw CloudWatch Logs + describe-tasks output.

resource "aws_ecs_cluster" "main" {
  name = "mythrun"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = { Name = "mythrun" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]
  # No FARGATE_SPOT — spec punts on spot until real cost pressure arrives.

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# ======== Application Load Balancer ========
# Single ALB shared across envs. Host-based listener rules (in the per-env
# serving module) route to per-env target groups. Lives in public subnets;
# SG is alb_sg_id from the network module. deletion_protection = true
# because the ALB serves both staging and future prod — accidental teardown
# kills both. Explicit flip to false required to destroy.

resource "aws_lb" "main" {
  name               = "mythrun-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [module.network.alb_sg_id]
  subnets            = module.network.public_subnet_ids

  idle_timeout               = 3600 # 1 hour for WebSocket keepalive tolerance
  enable_deletion_protection = true
  enable_http2               = true
  drop_invalid_header_fields = true # defense against header smuggling / RFC 7230 violations
  # access_logs — deferred to Observability spec (see bead for ALB access logs bucket)

  tags = { Name = "mythrun-alb" }
}

# HTTPS listener — the real traffic listener. Default action returns 404;
# per-env listener rules (in serving module) forward matching hosts to env
# target groups.

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06" # TLS 1.3 preferred, TLS 1.2 fallback, PFS-only ciphers
  certificate_arn   = module.dns.wildcard_cert_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "Not Found"
    }
  }

  tags = { Name = "mythrun-alb-https" }
}

# HTTP listener — permanent redirect to HTTPS. Never serves real traffic.

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }

  tags = { Name = "mythrun-alb-http-redirect" }
}
```

- [ ] **Step 2: Append outputs to `infra/environments/shared/outputs.tf`**

Open the file. It currently ends at line 66. Append this block:

```hcl

# ======== Compute-platform outputs (added by MYT-30) ========
# Consumed by staging (and future production) workspaces via
# data.terraform_remote_state.shared.

output "ecr_repository_url" {
  value       = aws_ecr_repository.mythrun.repository_url
  description = "ECR repo URL like '862127484110.dkr.ecr.us-east-1.amazonaws.com/mythrun'."
}

output "ecs_cluster_name" {
  value       = aws_ecs_cluster.main.name
  description = "Name of the shared ECS cluster ('mythrun')."
}

output "alb_arn" {
  value       = aws_lb.main.arn
  description = "ARN of the shared ALB."
}

output "alb_dns_name" {
  value       = aws_lb.main.dns_name
  description = "ALB's public DNS name (target for Route 53 A-alias records)."
}

output "alb_zone_id" {
  value       = aws_lb.main.zone_id
  description = "ALB's hosted zone ID (for Route 53 A-alias; NOT a Route 53 zone_id)."
}

output "alb_listener_https_arn" {
  value       = aws_lb_listener.https.arn
  description = "ARN of the HTTPS listener (per-env serving modules attach listener_rules here)."
}

output "github_oidc_provider_arn" {
  value       = aws_iam_openid_connect_provider.github.arn
  description = "ARN of the GitHub OIDC provider (per-env GH Actions IAM roles trust this)."
}
```

- [ ] **Step 3: Format**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && terraform -chdir=infra/environments/shared fmt
```

Expected: no output or reformatted filenames printed. No errors.

- [ ] **Step 4: `terraform init` (picks up any needed provider updates)**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/shared
terraform init
cd -
```

Expected: "Terraform has been successfully initialized!" No new providers expected (all already in lock file from MYT-25/26).

- [ ] **Step 5: `terraform validate`**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/shared
terraform validate
cd -
```

Expected: `Success! The configuration is valid.`

If validation fails, fix the reported error inline and re-run. Most likely failure mode: typo in an attribute name (check against AWS provider v6.x docs).

- [ ] **Step 6: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add infra/environments/shared/main.tf infra/environments/shared/outputs.tf
git commit -m "$(cat <<'EOF'
feat(infra): shared workspace — ECR + OIDC + ECS cluster + ALB + listeners

Appends single-instance compute-platform resources to the shared workspace:

- ECR repo 'mythrun' (MUTABLE, tag-immutable by CI discipline, 20-keep
  lifecycle, 1-day untagged expiry, scan_on_push, AES256)
- GitHub OIDC provider (thumbprint_list omitted — AWS v6 provider
  defaults are correct for github.com)
- ECS cluster 'mythrun' (Fargate only, containerInsights disabled,
  FARGATE default capacity provider)
- ALB 'mythrun-alb' (public, TLS 1.3 policy, idle_timeout=3600 for
  WebSocket keepalive, deletion_protection=true, drop_invalid_header_fields,
  HTTP/2 on)
- HTTPS listener :443 with *.mythrun.com wildcard cert; default action
  fixed-response 404
- HTTP listener :80 → permanent redirect to HTTPS (301)

New outputs: ecr_repository_url, ecs_cluster_name, alb_arn, alb_dns_name,
alb_zone_id, alb_listener_https_arn, github_oidc_provider_arn.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Do NOT push yet.

---

## Task 3: Apply shared workspace (Miklos approval gate)

**Goal:** `terraform apply` on the shared workspace creates the ECR repo + OIDC provider + ECS cluster + ALB + both listeners. ~10 new resources. Under a minute.

**Billing impact:** ~$16/mo idle for the ALB begins on apply. ECR storage is pennies, ECS cluster is free, listeners are free, OIDC provider is free.

### Steps

- [ ] **Step 1: Verify AWS credentials are current**

```bash
aws sts get-caller-identity
```

Expected: returns the mythrun-admin IAM user in account `862127484110`. If this fails, refresh SSO or log in before proceeding.

- [ ] **Step 2: `terraform plan`**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/shared
terraform plan -out=shared-myt30.tfplan
cd -
```

Expected: `Plan: 10 to add, 0 to change, 0 to destroy.` The 10 new resources are:
1. `aws_ecr_repository.mythrun`
2. `aws_ecr_lifecycle_policy.mythrun`
3. `aws_iam_openid_connect_provider.github`
4. `aws_ecs_cluster.main`
5. `aws_ecs_cluster_capacity_providers.main`
6. `aws_lb.main`
7. `aws_lb_listener.https`
8. `aws_lb_listener.http_redirect`
9-10. (maybe aws_cloudwatch_log_group side effects or SG updates — if plan reports something else, verify it's expected)

If plan reports "No changes" — did Step 1/5/6 of Task 2 actually save the files? Re-check.

- [ ] **Step 3: Pause for Miklos approval**

Surface the plan summary to Miklos. This is the first gated apply of MYT-30. Miklos approves before proceeding.

- [ ] **Step 4: `terraform apply`**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/shared
terraform apply shared-myt30.tfplan
cd -
```

Expected: `Apply complete! Resources: 10 added, 0 changed, 0 destroyed.` Under a minute. ALB creation is the long pole (~30s).

- [ ] **Step 5: Spot-checks**

```bash
# ECR repo exists and is MUTABLE
aws ecr describe-repositories --repository-names mythrun \
  --query 'repositories[0].[repositoryName,imageTagMutability,imageScanningConfiguration.scanOnPush]' --output text
```

Expected: `mythrun MUTABLE True`

```bash
# ECS cluster is ACTIVE
aws ecs describe-clusters --clusters mythrun \
  --query 'clusters[0].[clusterName,status,capacityProviders]' --output text
```

Expected: `mythrun ACTIVE FARGATE`

```bash
# OIDC provider exists (gets a stable ARN; list and grep)
aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text
```

Expected: one line containing `oidc-provider/token.actions.githubusercontent.com`.

```bash
# ALB exists and has HTTPS listener
aws elbv2 describe-load-balancers --names mythrun-alb \
  --query 'LoadBalancers[0].[LoadBalancerName,State.Code,Scheme,DeletionProtection]' --output text
```

Expected: `mythrun-alb active internet-facing True` (DeletionProtection reads as True).

```bash
# HTTPS listener with TLS 1.3 policy
aws elbv2 describe-listeners --load-balancer-arn \
  $(aws elbv2 describe-load-balancers --names mythrun-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text) \
  --query 'Listeners[].[Port,Protocol,SslPolicy]' --output text
```

Expected: two lines — `443 HTTPS ELBSecurityPolicy-TLS13-1-2-2021-06` and `80 HTTP None`.

- [ ] **Step 6: Idempotency gate**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/shared
terraform plan -detailed-exitcode -out=/dev/null 2>&1 | tail -3
echo "exit=$?"
cd -
```

Expected: `No changes. Your infrastructure matches the configuration.` with `exit=0`. If it reports a diff, investigate before proceeding.

- [ ] **Step 7: Clean up the plan file**

```bash
rm /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/shared/shared-myt30.tfplan
```

- [ ] **Step 8: No commit needed** — the previous Task 2 commit covered the code; this task was apply-only.

---

## Task 4: Staging workspace additions (module call + GH Actions role + SNS topic)

**Goal:** Wire the serving module call in `staging/main.tf`, add the GitHub Actions IAM role with 5-condition OIDC trust, add the SNS alerts topic. New variables `github_repository_owner_id` + `alerts_email`. `terraform init` + `terraform validate` should succeed.

**Files:**
- Modify: `infra/environments/staging/variables.tf` (append)
- Modify: `infra/environments/staging/main.tf` (append)
- Modify: `infra/environments/staging/outputs.tf` (append)

### Steps

- [ ] **Step 1: Append variables to `infra/environments/staging/variables.tf`**

```hcl

variable "github_repository_owner_id" {
  description = "Numeric GitHub organization ID for 'mythrun'. Looked up via: curl -s https://api.github.com/orgs/mythrun | jq .id . Used in the OIDC trust policy's repository_owner_id condition — immune to org rename/reclaim attacks."
  type        = string
  default     = "274691930" # mythrun org (confirmed 2026-04-22 via GitHub API)
}

variable "alerts_email" {
  description = "Email address to subscribe to the staging alerts SNS topic. Must be confirmed by clicking the AWS confirmation link after apply."
  type        = string
  default     = "miklos.bowling@gmail.com"
}
```

- [ ] **Step 2: Append to `infra/environments/staging/main.tf`**

Open the file. It currently ends at line 60 (closing `}` of `aws_secretsmanager_secret.bootstrap_secrets`). Append this block:

```hcl

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

  # Staging uses module defaults (256/512, 14-day log retention) per Week 0 §7.2.
}

# ======== GitHub Actions IAM Role (staging-scoped) ========
# Trust policy hardens against:
#   - missing audience (aud must be sts.amazonaws.com)
#   - wrong repo (repository must be mythrun/mythrun)
#   - org rename/reclaim attacks (repository_owner_id is the numeric ID)
#   - wrong GitHub Environment (must be 'staging')
#   - wrong branch (must be main)
# All conditions are StringEquals — StringLike with no wildcards would behave
# identically today but invite silent broadening on a future refactor.

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
      variable = "token.actions.githubusercontent.com:repository_owner_id"
      values   = [var.github_repository_owner_id]
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
```

- [ ] **Step 3: Append outputs to `infra/environments/staging/outputs.tf`**

```hcl

# ======== MYT-30 serving-infra outputs ========

output "api_service_arn" {
  value       = module.serving.api_service_arn
  description = "ARN of the staging API ECS service."
}

output "worker_service_arn" {
  value       = module.serving.worker_service_arn
  description = "ARN of the staging Worker ECS service."
}

output "api_hostname" {
  value       = module.serving.api_hostname
  description = "Staging API hostname (staging-api.mythrun.com)."
}

output "target_group_arn" {
  value       = module.serving.target_group_arn
  description = "ARN of the staging API target group."
}

output "task_execution_role_arn" {
  value       = module.serving.task_execution_role_arn
  description = "ARN of the staging task execution role."
}

output "task_role_arn" {
  value       = module.serving.task_role_arn
  description = "ARN of the staging task role."
}

output "github_actions_role_arn" {
  value       = aws_iam_role.github_actions_staging.arn
  description = "ARN of the staging GitHub Actions IAM role (assumed via OIDC by main-branch deploys into the 'staging' GitHub Environment)."
}

output "alerts_topic_arn" {
  value       = aws_sns_topic.alerts.arn
  description = "ARN of the mythrun-staging-alerts SNS topic (CloudWatch alarms will publish here at Observability milestone)."
}
```

- [ ] **Step 4: Format**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && terraform -chdir=infra/environments/staging fmt
```

Expected: no output or reformatted filenames printed.

- [ ] **Step 5: `terraform init` (picks up the new module)**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/staging
terraform init
cd -
```

Expected: "Terraform has been successfully initialized!" Registers the new `../../modules/serving` module reference. Downloads no new providers.

- [ ] **Step 6: `terraform validate`**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/staging
terraform validate
cd -
```

Expected: `Success! The configuration is valid.`

Common failure modes:
- Missing shared output — verify Task 3 applied and shared state has all 7 new outputs (`terraform output` in shared dir).
- `manual_secret_arns` validation fails — check the `for k, v in aws_secretsmanager_secret.manual_secrets : k => v.arn` expression produces the four expected keys.
- Typo in a resource/attribute name — follow the error message.

Fix inline and re-run until green.

- [ ] **Step 7: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add infra/environments/staging/main.tf infra/environments/staging/variables.tf infra/environments/staging/outputs.tf
git commit -m "$(cat <<'EOF'
feat(infra): staging workspace — serving module + GH Actions role + SNS

Wires the per-env serving module call from shared remote state. Adds:

- module "serving" instantiation for staging (256/512, 14d logs)
- aws_iam_role.github_actions_staging with 5-condition OIDC trust:
  aud, repository, repository_owner_id (numeric, immune to rename/reclaim),
  environment=staging, ref=refs/heads/main — all StringEquals
- Inline policy: ECR repo-scoped push/pull, ECS UpdateService scoped by
  ecs:cluster to mythrun, RegisterTaskDefinition + DeregisterTaskDefinition
  ARN-scoped to mythrun-staging-* family, DescribeTaskDefinition on *
  (AWS API limitation), iam:PassRole on both task roles conditioned on
  iam:PassedToService=ecs-tasks.amazonaws.com. Intentionally omits
  rds:CreateDBSnapshot (prod-only scope per Infra §5.5).
- SNS topic mythrun-staging-alerts with alias/aws/sns KMS, email subscription
  (starts in PendingConfirmation until email click)

New variables: github_repository_owner_id (default 274691930 — mythrun org),
alerts_email (default miklos.bowling@gmail.com).

New outputs: api/worker service ARNs, api_hostname, target_group_arn, both
task role ARNs, github_actions_role_arn, alerts_topic_arn.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Do NOT push yet.

---

## Task 5: Apply staging workspace (Miklos approval gate)

**Goal:** `terraform apply` on staging creates everything the serving module produces + the GH Actions role + the SNS topic. ~15 new resources. Under a minute.

**Billing impact:** minimal — SNS topic free, IAM role free, CloudWatch log groups empty, ECS services at desired_count=0 = $0. The ~$16/mo ALB cost already landed in Task 3.

### Steps

- [ ] **Step 1: `terraform plan`**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/staging
terraform plan -out=staging-myt30.tfplan
cd -
```

Expected: `Plan: ~15 to add, 0 to change, 0 to destroy.`

The ~15 adds include:
- `module.serving.aws_cloudwatch_log_group.api` + `.worker` (2)
- `module.serving.aws_iam_role.task_execution` + `.task` (2)
- `module.serving.aws_iam_role_policy.task_execution_secrets` + `.task_cloudwatch_metrics` (2)
- `module.serving.aws_iam_role_policy_attachment.task_execution_baseline` (1)
- `module.serving.aws_ecs_task_definition.api` + `.worker` (2)
- `module.serving.aws_lb_target_group.api` (1)
- `module.serving.aws_lb_listener_rule.api` (1)
- `module.serving.aws_ecs_service.api` + `.worker` (2)
- `module.serving.aws_route53_record.api_alias` (1)
- `aws_iam_role.github_actions_staging` + `aws_iam_role_policy.github_actions_staging` (2)
- `aws_sns_topic.alerts` + `aws_sns_topic_subscription.alerts_email` (2)

Total: 18 (my count). If plan reports fewer, verify nothing was dropped.

- [ ] **Step 2: Pause for Miklos approval**

Surface the plan summary to Miklos. Second gated apply of MYT-30. Less risky than Task 3 (no ALB, no net-new AWS spend of note).

- [ ] **Step 3: `terraform apply`**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/staging
terraform apply staging-myt30.tfplan
cd -
```

Expected: `Apply complete! Resources: ~18 added, 0 changed, 0 destroyed.` Under a minute.

- [ ] **Step 4: Immediate spot-checks**

```bash
# ECS cluster shows 2 services registered, 0 running tasks
aws ecs describe-clusters --clusters mythrun \
  --query 'clusters[0].[clusterName,status,activeServicesCount,runningTasksCount]' --output text
```

Expected: `mythrun ACTIVE 2 0`

```bash
# Both services are ACTIVE with desiredCount=0
aws ecs describe-services --cluster mythrun \
  --services mythrun-staging-api mythrun-staging-worker \
  --query 'services[].[serviceName,status,desiredCount,runningCount]' --output table
```

Expected: both services `ACTIVE`, `desiredCount=0`, `runningCount=0`.

```bash
# Task definitions registered with the :placeholder image
aws ecs describe-task-definition --task-definition mythrun-staging-api \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

Expected: `862127484110.dkr.ecr.us-east-1.amazonaws.com/mythrun:placeholder`

```bash
# No plaintext secrets in the task definition JSON
aws ecs describe-task-definition --task-definition mythrun-staging-api \
  --query 'taskDefinition.containerDefinitions[0].secrets[*].[name,valueFrom]' --output table
```

Expected: six rows, each with the env-var name and a Secrets Manager ARN (starts with `arn:aws:secretsmanager:`). No plaintext values anywhere in the output.

```bash
# GH Actions role has the 5-condition trust policy
aws iam get-role --role-name mythrun-github-actions-staging \
  --query 'Role.AssumeRolePolicyDocument' --output json | jq '.Statement[0].Condition'
```

Expected: JSON with `StringEquals` block containing all five conditions (aud, repository, repository_owner_id, environment, ref).

```bash
# SNS topic exists with email subscription (status will be PendingConfirmation)
aws sns list-subscriptions-by-topic \
  --topic-arn $(aws sns list-topics --query "Topics[?contains(TopicArn, 'mythrun-staging-alerts')].TopicArn | [0]" --output text) \
  --query 'Subscriptions[0].[Protocol,Endpoint,SubscriptionArn]' --output text
```

Expected: `email miklos.bowling@gmail.com PendingConfirmation`

```bash
# Route 53 A-alias exists
aws route53 list-resource-record-sets \
  --hosted-zone-id $(aws route53 list-hosted-zones --query 'HostedZones[?Name==`mythrun.com.`].Id | [0]' --output text | cut -d/ -f3) \
  --query "ResourceRecordSets[?Name=='staging-api.mythrun.com.' && Type=='A'].AliasTarget.DNSName" --output text
```

Expected: the ALB's DNS name (e.g. `mythrun-alb-XXXXX.us-east-1.elb.amazonaws.com.`). Trailing dot is expected.

```bash
# TLS handshake reaches staging-api.mythrun.com and presents the wildcard cert
curl -v -s https://staging-api.mythrun.com/health 2>&1 | grep -E "^(\*|<)" | head -20
```

Expected: TLS handshake succeeds, subject `CN=*.mythrun.com` (or similar ACM-issued cert), then HTTP/1.1 503 Service Unavailable (no healthy targets — expected since `desired_count=0`). If TLS fails, check the ALB listener's cert attachment.

- [ ] **Step 5: Idempotency gate**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/staging
terraform plan -detailed-exitcode -out=/dev/null 2>&1 | tail -3
echo "exit=$?"
cd -
```

Expected: `No changes.` with `exit=0`.

If a drift is reported: common case is a parameter with a perpetual no-op diff (like MYT-25 saw with `rds.force_ssl apply_method`). Read the diff carefully. If the diff is `apply_method` only, add `apply_method = "pending-reboot"` or `"immediate"` explicitly to silence. Anything else — stop and investigate.

- [ ] **Step 6: Clean up the plan file**

```bash
rm /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/staging/staging-myt30.tfplan
```

- [ ] **Step 7: No commit needed** — Task 4 commit already covered the code.

---

## Task 6: Post-apply manual confirmation + final acceptance + close MYT-30

**Goal:** Miklos confirms the SNS email subscription, we run full acceptance against the design's "Done when" criteria, push, close MYT-30 in Linear.

### Steps

- [ ] **Step 1: Miklos clicks the SNS confirmation email**

Miklos checks `miklos.bowling@gmail.com` for an AWS-sent email with subject like "AWS Notification - Subscription Confirmation" from sns-confirmation@amazonaws.com. Clicks the "Confirm subscription" link. AWS responds with a confirmation page.

- [ ] **Step 2: Verify SNS subscription is confirmed**

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn $(aws sns list-topics --query "Topics[?contains(TopicArn, 'mythrun-staging-alerts')].TopicArn | [0]" --output text) \
  --query 'Subscriptions[0].SubscriptionArn' --output text
```

Expected: a real ARN (starts with `arn:aws:sns:us-east-1:...`), NOT the literal string `PendingConfirmation`.

- [ ] **Step 3: Full acceptance checklist against the design's Done-when**

Run each and verify:

```bash
# ECS cluster ACTIVE, 0 tasks, 2 services
aws ecs describe-clusters --clusters mythrun \
  --query 'clusters[0].[status,runningTasksCount,activeServicesCount]' --output text
```
✅ Expected: `ACTIVE 0 2`

```bash
# Both services ACTIVE with desiredCount=0
aws ecs describe-services --cluster mythrun \
  --services mythrun-staging-api mythrun-staging-worker \
  --query 'services[].[status,desiredCount]' --output text
```
✅ Expected: `ACTIVE 0\nACTIVE 0`

```bash
# ALB returns 503 at /health (no healthy targets, as designed) and presents a valid TLS cert
curl -sS -o /dev/null -w "HTTP %{http_code}\n" https://staging-api.mythrun.com/health
```
✅ Expected: `HTTP 503`

```bash
# GH Actions role trust policy has 5 StringEquals conditions
aws iam get-role --role-name mythrun-github-actions-staging \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals' --output json
```
✅ Expected: JSON with 5 keys (aud, repository, repository_owner_id, environment, ref).

```bash
# ECR is MUTABLE
aws ecr describe-repositories --repository-names mythrun \
  --query 'repositories[0].imageTagMutability' --output text
```
✅ Expected: `MUTABLE`

```bash
# Task def has no plaintext secrets
aws ecs describe-task-definition --task-definition mythrun-staging-api \
  --query 'taskDefinition.containerDefinitions[0].environment[*].value' --output text | grep -iE "sk_|whsec_|anthropic|stripe|password" && echo "LEAK FOUND" || echo "no leaks in environment"
```
✅ Expected: `no leaks in environment`

```bash
# Idempotency — both workspaces report no changes
(cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/shared && terraform plan -detailed-exitcode > /tmp/shared-idem.txt 2>&1; echo "shared exit=$?")
(cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/infra/environments/staging && terraform plan -detailed-exitcode > /tmp/staging-idem.txt 2>&1; echo "staging exit=$?")
```
✅ Expected: both `exit=0`, both reports contain `No changes`.

- [ ] **Step 4: Push to origin**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git push origin main
```

Expected: pushes the Task 1, Task 2, and Task 4 commits to `origin/main`.

- [ ] **Step 5: Close MYT-30 in Linear**

Use the Linear MCP tool from the controlling session:

```
mcp__linear-server__save_issue
  id: MYT-30
  state: Done
```

- [ ] **Step 6: Mark the T9-equivalent bead (if any exists) and the MYT-30 decomposition beads as closed**

If the plan was decomposed into beads (Tasks 1-6 as beads), close them:

```bash
bd ready  # check state
bd close <bead-id-for-each-task>
```

- [ ] **Step 7: Final status message to Miklos**

Summarize what shipped, cost delta, follow-up beads that are now unblocked (especially `myth-bcx` MYT-28 first-deploy runbook), and suggest the next Linear issue (MYT-28 is the natural next pickup — CI/CD + first staging deploy, which is the end-to-end test of everything MYT-30 authored).

---

## Summary

6 tasks, all TDD-ordered (validate = failing test for each apply, apply = green). Two Miklos-gated applies. Roughly half a day end-to-end if run sequentially with review; ~2 hours if the implementer is working cleanly.

**Key risks documented:**
- ALB creation is the long pole on Task 3 (~30s).
- First-deploy sequence in MYT-28 requires the runbook bead `myth-bcx` — this plan does NOT cover MYT-28's work.
- `environment = "staging"` condition in the OIDC trust needs a GitHub Environment named "staging" on mythrun/mythrun before MYT-28's CI can assume the role (MYT-28 sets this up).
- SNS subscription confirmation is out-of-band (Miklos clicks email); Task 6 Step 1.

**Cost delta:** +$16/mo idle (ALB). Total idle after MYT-30 ≈ $83/mo.

---

## Self-review checklist

Before handing off to execution:

- [x] Every resource in the design spec has a corresponding task step.
- [x] No "TBD", "TODO", "see design for…", or "similar to Task N" placeholders — every code block has complete verbatim HCL.
- [x] Resource names are consistent across tasks (`mythrun-${env}-api` etc.).
- [x] Variable names match between module and caller (`shared_redis_auth_secret_arn`, `manual_secret_arns`, etc.).
- [x] The `:placeholder` image tag is consistent in both API and Worker task defs.
- [x] OIDC trust has all 5 StringEquals conditions with exact values.
- [x] `iam:PassRole` has the `iam:PassedToService` condition.
- [x] ECS mutating actions are scoped with `ecs:cluster` condition.
- [x] RegisterTaskDefinition + DeregisterTaskDefinition are ARN-scoped.
- [x] No `rds:CreateDBSnapshot` on the staging GH role.
- [x] Task defs have NO `lifecycle` block (no `create_before_destroy`).
- [x] ECS services have `lifecycle { ignore_changes = [desired_count, task_definition] }`.
- [x] Env vars use `DB_HOST`/`DB_PORT` (not `RDS_HOST`/`RDS_PORT`).
- [x] `rds_password_secret_arn` is read as a plain string (no JSON-path suffix on valueFrom).
- [x] Worker task def has NO `healthCheck` block.
- [x] Listener rule priority is 100 (prod) / 200 (staging).
- [x] Target group `healthy_threshold = 1`, `slow_start = 0`.
- [x] ECS service `health_check_grace_period_seconds = 120`, `platform_version = "LATEST"`.
- [x] Container `startPeriod = 60`.
- [x] ALB `enable_deletion_protection = true`.
- [x] ECR `image_tag_mutability = "MUTABLE"`.
- [x] OIDC provider has no `thumbprint_list`.
- [x] SNS topic has `kms_master_key_id = "alias/aws/sns"`.
- [x] `manual_secret_arns` variable has a validation block.
- [x] Idempotency gate runs in both Task 3 and Task 5.
- [x] Acceptance criteria match the design's Done-when verbatim.
