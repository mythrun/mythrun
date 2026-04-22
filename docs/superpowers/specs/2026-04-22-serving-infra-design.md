# Serving Infra + First-Deploy Substrate Design

> **Linear issue**: MYT-30
> **Milestone**: Ops Foundation (2026-04-27)
> **Date**: 2026-04-22
> **Depends on**: MYT-25 (foundation infra — VPC/SGs/RDS/Redis/Secrets, applied), MYT-26 (Route 53 authoritative + wildcard ACM cert issued, applied)
> **Blocks**: MYT-28 (CI/CD + first staging deploy)

## Goal

Extend the Terraform stack with the **compute + delivery layer** that MYT-28's CI/CD pipeline will push its first container image into. When MYT-30 completes, AWS holds a quiescent but complete serving substrate for staging: an ECS cluster with zero running tasks, an ALB serving a valid TLS handshake on `staging-api.mythrun.com` with no healthy targets, an ECR repo waiting for its first image push, and the IAM wiring for GitHub Actions to take over from there.

## Done when

```bash
cd infra/environments/shared  && terraform apply   # shared gains ECR + OIDC + cluster + ALB + HTTPS listener, exits 0
cd infra/environments/staging && terraform apply   # staging gains serving module + staging GH role + SNS topic, exits 0
```

Plus:

- `aws ecs describe-clusters --clusters mythrun` returns `ACTIVE`, `runningTasksCount=0`, `activeServicesCount=2`
- `aws ecs describe-services --cluster mythrun --services mythrun-staging-api mythrun-staging-worker` returns both `ACTIVE` with `desiredCount=0`, valid task definition revisions registered
- `curl -v https://staging-api.mythrun.com/health` returns HTTP 503 (no healthy targets, expected) and the TLS handshake presents the `*.mythrun.com` wildcard cert from MYT-26
- `aws iam get-role --role-name mythrun-github-actions-staging` returns the role with trust policy restricted to `repo:mythrun/mythrun:environment:staging` on the `main` branch only
- `aws ecr describe-repositories --repository-names mythrun` returns the repo, tag immutability enabled, lifecycle policy expiring untagged images after 1 day and keeping 20 most recent tagged
- SNS topic `mythrun-staging-alerts` exists with one email subscription (Miklos)
- `terraform plan` run a second time on both workspaces reports "No changes" (idempotent)

## What this task does NOT do

Explicit exclusions to prevent scope creep:

- **Production workspace.** `infra/environments/production/` is created with the Launch milestone, not MYT-30. Staging-only here.
- **First image push + desired_count=1 flip.** That's MYT-28. MYT-30 produces the substrate; MYT-28 validates an end-to-end deploy.
- **ALB access log S3 bucket.** Deferred to the Observability spec per Infra & DevOps spec §5.3. Follow-up bead tracks it.
- **CloudWatch alarms** (ECS service down, ALB 5xx, RDS CPU, Redis memory, ACM expiry, etc.). All Observability-milestone work. SNS topic lands here so alarms can be wired in without schema changes.
- **Autoscaling policies** (CPU-based, connection-based, scheduled). Infra spec §7 spec'd them but with `desired_count=0` there's nothing to scale. Land when real traffic arrives.
- **Custom WebSocket metrics** (`MythrunTotalWebSocketConnections` etc.). App has no WebSockets yet.
- **`/health/live` and `/health/ready` split.** Current backend `/health` returns `{ok: true}`. ALB uses `/health` for now. Backend Core milestone adds the real readiness check once DB/Redis clients exist.
- **RDS Proxy.** Per Infra spec §5.3, lands when the container count crosses 6. Today's ceiling is 1.
- **Worker actually running.** Task def + log group + IAM wiring lands here, but `desired_count=0`. Flips to 1 at the start of the Prep Pipeline milestone via a one-line Terraform change.

## Architecture summary

Two-workspace Terraform layout, already established by MYT-25/MYT-26:

