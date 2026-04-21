output "rds_endpoint" {
  value       = aws_db_instance.main.address
  description = "RDS endpoint hostname (without port)."
}

output "rds_port" {
  value       = aws_db_instance.main.port
  description = "RDS port."
}

output "rds_master_user_secret_arn" {
  # master_user_secret is a list block; index [0] is required.
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
  description = "ARN of the AWS-managed RDS master user secret (auto-created by manage_master_user_password)."
  sensitive   = true
}

output "redis_endpoint" {
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
  description = "Redis primary endpoint hostname."
}

output "redis_port" {
  value       = aws_elasticache_replication_group.main.port
  description = "Redis port (6379)."
}

output "redis_auth_secret_arn" {
  value       = aws_secretsmanager_secret.redis_auth.arn
  description = "ARN of mythrun/shared/redis-auth secret."
  sensitive   = true
}
