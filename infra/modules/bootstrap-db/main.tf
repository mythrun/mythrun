# infra/modules/bootstrap-db/main.tf

# ======== Security group: bootstrap → AWS APIs + RDS ========
# Egress-only by intent. Pulls the master secret + writes the app secret
# over Secrets Manager (HTTPS to AWS API endpoints) and connects to RDS
# via the existing private-subnet path. NAT Gateway egress to 443/tcp
# 0.0.0.0/0 matches the established pattern in modules/network (ECS SG
# egress 443 also goes to anywhere via NAT).

resource "aws_security_group" "bootstrap" {
  name        = "mythrun-${var.environment}-bootstrap-db"
  description = "Bootstrap-DB task: egress-only — 443 to AWS APIs, 5432 to RDS."
  vpc_id      = var.vpc_id

  tags = { Name = "mythrun-${var.environment}-bootstrap-db" }
}

# Egress: 443/tcp anywhere (Secrets Manager + ECR + STS over NAT, like ECS).
resource "aws_vpc_security_group_egress_rule" "bootstrap_https" {
  security_group_id = aws_security_group.bootstrap.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS to AWS APIs (Secrets Manager, ECR, STS) via NAT"
}

# Egress: 5432/tcp to RDS SG.
resource "aws_vpc_security_group_egress_rule" "bootstrap_to_rds" {
  security_group_id            = aws_security_group.bootstrap.id
  referenced_security_group_id = var.rds_sg_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS"
}

# Ingress on RDS SG: accept 5432 from the bootstrap SG.
# Owned by the consumer concern, not the producer SG. Asymmetric pair —
# bootstrap → RDS edge is one rule each side, no cycle.
resource "aws_vpc_security_group_ingress_rule" "rds_from_bootstrap" {
  security_group_id            = var.rds_sg_id
  referenced_security_group_id = aws_security_group.bootstrap.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from bootstrap-db task (${var.environment})"
}