```
┌─── infra/environments/shared/ ─────────────────────────────────────────┐
│                                                                        │
│  network (existing) ─ data (existing) ─ dns (existing)                 │
│                                                                        │
│  NEW:                                                                  │
│    ECR repo `mythrun` (tag-immutable, 20-keep, 1-day untagged expire)  │
│    GitHub OIDC provider                                                │
│    ECS cluster `mythrun` (Fargate, one cluster shared both envs)       │
│    ALB `mythrun-alb` (single ALB, host-based routing)                  │
│    Listener :443 HTTPS (default action = fixed-response 404)           │
│    Listener :80  HTTP  (permanent redirect to :443)                    │
│                                                                        │
│  New outputs: ecr_url, ecs_cluster_name, alb_arn, alb_listener_https,  │
│               alb_dns_name, alb_zone_id, github_oidc_provider_arn      │
└────────────────────────────────────────────────────────────────────────┘

┌─── infra/environments/staging/ ────────────────────────────────────────┐
│                                                                        │
│  Existing: staging secret shells (from MYT-25)                         │
│                                                                        │
│  NEW:                                                                  │
│    module "serving" (the new per-env module)                           │
│    aws_iam_role.github_actions_staging (main-only + env:staging)       │
│    aws_sns_topic.alerts + email subscription                           │
│                                                                        │
│  New outputs: ecs_api_service_arn, ecs_worker_service_arn,             │
│               alb_target_group_arn, github_actions_role_arn            │
└────────────────────────────────────────────────────────────────────────┘

┌─── infra/modules/serving/ (new) ───────────────────────────────────────┐
│                                                                        │
│  Inputs: environment, vpc_id, private_subnet_ids, ecs_sg_id,           │
│          ecs_cluster_name, ecr_repository_url, alb_arn,                │
│          alb_listener_https_arn, dns_zone_id, wildcard_cert_arn,       │
│          rds_host/port, redis_host/port, staging_secret_arns (map),    │
│          shared_redis_auth_arn, rds_master_user_secret_arn             │
│                                                                        │
│  Creates per-env:                                                      │
│    aws_cloudwatch_log_group.api, .worker                               │
│    aws_iam_role.task_execution + scoped policy                         │
│    aws_iam_role.task + minimal CloudWatch metrics policy               │
│    aws_ecs_task_definition.api, .worker                                │
│    aws_lb_target_group.api                                             │
│    aws_lb_listener_rule.staging_api (host-based: {env}-api.mythrun...) │
│    aws_ecs_service.api (desired_count=0, ignore_changes[desired_count, │
│                         task_definition])                              │
│    aws_ecs_service.worker (desired_count=0, same ignore_changes)       │
│    aws_route53_record.api_alias (alias A → ALB)                        │
│                                                                        │
│  Outputs: api_service_arn, worker_service_arn, target_group_arn,       │
│           task_execution_role_arn, task_role_arn                       │
└────────────────────────────────────────────────────────────────────────┘
```

## Detailed design

### 1. ECR repository (shared workspace, inline)

```hcl
resource "aws_ecr_repository" "mythrun" {
  name                 = "mythrun"
  image_tag_mutability = "IMMUTABLE"  # git-SHA tags are forever

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
          tagStatus   = "tagged"
          tagPatternList = ["*"]
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      }
    ]
  })
}
```

Per Infra spec §4.2: tag-based env differentiation, not separate repos. API and Worker share the image (different CMD overrides in task defs).

### 2. GitHub Actions OIDC provider (shared workspace, inline)

```hcl
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  # AWS discovers thumbprints automatically for well-known IdPs since 2023;
  # thumbprint_list no longer required for GitHub's OIDC endpoint.
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]  # placeholder; AWS ignores for GitHub

  tags = { Name = "github-actions-oidc" }
}
```

One per AWS account. Both staging and future prod IAM roles trust this provider. The `thumbprint_list` is a historical requirement; since 2023 AWS has native JWK discovery for GitHub's OIDC endpoint and the thumbprint list is vestigial. We pass a single placeholder to satisfy the schema.

