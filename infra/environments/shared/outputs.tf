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
