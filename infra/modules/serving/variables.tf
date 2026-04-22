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
  description = "Map of per-env manual secrets. Must contain keys: anthropic-api-key, stripe-secret-key, stripe-webhook-secret, cognito-client-secret."
  type        = map(string)

  validation {
    condition = alltrue([
      for k in ["anthropic-api-key", "stripe-secret-key", "stripe-webhook-secret", "cognito-client-secret"] :
      contains(keys(var.manual_secret_arns), k)
    ])
    error_message = "manual_secret_arns must contain all four expected keys: anthropic-api-key, stripe-secret-key, stripe-webhook-secret, cognito-client-secret."
  }
}

variable "rds_password_secret_arn" {
  description = "ARN of mythrun/${var.environment}/rds-password. Injected as DB_PASSWORD. Stored as a plain-string password by bootstrap-databases.sh (no JSON-path suffix on valueFrom)."
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
