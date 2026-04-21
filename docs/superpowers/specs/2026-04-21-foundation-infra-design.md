# Foundation Infra (Network + Data) Design

> **Linear issue**: MYT-25
> **Milestone**: Ops Foundation (2026-04-27)
> **Date**: 2026-04-21
> **Status**: Design v2 — reviewed by agent team (Zero Cool, Acid Burn, Phreak, Cipher), findings verified against live AWS/Terraform docs, fixes incorporated

## Goal

Stand up the Terraform-managed AWS network and data substrate for Mythrun in `us-east-1`: VPC with public/private subnets across 2 AZs, NAT Gateway, security groups, PostgreSQL 16 via RDS, Redis 7.x via ElastiCache, and Secrets Manager entry shells for staging. No application workloads yet — that's MYT-30 (serving infra) + MYT-28 (first deploy).

## Done when

```bash
cd infra/environments/shared && terraform apply     # exits 0, all resources healthy
cd infra/environments/staging && terraform apply    # exits 0, Secrets Manager entries created
```

Plus:
- VPC exists with the topology in section 2.1 of `docs/specs/2026-04-07-week0-ops-foundation.md`
- RDS reports `available` status; `deletion_protection = true`; master password is AWS-managed via `master_user_secret`
- ElastiCache replication group reports `available` status; `transit_encryption_mode = required`
- Neither is reachable from outside the VPC (not publicly accessible, security groups locked down, explicit egress denied on `sg-rds`/`sg-redis`)
- 5 Secrets Manager entries under `mythrun/staging/*` with placeholder values (anthropic, stripe-secret, stripe-webhook, cognito, rds-password)
- 1 Secrets Manager entry at `mythrun/shared/redis-auth` with a generated AUTH token
- S3 state bucket has versioning + public-access-block + TLS-only bucket policy
- `terraform plan` run a second time reports "No changes" (idempotent)
- `scripts/bootstrap-databases.sh` exists in the repo (runs after MYT-30 provides in-VPC compute; not exercised in MYT-25)

## Parent specs

- `docs/specs/2026-04-06-production-architecture-overview.md` (constitution)
- `docs/specs/2026-04-07-week0-ops-foundation.md` (primary reference — §2 VPC, §3 Secrets, §7 Terraform structure)
- `docs/specs/2026-04-10-infrastructure-devops.md` (primary reference — §5 RDS, §6 ElastiCache)

---

## Scope decisions

**Included in MYT-25:**
- VPC, subnets, IGW, NAT Gateway, route tables, 4 security groups (all in the `network` module)
- RDS Postgres instance with parameter group and subnet group
- ElastiCache Redis replication group with parameter group and subnet group
- Secrets Manager secret shells for staging
- Tagging conventions applied via provider default tags
- Bootstrap script for the Terraform state S3 bucket

**Explicitly deferred:**
- ALB, ACM certs, Route 53 records, target groups → MYT-30 (Serving infra)
- ECS cluster, ECR repo, IAM roles, GitHub Actions OIDC → MYT-30
- CloudWatch log groups, alarms, SNS topics → MYT-30 (part of observability module per Week 0 §7.1)
- Production environment workspace → added in Launch milestone
- Manual secret value population → Miklos does this post-apply via AWS Console / CLI
- RDS Proxy → deferred until 6+ concurrent ECS containers (per Architecture Overview Decisions Log)
- Multi-AZ for RDS and Redis → deferred until revenue justifies ~$25-37/mo extra (per Infra spec §8.1)

---

## Spec reconciliation

Places where this design deviates from the older specs:

| Topic | Older spec | This design | Why |
|---|---|---|---|
| Redis `maxmemory-policy` | `noeviction` (Architecture Overview §3) | `volatile-lru` (Infrastructure & DevOps §6.2) | Newer spec has explicit rationale. `noeviction` risks cascading failure under memory pressure (every write fails including BullMQ, rate limiting, pub/sub). `volatile-lru` evicts idle session states (which have TTLs and can be reloaded from Postgres checkpoints) before critical no-TTL keys. |
| Terraform state locking | DynamoDB lock table (Week 0 §7.3) | Native S3 locking (`use_lockfile = true`) | Terraform 1.10+ supports native S3 locking. DynamoDB-based locking is deprecated. One fewer AWS resource to provision, one fewer thing to break. |
| RDS password management | Secrets Manager rotation Lambda, initial password in Secrets Manager (Week 0 §3.1) | `manage_master_user_password = true` (AWS-managed) | AWS RDS now natively integrates with Secrets Manager — rotation handled by AWS, password never touches Terraform state. Cleaner than the Lambda rotation pattern. |
| Redis AUTH secret location | `mythrun/{env}/redis-auth` per env (Week 0 §3.1) | `mythrun/shared/redis-auth` (single copy) | Redis itself is shared between staging and production per Week 0 §2.5. One token, both environments. Name matches the original spec (`redis-auth`) to preserve env-var mapping continuity (Infra §2.3). Each env's ECS task role (MYT-30) will get explicit read access to this shared secret. |
| Deletion protection on shared RDS | Per-env toggle (staging off, prod on) | Unconditionally `deletion_protection = true`, `skip_final_snapshot = false`, `lifecycle { prevent_destroy = true }` (v2 revision) | Staging and prod share one instance. "Staging can be destroyed freely" doesn't apply when that same instance holds prod data. Hardening the shared instance protects both envs; staging-specific ephemeral operations are done at the DB level (drop and recreate `mythrun_staging` database), not the instance level. |
| Per-env database + user creation | Implied but unaddressed | Explicit `scripts/bootstrap-databases.sh` run against the shared RDS after Terraform applies (v2 addition) | Backend Core's migration runner connects to an existing database — it does not `CREATE DATABASE` or `CREATE USER`. Someone has to create `mythrun_staging` and `mythrun_prod` databases + their users before migrations run. MYT-25 provides the script; Backend Core consumes it. |

