# infra/modules/bootstrap-db/variables.tf
#
# Inputs for the bootstrap-db module. Consumed from
# infra/environments/{staging,production}/main.tf via terraform_remote_state
# of the shared workspace + per-env secret ARNs.

variable "environment" {
  description = "Env name (e.g. \"staging\")."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID — used as parent for the bootstrap security group."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the bootstrap task to run in (must have RDS network reachability)."
  type        = list(string)
}

variable "rds_sg_id" {
  description = "RDS security group ID — receives an ingress rule from the bootstrap SG on 5432."
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster name. Composed into the run-task command outputs."
  type        = string
}

variable "ecr_repository_url" {
  description = "ECR URL for mythrun-bootstrap-db (e.g. <acct>.dkr.ecr.us-east-1.amazonaws.com/mythrun-bootstrap-db)."
  type        = string
}

variable "image_tag" {
  description = "Image tag pinned into the task definition (e.g. \"bootstrap-db-abc1234-1\"). Bumped manually after each rebuild."
  type        = string
}

variable "rds_host" {
  description = "RDS endpoint hostname. Injected into the task as RDS_HOST. The AWS-managed RDS master secret only carries username+password; host+port come from the shared workspace's rds_endpoint/rds_port outputs."
  type        = string
}

variable "rds_port" {
  description = "RDS port (typically 5432). Injected into the task as RDS_PORT."
  type        = number
}

variable "rds_master_secret_arn" {
  description = "ARN of the RDS master user secret (read-only by the bootstrap task)."
  type        = string
}

variable "rds_password_secret_arn" {
  description = "ARN of the env-specific app password secret (read+write by the bootstrap task)."
  type        = string
}

variable "migrate_password_secret_arn" {
  description = "ARN of the env-specific migrate-user password secret (read+write by the bootstrap task — provision_migrate_user populates the first version)."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch log group retention for bootstrap operations."
  type        = number
  default     = 30
}

# ---- MYT-55 smoke-credits seeding (staging-only) ----
# When `cognito_user_pool_id` is set (non-empty), the bootstrap task gains:
#   - COGNITO_USER_POOL_ID + SMOKE_USER_EMAIL_* env vars
#   - cognito-idp:AdminGetUser IAM scoped to the user pool ARN
# This wires up the `--seed-smoke-credits` script mode (resolves email → sub
# at runtime, then INSERTs admin grants). Empty string disables the wiring
# entirely — production must pass "" so no Cognito surface gets bound to the
# bootstrap role.

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID to bind for --seed-smoke-credits. Empty string disables the wiring (env vars + IAM grant) entirely. Staging passes module.auth.user_pool_id; production passes \"\"."
  type        = string
  default     = ""
}

variable "smoke_user_emails" {
  description = "Map keyed by role (owner | player_1 | player_2 | player_3) of the smoke users' Cognito usernames (email-shape). Empty map disables the SMOKE_USER_EMAIL_* env vars. Only meaningful when cognito_user_pool_id is set."
  type        = map(string)
  default     = {}
}
