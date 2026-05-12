# ======== RDS Postgres ========

resource "aws_db_subnet_group" "main" {
  name       = "mythrun-rds"
  subnet_ids = var.private_subnet_ids

  tags = { Name = "mythrun-rds-subnet-group" }
}

resource "aws_db_parameter_group" "main" {
  name   = "mythrun-postgres16"
  family = "postgres16"

  # ---- Dynamic parameters (apply_method defaults to "immediate") ----
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
  parameter {
    name  = "statement_timeout"
    value = "30000"
  }
  parameter {
    name  = "random_page_cost"
    value = "1.1"
  }
  parameter {
    name  = "work_mem"
    value = "2048" # kB = 2MB
  }
  parameter {
    name  = "maintenance_work_mem"
    value = "65536" # kB = 64MB
  }
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot" # AWS classifies rds.force_ssl as static; omitting this causes a perpetual no-op diff.
  }
  parameter {
    name  = "log_parameter_max_length"
    value = "0" # Suppress parameter values in logs to prevent PII leakage
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }

  # ---- Static parameters (require apply_method = "pending-reboot") ----
  parameter {
    name         = "max_connections"
    value        = "80"
    apply_method = "pending-reboot"
  }
  parameter {
    name         = "shared_buffers"
    value        = "{DBInstanceClassMemory/4}"
    apply_method = "pending-reboot"
  }

  tags = { Name = "mythrun-postgres16" }
}

resource "aws_db_instance" "main" {
  identifier = "mythrun"

  engine                     = "postgres"
  engine_version             = "16"
  auto_minor_version_upgrade = true
  instance_class             = var.rds_instance_class
  multi_az                   = false
  storage_type               = "gp3"
  allocated_storage          = var.rds_allocated_storage
  max_allocated_storage      = var.rds_max_allocated_storage

  backup_retention_period = 7
  backup_window           = "02:00-02:30"
  maintenance_window      = "sun:03:00-sun:04:00"

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "mythrun-final-${var.environment}"

  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  storage_encrypted   = true
  publicly_accessible = false

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.rds_sg_id]
  parameter_group_name   = aws_db_parameter_group.main.name

  manage_master_user_password = true
  username                    = "mythrun_admin"

  # db_name intentionally unset: per-env databases (mythrun_staging, mythrun_prod) are
  # created by bootstrap-databases.sh post-MYT-30.

  apply_immediately = false

  tags = { Name = "mythrun" }

  lifecycle {
    ignore_changes  = [engine_version, final_snapshot_identifier]
    prevent_destroy = true
  }
}

# ======== ElastiCache Redis ========

resource "aws_elasticache_subnet_group" "main" {
  name       = "mythrun-redis"
  subnet_ids = var.private_subnet_ids

  tags = { Name = "mythrun-redis-subnet-group" }
}

resource "aws_elasticache_parameter_group" "main" {
  name   = "mythrun-redis7"
  family = "redis7"

  # BullMQ requires `noeviction` — under `volatile-lru` (or any evicting
  # policy), Redis may drop BullMQ job/queue keys under memory pressure
  # and lose work. BullMQ logs a startup warning when this is misconfigured.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
  parameter {
    name  = "timeout"
    value = "0"
  }
  parameter {
    name  = "tcp-keepalive"
    value = "300"
  }
  # rename-commands intentionally omitted. Tried three times during MYT-25 apply:
  # 1. "CONFIG ... DEBUG ..." rejected: "Command CONFIG cannot be renamed"
  # 2. "DEBUG ..." rejected: "Command DEBUG cannot be renamed"
  # 3. "FLUSHDB \"\" ..." rejected: "Renamed parameter expected to be alphanumeric"
  # ElastiCache (a) already platform-blocks admin commands (CONFIG, DEBUG, SHUTDOWN,
  # REPLICAOF, SAVE, BGSAVE, MIGRATE, SYNC) so renaming them is redundant and rejected,
  # and (b) requires an alphanumeric alias for any rename — it doesn't accept "" as
  # a "disable" target the way stock Redis does. Defense-in-depth here is carried by
  # AUTH token + transit-TLS-required + SG (ECS-only ingress) + private subnet.
  # Tracked as a follow-up: if we later want FLUSHDB/FLUSHALL/KEYS/SCRIPT guarded,
  # rename them to an alphanumeric suffix that app code doesn't know (e.g. FLUSHALLdisabled).

  tags = { Name = "mythrun-redis7" }
}

# AUTH token generated here (plaintext in state — acceptable given the state bucket
# is SSE-S3 encrypted + TLS-only + restricted-access). Deferred: evaluate ElastiCache
# IAM auth to eliminate token from state. Tracked in design's Out of Scope.
#
# Rotation contract: both aws_secretsmanager_secret_version.redis_auth (ignore_changes
# on secret_string) and aws_elasticache_replication_group.main (ignore_changes on
# auth_token) opt out of Terraform-driven AUTH updates after initial create. To rotate:
#   1. Write a new value to mythrun/shared/redis-auth in AWS Secrets Manager.
#   2. Apply the new token to Redis via aws elasticache modify-replication-group
#      --auth-token-update-strategy SET (or the AWS console).
# Terraform-side random_password remains pinned to its initial value; tainting it and
# re-applying is NOT a rotation path (the ignore_changes blocks wouldn't propagate it).
resource "random_password" "redis_auth" {
  length           = 32
  special          = true
  override_special = "!&#$^<>-"
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
}

resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "mythrun/shared/redis-auth"
  description             = "Redis AUTH token for shared ElastiCache (used by both staging and prod ECS task roles)"
  recovery_window_in_days = 30

  tags = { Name = "mythrun-shared-redis-auth" }
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id     = aws_secretsmanager_secret.redis_auth.id
  secret_string = random_password.redis_auth.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "mythrun-redis"
  description          = "Mythrun shared Redis (staging + prod)"

  engine         = "redis"
  engine_version = var.redis_engine_version
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = 1
  automatic_failover_enabled = false

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.redis_auth.result
  auth_token_update_strategy = "SET"

  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [var.redis_sg_id]
  parameter_group_name = aws_elasticache_parameter_group.main.name

  maintenance_window       = "mon:03:00-mon:04:00"
  snapshot_retention_limit = 1

  apply_immediately = false

  tags = { Name = "mythrun-redis" }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [auth_token]
  }
}