---

## Directory structure

```
infra/
├── scripts/
│   ├── bootstrap.sh                # One-time: create S3 state bucket (idempotent)
│   └── bootstrap-databases.sh      # After first shared/ apply: CREATE DATABASE + CREATE USER for each env
├── modules/
│   ├── network/                    # NOTE: will grow in MYT-30 (ALB, listeners, target groups, ACM)
│   │   ├── main.tf                 # VPC, subnets, IGW, NAT, route tables, 4 SGs with explicit egress
│   │   ├── variables.tf            # vpc_cidr, azs, environment
│   │   └── outputs.tf              # All IDs needed by downstream modules/envs
│   └── data/
│       ├── main.tf                 # RDS (with param group + subnet group), ElastiCache (same), Redis AUTH secret
│       ├── variables.tf            # vpc_id, private_subnet_ids, rds_sg_id, redis_sg_id, sizing params
│       └── outputs.tf              # rds_endpoint, rds_port, redis_endpoint, redis_port, redis_auth_secret_arn, rds_master_user_secret_arn
└── environments/
    ├── shared/                     # Owns VPC + SGs + RDS + Redis + shared secrets
    │   ├── backend.tf              # state key: environments/shared/terraform.tfstate; required_version >= 1.10
    │   ├── main.tf                 # Calls network module, then data module
    │   ├── variables.tf            # environment="shared", region, vpc_cidr, azs
    │   └── outputs.tf              # Re-exports everything downstream envs need
    └── staging/                    # Owns staging-scoped Secrets Manager shells (non-DB app secrets)
        ├── backend.tf              # state key: environments/staging/terraform.tfstate; required_version >= 1.10
        ├── main.tf                 # data.terraform_remote_state.shared + mythrun/staging/* secrets
        ├── variables.tf
        └── outputs.tf
```

`production/` will be added to `environments/` later (Launch milestone) — a near-mirror of `staging/` that points at `mythrun/production/*` secret names and references the same shared state.

---

## Network module

Resources created by `modules/network/main.tf`:

**VPC**
- `aws_vpc.main` — CIDR `10.0.0.0/16`, DNS support + DNS hostnames enabled (required for RDS/ElastiCache internal DNS).

**Subnets** (each in a specific AZ per Week 0 §2.1):
- `aws_subnet.public_a` — `10.0.1.0/24` in `us-east-1a`
- `aws_subnet.public_b` — `10.0.2.0/24` in `us-east-1b`
- `aws_subnet.private_a` — `10.0.10.0/24` in `us-east-1a`
- `aws_subnet.private_b` — `10.0.20.0/24` in `us-east-1b`

**Internet Gateway + NAT**
- `aws_internet_gateway.main`
- `aws_eip.nat` — Elastic IP for NAT Gateway
- `aws_nat_gateway.main` — in `public_a` subnet

**Route tables**
- `aws_route_table.public` — default route → IGW. Associated with both public subnets.
- `aws_route_table.private` — default route → NAT. Associated with both private subnets.
  - Note (per Week 0 §2.1): when a second NAT Gateway is added for AZ redundancy, `private_b` will need its own route table. Module inputs should make this a future parameter change, not a refactor.

**Security groups** (per Week 0 §2.3, with explicit egress hardening per Acid Burn review):

| SG | Inbound | Egress | Purpose |
|---|---|---|---|
| `aws_security_group.alb` | 443 from `0.0.0.0/0`; 80 from `0.0.0.0/0` (redirect) | All (ALB proxies to ECS) | ALB (used by MYT-30) |
| `aws_security_group.ecs` | 3000 from `alb` | 443 to `0.0.0.0/0` (Anthropic, Stripe, ECR, Secrets Manager); 5432 to `rds`; 6379 to `redis` | ECS tasks (used by MYT-30) |
| `aws_security_group.rds` | 5432 from `ecs` | **None** | RDS — no outbound needed |
| `aws_security_group.redis` | 6379 from `ecs` | **None** | Redis — no outbound needed |

