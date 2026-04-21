# Foundation Infra (Network + Data) Design

> **Linear issue**: MYT-25
> **Milestone**: Ops Foundation (2026-04-27)
> **Date**: 2026-04-21
> **Status**: Design v4 — reviewed by three independent agent teams (Zero Cool/Acid Burn/Phreak/Cipher, then Blossom/Buttercup/Bubbles/Professor Utonium, then Batman/Black Widow/Spider-Man/Doctor Strange). Findings verified against live AWS/Terraform docs. Third round surfaced a spec-hierarchy conflict on Redis eviction policy which has been resolved by amending the parent Architecture Overview spec.

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
- 1 AWS auto-generated secret `rds!db-*` with the RDS master password (managed lifecycle — not named by us)
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
| Redis `maxmemory-policy` | ~~`noeviction` (Architecture Overview §3, pre-amendment)~~ | `volatile-lru` — **now matches amended Architecture Overview §3 and Decisions Log** (updated 2026-04-21 after Doctor Strange's v3 review flagged spec-hierarchy conflict) | Amendment rationale: `noeviction` causes cascading failure across BullMQ + rate limiting + pub/sub + session state when memory fills. `volatile-lru` degrades gracefully — oldest idle session keys are evicted (TTL'd, reload from Postgres 5-min checkpoints on reconnect), BullMQ/rate-limit/pub-sub keys without TTLs are preserved. Graceful degradation preferred over total write failure during the 5-10 min scale-up window. |
| Terraform state locking | DynamoDB lock table (Week 0 §7.3) | Native S3 locking (`use_lockfile = true`) | Terraform 1.10+ supports native S3 locking. DynamoDB-based locking is deprecated. One fewer AWS resource to provision, one fewer thing to break. |
| RDS password management | Secrets Manager rotation Lambda, initial password in Secrets Manager (Week 0 §3.1) | `manage_master_user_password = true` (AWS-managed) | AWS RDS now natively integrates with Secrets Manager — rotation handled by AWS, password never touches Terraform state. Cleaner than the Lambda rotation pattern. |
| Redis AUTH secret location | `mythrun/{env}/redis-auth` per env (Week 0 §3.1) | `mythrun/shared/redis-auth` (single copy) | Redis itself is shared between staging and production per Week 0 §2.5. One token, both environments. Name matches the original spec (`redis-auth`) to preserve env-var mapping continuity (Infra §2.3). Each env's ECS task role (MYT-30) will get explicit read access to this shared secret. |
| Deletion protection on shared RDS | Per-env toggle (staging off, prod on) | Unconditionally `deletion_protection = true`, `skip_final_snapshot = false`, `lifecycle { prevent_destroy = true }` (v2 revision) | Staging and prod share one instance. "Staging can be destroyed freely" doesn't apply when that same instance holds prod data. Hardening the shared instance protects both envs; staging-specific ephemeral operations are done at the DB level (drop and recreate `mythrun_staging` database), not the instance level. |
| Per-env database + user creation | Implied but unaddressed | Explicit `scripts/bootstrap-databases.sh` run against the shared RDS after Terraform applies (v2 addition) | Backend Core's migration runner connects to an existing database — it does not `CREATE DATABASE` or `CREATE USER`. Someone has to create `mythrun_staging` and `mythrun_prod` databases + their users before migrations run. MYT-25 provides the script; Backend Core consumes it. |
| Security group egress posture | Week 0 §2.3: "All security groups allow all outbound traffic" | `sg-rds` and `sg-redis` allow NO egress; `sg-ecs` egress scoped to 443 + RDS/Redis ports (v3 reconciliation per Prof Utonium) | Week 0's blanket statement was correct for `sg-ecs` (containers need to reach Anthropic/Stripe/ECR) but wrong for data-tier SGs — RDS and Redis have no legitimate outbound needs. Explicit locking prevents a future SG misconfig from turning data services into exfiltration channels. |
| `mythrun/{env}/rds-password` semantics | Week 0 §3.1: RDS master password with 90-day Lambda rotation | Per-env app user password (not master), rotation is manual via operator runbook (v3 reconciliation per Prof Utonium) | RDS master password is now AWS-managed (`manage_master_user_password = true`) at an auto-generated secret name. `mythrun/{env}/rds-password` is repurposed for the per-env app user (`mythrun_staging`, `mythrun_prod`), which is what the application actually connects as (Infra §5.4). App user rotation is manual for MYT-25; a rotation runbook is a **pre-launch blocker** (v4 per Doctor Strange — Week 0 committed to automatic rotation; losing that commitment cannot slip past launch). |
| Backup retention | Architecture Overview §3 says 35 days; Infrastructure & DevOps §5.1 says 7 days | 7 days per Infra §5.1 (v4 addition per Doctor Strange — previously silent) | The two parent specs already disagreed. 7 days is the AWS-RDS default and keeps backup storage under the provisioned-storage free tier. 35 days would more than double backup storage cost and is overkill for a pre-launch system. Documented here so the Observability & Hardening milestone knows to revisit if compliance requirements demand longer retention. |

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
  - `lifecycle { prevent_destroy = true }` (v3 fix per Bubbles O-6: without this, a `terraform destroy` on shared could begin tearing down VPC-level resources before hitting the RDS/Redis prevent_destroy guards, leaving the workspace in an inconsistent state mid-destroy).

