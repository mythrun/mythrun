# infra/modules/serving/migrate.tf
#
# Migration-runner infrastructure: ECS task def + execution/task roles +
# Secrets Manager secret + dedicated security group + log group. Wired
# together so the GHA db-migrate.yml workflow can ECS run-task this
# family with command override `node dist/db/migrate.js` to apply
# pending migrations against RDS.
#
# Spec: docs/superpowers/specs/2026-05-11-migration-runner-design.md
# Bead: myth-4mlu

# --- log group ---

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/mythrun/${var.environment}/migrate"
  retention_in_days = 30
  tags              = { Name = "mythrun-${var.environment}-migrate" }
}

# --- Secrets Manager: migrate-db-credentials ---
#
# TF creates the secret resource; bootstrap-db populates the first
# version on its next default-mode run. ECS execution role can read this
# secret; the API/worker task roles cannot.
resource "aws_secretsmanager_secret" "migrate_db_credentials" {
  name                    = "mythrun/${var.environment}/migrate-db-credentials"
  description             = "JSON {username,password} for the migrate DB user. Rotated by bootstrap-db --reset-migrate-password."
  recovery_window_in_days = 7
  tags                    = { Name = "mythrun-${var.environment}-migrate-db-credentials" }
}

# --- security group ---
#
# Dedicated SG. NOT shared with bootstrap-db so an SG-rule change to
# bootstrap-db cannot accidentally widen migrate's reach (blast-radius
# isolation per spec §3).
resource "aws_security_group" "migrate" {
  name        = "mythrun-${var.environment}-migrate"
  description = "Migrate runner task: egress to RDS + HTTPS to AWS APIs"
  vpc_id      = var.vpc_id
  tags        = { Name = "mythrun-${var.environment}-migrate" }
}

resource "aws_vpc_security_group_egress_rule" "migrate_to_rds" {
  security_group_id            = aws_security_group.migrate.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.rds_security_group_id
  description                  = "Postgres to RDS"
}

resource "aws_vpc_security_group_egress_rule" "migrate_https" {
  security_group_id = aws_security_group.migrate.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  description       = "HTTPS to AWS APIs (Secrets Manager, ECR, STS) via NAT"
}

# RDS-side ingress: allow the migrate SG to reach RDS:5432. The RDS SG
# is owned outside this module; we add a one-way reference here.
resource "aws_vpc_security_group_ingress_rule" "rds_from_migrate" {
  security_group_id            = var.rds_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.migrate.id
  description                  = "Postgres from migrate task (${var.environment})"
}

# --- IAM: execution role (used by ECS to pull image + read secrets) ---

resource "aws_iam_role" "migrate_task_execution" {
  name = "mythrun-${var.environment}-migrate-task-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "mythrun-${var.environment}-migrate-task-execution" }
}

resource "aws_iam_role_policy_attachment" "migrate_task_execution_baseline" {
  role       = aws_iam_role.migrate_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "migrate_task_execution_inline" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.migrate_db_credentials.arn,
    ]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.migrate.arn}:*"]
  }
}

resource "aws_iam_role_policy" "migrate_task_execution_inline" {
  name   = "migrate-task-execution-inline"
  role   = aws_iam_role.migrate_task_execution.id
  policy = data.aws_iam_policy_document.migrate_task_execution_inline.json
}

# --- IAM: task role (no runtime AWS API access; placeholder for traceability) ---

resource "aws_iam_role" "migrate_task" {
  name = "mythrun-${var.environment}-migrate-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "mythrun-${var.environment}-migrate-task" }
}

# --- ECS task definition ---

resource "aws_ecs_task_definition" "migrate" {
  family                   = "mythrun-${var.environment}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.migrate_task_execution.arn
  task_role_arn            = aws_iam_role.migrate_task.arn

  container_definitions = jsonencode([{
    name        = "migrate"
    image       = "${var.ecr_repository_url}:placeholder" # CI swaps in real digest
    essential   = true
    command     = ["dumb-init", "node", "dist/db/migrate.js"]
    stopTimeout = 120
    environment = [
      { name = "AWS_REGION", value = "us-east-1" },
      { name = "MYTHRUN_ENV", value = var.environment },
      { name = "REGION_PREFIX", value = "use1" },
      { name = "DB_HOST", value = var.rds_host },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = "mythrun_${var.environment}" },
      { name = "DB_USER", value = "mythrun_${var.environment}_migrate" },
    ]
    secrets = [
      {
        name      = "DB_PASSWORD"
        valueFrom = "${aws_secretsmanager_secret.migrate_db_credentials.arn}:password::"
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migrate.name
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "migrate"
      }
    }
  }])

  # Image tag changes are CI-driven, not TF-driven. TF only owns the
  # task-def shape (env vars, secrets, IAM); CI re-registers with the
  # real ECR digest at deploy time. See reference_tf_ci_taskdef_split.md.
  lifecycle {
    ignore_changes = [
      container_definitions, # CI re-registers revisions
    ]
  }

  tags = { Name = "mythrun-${var.environment}-migrate" }
}

# --- outputs ---

output "migrate_security_group_id" {
  value       = aws_security_group.migrate.id
  description = "Set this as a GitHub Environment variable MIGRATE_SECURITY_GROUP_ID on the 'staging' environment."
}

output "migrate_task_definition_family" {
  value       = aws_ecs_task_definition.migrate.family
  description = "Task definition family name for the db-migrate workflow."
}

output "migrate_log_group_name" {
  value       = aws_cloudwatch_log_group.migrate.name
  description = "Log group name for the db-migrate workflow."
}

output "migrate_task_execution_role_arn" {
  value = aws_iam_role.migrate_task_execution.arn
}

output "migrate_task_role_arn" {
  value = aws_iam_role.migrate_task.arn
}

output "migrate_log_group_arn" {
  value = aws_cloudwatch_log_group.migrate.arn
}