Each rule is a separate `aws_vpc_security_group_ingress_rule` / `aws_vpc_security_group_egress_rule` resource (not the legacy inline blocks) for granular updates. Terraform creates `aws_security_group` resources with no default rules and we add every rule explicitly — this prevents the AWS default "allow all egress" from silently landing on `sg-rds` / `sg-redis`.

**Why lock down RDS/Redis egress:** defense-in-depth. Neither service needs to reach the internet. If a future SG misconfiguration exposed these, or if AWS developed a vulnerability that let workloads connect outbound from RDS/Redis, this is a tripwire.

Note: `sg-alb` and `sg-ecs` are created in MYT-25 but not used by any resource until MYT-30. SGs can exist before anything is attached — creating them now lets `sg-rds`/`sg-redis` ingress rules reference them, and means MYT-30 only needs to reference IDs.

**Module outputs:**
- `vpc_id`
- `public_subnet_ids` (list)
- `private_subnet_ids` (list)
- `alb_sg_id`, `ecs_sg_id`, `rds_sg_id`, `redis_sg_id`
- `nat_gateway_id` (for later reference if we add a second)

---

## Data module

Resources created by `modules/data/main.tf`:

### RDS PostgreSQL

Per Infrastructure & DevOps §5, incorporating Zero Cool / Acid Burn / Phreak fixes:

- `aws_db_subnet_group.main` — spans `private_a` + `private_b`.
- `aws_db_parameter_group.main` — family `postgres16`, parameters from §5.2:
  - Dynamic (apply immediately):
    - `log_min_duration_statement = 1000` (log queries >1s)
    - `log_disconnections = on`
    - `idle_in_transaction_session_timeout = 60000`
    - `statement_timeout = 30000`
    - `random_page_cost = 1.1`
    - `work_mem = 2MB`
    - `maintenance_work_mem = 64MB`
    - `rds.force_ssl = 1` (v2 addition per Acid Burn — refuse non-TLS connections server-side)
  - **Static (require `apply_method = "pending-reboot"`)**:
    - `max_connections = 80`
    - `log_connections = on`
    - `shared_buffers = "{DBInstanceClassMemory/4}"` (explicit for clarity; can be omitted to use RDS's default formula)
  - `effective_cache_size` uses RDS's default formula `{DBInstanceClassMemory*3/4}` — no explicit override

  **Implementation note on static parameters:** at implementation time, verify parameter classification via `aws rds describe-engine-default-parameters --db-parameter-group-family postgres16 --query "EngineDefaults.Parameters[?ParameterName=='<name>'].[ApplyType]"`. Anything classified as `static` needs `apply_method = "pending-reboot"` in the Terraform resource block, or the first apply will fail with `InvalidParameterCombination: cannot use an apply method of immediate`.

- `aws_db_instance.main`:
  - `identifier = "mythrun"` (v2 addition per Zero Cool — explicit so verification commands can grep for it)
  - `engine = "postgres"`, `engine_version = "16"` (v2: partial major version per Zero Cool + Phreak; AWS picks latest 16.x minor)
  - `auto_minor_version_upgrade = true` (let AWS patch minors during maintenance window)
  - `lifecycle { ignore_changes = [engine_version] }` (v2: prevent Terraform from fighting AWS about auto-patched minor versions — known drift issue in provider)
  - `lifecycle { prevent_destroy = true }` (v2 addition — blocks accidental `terraform destroy` on the shared instance)
  - `instance_class = "db.t4g.micro"`
  - `multi_az = false`
  - `storage_type = "gp3"`, `allocated_storage = 20`, `max_allocated_storage = 50`
  - `backup_retention_period = 7`, `backup_window = "02:00-02:30"`, `maintenance_window = "sun:03:00-sun:04:00"` (v2: tightened backup window to `02:00-02:30` leaving a 30-min gap before the maintenance window — avoids AWS validation edge cases with abutting windows)
  - `deletion_protection = true` (v2 revision — unconditionally on; see spec reconciliation row for rationale)
  - `skip_final_snapshot = false` (v2 revision — unconditional; staging ephemeral operations happen at the database level, not the instance level)
  - `performance_insights_enabled = true`, `performance_insights_retention_period = 7`
  - `storage_encrypted = true` (AWS-managed KMS key for MYT-25; CMK deferred to hardening sweep — see Out of Scope)
  - `publicly_accessible = false`
  - `db_subnet_group_name = aws_db_subnet_group.main.name`
  - `vpc_security_group_ids = [var.rds_sg_id]`
  - `parameter_group_name = aws_db_parameter_group.main.name`
  - **`manage_master_user_password = true`** — AWS provisions the password, stores it in a Secrets Manager secret it creates automatically, rotates it per RDS defaults. Password never enters Terraform state.
  - `username = "mythrun_admin"` (v2 fix per Zero Cool: correct argument name is `username`, not `master_username`)
  - `db_name` — **not set here.** The per-environment databases (`mythrun_staging`, `mythrun_prod`) are created by `scripts/bootstrap-databases.sh` after Terraform applies. RDS itself gets created with only the default Postgres `postgres` database.
  - `apply_immediately = false` (batch parameter changes into maintenance windows by default)

### ElastiCache Redis

Per Infrastructure & DevOps §6, incorporating Zero Cool fixes:

- `aws_elasticache_subnet_group.main` — spans `private_a` + `private_b`.
- `aws_elasticache_parameter_group.main` — family `redis7`, parameters from §6.2:
  - `maxmemory-policy = "volatile-lru"`
  - `timeout = "0"`
  - `tcp-keepalive = "300"`
  - (v2 fix per Zero Cool I5: removed `notify-keyspace-events = ""` — setting a parameter to its default value can cause perpetual diff plans as ElastiCache's describe API reports the param as "not user-modified" while Terraform still tracks it. If we want the default, omit the block.)
- `random_password.redis_auth` — 32 characters, `special = true`, `override_special = "!&#$^<>-"` (v2 fix per Zero Cool I3: ElastiCache AUTH tokens restrict nonalphanumeric chars to `! & # $ ^ < > -` only; excluded chars are `@ " /`. The `override_special` argument in `random_password` specifies which special chars are **allowed**, not excluded).
- `aws_secretsmanager_secret.redis_auth` — name `mythrun/shared/redis-auth` (v2: renamed from `redis-auth-token` to match Week 0 §3.1 env-var naming convention). Lives in shared scope (not `mythrun/{env}/redis-auth`) because Redis itself is shared across staging + production. **Implication for MYT-30:** each env's ECS task role will need read access to `mythrun/shared/redis-auth` in addition to its own `mythrun/{env}/*` scope.
- `aws_secretsmanager_secret_version.redis_auth` — stores `random_password.redis_auth.result`. `lifecycle { ignore_changes = [secret_string] }` (v2 addition per Zero Cool M3 — prevents Terraform from overwriting the value if rotated out-of-band later).
- `aws_elasticache_replication_group.main`:
  - `replication_group_id = "mythrun-redis"`
  - `description = "Mythrun shared Redis (staging + prod)"`
  - `engine = "redis"`, `engine_version = "7.1"` (confirm latest available via `aws elasticache describe-cache-engine-versions --engine redis --region us-east-1` during implementation)
  - `node_type = "cache.t4g.micro"`
  - `num_cache_clusters = 1` (single node; scale to 2 for replica later)
  - `automatic_failover_enabled = false` (requires ≥2 nodes)
  - `at_rest_encryption_enabled = true`
  - `transit_encryption_enabled = true`
  - `transit_encryption_mode = "required"` (v2 addition per Zero Cool I4 — explicit even though greenfield default matches)
  - `auth_token = random_password.redis_auth.result`
  - `auth_token_update_strategy = "SET"` (v2 fix per Zero Cool C3: provider v6 requires this argument when `auth_token` is set; `SET` is correct for initial creation, `ROTATE` is for replacing an existing token)
  - `subnet_group_name = aws_elasticache_subnet_group.main.name`
  - `security_group_ids = [var.redis_sg_id]`
  - `parameter_group_name = aws_elasticache_parameter_group.main.name`
  - `maintenance_window = "mon:03:00-mon:04:00"`
  - `snapshot_retention_limit = 1`
  - `lifecycle { prevent_destroy = true }` (v2 addition — matches RDS posture; Redis is shared between envs)

Note on replication group vs cluster mode: we use a **replication group with 1 cluster** rather than a plain `aws_elasticache_cluster` because replication group is the only path that supports in-place scale-out to a replica later without recreating the resource. This is the AWS-recommended pattern even for single-node Redis when you anticipate growth.

### Secrets Manager — shared (data module)

Two secrets live alongside the shared data resources:

- `aws_secretsmanager_secret.redis_auth` + version — Redis AUTH token, populated from `random_password`.
- The RDS master user secret is auto-created by AWS due to `manage_master_user_password = true`; we expose its ARN as a data-module output.

**Module outputs** (v2 fix per Zero Cool I2 — `master_user_secret` is a list attribute, indexed access required):

```hcl
output "rds_endpoint" {
  value = aws_db_instance.main.endpoint
}
output "rds_port" {
  value = aws_db_instance.main.port
}
output "rds_master_user_secret_arn" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
  # Note: master_user_secret is a list of blocks, hence [0] — common mistake to treat it as scalar
}
output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}
output "redis_port" {
  value = aws_elasticache_replication_group.main.port
}
output "redis_auth_secret_arn" {
  value = aws_secretsmanager_secret.redis_auth.arn
}
```

---

## Environment composition

### `environments/shared/main.tf`

Calls both modules:

```hcl
module "network" {
  source       = "../../modules/network"
  environment  = "shared"
  vpc_cidr     = "10.0.0.0/16"
  azs          = ["us-east-1a", "us-east-1b"]
}

module "data" {
  source              = "../../modules/data"
  environment         = "shared"
  private_subnet_ids  = module.network.private_subnet_ids
  rds_sg_id           = module.network.rds_sg_id
  redis_sg_id         = module.network.redis_sg_id
}
```

`shared/outputs.tf` re-exports outputs from both modules so other environments can read them via remote state.

### `environments/staging/main.tf`

Reads shared, then creates staging-scoped Secrets Manager entries:

```hcl
data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "mythrun-terraform-state"
    key    = "environments/shared/terraform.tfstate"
    region = "us-east-1"
  }
}

locals {
  env = "staging"
  secret_names = [
    "anthropic-api-key",
    "stripe-secret-key",
    "stripe-webhook-secret",
    "cognito-client-secret",
    "rds-password",  # v2 addition per Cipher: populated by bootstrap-databases.sh with the per-env app user password
  ]
}

resource "aws_secretsmanager_secret" "app_secrets" {
  for_each = toset(local.secret_names)
  name     = "mythrun/${local.env}/${each.key}"
  description = "Mythrun ${local.env} ${each.key} (value set out-of-band via bootstrap script or AWS Console)"
}

resource "aws_secretsmanager_secret_version" "app_secrets" {
  for_each      = aws_secretsmanager_secret.app_secrets
  secret_id     = each.value.id
  secret_string = "PLACEHOLDER — set via bootstrap-databases.sh (rds-password) or AWS Console (others)"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
```

Note: the Redis AUTH token and the RDS *master* user secret are NOT listed here — they live at `mythrun/shared/*` (managed by the data module) because the data infrastructure is shared. The `rds-password` here is for the per-env app user (`mythrun_staging`), distinct from the master user.

The five secrets in staging's list are per-environment because staging uses test-mode credentials (Stripe `sk_test_*`, separate Cognito user pool) while production uses live credentials. `rds-password` is per-env because each env has its own DB user (`mythrun_staging` vs `mythrun_prod`).

---

## Bootstrap scripts

### `infra/scripts/bootstrap.sh` — state bucket (v2: hardened with bucket policy)

```bash
#!/usr/bin/env bash
set -euo pipefail

BUCKET="mythrun-terraform-state"
REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "Bootstrapping Terraform state bucket in $REGION..."

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

# v2 addition: require TLS for all S3 requests to this bucket (Acid Burn I1)
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

# Tag the bucket
aws s3api put-bucket-tagging \
  --bucket "$BUCKET" \
  --tagging 'TagSet=[{Key=Project,Value=mythrun},{Key=ManagedBy,Value=manual},{Key=Environment,Value=shared}]'

echo "Done. SSE-S3 encryption is on by default (AWS default since Jan 2023)."
echo "Native S3 state locking is configured via use_lockfile=true in backend.tf (Terraform >=1.10)."
```

Dropped from Week 0 spec: the DynamoDB lock table block. Native S3 locking replaces it.

### `infra/scripts/bootstrap-databases.sh` — per-env DBs + users (v2 addition per Cipher)

**Purpose:** create `mythrun_staging` and `mythrun_prod` databases + their per-env users inside the shared RDS instance. Backend Core's migration runner expects these to exist; it connects via `DATABASE_URL` and runs schema migrations — it does NOT run `CREATE DATABASE` / `CREATE USER`.

**When to run:** once, after the first `terraform apply` on `shared/` succeeds and RDS is `available`. Before Backend Core's first migration.

**How to run (private subnet caveat):** RDS is in a private subnet, so the script can't be run directly from Miklos's laptop. Two options:

1. **Via ECS run-task (preferred once MYT-30 lands):** run the SQL from an ephemeral Fargate task in the same VPC. Clean, reproducible.
2. **Via SSM Session Manager (viable today):** open an SSM tunnel to RDS from a local shell. This requires an SSM-enabled EC2 instance or the AWS Client VPN — neither exists yet in MYT-25.

**Practical path for MYT-25:** the script lives in the repo but is not executed as part of the apply. It's a documented artifact. Its first actual execution happens when Backend Core lands and we have an ECS task to run it from. Until then, there's no traffic on the DB and the empty state is fine.

**SQL** (invoked by the script, parameterized by env):

```sql
-- Connect to the 'postgres' maintenance DB first, then:
CREATE DATABASE mythrun_staging;
CREATE USER mythrun_staging WITH PASSWORD '<generated>';
GRANT ALL PRIVILEGES ON DATABASE mythrun_staging TO mythrun_staging;
REVOKE ALL PRIVILEGES ON DATABASE mythrun_staging FROM PUBLIC;

-- Repeat for mythrun_prod when the Launch milestone lands.
```

**Per-env passwords:** generated at bootstrap time, written to `mythrun/{env}/rds-password` secrets created by the per-env Terraform workspace (the staging workspace gets a new `rds-password` shell added — see updated staging main.tf below). The bootstrap script writes the value via `aws secretsmanager put-secret-value`.

---

## Tagging

Applied globally via the provider's `default_tags`:

```hcl
provider "aws" {
  region  = var.region
  profile = "default"

  default_tags {
    tags = {
      Project     = "mythrun"
      Environment = var.environment   # "shared", "staging", or "production"
      ManagedBy   = "terraform"
    }
  }
}
```

Every Terraform-managed resource inherits these tags without per-resource plumbing.

Resources created outside Terraform (the S3 state bucket, set by `bootstrap.sh`) get `ManagedBy=manual` to distinguish them.

---

## Apply order

**One-time bootstrap (per machine):**
1. Confirm AWS CLI is logged in (`aws sts get-caller-identity`).
2. `bash infra/scripts/bootstrap.sh` — creates the state bucket with versioning, public-access-block, and TLS-only bucket policy.

**First MYT-25 provision:**
3. `cd infra/environments/shared && terraform init`
4. `terraform plan` — review output. Expect ~35-40 resources.
5. `terraform apply` — ~10-15 min (RDS provisioning is the long pole; ElastiCache ~5 min; VPC-layer resources <1 min).
6. `cd ../staging && terraform init`
7. `terraform plan` — expect 10 resources (5 secrets × 2 resources each: the secret + its placeholder version).
8. `terraform apply` — <1 min.

**Populate secret values** (human action, outside Terraform):

```bash
# App secrets — set by hand
aws secretsmanager put-secret-value \
  --secret-id mythrun/staging/anthropic-api-key \
  --secret-string "sk-ant-..."
# Repeat for stripe-secret-key, stripe-webhook-secret, cognito-client-secret

# rds-password — populated by bootstrap-databases.sh (runs later, see below)
```

Or via the AWS Console → Secrets Manager → click each secret → "Set secret value".

**Per-env databases + users** (runs later, not part of `terraform apply`):

The `infra/scripts/bootstrap-databases.sh` script creates `mythrun_staging` (database + user) inside the shared RDS instance. It's not run during MYT-25 because the shared RDS is in a private subnet and there's no compute in the VPC yet to reach it. The script is exercised when Backend Core lands — typically from a one-off ECS run-task invocation, which becomes possible after MYT-30 provides the cluster. Until then, the DB sits empty and that's correct — no app connects to it yet.

If immediate end-to-end verification is needed before MYT-30, the script can be run via an SSM Session Manager tunnel (requires an SSM-enabled jump instance, deferred).

**Verify:**
```bash
# Shared workspace
aws rds describe-db-instances --query 'DBInstances[?DBInstanceIdentifier==`mythrun`].[DBInstanceStatus]' --output text
# Expected: available

aws elasticache describe-replication-groups --replication-group-id mythrun-redis \
  --query 'ReplicationGroups[0].Status' --output text
# Expected: available

# Staging workspace
aws secretsmanager list-secrets --query 'SecretList[?starts_with(Name, `mythrun/staging/`)].[Name]' --output text
# Expected: 5 entries (anthropic-api-key, stripe-secret-key, stripe-webhook-secret, cognito-client-secret, rds-password)

# Shared workspace secrets
aws secretsmanager list-secrets --query 'SecretList[?starts_with(Name, `mythrun/shared/`)].[Name]' --output text
# Expected: 1 entry (redis-auth); the RDS master user secret is under AWS auto-generated name rds!db-*
```

**Idempotency check:**
```bash
cd infra/environments/shared && terraform plan  # Expected: "No changes"
cd ../staging && terraform plan                  # Expected: "No changes"
```

---

## Cost impact

Based on Infrastructure & DevOps §1 service inventory, running MYT-25 resources 24/7 costs roughly (v2 revision per Phreak):

| Resource | Monthly |
|---|---|
| NAT Gateway (1 × public-a) | ~$32.85 |
| NAT Gateway data transfer | ~$0 pre-app-deploy, ~$3-9/mo steady-state once apps run (Anthropic streaming + ECR pulls + Secrets Manager) |
| RDS `db.t4g.micro` Single-AZ + 20 GB gp3 | ~$14.71 ($12.41 instance + $2.30 storage) |
| RDS automated backups (7-day, 20 GB) | $0 (free up to 100% of provisioned storage) |
| ElastiCache `cache.t4g.micro` single-node | ~$11.68 |
| Secrets Manager (7 secrets: 5 staging + 1 shared redis-auth + 1 RDS master auto-created) | ~$2.80 ($0.40/secret/month) |
| **Elastic IP for NAT Gateway** | **~$3.65** (v2 fix: AWS began charging $0.005/hr for all public IPv4 Feb 2024, attached or not) |
| Performance Insights (7-day retention) | $0 (free tier — bumping to long-term would add ~$7/mo per vCPU) |
| VPC / subnets / route tables / SGs | $0 |
| S3 state bucket | <$0.05 |
| **Total idle** | **~$66/mo** |
| **Steady-state once apps deploy** | **~$75-85/mo** (NAT data transfer dominates the variance) |

Staging + production share these resources per Week 0 §2.5, so prod adds only marginal cost (more secrets, more NAT traffic). Well within the $200 AWS budget alarm.

**First actual AWS spend begins at `terraform apply` time.** This is the first resource-creating ticket in the entire project — a billing inflection point.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `terraform apply` fails mid-way (partial state) | Medium | Terraform is idempotent — re-run resolves most partial states. For truly stuck resources, `terraform state rm` + manual cleanup. |
| AWS provider version drift breaks config | Low | Pin `hashicorp/aws = "~> 6.0"` and `hashicorp/random = "~> 3.6"` in `required_providers`. Pin `required_version = ">= 1.10"` in `backend.tf` (v2 additions). |
| RDS master password lost/leaked | Low | `manage_master_user_password = true` means AWS owns rotation. Password is never in Terraform state. If we lose access, RDS can rotate on demand. |
| **Redis AUTH token exposure via state file** | Medium | `random_password.redis_auth.result` DOES live in Terraform state. State bucket has: SSE-S3 encryption, public-access-block, TLS-only bucket policy. Access controlled via the deploying IAM identity's permissions. **Hardening follow-up (deferred):** evaluate ElastiCache IAM authentication as a replacement for AUTH tokens in the Observability & Hardening milestone. |
| ElastiCache Redis version mismatch (local vs prod) | Medium | Implementation step: run `aws elasticache describe-cache-engine-versions --engine redis --region us-east-1` and use the latest 7.x available (likely 7.1). Update `docker-compose.yml` `redis:7.2-alpine` → the matching version. |
| **`terraform destroy` on shared deletes production data** | High (if run accidentally) | **v2 revision:** `deletion_protection = true` unconditionally on shared RDS + Redis, `skip_final_snapshot = false`, `lifecycle { prevent_destroy = true }` on both resources. Staging-level ephemeral operations happen at the DB level (drop and recreate `mythrun_staging` database), not the instance. |
| Someone edits a secret value via console, Terraform overwrites it | Low | `lifecycle { ignore_changes = [secret_string] }` on every `aws_secretsmanager_secret_version`. |
| Cost creep from forgotten resources | Low | Every resource tagged with `Project=mythrun` + `Environment`. AWS Budgets alarm at $200 (already configured). |
| First apply takes longer than estimated | Medium | RDS can take 10+ min. Just wait. Don't cancel mid-apply. |
| Static RDS parameters cause first apply to fail | Low | `apply_method = "pending-reboot"` explicitly set on `max_connections`, `log_connections`, `shared_buffers` (v2 fix per Zero Cool I1). |
| Per-env DBs missing when Backend Core's migrations run | Medium | `scripts/bootstrap-databases.sh` documented and exercised before Backend Core's first migration (v2 fix per Cipher). |

---

## Verification checklist (for implementation)

After `terraform apply` completes on both workspaces:

- [ ] `aws rds describe-db-instances --db-instance-identifier mythrun` shows `available`
- [ ] RDS instance has Performance Insights enabled (7-day retention)
- [ ] RDS storage is encrypted, `publicly_accessible = false`
- [ ] `manage_master_user_password = true` is reflected (`MasterUserSecret.SecretArn` populated)
- [ ] RDS `deletion_protection = true`, `skip_final_snapshot = false` (verified via describe output)
- [ ] RDS parameter group has `rds.force_ssl = 1` applied
- [ ] `aws elasticache describe-replication-groups --replication-group-id mythrun-redis` shows `available`
- [ ] Redis has `TransitEncryptionEnabled: true`, `AtRestEncryptionEnabled: true`, `TransitEncryptionMode: required`
- [ ] Redis parameter group shows `maxmemory-policy: volatile-lru`, `timeout: 0`, `tcp-keepalive: 300`
- [ ] 5 `mythrun/staging/*` secrets exist with placeholder values (anthropic, stripe-secret, stripe-webhook, cognito, rds-password)
- [ ] `mythrun/shared/redis-auth` exists with a `random_password`-generated value (32 chars, from allowed set `!&#$^<>-` plus alphanumerics)
- [ ] Security groups verified:
  - `sg-rds` ingress: only 5432 from `sg-ecs`; egress: none
  - `sg-redis` ingress: only 6379 from `sg-ecs`; egress: none
  - `sg-ecs` egress: 443 to `0.0.0.0/0`, 5432 to `sg-rds`, 6379 to `sg-redis`
- [ ] State bucket has TLS-only bucket policy (`aws s3api get-bucket-policy --bucket mythrun-terraform-state`)
- [ ] From outside the VPC, RDS and Redis endpoints do NOT respond (test: `nc -zv <endpoint> 5432` from local machine should time out)
- [ ] `terraform plan` on both workspaces reports "No changes" (true idempotency — critical gate for design correctness)

---

## Out of scope (explicit deferrals)

| Item | Deferred to |
|---|---|
| ECS cluster, ECR, task definitions | MYT-30 (Serving infra) |
| ALB, ACM certs, target groups, listener rules | MYT-30 |
| GitHub Actions OIDC role | MYT-30 |
| Route 53 hosted zone + records | MYT-26 (Route 53 cutover) |
| CloudWatch log groups + alarms + SNS topics | MYT-30 (observability module) |
| Production environment workspace | Launch milestone |
| RDS Proxy | Scale-up trigger: 6+ containers |
| Multi-AZ for RDS and Redis | Revenue justification |
| Second NAT Gateway for AZ redundancy | AZ-outage tolerance requirement |
| Database migrations and schema | Backend Core milestone |
| Execution of `bootstrap-databases.sh` (needs VPC compute) | After MYT-30 provides ECS cluster (or SSM bastion earlier if needed) |
| Secret value population (AWS Console / CLI step) | Post-apply human task |
| Connection pooling configuration in app | Backend Core milestone |
| **Customer-managed KMS keys (CMK)** for RDS/Redis/Secrets Manager encryption | Hardening sweep (pre-launch) — deferred per Acid Burn C5; AWS-managed keys used for MYT-25. Retrofitting CMK requires re-encryption. |
| **Dedicated Terraform deployer IAM role** (assume-role pattern) | Security hardening ticket — deferred per Acid Burn I7; today's deployer is the SSO `default` profile. |
| **VPC endpoints** (ECR, S3, Secrets Manager) to reduce NAT traffic | Cost/hardening optimization — deferred; NAT is cheaper at current scale per Phreak. |
| **State bucket noncurrent version expiration** and MFA delete | Hardening sweep — deferred; versioning stays unbounded for now (state history is valuable). |
| **ElastiCache IAM authentication** (replaces AUTH token) | Observability & Hardening milestone — evaluate as replacement for AUTH token in state. |
| **OCI labels on Docker images** (scaffold concern, not infra) | MYT-30 deploy workflow — already tracked in `myth-37p`. |

---

## Sources

**Mythrun specs:**
- `docs/specs/2026-04-06-production-architecture-overview.md` (§3, §4, §7, Decisions Log)
- `docs/specs/2026-04-07-week0-ops-foundation.md` (§2 VPC, §3 Secrets, §7 Terraform structure)
- `docs/specs/2026-04-10-infrastructure-devops.md` (§5 RDS, §6 ElastiCache, §8 scale-up triggers)
- `docs/specs/2026-04-13-backend-core.md` (§3 migration runner — informs rds-password/per-env DB handoff)
- `docs/superpowers/specs/2026-04-21-monorepo-scaffold-design.md` (prior scaffold spec — reference for patterns)
- Memory: `reference_agent_legible_code.md`
- Memory: `reference_zfc.md` (orthogonal for this infra work, but informs app layer)

**External (verified via live docs):**
- [Terraform AWS provider v6 upgrade guide](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/guides/version-6-upgrade) (auth_token_update_strategy breaking change)
- [Terraform AWS provider source — `aws_db_instance` schema](https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/rds/instance.go) (`username` vs `master_username` confirmation)
- [hashicorp/terraform-provider-aws#34094](https://github.com/hashicorp/terraform-provider-aws/issues/34094) (`master_user_secret[0].secret_arn` access pattern)
- [AWS RDS PostgreSQL parameters docs](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Parameters.html) (static vs dynamic parameter classification)
- [AWS ElastiCache AUTH token rules](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth.html) (allowed character set)
- [AWS: New Public IPv4 Address Charge](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/) (EIP pricing change Feb 2024)
- [Terraform S3 backend docs — `use_lockfile`](https://developer.hashicorp.com/terraform/language/backend/s3) (native locking requires Terraform ≥1.10)

## Changelog

- **2026-04-21 v1** — initial design, reviewed internally.
- **2026-04-21 v2** — agent-team review (Zero Cool / Acid Burn / Phreak / Cipher), verified against live AWS + Terraform docs. Fixes applied:
  - Terraform correctness: `username` (not `master_username`); `engine_version = "16"` + `auto_minor_version_upgrade` + `ignore_changes`; `auth_token_update_strategy = "SET"`; static param `apply_method = "pending-reboot"`; `master_user_secret[0].secret_arn` output; explicit `identifier`; pin `hashicorp/random`; drop `notify-keyspace-events` default.
  - Security: shared-instance deletion protection unconditional (`prevent_destroy` + `deletion_protection` + `skip_final_snapshot = false`); explicit egress on all SGs (`sg-rds`/`sg-redis` egress none, `sg-ecs` egress scoped); TLS-only bucket policy on state bucket; `rds.force_ssl = 1` parameter.
  - Cost: EIP cost correction (+$3.65/mo); total idle ~$66/mo.
  - Coherence: Redis AUTH secret renamed `redis-auth-token` → `redis-auth`; added `scripts/bootstrap-databases.sh` to close the Backend Core handoff gap; added `rds-password` to staging secret list; pinned `required_version >= 1.10` in backend config; noted `network/` module grows in MYT-30.
