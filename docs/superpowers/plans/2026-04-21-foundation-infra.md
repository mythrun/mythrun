# Foundation Infra (Network + Data) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the AWS network substrate (VPC + subnets + NAT + security groups) and the data substrate (RDS Postgres 16, ElastiCache Redis 7.x, Secrets Manager entries) via Terraform in `us-east-1`. No application workloads yet — that's MYT-30.

**Architecture:** Two-workspace Terraform layout. `environments/shared/` owns the VPC, security groups, RDS instance, Redis replication group, and shared Redis AUTH secret. `environments/staging/` owns per-env Secrets Manager shells and reads shared resource IDs via `data "terraform_remote_state"`. Two modules (`network`, `data`) called by both environments.

**Tech Stack:** Terraform ≥1.10 (native S3 state locking via `use_lockfile`), AWS provider `~> 6.0`, `hashicorp/random` for the Redis AUTH token. AWS-side generation for the app user password (done by `bootstrap-databases.sh` post-MYT-30, not by Terraform).

**Linear issue:** MYT-25
**Design spec:** `docs/superpowers/specs/2026-04-21-foundation-infra-design.md` (v4)

---

## Pre-flight notes

- **Real AWS spend starts here.** Every `terraform apply` in this plan creates billable resources. Estimated idle: ~$67/mo. Confirm the $200 billing alarm (MYT-9) is live before the first `apply`.
- **First `terraform apply` on `shared/` takes ~15 minutes.** RDS provisioning dominates. Don't cancel mid-apply.
- **Two workspaces, applied sequentially.** `shared/` first (creates the substrate), then `staging/` (reads shared state via remote state data source).
- **Bootstrap script must run before any `terraform init`.** The S3 state bucket it creates is the backend target.
- **`bootstrap-databases.sh` is created here but NOT executed.** RDS sits in a private subnet; no in-VPC compute exists until MYT-30. The script is executed when MYT-30 provides an ECS cluster.
- **Miklos approves every `terraform apply`.** The `plan` output is reviewed before each one.
- **Implementation sanity check before writing code:** run `aws elasticache describe-cache-engine-versions --engine redis --region us-east-1 --query 'CacheEngineVersions[*].EngineVersion'` to confirm the latest 7.x available. If 7.1 or newer exists, use it. Update `backend/docker-compose.yml` Redis image tag to match (so local dev doesn't drift from prod).
- **Before RDS parameter group code:** verify `log_connections` classification via `aws rds describe-engine-default-parameters --db-parameter-group-family postgres16 --query "EngineDefaults.Parameters[?ParameterName=='log_connections'].[ApplyType]" --output text`. If `dynamic`, drop its `apply_method = "pending-reboot"` and move it out of the static block in Task 4.

---

## Task 1: Infra directory skeleton + bootstrap script

**Goal:** Create the `infra/` directory structure and the state-bucket bootstrap script. No AWS resources yet.

**Files:**
- Create: `infra/scripts/bootstrap.sh`
- Create: `infra/modules/network/` (empty directory)
- Create: `infra/modules/data/` (empty directory)
- Create: `infra/environments/shared/` (empty directory)
- Create: `infra/environments/staging/` (empty directory)

### Steps

- [ ] **Step 1: Create the directory skeleton**

```bash
mkdir -p infra/scripts infra/modules/network infra/modules/data infra/environments/shared infra/environments/staging
```

- [ ] **Step 2: Create `infra/scripts/bootstrap.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

BUCKET="mythrun-terraform-state"
REGION="us-east-1"

echo "Bootstrapping Terraform state bucket in $REGION..."

# Fail fast if Terraform < 1.10 (required for use_lockfile native S3 locking)
TF_VERSION=$(terraform version -json 2>/dev/null | jq -r .terraform_version 2>/dev/null || echo "missing")
if [[ "$TF_VERSION" == "missing" ]]; then
  echo "ERROR: terraform not found on PATH. Install Terraform >= 1.10." >&2
  exit 1
fi
TF_MAJOR=$(echo "$TF_VERSION" | cut -d. -f1)
TF_MINOR=$(echo "$TF_VERSION" | cut -d. -f2)
if (( TF_MAJOR < 1 )) || (( TF_MAJOR == 1 && TF_MINOR < 10 )); then
  echo "ERROR: Terraform $TF_VERSION detected; >= 1.10 required for native S3 state locking." >&2
  exit 1
fi
echo "Terraform $TF_VERSION — OK."

# Create bucket if it doesn't exist (idempotent)
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3 mb "s3://$BUCKET" --region "$REGION"
  echo "Created bucket: $BUCKET"
else
  echo "Bucket $BUCKET already exists — skipping creation."
fi

# Enable versioning (idempotent)
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# Block all public access (idempotent)
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Require TLS for all requests (deny non-TLS)
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyNonTLS",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::$BUCKET",
        "arn:aws:s3:::$BUCKET/*"
      ],
      "Condition": {
        "Bool": { "aws:SecureTransport": "false" }
      }
    }
  ]
}
EOF
)"

# Expire noncurrent versions after 90 days
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules": [
    {
      "ID": "ExpireNoncurrentVersions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
    }
  ]
}'

# Tag the bucket
aws s3api put-bucket-tagging \
  --bucket "$BUCKET" \
  --tagging 'TagSet=[{Key=Project,Value=mythrun},{Key=ManagedBy,Value=manual},{Key=Environment,Value=shared}]'

echo "Done."
echo "  - SSE-S3 encryption on by default (AWS default since Jan 2023)"
echo "  - Public access blocked (all 4 settings)"
echo "  - TLS-only (aws:SecureTransport=false denied)"
echo "  - Versioning enabled; noncurrent versions expire after 90 days"
echo "  - Native S3 state locking via use_lockfile in backend.tf (Terraform >=1.10)"
```

- [ ] **Step 3: Make the script executable**

```bash
chmod +x infra/scripts/bootstrap.sh
```

- [ ] **Step 4: Shellcheck the script (optional but worth doing)**

```bash
shellcheck infra/scripts/bootstrap.sh || echo "shellcheck not installed; skipping (install: brew install shellcheck)"
```

Expected: no errors. If shellcheck flags anything that's not a stylistic nit (SC2xxx informational codes), fix it.

- [ ] **Step 5: Commit**

```bash
git add infra/scripts/bootstrap.sh
git commit -m "$(cat <<'EOF'
chore(infra): scaffold infra directory + state bucket bootstrap script

Creates infra/{scripts,modules/{network,data},environments/{shared,staging}}
layout. scripts/bootstrap.sh provisions the Terraform state S3 bucket with
versioning, public-access-block, TLS-only policy, and 90-day noncurrent
version expiration. Bails early if Terraform < 1.10 (required for native
S3 state locking via use_lockfile).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Empty directories aren't tracked by git — only the script lands in this commit. That's fine; directories will fill in later tasks.

---

## Task 2: Run bootstrap and create the state bucket

**Goal:** Execute the bootstrap script. State bucket exists after this.

**Files:** (none created in repo; this is an AWS-side operation)

### Steps

- [ ] **Step 1: Confirm AWS CLI session is active**

```bash
aws sts get-caller-identity
```

Expected: prints the `Account`, `UserId`, and `Arn` for Miklos's SSO session. If this errors with "Unable to locate credentials", run `aws sso login` first.

- [ ] **Step 2: Run the bootstrap script**

```bash
bash infra/scripts/bootstrap.sh
```

Expected: prints the "Done." message with all four lines of config confirmation. Takes 5-10 seconds.

**Miklos approves this step — it creates a real AWS resource (S3 bucket). Cost: <$0.10/mo.**

- [ ] **Step 3: Verify the bucket was created correctly**

```bash
aws s3api head-bucket --bucket mythrun-terraform-state
aws s3api get-bucket-versioning --bucket mythrun-terraform-state
aws s3api get-bucket-policy --bucket mythrun-terraform-state | jq -r .Policy | jq .
aws s3api get-bucket-lifecycle-configuration --bucket mythrun-terraform-state
```

Expected:
- `head-bucket` exits 0 silently
- versioning `Status: "Enabled"`
- policy contains `"Sid": "DenyNonTLS"` with the `aws:SecureTransport` condition
- lifecycle rule shows `NoncurrentVersionExpiration.NoncurrentDays: 90`

- [ ] **Step 4: No commit needed**

This task creates an AWS resource, not a code change. Moving on.

---

## Task 3: Network module

**Goal:** Write `modules/network/` — VPC, subnets, IGW, NAT Gateway, route tables, 4 security groups with explicit rules, default SG zeroed. The module outputs every ID downstream modules or environments need.

**Files:**
- Create: `infra/modules/network/main.tf`
- Create: `infra/modules/network/variables.tf`
- Create: `infra/modules/network/outputs.tf`

### Steps

- [ ] **Step 1: Create `infra/modules/network/variables.tf`**

```hcl
variable "environment" {
  description = "Logical environment label for tagging. One of: shared, staging, production."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "azs" {
  description = "Availability zones for subnet placement. Exactly 2 AZs at launch; list order matters (index 0 = 'a', index 1 = 'b')."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "num_nat_gateways" {
  description = "Number of NAT Gateways. 1 at launch (cost savings); bump to 2 when AZ-a outage tolerance is required (requires splitting private route table, handled automatically by this module when set to 2)."
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 2], var.num_nat_gateways)
    error_message = "num_nat_gateways must be 1 or 2."
  }
}
```

- [ ] **Step 2: Create `infra/modules/network/main.tf`**

```hcl
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
```

- [ ] **Step 3: Create `infra/modules/network/outputs.tf`**

```hcl
output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

