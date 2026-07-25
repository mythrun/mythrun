output "rds_endpoint" {
  value       = aws_db_instance.main.address
  description = "RDS endpoint hostname (without port)."
}

output "rds_port" {
  value       = aws_db_instance.main.port
  description = "RDS port."
}

output "rds_instance_identifier" {
  value       = aws_db_instance.main.identifier
  description = "RDS instance identifier ('mythrun') — the DBInstanceIdentifier dimension on AWS/RDS CloudWatch metrics (myth-6ik alarms)."
}

output "rds_allocated_storage_gb" {
  value       = aws_db_instance.main.allocated_storage
  description = "Currently-allocated RDS storage in GB. The free-storage alarm's threshold is expressed as an absolute byte count, so this is exported to let the composition sanity-check that the threshold is a sensible fraction of the volume."
}

# ElastiCache publishes node metrics under {CacheClusterId, CacheNodeId}. This
# output supplies the first: the MEMBER cluster id ('mythrun-redis-001'), not
# the replication group id. Consumers pair it with the constant CacheNodeId
# "0001" — a cluster-mode-disabled member cluster holds exactly one node, and a
# replica arrives as a new member cluster with its own node 0001 rather than as
# a second node here.
#
# Exported as the full list rather than a single value so alarms fan out over
# every node: staging runs one, and the spec's production sizing adds a replica.
# Sourced from the DERIVED local (see the rationale + check block in main.tf),
# so it is known at plan time and usable as a for_each key.
output "redis_member_cluster_ids" {
  value       = local.redis_member_cluster_ids
  description = "ElastiCache member cluster IDs (e.g. ['mythrun-redis-001']) — the CacheClusterId dimension on AWS/ElastiCache CloudWatch metrics (myth-6ik alarms). Known at plan time; asserted against the real member_clusters by the check block in main.tf."
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
