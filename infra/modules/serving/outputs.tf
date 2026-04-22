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