output "private_subnet_ids" {
  value = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

output "alb_sg_id" {
  value = aws_security_group.alb.id
}

output "ecs_sg_id" {
  value = aws_security_group.ecs.id
}

output "rds_sg_id" {
  value = aws_security_group.rds.id
}

output "redis_sg_id" {
  value = aws_security_group.redis.id
}

output "nat_gateway_id" {
  value = aws_nat_gateway.main_a.id
}
```

- [ ] **Step 4: Format the module**

```bash
cd infra/modules/network && terraform fmt
cd ../../..
```

Expected: may print filenames that were reformatted. No errors.

- [ ] **Step 5: Commit**

```bash
git add infra/modules/network/
git commit -m "$(cat <<'EOF'
feat(infra): network module (VPC, subnets, NAT, SGs with explicit egress)

Module creates:
- VPC 10.0.0.0/16 with DNS support + hostnames enabled
- 2 public subnets (ALB, NAT), 2 private subnets (ECS, RDS, Redis)
- Internet Gateway + 1 NAT Gateway (num_nat_gateways variable for future AZ redundancy)
- Public/private route tables with associations
- 4 security groups: alb, ecs, rds, redis
  - Ingress rules explicit (no legacy inline blocks)
  - Egress explicit: ALB all, ECS 443 + RDS/Redis ports, RDS/Redis NONE
- Default VPC SG zeroed (aws_default_security_group with no rules) to catch
  any resource accidentally launched into the default SG

VPC has lifecycle { prevent_destroy = true } since it's the foundation of
both staging and future production.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Data module

**Goal:** Write `modules/data/` — RDS subnet group + parameter group + instance, ElastiCache subnet group + parameter group + replication group, shared Redis AUTH secret generated with `random_password`.

**Files:**
- Create: `infra/modules/data/main.tf`
- Create: `infra/modules/data/variables.tf`
- Create: `infra/modules/data/outputs.tf`

### Steps

- [ ] **Step 1: Pre-flight check — verify Redis engine version availability + Postgres param classifications**

```bash
# What Redis versions does ElastiCache support today?
aws elasticache describe-cache-engine-versions --engine redis --region us-east-1 \
  --query 'CacheEngineVersions[*].EngineVersion' --output text

# Is log_connections static or dynamic in Postgres 16?
aws rds describe-engine-default-parameters --db-parameter-group-family postgres16 \
  --query "EngineDefaults.Parameters[?ParameterName=='log_connections'].[ApplyType]" --output text
```

Use the latest 7.x Redis version that comes back. Whatever `log_connections` reports (`static` or `dynamic`) determines whether Step 2 below includes `apply_method = "pending-reboot"` for it. If `dynamic`, remove the line — putting `pending-reboot` on a dynamic parameter is tolerated but misleading.

- [ ] **Step 2: Create `infra/modules/data/variables.tf`**

```hcl
variable "environment" {
  description = "Logical environment label for tagging."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for DB and Redis subnet groups. Must span 2 AZs (RDS requires ≥2 AZs in the subnet group even for Single-AZ instances)."
  type        = list(string)
}

variable "rds_sg_id" {
  description = "Security group ID for RDS."
  type        = string
}

variable "redis_sg_id" {
  description = "Security group ID for Redis."
  type        = string
}

variable "rds_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "rds_allocated_storage" {
  description = "Initial allocated storage (GB)."
  type        = number
  default     = 20
}

variable "rds_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GB)."
  type        = number
  default     = 50
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "Redis engine version. Verify available versions with aws elasticache describe-cache-engine-versions."
  type        = string
  default     = "7.1"
}
```

- [ ] **Step 3: Create `infra/modules/data/main.tf` — RDS portion**

Replace `# <PG_LOG_CONNECTIONS_BLOCK>` in Step 4 below based on the pre-flight check from Step 1. If `static`, keep the `apply_method = "pending-reboot"` line. If `dynamic`, remove it.

```hcl
# ======== RDS Postgres ========

resource "aws_db_subnet_group" "main" {
  name       = "mythrun-rds"
  subnet_ids = var.private_subnet_ids

  tags = { Name = "mythrun-rds-subnet-group" }
}

resource "aws_db_parameter_group" "main" {
  name   = "mythrun-postgres16"
  family = "postgres16"

  # ---- Dynamic parameters (apply_method defaults to "immediate") ----
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
  parameter {
    name  = "statement_timeout"
    value = "30000"
  }
  parameter {
    name  = "random_page_cost"
    value = "1.1"
  }
  parameter {
    name  = "work_mem"
    value = "2048"  # kB = 2MB
  }
  parameter {
    name  = "maintenance_work_mem"
    value = "65536" # kB = 64MB
  }
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_parameter_max_length"
    value = "0"  # Suppress parameter values in logs to prevent PII leakage
  }

  # ---- Static parameters (require apply_method = "pending-reboot") ----
  parameter {
    name         = "max_connections"
    value        = "80"
    apply_method = "pending-reboot"
  }
  parameter {
    name         = "log_connections"
    value        = "1"
    apply_method = "pending-reboot"  # REMOVE THIS LINE if describe-engine-default-parameters reports dynamic
  }
  parameter {
    name         = "shared_buffers"
    value        = "{DBInstanceClassMemory/4}"
    apply_method = "pending-reboot"
  }

  tags = { Name = "mythrun-postgres16" }
}

resource "aws_db_instance" "main" {
  identifier = "mythrun"

  engine                      = "postgres"
  engine_version              = "16"
  auto_minor_version_upgrade  = true
  instance_class              = var.rds_instance_class
  multi_az                    = false
  storage_type                = "gp3"
  allocated_storage           = var.rds_allocated_storage
  max_allocated_storage       = var.rds_max_allocated_storage

  backup_retention_period = 7
  backup_window           = "02:00-02:30"
  maintenance_window      = "sun:03:00-sun:04:00"

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "mythrun-final-${var.environment}"

  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  storage_encrypted   = true
  publicly_accessible = false

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.rds_sg_id]
  parameter_group_name   = aws_db_parameter_group.main.name

  manage_master_user_password = true
  username                    = "mythrun_admin"

  # db_name intentionally unset: per-env databases (mythrun_staging, mythrun_prod) are
  # created by bootstrap-databases.sh post-MYT-30.

  apply_immediately = false

  tags = { Name = "mythrun" }

  lifecycle {
    ignore_changes  = [engine_version, final_snapshot_identifier]
    prevent_destroy = true
  }
}
```

- [ ] **Step 4: Append Redis portion to `infra/modules/data/main.tf`**

```hcl
# ======== ElastiCache Redis ========

resource "aws_elasticache_subnet_group" "main" {
  name       = "mythrun-redis"
  subnet_ids = var.private_subnet_ids

  tags = { Name = "mythrun-redis-subnet-group" }
}

resource "aws_elasticache_parameter_group" "main" {
  name   = "mythrun-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru"
  }
  parameter {
    name  = "timeout"
    value = "0"
  }
  parameter {
    name  = "tcp-keepalive"
    value = "300"
  }
  # Disable dangerous commands via rename (defense-in-depth against compromised workloads)
  parameter {
    name  = "rename-commands"
    value = "CONFIG \"\" DEBUG \"\" FLUSHDB \"\" FLUSHALL \"\" KEYS \"\" SCRIPT \"\""
  }

  tags = { Name = "mythrun-redis7" }
}

# AUTH token generated here (plaintext in state — acceptable given the state bucket
# is SSE-S3 encrypted + TLS-only + restricted-access). Deferred: evaluate ElastiCache
# IAM auth to eliminate token from state. Tracked in design's Out of Scope.
resource "random_password" "redis_auth" {
  length           = 32
  special          = true
  override_special = "!&#$^<>-"
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
}

resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "mythrun/shared/redis-auth"
  description             = "Redis AUTH token for shared ElastiCache (used by both staging and prod ECS task roles)"
  recovery_window_in_days = 30

  tags = { Name = "mythrun-shared-redis-auth" }
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id     = aws_secretsmanager_secret.redis_auth.id
  secret_string = random_password.redis_auth.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "mythrun-redis"
  description          = "Mythrun shared Redis (staging + prod)"

  engine         = "redis"
  engine_version = var.redis_engine_version
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = 1
  automatic_failover_enabled = false

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.redis_auth.result
  auth_token_update_strategy = "SET"

  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [var.redis_sg_id]
  parameter_group_name = aws_elasticache_parameter_group.main.name

  maintenance_window       = "mon:03:00-mon:04:00"
  snapshot_retention_limit = 1

  apply_immediately = false

  tags = { Name = "mythrun-redis" }

  lifecycle {
    prevent_destroy = true
  }
}
```

- [ ] **Step 5: Create `infra/modules/data/outputs.tf`**

```hcl
output "rds_endpoint" {
  value       = aws_db_instance.main.address
  description = "RDS endpoint hostname (without port)."
}

output "rds_port" {
  value       = aws_db_instance.main.port
  description = "RDS port."
}

output "rds_master_user_secret_arn" {
  # master_user_secret is a list block; index [0] is required.
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
  description = "ARN of the AWS-managed RDS master user secret (auto-created by manage_master_user_password)."
  sensitive   = true
}

output "redis_endpoint" {
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
  description = "Redis primary endpoint hostname."
}

output "redis_port" {
  value       = aws_elasticache_replication_group.main.port
  description = "Redis port (6379)."
}

output "redis_auth_secret_arn" {
  value       = aws_secretsmanager_secret.redis_auth.arn
  description = "ARN of mythrun/shared/redis-auth secret."
  sensitive   = true
}
```

- [ ] **Step 6: Format the module**

```bash
cd infra/modules/data && terraform fmt
cd ../../..
```

- [ ] **Step 7: Commit**

```bash
git add infra/modules/data/
git commit -m "$(cat <<'EOF'
feat(infra): data module (RDS Postgres 16, ElastiCache Redis, shared secrets)

RDS:
- db.t4g.micro Single-AZ, 20 GB gp3 with autoscale to 50 GB
- manage_master_user_password = true (password never in Terraform state)
- username = "mythrun_admin"; per-env app users + databases created later
  by bootstrap-databases.sh
- engine_version = "16" + auto_minor_version_upgrade + lifecycle
  ignore_changes to avoid drift against AWS auto-patched minors
- deletion_protection = true, skip_final_snapshot = false,
  final_snapshot_identifier, prevent_destroy in lifecycle
- rds.force_ssl = 1, log_parameter_max_length = 0 for PII containment
- Static params (max_connections, log_connections, shared_buffers)
  carry apply_method = "pending-reboot"

ElastiCache:
- cache.t4g.micro single-node replication group (in-place scale path)
- maxmemory-policy = volatile-lru (per amended Architecture Overview)
- rename-commands disables CONFIG, DEBUG, FLUSHDB, FLUSHALL, KEYS, SCRIPT
- transit + at-rest encryption required, auth_token via random_password
- port = 6379 explicit so the output attribute is reliably populated
- lifecycle { prevent_destroy = true }

Shared Secrets Manager:
- mythrun/shared/redis-auth (30-day recovery window on the shared secret;
  staging/prod secrets use 7-day per their own workspace).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Shared environment workspace

**Goal:** Wire `environments/shared/` — backend config, provider, variables, module calls, outputs. `terraform init` should succeed.

**Files:**
- Create: `infra/environments/shared/backend.tf`
- Create: `infra/environments/shared/main.tf`
- Create: `infra/environments/shared/variables.tf`
- Create: `infra/environments/shared/outputs.tf`

### Steps

- [ ] **Step 1: Create `infra/environments/shared/backend.tf`**

```hcl
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket       = "mythrun-terraform-state"
    key          = "environments/shared/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "default"

  default_tags {
    tags = {
      Project     = "mythrun"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
```

- [ ] **Step 2: Create `infra/environments/shared/variables.tf`**

```hcl
variable "environment" {
  description = "Used for tagging. Fixed to 'shared' in this workspace."
  type        = string
  default     = "shared"
}
```

- [ ] **Step 3: Create `infra/environments/shared/main.tf`**

```hcl
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
```

- [ ] **Step 4: Create `infra/environments/shared/outputs.tf`**

These outputs become the contract the staging (and future production) workspace reads via `data "terraform_remote_state"`.

```hcl
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
```

- [ ] **Step 5: Format**

```bash
cd infra/environments/shared && terraform fmt
cd ../../..
```

- [ ] **Step 6: `terraform init`**

```bash
cd infra/environments/shared
terraform init
cd ../../..
```

Expected: downloads the AWS provider and random provider, configures the S3 backend, prints "Terraform has been successfully initialized!". Creates `.terraform/` and `.terraform.lock.hcl` in `shared/`.

- [ ] **Step 7: `terraform validate`**

```bash
cd infra/environments/shared
terraform validate
cd ../../..
```

Expected: "Success! The configuration is valid."

If validation fails, fix the reported error and re-run. Common issues:
- Missing `name` argument on a resource — check the resource docs.
- Typo in attribute reference (e.g., `aws_subnet.private_a.subnet_id` — the correct attribute is `id`).
- Unused variable — either reference it or remove.

- [ ] **Step 8: Commit**

```bash
git add infra/environments/shared/
git commit -m "$(cat <<'EOF'
feat(infra): shared environment Terraform workspace

Wires the network + data modules into the shared workspace. Backend state
lives at s3://mythrun-terraform-state/environments/shared/terraform.tfstate
with native S3 locking (use_lockfile). Provider version pinned to aws ~> 6.0
and random ~> 3.6. required_version >= 1.10 enforces native locking support.

Outputs the shared resource IDs (VPC, subnets, SGs, RDS/Redis endpoints,
secret ARNs) for consumption by the staging and future production
workspaces via data "terraform_remote_state".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Note: `.terraform/` and `.terraform.lock.hcl` are gitignored (already in `.gitignore` from MYT-27).

---

## Task 6: First apply on shared (the big moment)

**Goal:** `terraform apply` creates all shared resources. ~15 min wall-clock. Miklos approves.

**Files:** (none — pure AWS operation)

### Steps

- [ ] **Step 1: Run `terraform plan` on shared**

```bash
cd infra/environments/shared
terraform plan -out=shared.tfplan
cd ../../..
```

Expected output summary: `Plan: ~35 to add, 0 to change, 0 to destroy.` (exact count will vary by a handful depending on SG rule counts).

- [ ] **Step 2: Review the plan output**

Scan for:
- No resources being **destroyed** (this is a first apply, there shouldn't be any).
- VPC, 4 subnets, IGW, EIP, NAT Gateway, 2 route tables + 4 associations, 4 SGs, 4 ingress rules, 4 egress rules, `aws_default_security_group.default`
- DB subnet group, DB parameter group with ~12 parameters, DB instance
- ElastiCache subnet group, parameter group with 4 params, replication group
- `random_password.redis_auth`, Secrets Manager secret + version for Redis AUTH
- No resources with `(known after apply)` on critical security fields (encryption, public access block)

If anything looks surprising, stop and investigate before proceeding.

- [ ] **Step 3: Miklos approves — run `terraform apply`**

```bash
cd infra/environments/shared
terraform apply shared.tfplan
cd ../../..
```

**This is the big one.** Takes ~10-15 min. Do not cancel. RDS takes 8-12 min alone; Redis takes ~5 min; VPC-layer resources <1 min.

Expected final line: `Apply complete! Resources: ~35 added, 0 changed, 0 destroyed.`

- [ ] **Step 4: Smoke-check the outputs**

```bash
cd infra/environments/shared
terraform output
cd ../../..
```

Expected: all non-sensitive outputs print real values. Sensitive outputs (master_user_secret_arn, redis_auth_secret_arn) print `<sensitive>`.

- [ ] **Step 5: Verify RDS is `available`**

```bash
aws rds describe-db-instances --db-instance-identifier mythrun \
  --query 'DBInstances[0].DBInstanceStatus' --output text
```

Expected: `available`. If `creating`, wait a minute and re-check.

- [ ] **Step 6: Verify ElastiCache is `available`**

```bash
aws elasticache describe-replication-groups --replication-group-id mythrun-redis \
  --query 'ReplicationGroups[0].Status' --output text
```

Expected: `available`.

- [ ] **Step 7: Verify RDS is NOT reachable from outside the VPC**

```bash
RDS_ENDPOINT=$(cd infra/environments/shared && terraform output -raw rds_endpoint)
nc -zv -w 5 "$RDS_ENDPOINT" 5432
```

Expected: timeout / connection refused. RDS is in a private subnet with a strict SG; this should fail from Miklos's laptop.

- [ ] **Step 8: Idempotency gate — `terraform plan` should report no changes**

```bash
cd infra/environments/shared
terraform plan
cd ../../..
```

Expected: `No changes. Your infrastructure matches the configuration.`

If there ARE changes, that means one of the resources has attribute drift — usually a parameter group default getting re-applied, or an ignore_changes missing. Investigate and fix before continuing.

- [ ] **Step 9: Clean up the plan file**

```bash
rm infra/environments/shared/shared.tfplan
```

Plan files can contain sensitive data; don't leave them on disk.

- [ ] **Step 10: No new files to commit**

The .terraform/ directory holds state-adjacent metadata but is gitignored. The actual state lives in S3. There's nothing to commit from this task — moving on.

---

## Task 7: Staging environment workspace

**Goal:** Wire `environments/staging/` — backend config, reads shared remote state, creates the per-env Secrets Manager shells.

**Files:**
- Create: `infra/environments/staging/backend.tf`
- Create: `infra/environments/staging/main.tf`
- Create: `infra/environments/staging/variables.tf`
- Create: `infra/environments/staging/outputs.tf`

### Steps

- [ ] **Step 1: Create `infra/environments/staging/backend.tf`**

```hcl
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    bucket       = "mythrun-terraform-state"
    key          = "environments/staging/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "default"

  default_tags {
    tags = {
      Project     = "mythrun"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
```

- [ ] **Step 2: Create `infra/environments/staging/variables.tf`**

```hcl
variable "environment" {
  description = "Used for tagging and secret name prefixes."
  type        = string
  default     = "staging"
}
```

- [ ] **Step 3: Create `infra/environments/staging/main.tf`**

```hcl
# Read the shared workspace's state so we can reference its outputs.
# shared/ must be applied before staging/ or this returns null outputs.
data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "mythrun-terraform-state"
    key    = "environments/shared/terraform.tfstate"
    region = "us-east-1"
  }
}

locals {
  env = var.environment

  # Secrets populated manually via AWS Console/CLI. Placeholder initial version
  # is OK because app never reads these until values are set.
  manual_secret_names = [
    "anthropic-api-key",
    "stripe-secret-key",
    "stripe-webhook-secret",
    "cognito-client-secret",
  ]

  # Secrets populated by bootstrap-databases.sh (post-MYT-30). NO Terraform-
  # managed version resource — this avoids the landmine where
  # `terraform apply -replace` on a placeholder version would overwrite the
  # real password with PLACEHOLDER.
  bootstrap_secret_names = [
    "rds-password",
  ]
}

resource "aws_secretsmanager_secret" "manual_secrets" {
  for_each                = toset(local.manual_secret_names)
  name                    = "mythrun/${local.env}/${each.key}"
  description             = "Mythrun ${local.env} ${each.key} (value set via AWS Console/CLI out-of-band)"
  recovery_window_in_days = 7

  tags = { Name = "mythrun-${local.env}-${each.key}" }
}

resource "aws_secretsmanager_secret_version" "manual_secrets" {
  for_each      = aws_secretsmanager_secret.manual_secrets
  secret_id     = each.value.id
  secret_string = "PLACEHOLDER — set via AWS Console / CLI"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# rds-password: shell only. bootstrap-databases.sh creates the first version.
resource "aws_secretsmanager_secret" "bootstrap_secrets" {
  for_each                = toset(local.bootstrap_secret_names)
  name                    = "mythrun/${local.env}/${each.key}"
  description             = "Mythrun ${local.env} ${each.key} (value created by bootstrap-databases.sh; no Terraform-managed version to avoid overwrite-on-replace landmine)"
  recovery_window_in_days = 7

  tags = { Name = "mythrun-${local.env}-${each.key}" }
}
```

- [ ] **Step 4: Create `infra/environments/staging/outputs.tf`**

```hcl
output "manual_secret_arns" {
  value       = { for k, v in aws_secretsmanager_secret.manual_secrets : k => v.arn }
  description = "ARNs of the staging-scoped manually-populated secrets."
  sensitive   = true
}

output "bootstrap_secret_arns" {
  value       = { for k, v in aws_secretsmanager_secret.bootstrap_secrets : k => v.arn }
  description = "ARNs of secret shells to be populated by bootstrap-databases.sh."
  sensitive   = true
}
```

- [ ] **Step 5: Format + init + validate**

```bash
cd infra/environments/staging
terraform fmt
terraform init
terraform validate
cd ../../..
```

Expected: fmt may rewrite, init downloads provider, validate reports "Success!".

- [ ] **Step 6: `terraform plan`**

```bash
cd infra/environments/staging
terraform plan -out=staging.tfplan
cd ../../..
```

Expected: `Plan: 9 to add, 0 to change, 0 to destroy.` (4 `aws_secretsmanager_secret` manual + 4 `aws_secretsmanager_secret_version` manual + 1 `aws_secretsmanager_secret` rds-password = 9).

- [ ] **Step 7: Miklos approves — `terraform apply`**

```bash
cd infra/environments/staging
terraform apply staging.tfplan
cd ../../..
```

Expected: <1 min. `Apply complete! Resources: 9 added, 0 changed, 0 destroyed.`

- [ ] **Step 8: Verify secret shells exist**

```bash
aws secretsmanager list-secrets \
  --query "SecretList[?starts_with(Name, 'mythrun/staging/')].[Name]" --output text
```

Expected (5 lines, order may vary):
```
mythrun/staging/anthropic-api-key
mythrun/staging/cognito-client-secret
mythrun/staging/rds-password
mythrun/staging/stripe-secret-key
mythrun/staging/stripe-webhook-secret
```

- [ ] **Step 9: Verify `rds-password` has NO current version**

```bash
aws secretsmanager describe-secret --secret-id mythrun/staging/rds-password \
  --query 'VersionIdsToStages' --output text
```

Expected: empty (no `AWSCURRENT` stage yet — bootstrap-databases.sh will create it).

The manual secrets SHOULD have a `AWSCURRENT` version with the `PLACEHOLDER` string. Verify one:

```bash
aws secretsmanager get-secret-value --secret-id mythrun/staging/anthropic-api-key \
  --query 'SecretString' --output text
```

Expected: `PLACEHOLDER — set via AWS Console / CLI`.

- [ ] **Step 10: Idempotency gate**

```bash
cd infra/environments/staging
terraform plan
cd ../../..
```

Expected: `No changes.`

- [ ] **Step 11: Clean up the plan file**

```bash
rm infra/environments/staging/staging.tfplan
```

- [ ] **Step 12: Commit**

```bash
git add infra/environments/staging/
git commit -m "$(cat <<'EOF'
feat(infra): staging environment Terraform workspace

Reads shared/ state via data.terraform_remote_state for downstream consumers
(MYT-30 will wire ECS task env vars from these outputs). Creates:

- 4 manual secret shells (anthropic-api-key, stripe-secret-key,
  stripe-webhook-secret, cognito-client-secret) with placeholder versions;
  values populated via aws secretsmanager put-secret-value out-of-band.
- 1 bootstrap secret shell (rds-password) with NO Terraform-managed version
  to avoid the apply -replace landmine where a placeholder would overwrite
  the real password created by bootstrap-databases.sh.

All staging secrets have recovery_window_in_days = 7 to avoid 30-day
name lockout on destroy during iteration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: bootstrap-databases.sh script (created, not executed)

**Goal:** Write the script that creates per-env databases + users in RDS. Executed post-MYT-30 when an ECS run-task or SSM tunnel is available. Lives in the repo as an artifact.

**Files:**
- Create: `infra/scripts/bootstrap-databases.sh`
- Create: `infra/scripts/README.md`

### Steps

- [ ] **Step 1: Create `infra/scripts/bootstrap-databases.sh`**

```bash
#!/usr/bin/env bash
# Create per-env databases + app users inside the shared RDS instance, and
# write the generated password to mythrun/{env}/rds-password.
#
# MUST run from within the VPC (ECS run-task or SSM Session Manager tunnel) —
# RDS is not publicly accessible.
#
# Usage:
#   bootstrap-databases.sh --env staging [--verify | --user-only | --secret-only | --reset-password]
#
# Modes:
#   (default)         Create database + user + password secret. Idempotent.
#   --verify          Check current state without mutating. Prints one of:
#                     OK / DB_ONLY / USER_ONLY / SECRET_MISMATCH / MISSING
#   --user-only       DB exists but user doesn't: create user + password + secret.
#   --secret-only     DB + user exist but secret version missing or placeholder:
#                     ALTER USER password + write secret.
#   --reset-password  Everything exists but password is wrong: rotate it.
#
# Required env vars (injected via ECS task role):
#   AWS_REGION                us-east-1
#   RDS_MASTER_SECRET_ARN     ARN of the AWS-managed RDS master user secret
#                             (from shared workspace output: rds_master_user_secret_arn)

set -euo pipefail

ENV=""
MODE="default"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)            ENV="$2"; shift 2 ;;
    --verify)         MODE="verify"; shift ;;
    --user-only)      MODE="user-only"; shift ;;
    --secret-only)    MODE="secret-only"; shift ;;
    --reset-password) MODE="reset-password"; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$ENV" ]]; then
  echo "ERROR: --env required (staging or production)" >&2
  exit 2
