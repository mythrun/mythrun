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
# Task defs use create_before_destroy so in-place argument changes
# (env var, memory, log group) register the new revision before
# deregistering the old one. The previous "no lifecycle" stance (MYT-30)
# missed that destroy-and-replace fires on arg changes — correction in
# MYT-28 per Duncan review.

locals {
  common_env = concat(var.extra_env, [
    { name = "PORT", value = "3000" },
    { name = "AWS_REGION", value = "us-east-1" },
    { name = "REGION_PREFIX", value = "use1" },
    # DB_* consistent across HOST/PORT/USER/NAME/PASSWORD. App constructs
    # DATABASE_URL at startup per Infra §2.3.
    { name = "DB_HOST", value = var.rds_host },
    { name = "DB_PORT", value = tostring(var.rds_port) },
    { name = "DB_USER", value = "mythrun_${var.environment}" },
    { name = "DB_NAME", value = "mythrun_${var.environment}" },
    # REDIS_* parallels DB_*.
    { name = "REDIS_HOST", value = var.redis_host },
    { name = "REDIS_PORT", value = tostring(var.redis_port) },
    # MYT-37: AUTH_MODE / NODE_ENV / BOOT_GATE_ENABLED are owned by the
    # module's dedicated variables, not extra_env. Position-last means
    # they'd shadow any duplicate from extra_env even if the validation
    # in variables.tf were bypassed (defense in depth).
    { name = "AUTH_MODE", value = var.auth_mode },
    { name = "NODE_ENV", value = var.node_env },
    { name = "BOOT_GATE_ENABLED", value = var.boot_gate_enabled },
    # MYT-36 / MYT-37: Cognito values, also reserved-from-extra_env so they
    # land here via dedicated module variables wired from auth module outputs.
    { name = "COGNITO_USER_POOL_ID", value = var.cognito_user_pool_id },
    { name = "COGNITO_APP_CLIENT_ID", value = var.cognito_app_client_id },
    { name = "COGNITO_ISSUER_URL", value = var.cognito_issuer_url },
    { name = "COGNITO_HOSTED_UI_DOMAIN", value = var.cognito_hosted_ui_domain },
    # MYT-38: required by loadEnv() — used to compose invite share URLs.
    { name = "FRONTEND_BASE_URL", value = var.frontend_base_url },
  ])

  # rds-password secret holds a plain string (bootstrap-databases.sh writes
  # --secret-string "$pw" without wrapping in JSON). Read as-is, not via
  # JSON path. Changing the secret to JSON would require a `:password::`
  # suffix on valueFrom.
  common_secrets = [
    { name = "ANTHROPIC_API_KEY", valueFrom = var.manual_secret_arns["anthropic-api-key"] },
    { name = "STRIPE_SECRET_KEY", valueFrom = var.manual_secret_arns["stripe-secret-key"] },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = var.manual_secret_arns["stripe-webhook-secret"] },
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

  lifecycle {
    create_before_destroy = true
  }
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

  lifecycle {
    create_before_destroy = true
  }
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
    path                = "/health/ready" # MYT-35 closed myth-nf3; ALB gates on data-layer readiness
    protocol            = "HTTP"
    port                = "traffic-port"
    healthy_threshold   = 2 # AWS minimum — Infra §2.5 originally called for 1 but AWS rejects that (provider enforces range 2–10)
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
