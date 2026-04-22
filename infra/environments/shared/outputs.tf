# Network
output "vpc_id" {
  value = module.network.vpc_id
}
output "public_subnet_ids" {
  value = module.network.public_subnet_ids
}
output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}
output "alb_sg_id" {
  value = module.network.alb_sg_id
}
output "ecs_sg_id" {
  value = module.network.ecs_sg_id
}
output "rds_sg_id" {
  value = module.network.rds_sg_id
}
output "redis_sg_id" {
  value = module.network.redis_sg_id
}

# Data
output "rds_endpoint" {
  value = module.data.rds_endpoint
}
output "rds_port" {
  value = module.data.rds_port
}
output "rds_master_user_secret_arn" {
  value     = module.data.rds_master_user_secret_arn
  sensitive = true
}
output "redis_endpoint" {
  value = module.data.redis_endpoint
}
output "redis_port" {
  value = module.data.redis_port
}
output "redis_auth_secret_arn" {
  value     = module.data.redis_auth_secret_arn
  sensitive = true
}

# ======== DNS outputs ========
# Consumed by staging (MYT-30) and future production workspaces via
# data.terraform_remote_state.shared — they read zone_id to create A-alias
# records and wildcard_cert_arn to attach to their ALB listeners.

output "dns_zone_id" {
  value = module.dns.zone_id
}

output "dns_zone_name" {
  value = module.dns.zone_name
}

output "name_servers" {
  value       = module.dns.name_servers
  description = "Set these four at Squarespace Domains → DNS → Nameservers → Custom."
}

output "wildcard_cert_arn" {
  value = module.dns.wildcard_cert_arn
}

# ======== Compute-platform outputs (added by MYT-30) ========
# Consumed by staging (and future production) workspaces via
# data.terraform_remote_state.shared.

output "ecr_repository_url" {
  value       = aws_ecr_repository.mythrun.repository_url
  description = "ECR repo URL like '862127484110.dkr.ecr.us-east-1.amazonaws.com/mythrun'."
}

output "ecs_cluster_name" {
  value       = aws_ecs_cluster.main.name
  description = "Name of the shared ECS cluster ('mythrun')."
}

output "alb_arn" {
  value       = aws_lb.main.arn
  description = "ARN of the shared ALB."
}

output "alb_dns_name" {
  value       = aws_lb.main.dns_name
  description = "ALB's public DNS name (target for Route 53 A-alias records)."
}

output "alb_zone_id" {
  value       = aws_lb.main.zone_id
  description = "ALB's hosted zone ID (for Route 53 A-alias; NOT a Route 53 zone_id)."
}

output "alb_listener_https_arn" {
  value       = aws_lb_listener.https.arn
  description = "ARN of the HTTPS listener (per-env serving modules attach listener_rules here)."
}

output "github_oidc_provider_arn" {
  value       = aws_iam_openid_connect_provider.github.arn
  description = "ARN of the GitHub OIDC provider (per-env GH Actions IAM roles trust this)."
}
