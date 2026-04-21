# Foundation Infra (Network + Data) Design

> **Linear issue**: MYT-25
> **Milestone**: Ops Foundation (2026-04-27)
> **Date**: 2026-04-21
> **Status**: Design for review

## Goal

Stand up the Terraform-managed AWS network and data substrate for Mythrun in `us-east-1`: VPC with public/private subnets across 2 AZs, NAT Gateway, security groups, PostgreSQL 16 via RDS, Redis 7.x via ElastiCache, and Secrets Manager entry shells for staging. No application workloads yet — that's MYT-30 (serving infra) + MYT-28 (first deploy).

## Done when

```bash
cd infra/environments/shared && terraform apply     # exits 0, all resources healthy
cd infra/environments/staging && terraform apply    # exits 0, Secrets Manager entries created
```

Plus:
- VPC exists with the topology in section 2.1 of `docs/specs/2026-04-07-week0-ops-foundation.md`
- RDS reports `available` status
- ElastiCache replication group reports `available` status
- Neither is reachable from outside the VPC (not publicly accessible, security groups locked down)
- Six Secrets Manager entries exist under `mythrun/staging/*` with placeholder values
- Staging RDS password is AWS-managed (rotated automatically, stored in Secrets Manager — not in Terraform state)
- `terraform plan` run a second time reports "No changes" (idempotent)

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

Three places where this design deviates from the older specs:

| Topic | Older spec | This design | Why |
|---|---|---|---|
| Redis `maxmemory-policy` | `noeviction` (Architecture Overview §3) | `volatile-lru` (Infrastructure & DevOps §6.2) | Newer spec has explicit rationale. `noeviction` risks cascading failure under memory pressure (every write fails including BullMQ, rate limiting, pub/sub). `volatile-lru` evicts idle session states (which have TTLs and can be reloaded from Postgres checkpoints) before critical no-TTL keys. |
| Terraform state locking | DynamoDB lock table (Week 0 §7.3) | Native S3 locking (`use_lockfile = true`) | Terraform 1.10+ supports native S3 locking. One fewer AWS resource to provision, one fewer thing to break. Week 0 spec predates this feature. |
| RDS password management | Secrets Manager rotation Lambda, initial password in Secrets Manager (Week 0 §3.1) | `manage_master_user_password = true` (AWS-managed) | AWS RDS now natively integrates with Secrets Manager — rotation handled by AWS, password never touches Terraform state. Cleaner than the Lambda rotation pattern. Supported in PostgreSQL since 2023. |
| Redis AUTH secret location | `mythrun/{env}/redis-auth` per env (Week 0 §3.1) | `mythrun/shared/redis-auth-token` (single copy) | Redis itself is shared between staging and production per Week 0 §2.5 — storing the same token twice is duplication without benefit. Each env's ECS task role (MYT-30) will get explicit read access to this shared secret. |

---

## Directory structure

