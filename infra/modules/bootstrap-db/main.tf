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

# ======== CloudWatch log group ========

resource "aws_cloudwatch_log_group" "bootstrap" {
  name              = "/ecs/mythrun-${var.environment}-bootstrap-db"
  retention_in_days = var.log_retention_days

  tags = { Name = "mythrun-${var.environment}-bootstrap-db" }
}

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

  # GetRandomPassword is an account-level API (doesn't operate on a specific
  # secret ARN), so resource MUST be `*` per AWS Secrets Manager API design.
  # The script calls this once per bootstrap to generate the app password.
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
      { name = "AWS_REGION", value = "us-east-1" },
      { name = "RDS_MASTER_SECRET_ARN", value = var.rds_master_secret_arn },
      # The AWS-managed RDS master secret only carries username+password.
      # Host+port come from the shared workspace's RDS data outputs. The
      # script prefers env-supplied values over the JSON secret's host/port
      # (which don't exist on AWS-managed secrets).
      { name = "RDS_HOST", value = var.rds_host },
      { name = "RDS_PORT", value = tostring(var.rds_port) },
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