fi

if [[ ! "$ENV" =~ ^(staging|production)$ ]]; then
  echo "ERROR: --env must be 'staging' or 'production', got '$ENV'" >&2
  exit 2
fi

: "${AWS_REGION:=us-east-1}"
: "${RDS_MASTER_SECRET_ARN:?RDS_MASTER_SECRET_ARN env var required}"

DB_NAME="mythrun_${ENV}"
DB_USER="mythrun_${ENV}"
APP_SECRET_ID="mythrun/${ENV}/rds-password"

# Fetch master credentials from Secrets Manager
MASTER_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$RDS_MASTER_SECRET_ARN" --region "$AWS_REGION" \
  --query SecretString --output text)
MASTER_USER=$(echo "$MASTER_JSON" | jq -r .username)
MASTER_PASS=$(echo "$MASTER_JSON" | jq -r .password)
RDS_HOST=$(echo "$MASTER_JSON" | jq -r .host)
RDS_PORT=$(echo "$MASTER_JSON" | jq -r .port)

# Base psql command; connects to the 'postgres' maintenance DB.
export PGPASSWORD="$MASTER_PASS"
PSQL_MASTER=(psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
             --dbname=postgres --no-password --tuples-only --no-align)

# --- verify mode ---
verify_state() {
  local db_exists user_exists secret_has_version

  db_exists=$("${PSQL_MASTER[@]}" -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME';" | tr -d '[:space:]' || true)
  user_exists=$("${PSQL_MASTER[@]}" -c "SELECT 1 FROM pg_user WHERE usename = '$DB_USER';" | tr -d '[:space:]' || true)
  secret_has_version=$(aws secretsmanager describe-secret --secret-id "$APP_SECRET_ID" \
    --region "$AWS_REGION" --query 'VersionIdsToStages' --output text 2>/dev/null || echo "")

  if [[ "$db_exists" == "1" && "$user_exists" == "1" && -n "$secret_has_version" ]]; then
    echo "OK"; return 0
  elif [[ "$db_exists" == "1" && "$user_exists" == "1" ]]; then
    echo "USER_ONLY"; return 0  # DB + user, but no secret version
  elif [[ "$db_exists" == "1" ]]; then
    echo "DB_ONLY"; return 0
  else
    echo "MISSING"; return 0
  fi
}

generate_password() {
  aws secretsmanager get-random-password \
    --password-length 32 \
    --exclude-characters '/@"'\''\' \
    --require-each-included-type \
    --query RandomPassword --output text
}

create_db_and_user() {
  local pw
  pw=$(generate_password)

  # Use psql --set to avoid interpolating the password into SQL directly.
  "${PSQL_MASTER[@]}" --set=app_pw="$pw" <<SQL
CREATE DATABASE $DB_NAME;
CREATE USER $DB_USER WITH PASSWORD :'app_pw';
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
REVOKE ALL PRIVILEGES ON DATABASE $DB_NAME FROM PUBLIC;
SQL

  aws secretsmanager put-secret-value \
    --secret-id "$APP_SECRET_ID" \
    --secret-string "$pw" \
    --region "$AWS_REGION" \
    >/dev/null

  echo "Created DB $DB_NAME, user $DB_USER, and populated $APP_SECRET_ID"
}

create_user_only() {
  local pw
  pw=$(generate_password)
  "${PSQL_MASTER[@]}" --set=app_pw="$pw" <<SQL
CREATE USER $DB_USER WITH PASSWORD :'app_pw';
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
SQL
  aws secretsmanager put-secret-value \
    --secret-id "$APP_SECRET_ID" --secret-string "$pw" --region "$AWS_REGION" >/dev/null
  echo "Created user $DB_USER and populated $APP_SECRET_ID"
}

rotate_password() {
  local pw
  pw=$(generate_password)
  "${PSQL_MASTER[@]}" --set=app_pw="$pw" <<SQL
ALTER USER $DB_USER WITH PASSWORD :'app_pw';
SQL
  aws secretsmanager put-secret-value \
    --secret-id "$APP_SECRET_ID" --secret-string "$pw" --region "$AWS_REGION" >/dev/null
  echo "Rotated password for $DB_USER and updated $APP_SECRET_ID"
}

# --- dispatch by mode ---
case "$MODE" in
  verify)
    verify_state
    ;;
  default)
    state=$(verify_state)
    case "$state" in
      OK)            echo "Nothing to do (already bootstrapped)." ;;
      MISSING)       create_db_and_user ;;
      DB_ONLY)       create_user_only ;;
      USER_ONLY)     rotate_password ;;
      *)             echo "ERROR: unexpected state '$state'" >&2; exit 1 ;;
    esac
    ;;
  user-only)    create_user_only ;;
  secret-only)  rotate_password ;;
  reset-password) rotate_password ;;
