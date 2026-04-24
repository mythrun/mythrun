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

# ======== ECR Repository ========
# Single repo for both envs (tag-based differentiation per Infra §4.2). Image
# is shared between API + Worker — they use the same image with different CMD
# overrides in task defs. MUTABLE, not IMMUTABLE, because CI pushes :latest
# alongside :$GIT_SHA; IMMUTABLE would reject the second :latest push.
# Git-SHA tag immutability is a CI-discipline concern (never re-push the
# same SHA tag).

resource "aws_ecr_repository" "mythrun" {
  name                 = "mythrun"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "mythrun" }
}

resource "aws_ecr_lifecycle_policy" "mythrun" {
  repository = aws_ecr_repository.mythrun.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep 50 most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 50
        }
        action = { type = "expire" }
      },
    ]
  })
}

# ======== ECR pull-through cache for Docker Hub (via ECR Public) ========
# Routes base-image pulls (node:24-alpine et al.) through our ECR instead
# of Docker Hub directly. Avoids the 100-pulls/6h anonymous rate limit
# that GitHub-hosted runner IP pools can trigger at team scale, and
# improves cold-start latency by keeping pulls in-region.
#
# Upstream is public.ecr.aws (ECR Public Gallery's mirror of Docker Hub
# official images) rather than registry-1.docker.io — AWS's pull-through
# cache for Docker Hub proper now requires Secrets Manager-stored auth
# credentials, which we skip by going through the auth-free public mirror.
# The `docker/library/*` namespace on ECR Public is the official Docker
# Hub Library mirror.
#
# Cache repos (e.g., ecr-public/docker/library/node) are auto-created on
# first pull. IAM additions live in the staging workspace's GH Actions
# role policy (MYT-28).

resource "aws_ecr_pull_through_cache_rule" "ecr_public" {
  ecr_repository_prefix = "ecr-public"
  upstream_registry_url = "public.ecr.aws"
}

# ======== GitHub Actions OIDC Provider ========
# One per AWS account. Both staging and future prod IAM roles trust this
# provider. thumbprint_list is omitted — it's Optional in AWS provider v6.x,
# and AWS has done native JWK discovery for GitHub's OIDC endpoint since 2023.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  tags = { Name = "github-actions-oidc" }
}

# ======== ECS Cluster ========
# One cluster shared across envs — per-env services live inside it.
# containerInsights disabled — saves ~$2.50/task/month. MYT-28 first-deploy
# debugging will rely on raw CloudWatch Logs + describe-tasks output.

resource "aws_ecs_cluster" "main" {
  name = "mythrun"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = { Name = "mythrun" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]
  # No FARGATE_SPOT — spec punts on spot until real cost pressure arrives.

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# ======== Application Load Balancer ========
# Single ALB shared across envs. Host-based listener rules (in the per-env
# serving module) route to per-env target groups. Lives in public subnets;
# SG is alb_sg_id from the network module. deletion_protection = true
# because the ALB serves both staging and future prod — accidental teardown
# kills both. Explicit flip to false required to destroy.

resource "aws_lb" "main" {
  name               = "mythrun-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [module.network.alb_sg_id]
  subnets            = module.network.public_subnet_ids

  idle_timeout               = 3600 # 1 hour for WebSocket keepalive tolerance
  enable_deletion_protection = true
  enable_http2               = true
  drop_invalid_header_fields = true # defense against header smuggling / RFC 7230 violations
  # access_logs — deferred to Observability spec (see bead for ALB access logs bucket)

  tags = { Name = "mythrun-alb" }
}

# HTTPS listener — the real traffic listener. Default action returns 404;
# per-env listener rules (in serving module) forward matching hosts to env
# target groups.

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06" # TLS 1.3 preferred, TLS 1.2 fallback, PFS-only ciphers
  certificate_arn   = module.dns.wildcard_cert_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "Not Found"
    }
  }

  tags = { Name = "mythrun-alb-https" }
}

# HTTP listener — permanent redirect to HTTPS. Never serves real traffic.

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }

  tags = { Name = "mythrun-alb-http-redirect" }
}
