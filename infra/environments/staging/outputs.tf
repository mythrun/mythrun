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
