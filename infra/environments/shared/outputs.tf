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