```
infra/
├── scripts/
│   └── bootstrap.sh                # One-time: create S3 state bucket (idempotent)
├── modules/
│   ├── network/
│   │   ├── main.tf                 # VPC, subnets, IGW, NAT, route tables, 4 SGs
│   │   ├── variables.tf            # vpc_cidr, azs, environment
│   │   └── outputs.tf              # All IDs needed by downstream modules/envs
│   └── data/
│       ├── main.tf                 # RDS (with param group + subnet group), ElastiCache (same), Redis AUTH token
│       ├── variables.tf            # vpc_id, private_subnet_ids, rds_sg_id, redis_sg_id, sizing params
│       └── outputs.tf              # rds_endpoint, rds_port, rds_db_name, redis_endpoint, redis_port, redis_auth_secret_arn, rds_password_secret_arn
└── environments/
    ├── shared/                     # Owns VPC + SGs + RDS + Redis
    │   ├── backend.tf              # state key: environments/shared/terraform.tfstate
    │   ├── main.tf                 # Calls network module, then data module
    │   ├── variables.tf            # environment="shared", region, vpc_cidr, azs
    │   └── outputs.tf              # Re-exports everything downstream envs need
    └── staging/                    # Owns staging-scoped Secrets Manager shells
        ├── backend.tf              # state key: environments/staging/terraform.tfstate
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

**Security groups** (per Week 0 §2.3):
| SG | Inbound | Purpose |
|---|---|---|
| `aws_security_group.alb` | 443 from `0.0.0.0/0` | ALB (used by MYT-30) |
| `aws_security_group.ecs` | 3000 from `alb` | ECS tasks (used by MYT-30) |
| `aws_security_group.rds` | 5432 from `ecs` | RDS |
| `aws_security_group.redis` | 6379 from `ecs` | Redis |

All SGs allow all outbound. We use `aws_vpc_security_group_ingress_rule` (not the legacy inline `ingress` blocks) for granular updates without full-rule replacement.

Note: `sg-alb` and `sg-ecs` are created in MYT-25 but not used by any resource until MYT-30. This is fine — SG can exist before anything is attached to it. Creating them now keeps the network module complete and means MYT-30 only needs to reference IDs.

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

Per Infrastructure & DevOps §5:

- `aws_db_subnet_group.main` — spans `private_a` + `private_b`.
- `aws_db_parameter_group.main` — family `postgres16`, parameters from §5.2:
  - `log_min_duration_statement = 1000` (log queries >1s)
  - `log_connections = on`, `log_disconnections = on`
  - `idle_in_transaction_session_timeout = 60000`
  - `statement_timeout = 30000`
  - `max_connections = 80`
  - `random_page_cost = 1.1`
  - `work_mem = 2MB`
  - `maintenance_work_mem = 64MB`
  - `shared_buffers` and `effective_cache_size` use defaults keyed to instance class memory (`{DBInstanceClassMemory/4}` / `{DBInstanceClassMemory*3/4}`) — these are set automatically by AWS for these parameter names and do not need explicit values
- `aws_db_instance.main`:
  - `engine = "postgres"`, `engine_version = "16.x"` (latest 16.x minor)
  - `instance_class = "db.t4g.micro"`
  - `multi_az = false`
  - `storage_type = "gp3"`, `allocated_storage = 20`, `max_allocated_storage = 50` (staging cap per Week 0 §7.2)
  - `backup_retention_period = 7`, `backup_window = "02:00-03:00"`, `maintenance_window = "sun:03:00-sun:04:00"` (all UTC, per Week 0)
  - `deletion_protection = false` (staging; prod will set true)
  - `performance_insights_enabled = true`, `performance_insights_retention_period = 7`
  - `storage_encrypted = true` (AWS-managed KMS key)
  - `publicly_accessible = false`
  - `db_subnet_group_name = aws_db_subnet_group.main.name`
  - `vpc_security_group_ids = [var.rds_sg_id]`
  - **`manage_master_user_password = true`** — AWS provisions the password, stores it in a Secrets Manager secret it creates automatically, rotates it per RDS defaults. Password never enters Terraform state.
  - `master_username = "mythrun_admin"` (single superuser at RDS level; per-env app users are created later via migrations)
  - `db_name` — **not set here.** Per Week 0 §2.5, the per-environment databases (`mythrun_staging`, `mythrun_prod`) are created inside the instance via migrations or a one-shot provisioning script. RDS itself gets created with no initial database beyond what Postgres creates automatically.
  - `skip_final_snapshot = true` (staging only; prod will set false). Suppresses the "you're about to destroy data" gate in exchange for faster `terraform destroy` — acceptable for staging.
  - `apply_immediately = false` (batch parameter changes into maintenance windows by default; can be overridden per-change if urgent)

### ElastiCache Redis

Per Infrastructure & DevOps §6:

- `aws_elasticache_subnet_group.main` — spans `private_a` + `private_b`.
- `aws_elasticache_parameter_group.main` — family `redis7`, parameters from §6.2:
  - `maxmemory-policy = "volatile-lru"`
  - `timeout = "0"`
  - `tcp-keepalive = "300"`
  - `notify-keyspace-events = ""` (default, listed for clarity)
- `random_password.redis_auth` — 32 characters, excluding `/@"'\` (ElastiCache AUTH token rules — avoids chars that break URI-style connection strings). Stored in Secrets Manager.
- `aws_secretsmanager_secret.redis_auth` — name `mythrun/shared/redis-auth-token`. Lives in shared scope (not `mythrun/staging/redis-auth` per Week 0 §3.1) because Redis itself is shared across staging + production and generating two copies of the same value is needless duplication. **Implication for MYT-30:** each env's ECS task role will need read access to `mythrun/shared/redis-auth-token` in addition to its own `mythrun/{env}/*` scope. This is a small IAM policy addition in the serving-infra milestone.
- `aws_secretsmanager_secret_version.redis_auth` — stores `random_password.redis_auth.result`.
- `aws_elasticache_replication_group.main`:
  - `replication_group_id = "mythrun-redis"`
  - `description = "Mythrun shared Redis (staging + prod)"`
  - `engine = "redis"`, `engine_version = "7.1"` (confirm latest available via `aws elasticache describe-cache-engine-versions --engine redis --region us-east-1` during implementation — per spec note)
  - `node_type = "cache.t4g.micro"`
  - `num_cache_clusters = 1` (single node; replica can be added later by bumping to 2)
  - `automatic_failover_enabled = false` (requires ≥2 nodes)
  - `at_rest_encryption_enabled = true`
  - `transit_encryption_enabled = true`
  - `auth_token = random_password.redis_auth.result`
  - `subnet_group_name = aws_elasticache_subnet_group.main.name`
  - `security_group_ids = [var.redis_sg_id]`
  - `parameter_group_name = aws_elasticache_parameter_group.main.name`
  - `maintenance_window = "mon:03:00-mon:04:00"`
  - `snapshot_retention_limit = 1`

