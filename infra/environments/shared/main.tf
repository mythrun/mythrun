module "network" {
  source      = "../../modules/network"
  environment = var.environment
  vpc_cidr    = "10.0.0.0/16"
  azs         = ["us-east-1a", "us-east-1b"]
}

module "data" {
  source             = "../../modules/data"
  environment        = var.environment
  private_subnet_ids = module.network.private_subnet_ids
  rds_sg_id          = module.network.rds_sg_id
  redis_sg_id        = module.network.redis_sg_id
}