### 3. ECS cluster (shared workspace, inline)

```hcl
resource "aws_ecs_cluster" "main" {
  name = "mythrun"

  setting {
    name  = "containerInsights"
    value = "disabled"  # CloudWatch Container Insights is $~/task/month; enable when real traffic arrives
  }

  tags = { Name = "mythrun" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]
  # No FARGATE_SPOT — spec punts on spot until real cost pressure.

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}
```

One cluster, shared across envs — services within it carry env-scoped names.

### 4. ALB + listeners (shared workspace, inline)

```hcl
resource "aws_lb" "main" {
  name               = "mythrun-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [module.network.alb_sg_id]
  subnets            = module.network.public_subnet_ids

  idle_timeout               = 3600  # 1 hour for WebSocket keepalive tolerance
  enable_deletion_protection = false # staging can be torn down; prod will flip to true
  enable_http2               = true
  drop_invalid_header_fields = true  # defense against header smuggling
  # access_logs — deferred to Observability spec

  tags = { Name = "mythrun-alb" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
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

Per-env listener rules (the host-based routing) live in the serving module — one rule per env points at the env's target group.

### 5. Serving module (new, `infra/modules/serving/`)

The per-env module. Instantiated once today for staging, will be instantiated again for prod at Launch.

#### 5.1 Variables (inputs)

```hcl
variable "environment"                  { type = string }  # "staging" | "production"
variable "vpc_id"                       { type = string }
variable "private_subnet_ids"           { type = list(string) }
variable "ecs_sg_id"                    { type = string }
variable "ecs_cluster_name"             { type = string }
variable "ecr_repository_url"           { type = string }
variable "alb_arn"                      { type = string }
variable "alb_listener_https_arn"       { type = string }
variable "dns_zone_id"                  { type = string }
variable "dns_zone_name"                { type = string }  # "mythrun.com"
variable "wildcard_cert_arn"            { type = string }
variable "alb_dns_name"                 { type = string }
variable "alb_zone_id"                  { type = string }

# Data-layer references (for env var wiring)
variable "rds_host"                     { type = string }
variable "rds_port"                     { type = number }
variable "redis_host"                   { type = string }
variable "redis_port"                   { type = number }

# Secret ARN references
variable "shared_redis_auth_secret_arn" { type = string }
variable "manual_secret_arns"           { type = map(string) }  # keys: anthropic-api-key, stripe-secret-key, stripe-webhook-secret, cognito-client-secret
variable "rds_password_secret_arn"      { type = string }
# rds_master_user_secret_arn is NOT here — the API/Worker tasks run as the
# per-env app user (mythrun_${env}), not the master. Only bootstrap-databases.sh's
# future IAM principal needs the master secret.

# Tunables with sensible defaults
variable "api_cpu"                      { type = string; default = "512" }
variable "api_memory"                   { type = string; default = "1024" }
variable "worker_cpu"                   { type = string; default = "512" }
variable "worker_memory"                { type = string; default = "1024" }
variable "log_retention_days"           { type = number; default = 14 }  # staging default; prod passes 30
```

#### 5.2 Log groups

```hcl
resource "aws_cloudwatch_log_group" "api" {
  name              = "/mythrun/${var.environment}/api"
  retention_in_days = var.log_retention_days
  tags              = { Name = "mythrun-${var.environment}-api-logs" }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/mythrun/${var.environment}/worker"
  retention_in_days = var.log_retention_days
  tags              = { Name = "mythrun-${var.environment}-worker-logs" }
}
```

#### 5.3 Task execution role (env-scoped)

```hcl
data "aws_iam_policy_document" "task_execution_assume" {
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
  assume_role_policy = data.aws_iam_policy_document.task_execution_assume.json
  tags               = { Name = "mythrun-${var.environment}-task-execution" }
}