**Subnets** (each in a specific AZ per Week 0 §2.1):
- `aws_subnet.public_a` — `10.0.1.0/24` in `us-east-1a`
- `aws_subnet.public_b` — `10.0.2.0/24` in `us-east-1b`
- `aws_subnet.private_a` — `10.0.10.0/24` in `us-east-1a`
- `aws_subnet.private_b` — `10.0.20.0/24` in `us-east-1b`

**Internet Gateway + NAT**
- `aws_internet_gateway.main`
- `aws_eip.nat` — Elastic IP for NAT Gateway. Set `domain = "vpc"` explicitly (v4 per Batman I4 — v6 default, but explicit is more robust).
- `aws_nat_gateway.main` — in `public_a` subnet. Add `depends_on = [aws_internet_gateway.main]` explicitly (v4 per Batman I5 — implicit dependency is otherwise only through the route table).
- `var.num_nat_gateways` (default `1`) — module variable (v4 per Doctor Strange). When AZ redundancy is required, flip to `2` and the module creates a second NAT in `public_b` with a separate route table for `private_b`. No refactor needed.

**Route tables**
- `aws_route_table.public` — default route → IGW. Associated with both public subnets.
- `aws_route_table.private` — default route → NAT. Associated with both private subnets.
  - Note (per Week 0 §2.1): when a second NAT Gateway is added for AZ redundancy, `private_b` will need its own route table. Module inputs should make this a future parameter change, not a refactor.

**Security groups** (per Week 0 §2.3, with explicit egress hardening):

| SG | Inbound | Egress | Purpose |
|---|---|---|---|
| `aws_security_group.alb` | 443 from `0.0.0.0/0` (port 80 listener + rule added in MYT-30 alongside the actual ALB) | All (ALB proxies to ECS) | ALB (used by MYT-30) |
| `aws_security_group.ecs` | 3000 from `alb` | 443 to `0.0.0.0/0` (Anthropic, Stripe, ECR, Secrets Manager); 5432 to `rds`; 6379 to `redis` | ECS tasks (used by MYT-30) |
| `aws_security_group.rds` | 5432 from `ecs` | **None** | RDS — no outbound needed |
| `aws_security_group.redis` | 6379 from `ecs` | **None** | Redis — no outbound needed |

**Port 80 ingress note (v4 per Doctor Strange):** moved to MYT-30 where the HTTP→HTTPS redirect listener actually lives. No point opening a port on an SG where no listener exists.