esac
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x infra/scripts/bootstrap-databases.sh
```

- [ ] **Step 3: Create `infra/scripts/README.md`**

```markdown
# infra/scripts

## bootstrap.sh

One-time bootstrap of the Terraform state S3 bucket.

Run once per AWS account, before any `terraform init`:

\`\`\`bash
bash infra/scripts/bootstrap.sh
\`\`\`

Idempotent — safe to re-run.

## bootstrap-databases.sh

Creates per-env databases and app users inside the shared RDS instance, and
populates `mythrun/{env}/rds-password`. **Must run from inside the VPC** (RDS
is not publicly accessible).

### Execution methods

Today (pre-MYT-30): no in-VPC compute exists. The script is an artifact only.

Post-MYT-30: run via one-shot ECS task:

\`\`\`bash
aws ecs run-task \
  --cluster mythrun \
  --task-definition mythrun-bootstrap-db \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[PRIVATE_A],securityGroups=[SG_ECS],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"bootstrap","command":["/app/bootstrap-databases.sh","--env","staging"]}]}'
\`\`\`

The task role needs:
- `secretsmanager:GetSecretValue` on the RDS master user secret ARN (from shared outputs)
- `secretsmanager:PutSecretValue` on `mythrun/{env}/rds-password` only
- Network path to RDS (join `sg-ecs`, place in `private-a` or `private-b`)

Scope the task role tightly. Revoke after use.

### Modes

- `--verify` — check current state. Prints `OK`, `DB_ONLY`, `USER_ONLY`, or `MISSING`.
- default — create whatever is missing. Idempotent.
- `--user-only` — DB exists but user doesn't. Create user + password.
- `--secret-only` / `--reset-password` — rotate the app user password.

### Recovery from partial failures

State reported by `--verify`:

- `OK` — nothing to do.
- `MISSING` — run the default (no flags). Creates DB + user + secret.
- `DB_ONLY` — run with `--user-only`.
- `USER_ONLY` — run with `--secret-only`. The DB user exists but we don't know its password. `--secret-only` rotates the password via `ALTER USER` and writes the new value to Secrets Manager.
```