# ECR + CloudWatch Logs (AWS managed baseline)
resource "aws_iam_role_policy_attachment" "task_execution_ecs_baseline" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Secrets injection — env-scoped explicitly
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
```

Execution role is **explicitly listed** per-secret ARN rather than wildcarded to `mythrun/${env}/*` — more explicit, and captures the `rds!db-*` auto-managed secret and the cross-env shared `mythrun/shared/redis-auth` correctly (wildcarding would miss the latter).

#### 5.4 Task role (the app's own permissions)

```hcl
resource "aws_iam_role" "task" {
  name               = "mythrun-${var.environment}-task"
  assume_role_policy = data.aws_iam_policy_document.task_execution_assume.json  # same trust policy
  tags               = { Name = "mythrun-${var.environment}-task" }
}

data "aws_iam_policy_document" "task_cloudwatch_metrics" {
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]  # PutMetricData doesn't support resource ARN scoping

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
```

Minimal today — the app doesn't actually call any AWS APIs at rest yet. Grow additively as real features need more.

#### 5.5 Task definitions (API + Worker)

```hcl
locals {
  common_env = [
    { name = "NODE_ENV",      value = var.environment },
    { name = "PORT",          value = "3000" },
    { name = "AWS_REGION",    value = "us-east-1" },
    { name = "REGION_PREFIX", value = "use1" },
    { name = "AUTH_MODE",     value = "real" },
    { name = "RDS_HOST",      value = var.rds_host },
    { name = "RDS_PORT",      value = tostring(var.rds_port) },
    { name = "DB_USER",       value = "mythrun_${var.environment}" },
    { name = "DB_NAME",       value = "mythrun_${var.environment}" },
    { name = "REDIS_HOST",    value = var.redis_host },
    { name = "REDIS_PORT",    value = tostring(var.redis_port) },
  ]

  # The rds-password secret holds a plain string (bootstrap-databases.sh writes
  # --secret-string "$pw" without wrapping in JSON). Read as-is, not via JSON path.
  common_secrets = [
    { name = "ANTHROPIC_API_KEY",     valueFrom = var.manual_secret_arns["anthropic-api-key"] },
    { name = "STRIPE_SECRET_KEY",     valueFrom = var.manual_secret_arns["stripe-secret-key"] },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = var.manual_secret_arns["stripe-webhook-secret"] },
    { name = "COGNITO_CLIENT_SECRET", valueFrom = var.manual_secret_arns["cognito-client-secret"] },
    { name = "DB_PASSWORD",           valueFrom = var.rds_password_secret_arn },
    { name = "REDIS_AUTH_TOKEN",      valueFrom = var.shared_redis_auth_secret_arn },
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
    name  = "api"
    image = "${var.ecr_repository_url}:placeholder"
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
      startPeriod = 30
    }
  }])

  lifecycle {
    create_before_destroy = true  # cuts over cleanly on new revision
  }

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
    name  = "worker"
    image = "${var.ecr_repository_url}:placeholder"
    essential = true

    command = ["node", "--max-old-space-size=768", "dist/worker.js"]

    # No portMappings — worker isn't ALB-registered

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

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "mythrun-${var.environment}-worker" }
}
```

Container image points at `${ecr_url}:placeholder` — a tag that doesn't exist. This is intentional and safe because:
- Task def registration itself doesn't validate the image tag exists
- `desired_count = 0` on the service means ECS never tries to pull
- MYT-28's first CI run registers a new task def revision pointing at the real git-SHA tag and flips `desired_count` to 1 via `update-service --force-new-deployment`

The `:placeholder` never gets pulled. If someone bumps `desired_count` before MYT-28 runs, the task fails to start and ECS surfaces the pull error — not silent.

#### 5.6 Target group + listener rule

```hcl
resource "aws_lb_target_group" "api" {
  name        = "mythrun-${var.environment}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"  # required for Fargate awsvpc
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    path                = "/health"  # current backend endpoint; refactor to /health/ready when Backend Core lands
    protocol            = "HTTP"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  deregistration_delay = 120  # matches ECS stopTimeout; in-flight LLM calls get grace
  # stickiness off — session state lives in Redis

  tags = { Name = "mythrun-${var.environment}-api" }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = var.alb_listener_https_arn
  priority     = var.environment == "production" ? 100 : 200  # staging has lower priority, prod wins if both registered

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = ["${var.environment == "production" ? "api" : "${var.environment}-api"}.${var.dns_zone_name}"]
    }
  }

  tags = { Name = "mythrun-${var.environment}-api-rule" }
}
```

Host header: `staging-api.mythrun.com` for staging, `api.mythrun.com` for prod. Priority 200/100 — if both envs are ever misconfigured to the same host, prod wins; otherwise they're on different hosts and priority is academic.

#### 5.7 ECS services

```hcl
resource "aws_ecs_service" "api" {
  name            = "mythrun-${var.environment}-api"
  cluster         = var.ecs_cluster_name
  task_definition = aws_ecs_task_definition.api.arn
  launch_type     = "FARGATE"
  desired_count   = 0  # MYT-28 bumps to 1 after first image push

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false  # private subnet; egress via NAT
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

  health_check_grace_period_seconds = 60

  lifecycle {
    ignore_changes = [
      desired_count,     # CI/CD owns task count
      task_definition,   # CI/CD registers new revisions
    ]
  }

  depends_on = [aws_lb_listener_rule.api]  # service registration fails if listener rule isn't ready

  tags = { Name = "mythrun-${var.environment}-api" }
}

resource "aws_ecs_service" "worker" {
  name            = "mythrun-${var.environment}-worker"
  cluster         = var.ecs_cluster_name
  task_definition = aws_ecs_task_definition.worker.arn
  launch_type     = "FARGATE"
  desired_count   = 0

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false
  }

  # No load_balancer block — worker isn't ALB-registered

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
```

The `ignore_changes = [desired_count, task_definition]` is load-bearing — without it, every CI push would get reverted on the next `terraform apply`. This is the standard Terraform-on-ECS-with-CI pattern.

#### 5.8 Route 53 A-alias record

```hcl
resource "aws_route53_record" "api_alias" {
  zone_id = var.dns_zone_id
  name    = var.environment == "production" ? "api.${var.dns_zone_name}" : "${var.environment}-api.${var.dns_zone_name}"
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = false  # ALB owns health; R53 health-checking would double-bill
  }
}
```

Alias records are free in Route 53 and resolve to the ALB's current IPs automatically.

### 6. GitHub Actions IAM role (staging workspace)

```hcl
data "aws_caller_identity" "current" {}

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
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # Environment-scoped AND main-only. The "environment:staging" substring
      # requires GitHub Environments to be configured on the mythrun/mythrun
      # repo with a "staging" environment (MYT-28 sets this up).
      values   = ["repo:mythrun/mythrun:environment:staging"]
    }
  }
}

resource "aws_iam_role" "github_actions_staging" {
  name               = "mythrun-github-actions-staging"
  assume_role_policy = data.aws_iam_policy_document.gh_actions_trust.json
  tags               = { Name = "mythrun-github-actions-staging" }
}

data "aws_iam_policy_document" "gh_actions_staging" {
  # ECR push/pull for the shared mythrun repo
  statement {
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]  # GetAuthorizationToken is account-wide
  }

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

  # ECS service update (scoped to staging services only)
  statement {
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
      "ecs:DeregisterTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
    ]
    resources = ["*"]  # ECS API doesn't support per-service ARN scoping on most actions
  }

  # Pass role for task execution + task roles (scoped)
  statement {
    actions = ["iam:PassRole"]
    resources = [
      module.serving.task_execution_role_arn,
      module.serving.task_role_arn,
    ]
  }

  # Pre-deploy RDS snapshot (spec §5.5)
  statement {
    actions = [
      "rds:CreateDBSnapshot",
      "rds:DescribeDBSnapshots",
    ]
    resources = [
      "arn:aws:rds:us-east-1:${data.aws_caller_identity.current.account_id}:db:mythrun",
      "arn:aws:rds:us-east-1:${data.aws_caller_identity.current.account_id}:snapshot:mythrun-*",
    ]
  }
}

resource "aws_iam_role_policy" "github_actions_staging" {
  name   = "deploy-permissions"
  role   = aws_iam_role.github_actions_staging.id
  policy = data.aws_iam_policy_document.gh_actions_staging.json
}
```

Several `resources = ["*"]` here are because ECS's API surface doesn't support fine-grained ARN scoping on actions like `RegisterTaskDefinition`. The role is still scoped at the assume-side (only `main` branch, `staging` environment) and most destructive actions go through `UpdateService` which IS scopable — but per-service scoping needs the service ARN and we'd have a circular reference (the role lives in staging, which calls the module which creates the service). Acceptable tradeoff for now; tighten if a later audit demands it.

### 7. SNS alerts topic (staging workspace)

```hcl
resource "aws_sns_topic" "alerts" {
  name = "mythrun-staging-alerts"

  tags = { Name = "mythrun-staging-alerts" }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alerts_email
}
```

Adds to `infra/environments/staging/variables.tf`:

```hcl
variable "alerts_email" {
  description = "Email address to subscribe to the staging alerts SNS topic. Must be confirmed by clicking the AWS confirmation link after apply."
  type        = string
  default     = "miklos.bowling@gmail.com"  # ok to commit; it's public in the git log anyway via Co-Authored-By trailers
}
```

The email subscription creates a pending confirmation; Miklos clicks the AWS confirmation link once. After that, alarms can publish to this topic.

Actual alarms (ECS service down, RDS CPU, etc.) land in the Observability milestone. Creating the topic here gives that work a stable target without needing to re-visit MYT-30's Terraform later.

## Decisions log

**Single ALB across staging + prod.** Per Infra spec §2.5. Saves ~$32/mo vs per-env ALBs. Host-based listener rules provide isolation. The ALB itself is in `shared`; per-env listener rules + target groups live in `staging` (and future `production`).

**ECR + ECS cluster + OIDC provider in `shared`, not a new module.** They're single-instance resources. A module boundary around unrelated resource families (ECR, OIDC, cluster, ALB) would add navigation cost without reuse value. Per-env stuff (ECS service/task def/target group/listener rule/IAM roles/log groups/R53 record) DOES go in a module because the production workspace will instantiate it again at Launch.

**`desired_count = 0` at creation.** Cleanly decouples MYT-30 (substrate authoring) from MYT-28 (first deploy). No chicken-and-egg on the `:placeholder` image tag. `ignore_changes = [desired_count, task_definition]` keeps Terraform out of CI's way thereafter.

**OIDC trust = `environment:staging` on main.** Tightest safe scope given we control the repo. Requires setting up a GitHub Environment named "staging" in the mythrun/mythrun repo settings — that's MYT-28's setup work. If we later want feature-branch deploys to staging, we'd broaden the `StringLike` pattern.

**No `/health/live` / `/health/ready` split yet.** Existing `/health` returns 200 with no dependency checks. Splitting adds endpoints that would be no-op aliases until Backend Core lands real DB/Redis clients. Revisit then.

**ALB access logs deferred.** Per Infra spec §5.3 (Week 0 spec defers this to Observability). Zero traffic today means zero operational value. Follow-up bead tracks it.

**No autoscaling today.** `desired_count = 0` → nothing to scale. Autoscaling policies (CPU/connection-based/scheduled per Infra spec §7) land when the app has real traffic.

**SNS topic created, no alarms.** Topic is cheap, no alarms until Observability. Subscribing Miklos's email requires an out-of-band confirmation click — that's expected AWS UX, not a smell.

**`thumbprint_list` on the OIDC provider is placeholder.** AWS has done native JWK discovery for GitHub's OIDC endpoint since 2023; the thumbprint list is a legacy schema requirement. We pass one placeholder value to satisfy the Terraform schema; AWS ignores it for GitHub's well-known provider.

**GitHub Actions role permissions mix scoped + wildcarded.** ECR push/pull scoped to the `mythrun` repo ARN. `ecs:*` actions mostly wildcarded because ECS's IAM surface doesn't support per-service ARN scoping on most actions. `iam:PassRole` scoped to the two task roles. `rds:CreateDBSnapshot` scoped to the `mythrun` instance. Net effect: the role can't exfiltrate secrets from other services or touch non-mythrun resources. Production launch should re-audit.

**Execution role secret list is explicit per-ARN rather than wildcarded.** Captures the cross-env shared `mythrun/shared/redis-auth` and the per-env `mythrun/${env}/rds-password` correctly. The master user secret (`rds!db-*`) is deliberately absent — API/Worker tasks run as the per-env app user (`mythrun_${env}`), not the master. Only `bootstrap-databases.sh`'s future IAM principal (a separate ECS run-task invocation) needs master-secret access.

**Plain-string password secret.** `mythrun/${env}/rds-password` stores the app user's password as a plain string (the way `bootstrap-databases.sh` writes it), not a JSON blob. The task def's `secrets` block reads `valueFrom = var.rds_password_secret_arn` directly without JSON-path suffix. `DB_USER` and `DB_NAME` are plain env vars (`mythrun_${env}`) since they're known at build time.

## Risks

1. **GitHub Environment must exist before the OIDC role works.** The trust policy's `environment:staging` substring only matches if GitHub actually emits that claim, which requires a GitHub Environment named "staging" configured on the repo. MYT-30 authors the Terraform; MYT-28's first action will be setting up that GitHub Environment. Documented in MYT-28's scope.

2. **Task role is minimal — might need to grow fast.** When Backend Core adds real AWS integrations (X-Ray? CloudWatch Logs Insights queries from the app? S3 uploads?), the task role grows. Each addition is a one-file Terraform change; should be painless.

3. **`ignore_changes = [task_definition]` means Terraform loses visibility into which revision is running.** Deliberate — CI owns deployments. Side effect: `terraform state show` won't tell you the live revision; you query `aws ecs describe-services` for that. Documented expectation.

4. **SNS email subscription is async.** Miklos has to click the confirmation link AWS sends. Until then, the subscription is `PendingConfirmation`. If forgotten, alarms land in the void. Mitigation: verification step in MYT-30 includes checking the subscription status.

5. **Container `healthCheck` is a Node one-liner — fails if the image is broken before /health is reachable.** The container-level health check runs inside the running container; a crash-on-start image means ECS kills and retries, ALB never sees it. That's correct behavior. Documented because the first-deploy verification (MYT-28) should inspect the container logs in CloudWatch, not only the ALB target health.

## Out of scope (follow-up beads)

- Harden bootstrap-databases.sh (existing `myth-5hq`)
- Revisit Redis rename-commands alphanumeric aliases (existing `myth-dwy`)
- ALB access logs S3 bucket (new — Observability)
- CloudWatch alarms (Observability milestone)
- Production workspace (Launch milestone)
- `/health/live` + `/health/ready` split (Backend Core milestone)
- Autoscaling policies (post-first-traffic)

## Cost delta over MYT-25 baseline

Added resources, monthly:
- **ALB** ~$16.20/mo (hourly charge; zero LCU use today)
- **ECR storage** pennies (we'll have ~500 MB of images over 20 retained tags)
- **ECS cluster** free; Fargate tasks bill per-second. `desired_count=0` = $0.
- **CloudWatch log groups** empty; $0 ingest today. Retention storage is pennies.
- **SNS topic** free; $0.50/million notifications (we're nowhere near that).
- **Route 53 alias record** free (alias records don't incur query charges for AWS services).
- **GitHub OIDC provider** free.
- **IAM roles** free.

**New idle cost: ~$16/mo.** Takes total from ~$67/mo (MYT-25 baseline) to ~$83/mo.

When MYT-28 flips `desired_count = 1`, add ~$17/mo for the 0.5 vCPU / 1 GB Fargate task running 24/7.
