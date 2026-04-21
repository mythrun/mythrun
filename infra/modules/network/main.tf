# VPC
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "mythrun" }

  lifecycle {
    prevent_destroy = true
  }
}

# Zero out the default SG that AWS auto-creates with every VPC.
# Any resource accidentally launched into the default SG inherits no rules.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id

  # No ingress, no egress — deny everything by default.
  tags = { Name = "mythrun-default-locked-down" }
}

# Public subnets (ALB, NAT Gateway)
resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = var.azs[0]
  map_public_ip_on_launch = false

  tags = { Name = "mythrun-public-a" }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = var.azs[1]
  map_public_ip_on_launch = false

  tags = { Name = "mythrun-public-b" }
}

# Private subnets (ECS, RDS, Redis — nothing public-facing)
resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.10.0/24"
  availability_zone = var.azs[0]

  tags = { Name = "mythrun-private-a" }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.20.0/24"
  availability_zone = var.azs[1]

  tags = { Name = "mythrun-private-b" }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "mythrun-igw" }
}

# Elastic IP for NAT
resource "aws_eip" "nat_a" {
  domain = "vpc"

  tags = { Name = "mythrun-nat-a-eip" }

  depends_on = [aws_internet_gateway.main]
}

# NAT Gateway in public-a
resource "aws_nat_gateway" "main_a" {
  allocation_id = aws_eip.nat_a.id
  subnet_id     = aws_subnet.public_a.id

  tags = { Name = "mythrun-nat-a" }

  depends_on = [aws_internet_gateway.main]
}

# Public route table
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "mythrun-public-rt" }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# Private route table (single NAT today; split into per-AZ route tables when num_nat_gateways = 2)
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main_a.id
  }

  tags = { Name = "mythrun-private-rt" }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

# ------ Security groups ------

resource "aws_security_group" "alb" {
  name        = "mythrun-alb"
  description = "ALB inbound 443 from internet; used by MYT-30."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "mythrun-alb" }
}

resource "aws_security_group" "ecs" {
  name        = "mythrun-ecs"
  description = "ECS tasks: inbound 3000 from ALB; outbound 443 + DB/Redis; used by MYT-30."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "mythrun-ecs" }
}

resource "aws_security_group" "rds" {
  name        = "mythrun-rds"
  description = "RDS: inbound 5432 from ECS only; no outbound."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "mythrun-rds" }
}

resource "aws_security_group" "redis" {
  name        = "mythrun-redis"
  description = "Redis: inbound 6379 from ECS only; no outbound."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "mythrun-redis" }
}

# ------ SG ingress rules (all explicit; no legacy inline ingress blocks) ------

resource "aws_vpc_security_group_ingress_rule" "alb_443" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS from internet"
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_alb" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  description                  = "App port from ALB"
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_ecs" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from ECS"
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_ecs" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Redis from ECS"
}

# ------ SG egress rules (explicit; aws_security_group creates SGs with NO default egress) ------

# ALB egress: all (ALB must reach ECS tasks on any high port)
resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "ALB egress to ECS (all)"
}

# ECS egress: 443 to internet (Anthropic, Stripe, ECR, Secrets Manager, AWS APIs)
resource "aws_vpc_security_group_egress_rule" "ecs_https" {
  security_group_id = aws_security_group.ecs.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS to internet (Anthropic, Stripe, AWS APIs via NAT)"
}

# ECS egress: 5432 to RDS SG
resource "aws_vpc_security_group_egress_rule" "ecs_to_rds" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS"
}

# ECS egress: 6379 to Redis SG
resource "aws_vpc_security_group_egress_rule" "ecs_to_redis" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = aws_security_group.redis.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Redis from ECS"
}

# RDS egress: NONE (deliberate — RDS has no legitimate outbound need)
# Redis egress: NONE (same)
# No egress_rule resources created for sg-rds or sg-redis.