- [ ] **Step 4: Shellcheck**

```bash
shellcheck infra/scripts/bootstrap-databases.sh || echo "shellcheck not installed; skipping"
```

Expected: no errors. If it flags SC2086 (quote to prevent globbing), review — some are intentional (`PSQL_MASTER` array expansion) and some need fixing.

- [ ] **Step 5: Commit**

```bash
git add infra/scripts/bootstrap-databases.sh infra/scripts/README.md
git commit -m "$(cat <<'EOF'
feat(infra): bootstrap-databases.sh for per-env DB + user creation

Creates mythrun_{env} database and mythrun_{env} app user inside the shared
RDS instance, generates a password via aws secretsmanager get-random-password
(AWS-side, not bash), and writes it to mythrun/{env}/rds-password.

Supports --verify (non-mutating state check with three named partial-failure
states: OK, DB_ONLY, USER_ONLY, MISSING) and recovery paths via --user-only,
--secret-only, --reset-password.

Uses psql --set to pass the password as a SQL variable, avoiding shell
interpolation into the CREATE USER statement (SQL injection safety if the
random password ever contains a character AWS's exclusion didn't catch).

NOT executed in MYT-25: RDS is in a private subnet; no in-VPC compute yet.
Exercised post-MYT-30 via one-shot ECS task (see infra/scripts/README.md).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final verification and close MYT-25

**Goal:** Full acceptance against the design's "Done when" criteria. Close MYT-25 in Linear. Push.

**Files:** (none created; verification + git push + Linear update)

### Steps

- [ ] **Step 1: Idempotency on both workspaces**

```bash
cd infra/environments/shared && terraform plan | tail -3
cd ../staging && terraform plan | tail -3
cd ../../..
```

Both should report: `No changes. Your infrastructure matches the configuration.`

- [ ] **Step 2: Full AWS-side verification**

```bash
# RDS
aws rds describe-db-instances --db-instance-identifier mythrun \
  --query 'DBInstances[0].[DBInstanceStatus,Engine,EngineVersion,MultiAZ,PubliclyAccessible,DeletionProtection,StorageEncrypted]' \
  --output text

