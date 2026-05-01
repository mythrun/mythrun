# ======== Environment + naming ========

variable "environment" {
  description = "Logical environment label: 'staging' or 'production'. Used for resource naming + tags + log group paths + DB_USER/DB_NAME values."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

# ======== Network inputs (from shared workspace's network module) ========

variable "vpc_id" {
  description = "VPC ID the ECS services run in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks (no public IPs; egress via NAT)."
  type        = list(string)
}

variable "ecs_sg_id" {
  description = "Security group ID for ECS tasks. Ingress 3000 from ALB SG; egress 443, 5432 to RDS SG, 6379 to Redis SG."
  type        = string
}

# ======== Compute-platform inputs (from shared workspace's new additions) ========

variable "ecs_cluster_name" {
  description = "Name of the shared ECS cluster ('mythrun')."
  type        = string
}

variable "ecr_repository_url" {
  description = "ECR repo URL like '862127484110.dkr.ecr.us-east-1.amazonaws.com/mythrun'. Used as the image base in task defs."
  type        = string
}

variable "alb_arn" {
  description = "ARN of the shared ALB (for target group registration)."
  type        = string
}

variable "alb_listener_https_arn" {
  description = "ARN of the ALB's HTTPS listener (the listener_rule attaches here)."
  type        = string
}

variable "alb_dns_name" {
  description = "ALB's public DNS name (for the Route 53 A-alias target)."
  type        = string
}

variable "alb_zone_id" {
  description = "ALB's hosted zone ID (for the Route 53 A-alias; NOT Route 53 zone_id)."
  type        = string
}

# ======== DNS inputs (from shared workspace's dns module) ========

variable "dns_zone_id" {
  description = "Route 53 hosted zone ID for mythrun.com (from shared workspace)."
  type        = string
}

variable "dns_zone_name" {
  description = "Route 53 zone name, e.g. 'mythrun.com' (no trailing dot)."
  type        = string
}

variable "wildcard_cert_arn" {
  description = "ARN of the *.mythrun.com wildcard ACM cert (from shared workspace's dns module). NOT USED by this module — listener is owned by shared; cert is attached there. Kept here for potential future per-env cert attachment."
  type        = string
  default     = ""
}

# ======== Data-layer inputs (from shared workspace's data module) ========

variable "rds_host" {
  description = "RDS endpoint hostname (no port). Injected as DB_HOST env var."
  type        = string
}

variable "rds_port" {
  description = "RDS port. Injected as DB_PORT env var."
  type        = number
}

variable "redis_host" {
  description = "ElastiCache primary endpoint hostname. Injected as REDIS_HOST env var."
  type        = string
}

variable "redis_port" {
  description = "ElastiCache port. Injected as REDIS_PORT env var."
  type        = number
}

# ======== Secret ARN inputs ========

variable "shared_redis_auth_secret_arn" {
  description = "ARN of mythrun/shared/redis-auth (cross-env shared secret). Injected as REDIS_AUTH_TOKEN."
  type        = string
}

variable "manual_secret_arns" {
  description = "Map of per-env manual secrets. Must contain keys: anthropic-api-key, stripe-secret-key, stripe-webhook-secret."
  type        = map(string)

  validation {
    condition = alltrue([
      for k in ["anthropic-api-key", "stripe-secret-key", "stripe-webhook-secret"] :
      contains(keys(var.manual_secret_arns), k)
    ])
    error_message = "manual_secret_arns must contain all three expected keys: anthropic-api-key, stripe-secret-key, stripe-webhook-secret."
  }
}

variable "rds_password_secret_arn" {
  description = "ARN of the mythrun/<env>/rds-password secret. Injected as DB_PASSWORD. Stored as a plain-string password by bootstrap-databases.sh (no JSON-path suffix on valueFrom)."
  type        = string
}

# rds_master_user_secret_arn is NOT here — the API/Worker tasks run as the
# per-env app user (mythrun_${env}), not the master. Only bootstrap-databases.sh's
# future IAM principal needs the master secret.

# ======== Tunables ========

# Defaults match Week 0 §7.2's staging-size matrix. Production workspace
# overrides to 512/1024 explicitly when instantiating this module at Launch.
variable "api_cpu" {
  description = "CPU units for the API task (256, 512, 1024, etc.)."
  type        = string
  default     = "256"
}

variable "api_memory" {
  description = "Memory (MB) for the API task."
  type        = string
  default     = "512"
}

variable "worker_cpu" {
  description = "CPU units for the Worker task."
  type        = string
  default     = "256"
}

variable "worker_memory" {
  description = "Memory (MB) for the Worker task."
  type        = string
  default     = "512"
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days. Staging defaults to 14; production should pass 30."
  type        = number
  default     = 14
}

variable "extra_env" {
  description = "Per-environment additional env vars to inject into the API task. May NOT contain AUTH_MODE, NODE_ENV, BOOT_GATE_ENABLED, or any COGNITO_* — those are owned by the module's dedicated variables (auth_mode, node_env) or by the auth module's outputs. Override attempts fail at terraform plan."
  type        = list(object({ name = string, value = string }))
  default     = []

  validation {
    condition = alltrue([
      for e in var.extra_env : !contains([
        "AUTH_MODE", "NODE_ENV", "BOOT_GATE_ENABLED",
        "COGNITO_USER_POOL_ID", "COGNITO_APP_CLIENT_ID",
        "COGNITO_ISSUER_URL", "COGNITO_HOSTED_UI_DOMAIN",
        "AWS_EXECUTION_ENV", "ECS_CONTAINER_METADATA_URI_V4",
      ], e.name)
    ])
    error_message = "extra_env must not contain reserved auth/Cognito/boot-gate/AWS-runtime names. Use the module's dedicated variables (auth_mode, node_env) instead."
  }
}

variable "auth_mode" {
  description = "Mythrun auth-plugin mode. Defaults to 'real' so a new environment can't accidentally launch with bypass mode just by forgetting to set this. Override to 'bypass' is structurally possible but requires an explicit composition-level opt-in, which a code reviewer would catch immediately."
  type        = string
  default     = "real"

  validation {
    condition     = contains(["real", "bypass"], var.auth_mode)
    error_message = "auth_mode must be 'real' or 'bypass'."
  }
}

variable "node_env" {
  description = "Node.js NODE_ENV value. Defaults to 'production' so a real environment can't lose Layer 2 of the bypass-mode defense by forgetting to set it. The bypass plugin demands NODE_ENV in {'development','test'} at registration."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["development", "test", "production"], var.node_env)
    error_message = "node_env must be 'development', 'test', or 'production'."
  }
}

