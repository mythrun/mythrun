# infra/modules/bootstrap-db/outputs.tf

output "task_definition_family" {
  value       = aws_ecs_task_definition.bootstrap.family
  description = "Family name passed to `aws ecs run-task --task-definition`."
}

output "security_group_id" {
  value       = aws_security_group.bootstrap.id
  description = "SG ID for run-task --network-configuration."
}

output "log_group_name" {
  value       = aws_cloudwatch_log_group.bootstrap.name
  description = "CloudWatch log group — view results via `aws logs tail`."
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "Task role ARN (for audit / IAM-policy-simulator)."
}

# ======== Paste-ready run-task commands (one per script mode) ========
#
# Five discrete outputs because string-substitution inside `terraform output
# -raw` is fragile (a previous spec iteration had a literal MODE_FLAG token
# that the operator hit "unknown arg" on). Each output is fully formed and
# pasteable. The shared base composition lives in a local.
#
# Operators MUST invoke these via `eval` (or `bash -c`), not paste raw —
# the `--overrides '{...}'` and `--network-configuration 'awsvpc...'`
# segments are single-quote-wrapped inside the string, and the shell
# re-parses those quotes only when the string passes through `eval`. The
# output description on each output below repeats this requirement so the
# wiki page renders it verbatim.

locals {
  _network_config = format(
    "awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=DISABLED}",
    join(",", var.private_subnet_ids),
    aws_security_group.bootstrap.id,
  )

  _modes = {
    verify              = ["--env", var.environment, "--verify"]
    secret_only         = ["--env", var.environment, "--secret-only"]
    reset_password      = ["--env", var.environment, "--reset-password"]
    user_only           = ["--env", var.environment, "--user-only"]
    default             = ["--env", var.environment]
    seed_smoke_credits  = ["--env", var.environment, "--seed-smoke-credits"]
  }

  _run_task_template = "aws ecs run-task --cluster %s --task-definition %s --launch-type FARGATE --network-configuration '%s' --overrides %s"
}

output "run_task_verify" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.verify }] })),
  )
  description = "Read-only mode: prints OK / MISSING / DB_ONLY / SECRET_MISSING. Always safe. Invoke via `eval \"$(terraform output -raw bootstrap_db_run_task_verify)\"` — single-quote wrapping requires shell re-parse."
}

output "run_task_secret_only" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.secret_only }] })),
  )
  description = "Rotates app password + writes to Secrets Manager. Use when --verify prints SECRET_MISSING. Invoke via `eval`."
}

output "run_task_reset_password" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.reset_password }] })),
  )
  description = "Alias of --secret-only. Use when the stored secret is known-wrong (drift), not just missing. Invoke via `eval`."
}

output "run_task_user_only" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.user_only }] })),
  )
  description = "DB exists, user doesn't: create user + write secret. Use when --verify prints DB_ONLY. Invoke via `eval`."
}

output "run_task_default" {
  value = format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.default }] })),
  )
  description = "Default mode: create DB + user + secret. Use when --verify prints MISSING. Invoke via `eval`."
}

# MYT-55: seed 1M credits each of world_gen + session for the four staging
# smoke users. Idempotent (WHERE NOT EXISTS guard on a deterministic
# source_id hash). Empty string when the feature is gated off (production —
# var.cognito_user_pool_id == "") so consumers can reference the output
# unconditionally; they just get "" when seeding isn't wired in this env.
output "run_task_seed_smoke_credits" {
  value = local.smoke_seeding_enabled ? format(
    local._run_task_template,
    var.ecs_cluster_name,
    aws_ecs_task_definition.bootstrap.family,
    local._network_config,
    format("'%s'", jsonencode({ containerOverrides = [{ name = "bootstrap", command = local._modes.seed_smoke_credits }] })),
  ) : ""
  description = "Paste-ready: grant 1M world_gen + 1M session credits to the four MYT-55 smoke users. Idempotent (re-runs are no-ops). Requires the smoke users' `users` rows to already exist (the smoke materializes them on first POST /api/users/register). Empty string when staging-only smoke seeding isn't wired in this env. Invoke via `eval`."
}
