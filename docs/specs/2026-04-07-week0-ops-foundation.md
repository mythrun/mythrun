# Week 0: Ops Foundation Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-07
> **Updated**: 2026-04-08 (post-review: Raj + Lin)
> **Status**: Draft
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Scope**: VPC topology, secrets management, CI/CD pipeline, staging+prod environments, DNS/SSL, logging baseline. This is the first thing built -- before any application code changes.

---

## Table of Contents

1. [Overview](#1-overview)
2. [VPC Topology](#2-vpc-topology)
3. [Secrets Management](#3-secrets-management)
4. [CI/CD Pipeline](#4-cicd-pipeline)
5. [DNS and SSL](#5-dns-and-ssl)
6. [Logging and Alerting Baseline](#6-logging-and-alerting-baseline)
7. [Terraform Structure](#7-terraform-structure)
8. [Local Development Environment](#8-local-development-environment)
9. [Known Local/Production Divergences](#9-known-localproduction-divergences)
10. [Out of Scope](#10-out-of-scope)

---

## 1. Overview

Week 0 establishes the infrastructure foundation that all subsequent sub-projects deploy into. No application code is modified. The deliverable is a working CI/CD pipeline that can build a Docker image, push it to a container registry, and deploy it to both staging and production environments with proper networking, secrets, logging, and SSL.

**Region**: `us-east-1` (N. Virginia)

**Environments**: Staging and production share a single VPC. Staging uses separate ECS services, a separate database (on the same RDS instance), and separate Redis key prefixes -- but the same ALB (host-based routing), NAT Gateway, and network topology. This saves ~$120/mo vs. a full VPC mirror while still testing real infrastructure paths.

**Infrastructure-as-Code**: Terraform with S3 backend and DynamoDB state locking.

---

## 2. VPC Topology

One VPC shared by both staging and production.

### 2.1 Network Layout

```
VPC: 10.0.0.0/16
|
+-- Public Subnets (internet-facing)
|   +-- public-a  (us-east-1a)  10.0.1.0/24  -- ALB, NAT Gateway
|   +-- public-b  (us-east-1b)  10.0.2.0/24  -- ALB
|
+-- Private Subnets (no direct internet access)
|   +-- private-a (us-east-1a)  10.0.10.0/24 -- ECS tasks, RDS primary, Redis primary
|   +-- private-b (us-east-1b)  10.0.20.0/24 -- ECS tasks, RDS standby, Redis replica
|
+-- Internet Gateway -- attached to VPC, routes public subnet traffic to internet
|
+-- NAT Gateway -- in public-a, routes private subnet outbound traffic to internet
|   (private subnets -> NAT Gateway -> Internet Gateway -> Anthropic/Stripe/etc.)
|
+-- Route Tables
    +-- public-rt:  0.0.0.0/0 -> Internet Gateway
    +-- private-rt: 0.0.0.0/0 -> NAT Gateway
```

**Note on route tables:** Both private subnets share `private-rt` with the single NAT Gateway. When a second NAT Gateway is added for AZ redundancy, each private subnet will need its own route table (private-a routes to NAT-a, private-b routes to NAT-b). The Terraform module should make this a parameter change, not a refactor.

### 2.2 Diagram: Network Flow

```
                         +-------------+
                         |  Internet   |
                         +------+--+---+
                                |  |
                    HTTPS/WSS   |  |  Outbound API calls
                    (inbound)   |  |  (Anthropic, Stripe)
                                |  |
                         +------v--+-------+
                         | Internet Gateway |
                         +------+--+-------+
                                |  |
                 +--------------+  +---------------+
                 |                                  |
          +------v------+                    +------v------+
          |  Public      |                    |  NAT        |
          |  Subnets     |                    |  Gateway    |
          |              |                    |  (public-a) |
          |  +--------+  |                    +------+------+
          |  |  ALB   |  |                           |
          |  +---+----+  |                           |
          +------+-------+                           |
                 |                                   |
          +------v-----------------------------------+--+
          |                Private Subnets                |
          |                                               |
          |  +--------------+  +---------+  +---------+   |
          |  | ECS Fargate  |  |  RDS    |  |  Redis  |   |
          |  | (API+Worker) +--+ Postgres|  | (1 inst)|   |
          |  | (prod+stg)   |  |         |  +---------+   |
          |  +--------------+  +---------+                 |
          +-------------------------------------------------+
```

### 2.3 Security Groups

| Security Group | Name | Inbound Rules | Purpose |
|----------------|------|---------------|---------|
| `sg-alb` | ALB | Port 443 from `0.0.0.0/0` | Only HTTPS from the internet |
| `sg-ecs` | ECS Tasks | Port 3000 from `sg-alb` | Containers only reachable via ALB on the app port |
| `sg-rds` | RDS | Port 5432 from `sg-ecs` | Database only reachable from containers |
| `sg-redis` | Redis | Port 6379 from `sg-ecs` | Redis only reachable from containers |

All security groups allow all outbound traffic (containers need to reach Anthropic, Stripe, Secrets Manager, ECR, etc. via NAT Gateway).

**Note:** NAT Gateways do not need security groups (managed by AWS).

### 2.4 NAT Gateway Decision

One NAT Gateway in `public-a`. Cost: ~$32/mo + data transfer ($0.045/GB).

If `us-east-1a` has an AZ outage, outbound connectivity is lost (containers in `private-b` can't reach external APIs). Inbound traffic (ALB -> ECS) still works across both AZs. This is an acceptable risk at launch -- adding a second NAT Gateway in `public-b` ($64/mo total) is a future reliability upgrade.

### 2.5 Staging vs Production (Shared VPC)

Both environments share the single VPC. Isolation is at the service level, not the network level:

| Resource | Staging | Production |
|----------|---------|------------|
| VPC | Shared | Shared |
| ALB | Shared (host-based routing: `staging-api.mythrun.com` vs `api.mythrun.com`) | Shared |
| NAT Gateway | Shared | Shared |
| ECS Cluster | Shared | Shared |
| ECS Services | `mythrun-staging-api`, `mythrun-staging-worker` | `mythrun-prod-api`, `mythrun-prod-worker` |
| RDS Instance | Shared (database: `mythrun_staging`) | Shared (database: `mythrun_prod`) |
| Redis | Shared (key prefix: `staging:`) | Shared (key prefix: `prod:`) |
| Secrets | `mythrun/staging/*` | `mythrun/prod/*` |
| Log groups | `/mythrun/staging/*` | `/mythrun/prod/*` |

This saves ~$120/mo vs. a full VPC mirror. The trade-off: a staging bug that crashes the RDS instance or exhausts Redis memory could affect production. This is acceptable at launch scale -- if it becomes a concern, split to separate VPCs later.

---

## 3. Secrets Management

### 3.1 Secrets Inventory

All secrets stored in AWS Secrets Manager. Each environment has its own set.

| Secret | Secrets Manager Key | Rotation | Notes |
|--------|-------------------|----------|-------|
| Anthropic API key | `mythrun/{env}/anthropic-api-key` | Manual | Rotated when Anthropic issues new key |
| Stripe secret key | `mythrun/{env}/stripe-secret-key` | Manual | Staging uses Stripe test mode key |
| Stripe webhook signing secret | `mythrun/{env}/stripe-webhook-secret` | Manual | Different per environment |
| RDS database password | `mythrun/{env}/rds-password` | Automatic (90 days) | Secrets Manager rotation Lambda |
| Redis auth token | `mythrun/{env}/redis-auth` | Manual | Single instance at launch |
| Cognito client secret | `mythrun/{env}/cognito-client-secret` | Manual | |

### 3.2 ECS Integration

ECS task definitions reference secrets by ARN, not by value. Use `data "aws_caller_identity" "current" {}` in Terraform to avoid hardcoding the account ID:

```json
{
  "secrets": [
    {
      "name": "ANTHROPIC_API_KEY",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:${account_id}:secret:mythrun/prod/anthropic-api-key"
    }
  ]
}
```

ECS injects these as environment variables at container startup. The task definition itself contains only the ARN -- the actual value is never visible in the ECS console, CloudFormation, or Terraform state.

### 3.3 IAM Policy

The ECS task execution role gets a scoped policy:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:${account_id}:secret:mythrun/prod/*"
}
```

Staging tasks get the same policy scoped to `mythrun/staging/*`. A staging container cannot read production secrets.

**Amended 2026-04-22 (MYT-30 serving-infra design):** The implementation uses an **explicit per-ARN list** rather than a wildcard, because the shared `mythrun/shared/redis-auth` secret is accessed by both staging and production task roles and a per-env wildcard (`mythrun/staging/*`) would miss it. Implementation lists: `mythrun/shared/redis-auth` + `mythrun/${env}/rds-password` + the four manual secret ARNs (anthropic, stripe-secret, stripe-webhook, cognito). The per-env isolation claim still holds because the list is constructed per-role. See `docs/superpowers/specs/2026-04-22-serving-infra-design.md` §5.3 for the Terraform shape.

### 3.4 Terraform State Protection

The Terraform state S3 bucket:
- **Server-side encryption**: SSE-S3 (AES-256)
- **Versioning**: Enabled (recover from corrupted or bad state)
- **Bucket policy**: Restricts access to the deployment IAM role only
- **Public access**: Blocked (all four S3 block public access settings enabled)
- **DynamoDB lock table**: Prevents concurrent `terraform apply` (even solo, protects against accidental double-runs)
- **Tags**: `Project=mythrun`, `ManagedBy=manual` (these resources are bootstrapped outside Terraform)

Terraform never stores secret values in `.tf` files. Secrets are created manually in the Secrets Manager console (or CLI) once, then referenced in Terraform via `data "aws_secretsmanager_secret_version"`.

---

## 4. CI/CD Pipeline

### 4.1 Pipeline Overview

Two separate pipelines: one for infrastructure changes (Terraform), one for application deploys (Docker image -> ECS).

**Application deploy pipeline** (runs on every push to main):

```
Push to main
    |
    v
+-----------------------------+
|  Stage 1: Build & Test      |
|  +-- pnpm install           |
|  +-- pnpm lint              |
|  +-- pnpm typecheck         |
|  +-- pnpm test              |
|  +-- docker build           |
|  +-- docker push -> ECR     |
|      (tagged: git SHA)      |
+-------------+---------------+
              | (automatic)
              v
+-----------------------------+
|  Stage 2: Deploy Staging    |
|  +-- Update ECS service     |
|  |   (new task definition   |
|  |    with image SHA)       |
|  +-- Wait for stable        |
|  |   (health checks pass)   |
|  +-- Smoke test             |
|      (GET /health -> 200    |
|       + verify DB + Redis)  |
+-------------+---------------+
              | (manual approval
              |  via GitHub UI)
              v
+-----------------------------+
|  Stage 3: Deploy Production |
|  +-- Update ECS service     |
|  |   (same image as staging)|
|  +-- Blue/green with 120s   |
|  |   deregistration delay   |
|  +-- Wait for stable        |
|  +-- Smoke test             |
|  +-- Auto-rollback on       |
|      smoke test failure     |
+-----------------------------+
```

**Infrastructure pipeline** (runs on changes to `infra/` path, or manually):

```
Push to main (infra/ changes)
    |
    v
+-----------------------------+
|  terraform plan             |
|  (output to workflow summary|
|   for audit trail)          |
+-------------+---------------+
              | (manual approval)
              v
+-----------------------------+
|  terraform apply            |
+-----------------------------+
```

Application deploys use `aws ecs update-service` (fast, image-only change). Infrastructure changes use `terraform apply` (slower, can modify any resource). These are deliberately separate workflows to prevent accidental infrastructure changes on routine code pushes.

### 4.2 Docker Image

Single multi-stage Dockerfile:

```dockerfile
# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json backend/
RUN corepack enable && pnpm install --frozen-lockfile
COPY backend/ backend/
RUN pnpm --filter backend build

# Runtime stage (production dependencies only)
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

**Key detail:** The runtime stage runs `pnpm install --prod` to get only production dependencies. DevDependencies (test frameworks, linters, type definitions) are excluded from the production image. This reduces image size and attack surface.

The same image is used for both the API service and the Worker service. The Worker service overrides the CMD to `["node", "dist/worker.js"]` in its ECS task definition.

Image tags:
- `{account_id}.dkr.ecr.us-east-1.amazonaws.com/mythrun:{git-sha}` (immutable, traceable)
- `{account_id}.dkr.ecr.us-east-1.amazonaws.com/mythrun:latest` (convenience, overwritten each build)

**ECR lifecycle policy:** Keep the 20 most recent tagged images. Expire untagged images after 1 day. Prevents unbounded image accumulation and storage cost creep.

### 4.3 GitHub Actions Workflow

The workflow uses:
- **OIDC authentication** with AWS (no long-lived AWS credentials stored in GitHub secrets -- GitHub Actions assumes an IAM role via OpenID Connect). This is ~15 lines of Terraform (IAM OIDC provider + trust policy) and eliminates credential rotation burden.
- **GitHub Environments** with protection rules: `production` environment requires manual approval
- **Concurrency control**: Only one deploy at a time (cancel in-progress deploys if a new push arrives)

### 4.4 Rollback

Three rollback options, in order of speed:

1. **ECS automatic rollback**: If the deployment health check fails, ECS automatically rolls back to the previous task definition. No human action needed.
2. **Manual rollback via GitHub**: Re-run the last successful production deploy workflow. Deploys the previous image.
3. **Git revert**: Push a revert commit. Flows through the full pipeline (build -> staging -> manual approve -> prod).

### 4.5 Frontend Deployment

The frontend is deployed separately from the backend:

1. `pnpm --filter frontend build` produces static files in `frontend/dist/`
2. Upload to S3 bucket
3. Invalidate CloudFront cache for `index.html` only (Vite hashes all other filenames, so they're naturally cache-busted)

This can be a separate GitHub Actions workflow or a step in the same pipeline. Since frontend and backend deploy independently, a frontend bug can be fixed without redeploying the backend and vice versa.

### 4.6 Health Check Contract

Two endpoints, split by purpose:

**`GET /health/live`** (liveness -- used by ECS container health check):
- **200** if the Node.js process is alive and the event loop is responsive
- Does NOT check external dependencies (a momentary Postgres blip shouldn't restart the container)

**`GET /health/ready`** (readiness -- used by ALB target group health check):
- **200** if the service can execute a `SELECT 1` against Postgres AND a `PING` against Redis
- **503** if either check fails
- Response body: `{ "status": "ok", "postgres": "ok", "redis": "ok" }`

**`GET /health`** (convenience -- same as `/health/ready`):
- Used by the CI smoke test after deploy

This split prevents a Redis blip from causing ECS to restart all containers (making the blip worse), while still ensuring the ALB only routes to tasks that can serve requests.

---

## 5. DNS and SSL

### 5.1 Route 53 Records

| Record | Type | Target | Purpose |
|--------|------|--------|---------|
| `mythrun.com` | A (alias) | CloudFront distribution | Frontend |
| `www.mythrun.com` | CNAME | `mythrun.com` | Redirect |
| `api.mythrun.com` | A (alias) | ALB | Production backend API + WebSocket |
| `staging-api.mythrun.com` | A (alias) | ALB (same ALB, host-based routing) | Staging backend |

### 5.2 SSL Certificates (ACM)

| Certificate | Domains | Used By | Region |
|-------------|---------|---------|--------|
| Frontend cert | `mythrun.com`, `*.mythrun.com` | CloudFront | `us-east-1` (required by CloudFront) |
| Backend cert | `api.mythrun.com`, `staging-api.mythrun.com` | ALB | `us-east-1` |

Certificates are validated via DNS (Terraform creates the validation CNAME records in Route 53 automatically). ACM certificates are free and auto-renew.

**ACM expiry alarm:** CloudWatch alarm on `DaysToExpiry` with threshold of 30 days. If DNS validation records are ever accidentally deleted (e.g., during debugging), the certificate renewal silently fails. This alarm catches it before the certificate expires and takes down the site.

### 5.3 ALB Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Listener | HTTPS (443) only | HTTP (80) redirects to HTTPS |
| SSL policy | `ELBSecurityPolicy-TLS13-1-2-2021-06` | TLS 1.2+ only |
| Idle timeout | 3600 seconds | Prevents dropping WebSocket connections during long read pauses |
| Host-based routing | `api.mythrun.com` -> prod target group; `staging-api.mythrun.com` -> staging target group | Single ALB serves both environments |
| Target group health check | `GET /health`, interval 15s, timeout 5s, healthy threshold 2, unhealthy threshold 3, start period 30s | Allows containers 30s to start before health checks begin |
| Deregistration delay | 120 seconds | Gives containers time to finish in-flight LLM calls during deploys |
| Stickiness | Disabled | Not needed -- session state is in Redis, any container can serve any request |

### 5.4 CloudFront Configuration

| Setting | Value |
|---------|-------|
| Origin | S3 bucket (frontend assets) |
| Price class | PriceClass_100 (US, Canada, Europe -- cheapest) |
| Default TTL | 86400 (24 hours) for hashed assets |
| `index.html` TTL | 0 (no cache -- always fetch fresh) |
| Viewer protocol | Redirect HTTP to HTTPS |
| Compress | Enabled (gzip + brotli) |

---

## 6. Logging and Alerting Baseline

### 6.1 CloudWatch Log Groups

| Log Group | Source | Retention |
|-----------|--------|-----------|
| `/mythrun/prod/api` | ECS API service (stdout/stderr) | 30 days |
| `/mythrun/prod/worker` | ECS Worker service (stdout/stderr) | 14 days |
| `/mythrun/staging/api` | Staging API service | 14 days |
| `/mythrun/staging/worker` | Staging Worker service | 14 days |

ECS tasks use the `awslogs` log driver, which ships container stdout/stderr directly to CloudWatch. No log agent or sidecar needed.

**Cost note:** CloudWatch Logs ingestion is $0.50/GB. Set Pino to `warn` level in production by default. Bump to `info` only when actively debugging. Never log LLM response bodies -- log metadata only (model, tokens, latency, cost). Full responses are already in the database.

### 6.2 Log Format

Pino JSON output. At Week 0, logs contain:
- `timestamp` (ISO 8601)
- `level` (info, warn, error, fatal)
- `msg` (log message)
- `pid` (process ID)
- `hostname` (container ID)

Application-level fields (request ID, user ID, campaign ID, LLM call metadata) are added when the application code is updated in later sub-projects.

### 6.3 Critical Alarms

**Amended 2026-04-22 (MYT-30 serving-infra design):** Alarm **provisioning** (CloudWatch alarm resources) moved out of Ops Foundation into the Observability & Hardening sub-spec. Rationale: alarms against zero-traffic empty services either fire immediately (e.g. "API service down" when `desired_count = 0` by design) or never fire (e.g. "RDS high CPU" on a database with zero connections). Ops Foundation delivers the SNS topics (`mythrun-critical-alerts` for prod, `mythrun-staging-alerts` for staging) + Miklos's email/SMS subscriptions — the plumbing alarms will publish into. The eight alarms below are the Observability sub-spec's work, blocked on real traffic existing (Platform milestone onward).

Week 0 alarms are limited to "the service is down" scenarios. Granular alarms (error rates, latency, LLM spend) come in the Observability & Hardening sub-spec.

| Alarm | Condition | Action |
|-------|-----------|--------|
| API service down | ECS running task count = 0 for 1 minute | SNS -> SMS |
| Worker service down | ECS running task count = 0 for 1 minute | SNS -> SMS |
| RDS high CPU | CPU > 90% for 5 minutes | SNS -> SMS |
| RDS low storage | FreeStorageSpace < 2 GB | SNS -> SMS |
| Redis memory pressure | Memory usage > 80% for 5 minutes | SNS -> SMS |
| ALB 5xx spike | 5xx count > 50 in 5 minutes | SNS -> SMS |
| ACM certificate expiry | DaysToExpiry < 30 | SNS -> SMS |
| AWS account spend | Estimated charges > $300/mo | SNS -> SMS + Email |

### 6.4 SNS Alert Delivery

- One SNS topic: `mythrun-critical-alerts` (production alarms only)
- SMS subscription to your phone number (configured via Terraform variable, not hardcoded)
- Email subscription as backup (in case SMS delivery fails)
- **Important:** Increase the SNS SMS spending limit on day one. AWS defaults to $1.00/month -- after a few alerts, SMS silently stops. Set to at least $10/month in the SNS console.
- Staging alarms go to a separate `mythrun-staging-alerts` topic with email only (no SMS)

---

## 7. Terraform Structure

### 7.1 Directory Layout

4 modules, collapsed for solo-dev debuggability. Split later if any module gets unwieldy.

```
infra/
  modules/
    network/          # VPC, subnets, NAT Gateway, route tables, security groups,
                      # ALB, listeners, target groups, Route 53, ACM certificates
    compute/          # ECS cluster, services, task definitions, ECR repo,
                      # ECR lifecycle policy, IAM roles (OIDC + task execution)
    data/             # RDS instance, RDS Proxy, ElastiCache replication groups,
                      # Secrets Manager secret definitions (not values)
    observability/    # CloudWatch log groups, alarms, SNS topics
  environments/
    staging/
      main.tf         # Calls modules with staging-sized parameters
      variables.tf    # Staging-specific variables
      terraform.tfvars # Staging values (instance sizes, etc.)
      backend.tf      # Hardcoded S3 backend key for staging
    production/
      main.tf         # Calls modules with production-sized parameters
      variables.tf
      terraform.tfvars
      backend.tf      # Hardcoded S3 backend key for production
  scripts/
    bootstrap.sh      # Idempotent setup for S3 state bucket + DynamoDB lock table
```

### 7.2 Module Parameterization

Modules accept size parameters so staging and production use the same code with different values:

| Parameter | Staging | Production |
|-----------|---------|------------|
| `ecs_api_cpu` | 256 (0.25 vCPU) | 512 (0.5 vCPU) |
| `ecs_api_memory` | 512 (0.5 GB) | 1024 (1 GB) |
| `ecs_api_count` | 1 | 2 |
| `ecs_worker_cpu` | 256 | 512 |
| `ecs_worker_memory` | 512 | 1024 |
| `ecs_worker_count` | 1 | 1 |
| `rds_instance_class` | `db.t4g.micro` | `db.t4g.micro` |
| `rds_storage_autoscaling` | true (max 50 GB) | true (max 100 GB) |
| `redis_node_type` | `cache.t4g.micro` | `cache.t4g.micro` |
| `redis_replicas` | 0 | 1 |

Production starts with the same instance sizes as staging -- scale up based on actual load, not guesses.

### 7.3 State Backend

Each environment has its own `backend.tf` with a **hardcoded** key (Terraform backend blocks do not support variable interpolation):

```hcl
# infra/environments/production/backend.tf
terraform {
  backend "s3" {
    bucket         = "mythrun-terraform-state"
    key            = "environments/production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "mythrun-terraform-locks"
  }
}
```

```hcl
# infra/environments/staging/backend.tf
terraform {
  backend "s3" {
    bucket         = "mythrun-terraform-state"
    key            = "environments/staging/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "mythrun-terraform-locks"
  }
}
```

### 7.4 Bootstrap Script

The state bucket and DynamoDB table are bootstrapped outside Terraform (chicken-and-egg). The `scripts/bootstrap.sh` script handles this idempotently:

```bash
#!/bin/bash
set -euo pipefail

BUCKET="mythrun-terraform-state"
TABLE="mythrun-terraform-locks"
REGION="us-east-1"

# Create S3 bucket (idempotent)
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3 mb "s3://$BUCKET" --region "$REGION"
fi

# Enable versioning
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Block public access
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Tag bucket
aws s3api put-bucket-tagging --bucket "$BUCKET" \
  --tagging 'TagSet=[{Key=Project,Value=mythrun},{Key=ManagedBy,Value=manual}]'

# Create DynamoDB lock table (idempotent)
if ! aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" 2>/dev/null; then
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" \
    --tags Key=Project,Value=mythrun Key=ManagedBy,Value=manual
fi

echo "Bootstrap complete."
```

---

## 8. Local Development Environment

Local dev does not mirror the AWS topology. It runs services directly on your machine via Docker Compose.

**Important:** The Docker Compose setup provisions Postgres and Redis locally, but the application code currently speaks SQLite (via `better-sqlite3`). Docker Compose is ready in Week 0 but is not connected to the application until the Database Migration sub-spec is complete. During the transition, `pnpm dev` continues to use SQLite as it does today.

### 8.1 Docker Compose

A `docker-compose.yml` at the project root starts the local infrastructure:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: mythrun
      POSTGRES_PASSWORD: mythrun_dev
      POSTGRES_DB: mythrun
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7.2-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

**Note:** Redis images are pinned to `7.2-alpine` to match ElastiCache's available version. Using `redis:7-alpine` risks running a newer Redis locally than what ElastiCache provides, causing commands that work locally to fail in production.

Start with `docker compose up -d`. Stop with `docker compose down`. Data persists in the `pgdata` volume between restarts.

### 8.2 Local Environment Variables

A `.env.development.example` file is committed to the repo with placeholder values:

```
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun
REDIS_URL=redis://localhost:6379
ANTHROPIC_API_KEY=sk-ant-your-key-here
STRIPE_SECRET_KEY=sk_test_your-key-here
STRIPE_WEBHOOK_SECRET=whsec_your-secret-here
AUTH_MODE=bypass
PORT=3000
```

Copy to `.env.development` (gitignored) and fill in real values.

### 8.3 Auth Modes

Controlled by the `AUTH_MODE` environment variable:

| Mode | Behavior | When to use |
|------|----------|-------------|
| `bypass` (default for local) | Auth middleware injects a fake user (`{ id: 'dev-user-1', email: 'dev@mythrun.com', displayName: 'Dev User' }`). No JWT validation. No Cognito calls. | Normal development. Fast, no login friction. |
| `real` | Auth middleware validates JWTs against the staging Cognito user pool. Real OAuth login required. | Testing auth flows, invite system, multi-user scenarios. |

Production and staging always use `real` mode. The `bypass` mode is only available when `NODE_ENV !== 'production'`.

### 8.4 Local Dev Commands

| Command | What it does |
|---------|-------------|
| `docker compose up -d` | Start Postgres + Redis |
| `pnpm dev` | Start backend with hot reload |
| `pnpm --filter frontend dev` | Start frontend dev server with Vite proxy |
| `stripe listen --forward-to localhost:3000/webhooks/stripe` | Forward Stripe test webhooks to local server |
| `docker compose down` | Stop infrastructure |
| `docker compose down -v` | Stop and delete all data (fresh start) |

### 8.5 Stripe Local Testing

The Stripe CLI forwards webhook events from Stripe's test environment to your local server. When you create a test checkout session, Stripe sends the `checkout.session.completed` webhook to the CLI, which forwards it to `localhost:3000/webhooks/stripe`. This lets you test the full purchase flow locally without deploying.

Stripe test mode uses separate API keys (prefixed `sk_test_` and `pk_test_`) that never charge real money.

---

## 9. Known Local/Production Divergences

These are places where local dev behaves differently from production. Document them so you're not surprised when something works locally but fails in staging.

| Area | Local | Production | Impact |
|------|-------|------------|--------|
| Database connection | Direct Postgres connection | Direct Postgres connection (same at launch; RDS Proxy added later when scaling) | Identical at launch. When RDS Proxy is added, connection pooling behavior may differ (e.g., prepared statements in transaction mode) |
| Secrets | `.env.development` file | AWS Secrets Manager via ECS injection | Identical from the app's perspective (both are environment variables) |
| Auth | Bypass mode (fake user) | Cognito JWT validation | Auth-dependent logic is untested in bypass mode; switch to `real` mode for auth testing |
| Redis | Single-node, no auth | ElastiCache with auth token, Multi-AZ | Connection string differs; auth token required in production |
| SSL | No SSL (plain HTTP on localhost) | TLS everywhere (ALB terminates HTTPS) | Cookie `Secure` flags, HSTS, and mixed-content issues only surface in staging/prod |
| WebSocket | Direct connection to localhost:3000 | Via ALB with 3600s idle timeout | ALB-specific timeout and keepalive behavior not tested locally |

---

## 10. Out of Scope

The following are explicitly NOT part of Week 0 and are deferred to later sub-specs:

| Item | Deferred To |
|------|------------|
| ECS service definitions (API + Worker) | Infrastructure & DevOps sub-spec |
| RDS instance, RDS Proxy configuration | Infrastructure & DevOps sub-spec |
| ElastiCache instance configuration | Infrastructure & DevOps sub-spec |
| Auto-scaling policies | Infrastructure & DevOps sub-spec |
| Application-level metrics and dashboards | Observability & Hardening sub-spec |
| Request-level logging fields (user ID, campaign ID) | Observability & Hardening sub-spec |
| Rate limiting | Observability & Hardening sub-spec |
| Security headers (CSP, HSTS, etc.) | Observability & Hardening sub-spec |
| Postgres schema and tables | Database Migration sub-spec |
| Database migration from SQLite to Postgres | Database Migration sub-spec |
| Cognito user pool configuration | Auth & Users sub-spec |
| Incident response runbook | Observability & Hardening sub-spec |

Week 0 produces: a VPC you can deploy into, secrets you can reference, a CI/CD pipeline that builds and deploys, DNS that routes traffic, SSL that encrypts it, logs that capture what happens, and alarms that wake you up when it breaks. Everything else builds on top.
