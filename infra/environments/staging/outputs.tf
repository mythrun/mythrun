output "manual_secret_arns" {
  value       = { for k, v in aws_secretsmanager_secret.manual_secrets : k => v.arn }
  description = "ARNs of the staging-scoped manually-populated secrets."
  sensitive   = true
}

output "bootstrap_secret_arns" {
  value       = { for k, v in aws_secretsmanager_secret.bootstrap_secrets : k => v.arn }
  description = "ARNs of secret shells to be populated by bootstrap-databases.sh."
  sensitive   = true
}

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

# ======== MYT-9qgb bootstrap-db outputs ========

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
