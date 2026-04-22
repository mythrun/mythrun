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

module "dns" {
  source      = "../../modules/dns"
  domain_name = "mythrun.com"

  # Full DKIM public key pulled from the Squarespace DNS export (MYT-26 audit,
  # 2026-04-22). Public values — DNS publishes them globally, not a secret.
  dkim_key_rrdata = "v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmahZYAC+S0RRJLvVmIx2Pp2P73HT30vgVxskC0hqpqCQlCAAoubNMlMzOC3QJnIlZ2fYEoqV9k0G9pjev/6tlMsVAyvrhBC+dNdRhkPRpDm9v5dXhdghoB9NlNNTb4R0Rb5r8UUyG3xckDZoEut6AaopWhce5qyXZN98FCwJPqrHkJRhnfIza8PfNwEJKw7tx43dRGpdYWumsPNFGl8O0+HixtMDbzjo4Eg0GetYIdIqD7heXV7I4cD1TVj/9X4zGiBSh8U55vgwMGwu+7ZowO3lbm9fA7+E7dCsRaIC7sNJMdkn4NzzuKEBaJb9TkO/EGFMzcWXoxbYhcckE5eJMQIDAQAB"
}