# Redis
aws elasticache describe-replication-groups --replication-group-id mythrun-redis \
  --query 'ReplicationGroups[0].[Status,TransitEncryptionEnabled,AtRestEncryptionEnabled,TransitEncryptionMode]' \
  --output text

# Secrets — count the staging ones
aws secretsmanager list-secrets \
  --query "length(SecretList[?starts_with(Name, 'mythrun/staging/')])"

# Secrets — shared redis-auth
aws secretsmanager list-secrets \
  --query "SecretList[?Name=='mythrun/shared/redis-auth'].Name" --output text

# Secrets — AWS auto-managed master user secret exists
aws rds describe-db-instances --db-instance-identifier mythrun \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text
```

Expected:
- RDS: `available postgres 16.x false false true true`
- Redis: `available True True required`
- Staging secrets count: `5`
- Shared redis-auth: `mythrun/shared/redis-auth`
- Master user secret ARN: matches pattern `arn:aws:secretsmanager:us-east-1:...:secret:rds!db-...`

- [ ] **Step 3: External reachability test**

```bash
RDS_ENDPOINT=$(cd infra/environments/shared && terraform output -raw rds_endpoint)
REDIS_ENDPOINT=$(cd infra/environments/shared && terraform output -raw redis_endpoint)
nc -zv -w 5 "$RDS_ENDPOINT" 5432 2>&1 || echo "RDS blocked — expected"
nc -zv -w 5 "$REDIS_ENDPOINT" 6379 2>&1 || echo "Redis blocked — expected"
```

Expected: both timeouts. Private subnets are doing their job.

- [ ] **Step 4: Push everything**

```bash
git status
git push
```

Expected: push succeeds; all MYT-25 commits land on `origin/main`.

- [ ] **Step 5: Update MYT-25 state in Linear to Done**

Via MCP:

```
(Linear: save_issue id=MYT-25 state=Done)
```

Add a closing comment to the issue noting:
- All shared + staging resources applied successfully
- Both workspaces report `terraform plan = No changes`
- `mythrun/staging/rds-password` is still a shell (no current version) — intentional; bootstrap-databases.sh creates the first version post-MYT-30
- Est. ~$67/mo idle from now on

- [ ] **Step 6: Close the implementation plan's beads**

```bash
bd close <bead ids for all MYT-25 tasks>
bd stats
```

Verify all MYT-25 tasks report closed in `bd list`.

- [ ] **Step 7: Session close protocol**

Per CLAUDE.md's Session Close Protocol:

```bash
git status   # should be clean
git log --oneline origin/main..HEAD   # should be empty (pushed)
```

---

## Self-review

### Spec coverage

Each section of the design spec maps to a task:

- **Goal + Done when** (design §Goal, §Done when): Tasks 6 + 7 + 9 cover the apply + verification
- **Scope decisions** (design §Scope): correctly reflected in task scope (ALB/Route 53/ECS deferred)
- **Spec reconciliation rows**: all seven rows covered
  - Redis volatile-lru: Task 4 Step 4 (maxmemory-policy = volatile-lru)
  - Native S3 locking: Task 5 Step 1 (`use_lockfile = true`)
  - `manage_master_user_password`: Task 4 Step 3 (aws_db_instance block)
  - Redis AUTH at `mythrun/shared/redis-auth`: Task 4 Step 4 (aws_secretsmanager_secret.redis_auth)
  - Unconditional deletion protection: Task 4 Step 3 (deletion_protection, skip_final_snapshot, prevent_destroy)
  - Per-env DB bootstrap: Task 8 (bootstrap-databases.sh)
  - SG egress lockdown: Task 3 Step 2 (egress rules)
  - rds-password semantics: Task 7 Step 3 (bootstrap_secrets — shell only)
  - Backup retention: Task 4 Step 3 (backup_retention_period = 7)
- **Directory structure**: Task 1 creates skeleton; subsequent tasks populate
- **Network module contents**: Task 3
- **Data module contents**: Task 4
- **Environment composition**: Tasks 5 + 7
- **Bootstrap scripts**: Task 1 (bootstrap.sh) + Task 8 (bootstrap-databases.sh)
- **Handoff sequence**: documented in design; Task 8 README explicitly points forward to MYT-30 consumption
- **Verification checklist**: Task 9 covers every checkbox

### Placeholder scan

No TBDs, TODOs, "implement later," or "similar to Task N" patterns. Every code step has complete HCL or bash.

One intentional caveat: Task 4 Step 1 says "verify `log_connections` classification at implementation time" and Step 3 says "REMOVE THIS LINE if describe-engine-default-parameters reports dynamic." This is an explicit verification gate, not a placeholder.

### Type consistency

- `identifier = "mythrun"` appears once (Task 4) and is referenced by `aws rds describe-db-instances --db-instance-identifier mythrun` in Task 6 Step 5 and Task 9 Step 2. Consistent.
- `replication_group_id = "mythrun-redis"` appears once (Task 4) and is referenced by `aws elasticache describe-replication-groups --replication-group-id mythrun-redis` in Task 6 Step 6 and Task 9 Step 2. Consistent.
- Secret names use `mythrun/{env}/*` pattern (staging workspace) and `mythrun/shared/redis-auth` (shared). Task 9 verification greps for exactly these patterns. Consistent.
- Module input/output names match between `modules/network/outputs.tf` and `environments/shared/main.tf` module calls. Consistent.
- `random_password.redis_auth.result` referenced in `aws_secretsmanager_secret_version.redis_auth.secret_string` and `aws_elasticache_replication_group.main.auth_token`. All three use the same resource. Consistent.

### Scope check

Single-workspace plan, two Terraform workspaces applied sequentially. Fits a single implementation plan. No cross-cutting subsystem that would warrant decomposition.