**Default VPC SG lockdown (v4 per Black Widow I6):** `aws_default_security_group` resource added to zero out inbound + outbound rules on the VPC's default SG. Prevents accidental "allow-all from self" inheritance if any future resource is launched into the default SG (e.g., a console-created test instance).

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

- `aws_db_subnet_group.main` — `name = "mythrun-rds"`, spans `private_a` + `private_b` (v4 fix per Batman I11: `name` is required; was previously implied).
- `aws_db_parameter_group.main` — family `postgres16`, parameters from §5.2:
  - Dynamic (apply immediately):
    - `log_min_duration_statement = 1000` (log queries >1s)
    - `log_disconnections = on`
    - `idle_in_transaction_session_timeout = 60000`
    - `statement_timeout = 30000`
    - `random_page_cost = 1.1`
    - `work_mem = 2MB`
    - `maintenance_work_mem = 64MB`
    - `rds.force_ssl = 1` (v2: refuse non-TLS connections server-side)
    - `log_parameter_max_length = 0` (v4 per Black Widow M3: suppress parameter values in slow-query logs to prevent PII/secret bleed into CloudWatch; without this, slow queries log the parameter values which may contain user emails, UUIDs, etc.)
  - **Static (require `apply_method = "pending-reboot"`)**:
    - `max_connections = 80`
    - `log_connections = on` — **verify at implementation time** per Batman I3: the parameter's `ApplyType` may be `dynamic` in Postgres 16 on RDS despite being static in upstream Postgres. Run `aws rds describe-engine-default-parameters --db-parameter-group-family postgres16 --query "EngineDefaults.Parameters[?ParameterName=='log_connections'].[ApplyType]"` before apply. If `dynamic`, move this to the dynamic list and drop `apply_method`.
    - `shared_buffers = "{DBInstanceClassMemory/4}"` (explicit for clarity; can be omitted to use RDS's default formula)
  - `effective_cache_size` uses RDS's default formula `{DBInstanceClassMemory*3/4}` — no explicit override

  **Implementation note on static parameters:** at implementation time, verify parameter classification via `aws rds describe-engine-default-parameters --db-parameter-group-family postgres16 --query "EngineDefaults.Parameters[?ParameterName=='<name>'].[ApplyType]"`. Anything classified as `static` needs `apply_method = "pending-reboot"` in the Terraform resource block, or the first apply will fail with `InvalidParameterCombination: cannot use an apply method of immediate`.

- `aws_db_instance.main`:
  - `identifier = "mythrun"` (v2 addition per Zero Cool — explicit so verification commands can grep for it)
  - `engine = "postgres"`, `engine_version = "16"` (v2: partial major version per Zero Cool + Phreak; AWS picks latest 16.x minor)
  - `auto_minor_version_upgrade = true` (let AWS patch minors during maintenance window)
  - **`lifecycle { ignore_changes = [engine_version, final_snapshot_identifier], prevent_destroy = true }`** (v4: added `final_snapshot_identifier` to ignore_changes so the deterministic snapshot name doesn't cause drift. Both concerns go in a single lifecycle block; Terraform rejects duplicate lifecycle blocks per resource. The combined block achieves: AWS auto-patches minors without Terraform drift, shared instance is protected from accidental `terraform destroy`, final snapshot name is stable.)
  - `instance_class = "db.t4g.micro"`
  - `multi_az = false`
  - `storage_type = "gp3"`, `allocated_storage = 20`, `max_allocated_storage = 50`
  - `backup_retention_period = 7`, `backup_window = "02:00-02:30"`, `maintenance_window = "sun:03:00-sun:04:00"` (v2: tightened backup window to `02:00-02:30` leaving a 30-min gap before the maintenance window — avoids AWS validation edge cases with abutting windows)
  - `deletion_protection = true` (v2 revision — unconditionally on; see spec reconciliation row for rationale)
  - `skip_final_snapshot = false` (v2 revision — unconditional; staging ephemeral operations happen at the database level, not the instance level)
  - `final_snapshot_identifier = "mythrun-final-${var.environment}"` (v4 fix per Batman C1 — required by the provider when `skip_final_snapshot = false`; without it, any replacement-forcing change or future `terraform destroy` fails. Added to `ignore_changes` below so setting the snapshot name deterministically doesn't cause drift.)
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

- `aws_elasticache_subnet_group.main` — `name = "mythrun-redis"`, spans `private_a` + `private_b` (v4 fix per Batman I12: `name` is required).
- `aws_elasticache_parameter_group.main` — family `redis7`, parameters from §6.2:
  - `maxmemory-policy = "volatile-lru"`
  - `timeout = "0"`
  - `tcp-keepalive = "300"`
  - **`rename-command` entries** (v4 per Black Widow M6): rename dangerous commands to empty strings so they cannot be invoked, even by a compromised ECS task with the AUTH token: `CONFIG`, `DEBUG`, `FLUSHDB`, `FLUSHALL`, `KEYS`, `SCRIPT`. Free defense-in-depth. Syntax: `rename-commands = "CONFIG \"\" DEBUG \"\" FLUSHDB \"\" FLUSHALL \"\" KEYS \"\" SCRIPT \"\""`. Note: the app does not use any of these commands (BullMQ uses `LPUSH`/`RPOP`/etc.; session state uses `HSET`/`HGET`/`EXPIRE`).
  - (v2 fix: removed `notify-keyspace-events = ""` — setting a parameter to its default value can cause perpetual diff plans.)
- `random_password.redis_auth` — 32 characters, `special = true`, `override_special = "!&#$^<>-"` (v2: ElastiCache AUTH tokens restrict nonalphanumeric chars to `! & # $ ^ < > -` only; excluded chars are `@ " /`. `override_special` specifies which special chars are **allowed**, not excluded). Plus `min_upper = 1`, `min_lower = 1`, `min_numeric = 1`, `min_special = 1` (v4 per Batman I7: guarantees generated token meets ElastiCache's implicit complexity expectation even in the statistically unlikely case that a 32-char random string happens to be all letters).
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
  - `port = 6379` (v3 fix per Blossom I1: set explicitly so the resource's `port` attribute is reliably exported for data-module outputs; it's an argument, not a documented exported attribute when left defaulted)
  - `lifecycle { prevent_destroy = true }` (matches RDS posture; Redis is shared between envs)

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
  # Secrets populated manually via AWS Console / CLI — placeholder initial version is OK
  manual_secret_names = [
    "anthropic-api-key",
    "stripe-secret-key",
    "stripe-webhook-secret",
    "cognito-client-secret",
  ]
  # Secrets populated by bootstrap-databases.sh — NO initial version created here,
  # because `terraform apply -replace` on a _secret_version resource would overwrite
  # the real value with PLACEHOLDER (v4 fix per Batman C4).
  bootstrap_secret_names = [
    "rds-password",
  ]
}

resource "aws_secretsmanager_secret" "manual_secrets" {
  for_each    = toset(local.manual_secret_names)
  name        = "mythrun/${local.env}/${each.key}"
  description = "Mythrun ${local.env} ${each.key} (value set via AWS Console/CLI out-of-band)"
  recovery_window_in_days = 7  # v3: default 30 days creates name lockout on destroy
}

resource "aws_secretsmanager_secret_version" "manual_secrets" {
  for_each      = aws_secretsmanager_secret.manual_secrets
  secret_id     = each.value.id
  secret_string = "PLACEHOLDER — set via AWS Console / CLI"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# rds-password: shell only, no version. bootstrap-databases.sh creates the first version.
# This avoids the landmine where `terraform apply -replace` on a placeholder version
# would overwrite a real password.
resource "aws_secretsmanager_secret" "bootstrap_secrets" {
  for_each    = toset(local.bootstrap_secret_names)
  name        = "mythrun/${local.env}/${each.key}"
  description = "Mythrun ${local.env} ${each.key} (value created by bootstrap-databases.sh — NO Terraform-managed version)"
  recovery_window_in_days = 7
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

# v3 addition per Blossom I5: fail fast if Terraform < 1.10 (required for use_lockfile)
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

# v4 addition per Black Widow I7: expire noncurrent versions after 90 days
# (state history is valuable but unbounded growth is cost smell + long-tail secret exposure)
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

echo "Done. SSE-S3 encryption is on by default (AWS default since Jan 2023)."
echo "Native S3 state locking is configured via use_lockfile=true in backend.tf (Terraform >=1.10)."
echo "Noncurrent versions expire after 90 days."
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

**Per-env password generation (v3 hardening per Buttercup I7):**

- Generate via `aws secretsmanager get-random-password --password-length 32 --exclude-characters '/@"'\' --require-each-included-type` (AWS-side generation, avoids bash RNG quality concerns and predictable shell history).
- The SQL must NOT bash-interpolate the password into the `CREATE USER` statement. Use a parameterized approach: write the password to a temp file with `0600` permissions, then invoke `psql --variable=app_pw="$password"` and reference it as `\set` variable in the SQL. This prevents SQL injection if the random password ever contains a stray quote that AWS's character exclusion didn't catch.
- The bootstrap role (one-shot ECS task role) needs `secretsmanager:PutSecretValue` scoped to exactly `mythrun/{env}/rds-password` and `secretsmanager:GetSecretValue` on the RDS master user secret ARN. Revoke after one-time use.
- Write the generated password to `mythrun/{env}/rds-password` via `aws secretsmanager put-secret-value` **after** the `CREATE USER` SQL succeeds — so the secret is never populated with credentials that don't work.
- If the script fails partway through (e.g., `CREATE DATABASE` succeeded but the `put-secret-value` failed), the script must be idempotent — re-running should detect existing database + user and only fix the missing pieces.

**v4 addition per Spider-Man O-H1 — `--verify` mode and named partial-failure states:**

The script MUST support `bootstrap-databases.sh --verify` which performs the following checks without mutating state:

```sql
-- Verify database exists
SELECT 1 FROM pg_database WHERE datname = 'mythrun_staging';
-- Verify user exists
SELECT 1 FROM pg_user WHERE usename = 'mythrun_staging';
-- Verify user has expected grants
SELECT has_database_privilege('mythrun_staging', 'mythrun_staging', 'CONNECT');
```

Plus:
```bash
aws secretsmanager describe-secret --secret-id mythrun/staging/rds-password \
  --query 'VersionIdsToStages' --output text
# Expected: a version with 'AWSCURRENT' stage (not just the shell with no version)
```

Three named partial-failure states, each with a recovery path:

1. **`DB_ONLY`**: database exists, user does not. Recovery: re-run bootstrap with `--user-only` which creates user + password + writes secret.
2. **`USER_ONLY`**: database + user exist but secret has no version (or is still `PLACEHOLDER`). Recovery: re-run bootstrap with `--secret-only` which `ALTER USER ... WITH PASSWORD '<new>'` + writes secret.
3. **`SECRET_MISMATCH`**: database + user + secret all exist but the app can't authenticate. The secret value and the actual DB password have drifted. Recovery: run `--reset-password` which generates a new password, does `ALTER USER`, and overwrites the secret.

All three recovery paths must be safe to run against a live but unconnected database (no app connections yet). Backend Core's migration runner should have a preflight check that calls `bootstrap-databases.sh --verify` before connecting and fails loud if verification fails.

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

---

## Handoff sequence (v3 addition per Professor Utonium)

The MYT-25 → MYT-30 → Backend Core chain has non-obvious ordering constraints. Here's the canonical sequence:

1. **MYT-25 apply.** Bootstrap script creates the state bucket. `terraform apply` on `environments/shared/` provisions VPC, SGs, RDS, Redis, Redis AUTH secret, RDS master user secret (auto-generated name `rds!db-*`). `terraform apply` on `environments/staging/` creates 5 placeholder secrets under `mythrun/staging/*`, including `rds-password` as a placeholder.

2. **MYT-25 → MYT-30 handoff.** No runtime workload connects to RDS or Redis yet. The shared RDS has only the default `postgres` database. The staging `rds-password` secret contains literal `"PLACEHOLDER"`.

3. **MYT-30 apply (first part).** ECS cluster, ECR repo, task definitions, IAM roles. NO ECS service is started yet — only the infrastructure.

4. **One-shot `bootstrap-databases.sh` run.** Executed via `aws ecs run-task` using the new task definition with an overridden CMD. The task:
   - Reads the RDS master user secret (`rds!db-*`) to connect as admin.
   - Runs `CREATE DATABASE mythrun_staging`.
   - Generates a random password via `aws secretsmanager get-random-password`.
   - Runs `CREATE USER mythrun_staging WITH PASSWORD '...'` + grants.
   - Writes the password to `mythrun/staging/rds-password` via `put-secret-value`.
   - Exits cleanly. Task role is single-use and revoked after.

5. **MYT-30 apply (second part).** Now that `rds-password` has a real value and the target database exists, create the ECS service. First deployment's health check can successfully open `sslmode=verify-full` connections to `mythrun_staging` and the deployment succeeds.

6. **Backend Core deploy.** Migration runner connects via `DATABASE_URL` (composed from outputs + `rds-password` secret), runs schema migrations against `mythrun_staging`. Works cleanly because database + user + password are already in place.

**Failure mode without this ordering:** if MYT-30 creates the ECS service before step 4, the first deploy's health check fails (auth fails against placeholder password, database doesn't exist). ECS's deployment circuit breaker rolls back. Manual intervention needed to un-stick.

**Responsibility for step 4 execution:** MYT-30's implementation plan (not MYT-25) owns running the bootstrap script at the correct time. This spec provides the script; the next spec invokes it.

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
| ElastiCache `cache.t4g.micro` single-node | ~$12.41 (v3 fix per Bubbles: corrected from $11.68) |
| Secrets Manager (7 secrets: 5 staging + 1 shared redis-auth + 1 RDS master auto-created) | ~$2.80 storage + ~$0.50-2/mo API calls once ECS tasks fetch on cold start |
| **Elastic IP for NAT Gateway** | **~$3.65** (AWS began charging $0.005/hr for all public IPv4 Feb 2024, attached or not) |
| Performance Insights (7-day retention) | $0 (free tier — bumping to long-term would add ~$7/mo per vCPU) |
| KMS API calls (AWS-managed keys, no storage charge) | ~$0.50-3/mo at steady state (v3 addition per Bubbles) |
| Cross-AZ data transfer (ECS ↔ RDS across AZs) | ~$2-8/mo at launch scale once apps deploy (v3 addition per Bubbles) |
| VPC / subnets / route tables / SGs | $0 |
| S3 state bucket | <$0.50/mo including API calls |
| **Total idle (MYT-25 alone)** | **~$67/mo** |
| **Steady-state once MYT-30 + Backend Core + apps deploy** | **~$100-125/mo** (v3 revision per Bubbles — NAT data transfer dominates the variance; original $75-85 was too conservative) |

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
| Static RDS parameters cause first apply to fail | Low | `apply_method = "pending-reboot"` explicitly set on `max_connections`, `log_connections`, `shared_buffers` (v2 fix). Verify `log_connections` classification at implementation time (v4 per Batman I3). |
| Per-env DBs missing when Backend Core's migrations run | Medium | `scripts/bootstrap-databases.sh` documented and exercised before Backend Core's first migration. Script supports `--verify` mode + three named partial-failure recovery paths (v4 per Spider-Man O-H1). |
| **Someone needs to intentionally delete the shared RDS/Redis/VPC** (e.g., region migration) | Low | Unlock procedure (v4 per Spider-Man O-M4): (1) in Terraform, remove `prevent_destroy = true` from the resource's lifecycle block, (2) `terraform apply` — no resource change, just updates the lifecycle metadata, (3) on RDS only: set `deletion_protection = false` in Terraform + `terraform apply`, (4) `terraform destroy`. Four steps, two `apply`s before destroy, enforces deliberation. If someone removes both `prevent_destroy` AND `deletion_protection` in one commit, require a second reviewer before merging (branch protection rule — deferred to org-level hardening). |

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
| **CloudTrail, GuardDuty, AWS Config, VPC flow logs** (detective controls) | Observability & Hardening milestone per Buttercup I10/I11. ~$30/mo combined; genuinely valuable pre-launch. |
| **CloudWatch alarms on RDS free storage and Redis memory** (the blind window between MYT-25 and MYT-30) | MYT-30 observability module. Low cost (~$0.30/alarm); worth considering earlier per Bubbles O-8. |
| **App user password rotation runbook** (for `mythrun/{env}/rds-password`) | Pre-launch hardening ticket. AWS-managed rotation applies to master user only; app users are manual. |
| **Redis AUTH token rotation runbook** (switch from `SET` to `ROTATE` strategy) | Pre-launch hardening ticket per Bubbles O-11. |
| **RDS snapshot restore drill** (verify backups actually work) | Pre-launch hardening per Bubbles O-5. |
| **Performance Insights retention bump** (7 days → 2 years, ~$14/mo) | Pre-launch when real traffic starts producing query history worth keeping. |
| **Second NAT Gateway** (AZ-a outage currently takes down all private-subnet egress) | Pre-launch per Bubbles O-2. ~$36.50/mo. Not ship-blocker pre-revenue; is for the launch runbook. |
| **Account-level S3 public access block** | Security hardening — prevents future-bucket misconfig regardless of per-bucket settings. |
| **SSL client-side verification requirement** (`sslmode=verify-full` on DB client) | Backend Core spec — MYT-30's task definition must ship the RDS CA bundle and app must use `verify-full`. |
| **IMDSv2 enforcement on ECS task definitions** | MYT-30 per Black Widow C6 — task definitions must require IMDSv2-only metadata access with hop limit 1. |
| **RDS snapshot restore drill** | Pre-launch per Spider-Man O-H3 — one-time test restore of the empty RDS to a new instance to verify the backup chain works end-to-end. ~$1 cost (one hour of runtime). Only way to know your DR plan is real. |
| **Maintenance window review** | Post-launch per Spider-Man O-M6 — current Sun 03:00-04:00 UTC = Sat 20:00-23:00 Pacific, which is D&D prime time. Measure actual user activity in week 2 and shift to the true low-traffic window. |
| **App-user password rotation runbook** | **PRE-LAUNCH BLOCKER** per Doctor Strange — Week 0 §3.1 committed to automatic 90-day rotation on `mythrun/{env}/rds-password`. The design silently downgrades to manual when repurposing the secret for the app user. The rotation runbook + mechanism must exist before launch so the automatic-rotation commitment isn't silently abandoned. |

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
- **2026-04-21 v3** — second-round blind review (Blossom / Buttercup / Bubbles / Professor Utonium). Convergent findings from both teams locked in confidence that v2 fixes were real. New findings v2 missed, now incorporated:
  - Ship-blocker fixes: merged duplicate `lifecycle` blocks on RDS into one (Blossom C1); explicit `port = 6379` on ElastiCache replication group (Blossom I1); added `prevent_destroy` to VPC (Bubbles O-6); `recovery_window_in_days = 7` on staging secrets to avoid 30-day name lockout (Blossom C2).
  - Bootstrap hardening: Terraform version pre-check in `bootstrap.sh` (Blossom I5); `bootstrap-databases.sh` now specifies AWS-side random password generation, psql variable binding to avoid SQL injection, scoped one-shot task role, idempotency requirement (Buttercup I7).
  - Documentation: added explicit reconciliation rows for SG egress lockdown and `rds-password` semantic change; added numbered "Handoff sequence" section walking MYT-25 → MYT-30 → bootstrap → Backend Core ordering (Professor Utonium).
  - Out-of-Scope expanded: CloudTrail/GuardDuty/Config/VPC flow logs (Buttercup I10, I11); app user + Redis AUTH rotation runbooks; RDS snapshot restore drill; Performance Insights long-retention; second NAT Gateway pre-launch (all from Bubbles); account-level S3 PAB; SSL client-side `verify-full` requirement for Backend Core.
  - Cost: ElastiCache corrected to $12.41 (not $11.68); KMS API calls + cross-AZ data transfer added as line items; steady-state revised from $75-85 to $100-125/mo.
- **2026-04-21 v4** — third-round blind review (Batman / Black Widow / Spider-Man / Doctor Strange). Three-round convergence now provides very strong evidence the foundations are solid. Biggest surface: **Doctor Strange challenged the Redis `maxmemory-policy` spec hierarchy** — the design was silently overriding the Architecture Overview (parent spec). Resolution: the parent Architecture Overview was **amended** to adopt `volatile-lru` with full rationale in its Decisions Log, chosen deliberately for graceful degradation over cascading failure; the MYT-25 design's reconciliation row now reflects "design follows amended parent" instead of "design overrides parent." New findings incorporated:
  - Ship-blocker fixes: `final_snapshot_identifier` added (Batman C1 — required when `skip_final_snapshot = false`); `rds-password` secret architecture split into shell-only (no Terraform-managed version) to eliminate the placeholder-overwrite landmine on `apply -replace` (Batman C4); explicit `name` arguments on `aws_db_subnet_group` and `aws_elasticache_subnet_group` (Batman I11/I12).
  - Network hardening: `domain = "vpc"` on EIP (Batman I4); explicit `depends_on` on NAT Gateway (Batman I5); `num_nat_gateways` module variable exposed for future AZ redundancy (Doctor Strange); `aws_default_security_group` zeroing the VPC default SG (Black Widow I6); port 80 ingress on `sg-alb` moved to MYT-30 where its listener lives (Doctor Strange).
  - Data-plane hardening: `log_parameter_max_length = 0` to prevent PII leaking into slow-query logs (Black Widow M3); `log_connections` classification flagged for implementation-time verification (Batman I3); `rename-commands` on Redis parameter group to disable `CONFIG`, `DEBUG`, `FLUSHDB`, `FLUSHALL`, `KEYS`, `SCRIPT` (Black Widow M6); `random_password` explicit `min_upper/lower/numeric/special` complexity guards (Batman I7).
  - State bucket hardening: lifecycle policy to expire noncurrent versions after 90 days (Black Widow I7).
  - Bootstrap: `bootstrap-databases.sh --verify` mode with three named partial-failure recovery paths (DB_ONLY, USER_ONLY, SECRET_MISMATCH) per Spider-Man O-H1.
  - Ops: "unlock procedure" runbook for intentional RDS deletion (Spider-Man O-M4).
  - Out-of-Scope additions: IMDSv2 enforcement for MYT-30 (Black Widow C6); RDS snapshot restore drill (Spider-Man O-H3); maintenance window review post-launch (Spider-Man O-M6); **app-user password rotation runbook elevated to pre-launch blocker** from "hardening sweep" (Doctor Strange — Week 0 committed to automatic rotation; commitment must not silently erode).
  - New reconciliation rows: backup retention (Arch Overview 35d vs Infra 7d; design follows Infra); Redis policy row updated to reflect amended parent spec.