variable "boot_gate_enabled" {
  description = "MYT-29 boot gate flag. '1' = wait for pg+redis at boot before app.listen; '0' (or unset) = fallbackStart with stub deps. Defaults to '1' for production safety."
  type        = string
  default     = "1"

  validation {
    condition     = contains(["0", "1"], var.boot_gate_enabled)
    error_message = "boot_gate_enabled must be '0' or '1'."
  }
}

# ======== MYT-36 / MYT-37: Cognito wiring ========
# Promoted from free-form extra_env entries (which now reject these names per
# MYT-37 reserved-name validation). The composition wires these from the auth
# module's outputs.

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID (from auth module). Injected as COGNITO_USER_POOL_ID. Empty default keeps two-pass-apply / pre-auth-module bring-up paths working."
  type        = string
  default     = ""
}

variable "cognito_app_client_id" {
  description = "Cognito App Client ID (from auth module). Injected as COGNITO_APP_CLIENT_ID."
  type        = string
  default     = ""
}

variable "cognito_issuer_url" {
  description = "Cognito OIDC issuer URL (from auth module). Injected as COGNITO_ISSUER_URL. The MYT-37 JWT middleware verifies the iss claim against this exact string and derives the JWKS URL as $${issuer_url}/.well-known/jwks.json."
  type        = string
  default     = ""
}

variable "cognito_hosted_ui_domain" {
  description = "Cognito Hosted UI domain (from auth module). Injected as COGNITO_HOSTED_UI_DOMAIN."
  type        = string
  default     = ""
}