Note on replication group vs cluster mode: we use a **replication group with 1 cluster** rather than a plain `aws_elasticache_cluster` because replication group is the only path that supports in-place scale-out to a replica later without recreating the resource. This is the AWS-recommended pattern even for single-node Redis when you anticipate growth.

### Secrets Manager — shared (data module)

Two secrets live alongside the shared data resources:

- `aws_secretsmanager_secret.redis_auth` + version (the Redis AUTH token, populated from `random_password`)
- The RDS master user secret is auto-created by AWS due to `manage_master_user_password = true`; we expose its ARN as a data-module output so downstream code can reference it.

Module outputs:
- `rds_endpoint`, `rds_port` (5432), `rds_master_user_secret_arn`
- `redis_endpoint` (primary endpoint), `redis_port` (6379), `redis_auth_secret_arn`

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
  ]
}

resource "aws_secretsmanager_secret" "app_secrets" {
  for_each = toset(local.secret_names)
  name     = "mythrun/${local.env}/${each.key}"
  description = "Mythrun ${local.env} ${each.key} (value set manually out-of-band)"
}

resource "aws_secretsmanager_secret_version" "app_secrets" {
  for_each      = aws_secretsmanager_secret.app_secrets
  secret_id     = each.value.id
  secret_string = "PLACEHOLDER — set via AWS Console or CLI"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
```

Note: RDS password and Redis auth token are NOT listed here — they live at `mythrun/shared/*` (managed by the data module) because the data infrastructure is shared.

The four secrets in staging's list (`anthropic-api-key`, `stripe-secret-key`, `stripe-webhook-secret`, `cognito-client-secret`) are per-environment because staging uses test-mode credentials (e.g., Stripe `sk_test_*`, a separate Cognito user pool in staging) while production uses live credentials.

---

## Bootstrap script

`infra/scripts/bootstrap.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BUCKET="mythrun-terraform-state"
REGION="us-east-1"

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

# Tag the bucket
aws s3api put-bucket-tagging \
  --bucket "$BUCKET" \
  --tagging 'TagSet=[{Key=Project,Value=mythrun},{Key=ManagedBy,Value=manual},{Key=Environment,Value=shared}]'

echo "Done. SSE-S3 encryption is on by default (AWS default since Jan 2023)."
echo "Native S3 state locking is configured via use_lockfile=true in backend.tf (Terraform 1.10+)."
```

Dropped from the Week 0 spec's version: the entire DynamoDB lock table block. Native S3 locking replaces it.

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
2. `bash infra/scripts/bootstrap.sh` — creates the state bucket.

**First MYT-25 provision:**
3. `cd infra/environments/shared && terraform init`
4. `terraform plan` — review output. Expect ~35-40 resources.
5. `terraform apply` — ~10-15 min (RDS provisioning is the long pole; ElastiCache ~5 min; VPC-layer resources <1 min).
6. `cd ../staging && terraform init`
7. `terraform plan` — expect 8 resources (4 secrets × 2 resources each: the secret + its placeholder version).
8. `terraform apply` — <1 min.

**Populate secret values** (human action, outside Terraform):

```bash
aws secretsmanager put-secret-value \
  --secret-id mythrun/staging/anthropic-api-key \
  --secret-string "sk-ant-..."
# ... repeat for stripe-secret-key, stripe-webhook-secret, cognito-client-secret
```

Or via the AWS Console → Secrets Manager → click each secret → "Set secret value".

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
# Expected: 4 entries
```

**Idempotency check:**
```bash
cd infra/environments/shared && terraform plan  # Expected: "No changes"
cd ../staging && terraform plan                  # Expected: "No changes"
```

---

## Cost impact

Based on Infrastructure & DevOps §1 service inventory, running MYT-25 resources 24/7 costs roughly:

| Resource | Monthly |
|---|---|
| NAT Gateway (1 × public-a) | ~$32 |
| NAT Gateway data transfer | ~$1-5 (trivial until apps deploy) |
| RDS `db.t4g.micro` Single-AZ + 20 GB gp3 | ~$15 |
| ElastiCache `cache.t4g.micro` single-node | ~$12 |
| Secrets Manager (6 secrets) | ~$2.40 ($0.40/secret/month) |
| Elastic IP (for NAT) | $0 (free while attached) |
| VPC/subnets/route tables/SGs | $0 |
| S3 state bucket | <$0.10 |
| **Total** | **~$62/mo** |

Staging + production will share these resources per Week 0 §2.5, so prod adds only marginal cost (more secrets, more traffic through NAT). Well within the $200 AWS budget alarm.

**First actual AWS spend begins at `terraform apply` time.** This is the first resource-creating ticket in the entire project — a billing inflection point.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `terraform apply` fails mid-way (partial state) | Medium | Terraform is idempotent — re-run resolves most partial states. For truly stuck resources, `terraform state rm` + manual cleanup. |
| AWS provider version drift breaks config | Low | Pin `hashicorp/aws = "~> 6.0"` in `required_providers`. |
| RDS master password lost/leaked | Low | `manage_master_user_password = true` means AWS owns rotation. Password is never in Terraform state. If we lose access, RDS can rotate on demand. |
| ElastiCache Redis 7.2 isn't available (spec flag) | Medium | Implementation step: run `aws elasticache describe-cache-engine-versions --engine redis` and use the latest 7.x (expect 7.1). Update Docker Compose `redis:7.2-alpine` → `redis:7.1-alpine` to match. |
| Default `maxmemory-policy` drift from parameter group | Low | Parameter group is explicitly attached to the replication group. Terraform will detect and correct drift on next apply. |
| Someone edits a secret value via console, Terraform overwrites it | Low | `lifecycle { ignore_changes = [secret_string] }` on every `aws_secretsmanager_secret_version`. |
| `terraform destroy` on shared deletes production data | High (if run accidentally) | Set `deletion_protection = true` on RDS in production env. Staging can be destroyed freely. Document in `shared/README.md`. |
| Cost creep from forgotten resources | Low | Every resource tagged with `Project=mythrun` + `Environment`. AWS Budgets alarm at $200 (already configured). |
| First apply takes longer than estimated | Medium | RDS can take 10+ min. Just wait. Don't cancel mid-apply. |

---

## Verification checklist (for implementation)

After `terraform apply` completes on both workspaces:

- [ ] `aws rds describe-db-instances` shows `mythrun` in `available` state
- [ ] RDS instance has Performance Insights enabled
- [ ] RDS storage is encrypted, `publicly_accessible = false`
- [ ] `manage_master_user_password = true` is reflected (check `MasterUserSecret` is populated)
- [ ] `aws elasticache describe-replication-groups` shows `mythrun-redis` in `available` state
- [ ] Redis has `TransitEncryptionEnabled: true` and `AtRestEncryptionEnabled: true`
- [ ] Redis parameter group shows `maxmemory-policy: volatile-lru`
- [ ] 4 `mythrun/staging/*` secrets exist with placeholder values
- [ ] `mythrun/shared/redis-auth-token` exists with the `random_password`-generated value
- [ ] All security groups have the exact rules in the network section above (no permissive 0.0.0.0/0 on RDS/Redis ports)
- [ ] From outside the VPC, RDS and Redis endpoints do NOT respond (test: `nc -zv <endpoint> 5432` from the local machine should time out)
- [ ] `terraform plan` on both workspaces reports "No changes" (true idempotency)

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
| Secret value population (AWS Console step) | Post-apply human task |
| Connection pooling configuration in app | Backend Core milestone |

---

## Sources

- `docs/specs/2026-04-06-production-architecture-overview.md` (§3, §4, §7, Decisions Log)
- `docs/specs/2026-04-07-week0-ops-foundation.md` (§2 VPC, §3 Secrets, §7 Terraform structure)
- `docs/specs/2026-04-10-infrastructure-devops.md` (§5 RDS, §6 ElastiCache, §8 scale-up triggers)
- `docs/superpowers/specs/2026-04-21-monorepo-scaffold-design.md` (prior scaffold spec — reference for patterns)
- Memory: `reference_agent_legible_code.md`
- Memory: `reference_zfc.md` (orthogonal for this infra work, but informs app layer)
