# Infrastructure & DevOps Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-10
> **Updated**: 2026-04-10 (post-review: Toad, Samus, Kirby, Fox McCloud)
> **Status**: Draft
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Depends on**: `2026-04-07-week0-ops-foundation.md` (VPC, secrets, CI/CD, DNS/SSL, logging)
> **Scope**: ECS service definitions (API + Worker), RDS Postgres configuration, ElastiCache Redis configuration, auto-scaling policies, Docker image finalization. These are the compute, storage, and caching services that run inside the Week 0 network foundation.

---

## Table of Contents

1. [Overview](#1-overview)
2. [ECS API Service](#2-ecs-api-service)
3. [ECS Worker Service](#3-ecs-worker-service)
4. [Docker Image](#4-docker-image)
5. [RDS PostgreSQL](#5-rds-postgresql)
6. [ElastiCache Redis](#6-elasticache-redis)
7. [Auto-Scaling Policies](#7-auto-scaling-policies)
8. [Scale-Up Triggers and Progression](#8-scale-up-triggers-and-progression)
9. [Out of Scope](#9-out-of-scope)

---

## 1. Overview

This sub-spec defines the AWS services that run Mythrun's backend. It builds on top of the Week 0 foundation (VPC, subnets, security groups, ALB, NAT Gateway, secrets, CI/CD) and configures the actual compute, database, and caching infrastructure.

**Design principle:** Start with the smallest viable configuration. Every component has a defined scale-up trigger that's a Terraform parameter change, not a redesign. Monitor first, scale second.

### Service Inventory

| Service | Type | Launch Config | Monthly Cost |
|---------|------|---------------|-------------|
| API Service | ECS Fargate | 1-4 tasks, 0.5 vCPU / 1GB each | $24-96 |
| Worker Service | ECS Fargate | 1 task, 0.5 vCPU / 1GB | $24 |
| PostgreSQL | RDS | db.t4g.micro, Single-AZ, 20GB gp3 | ~$15 |
| Redis | ElastiCache | cache.t4g.micro, single node | ~$12 |

---

## 2. ECS API Service

The API service handles all HTTP REST endpoints and WebSocket connections. It is the user-facing compute layer.

### 2.1 Task Definition

**Amended 2026-04-22 (MYT-30 serving-infra design):** The CPU/memory values in this table are the **production** values. Staging uses half-size (CPU=256, Memory=512) per Week 0 §7.2's module parameterization matrix. The Fargate sizing matrix (staging vs prod) is owned by Week 0 §7.2; §2.1 gives the per-task-def settings at prod scale.

| Setting | Value | Rationale |
|---------|-------|-----------|
| Family | `mythrun-{env}-api` | Environment-scoped naming |
| CPU (prod) | 512 (0.5 vCPU) | Sufficient for WebSocket + REST at launch scale |
| CPU (staging) | 256 (0.25 vCPU) | Per Week 0 §7.2 |
| Memory (prod) | 1024 (1 GB) | Node.js with streaming LLM responses + WebSocket state |
| Memory (staging) | 512 (0.5 GB) | Per Week 0 §7.2 |
| Network mode | `awsvpc` | Required for Fargate; each task gets its own ENI |
| Launch type | `FARGATE` | Managed, no EC2 instances to maintain |
| Platform version | `LATEST` | Fargate platform version |
| Image | `{account_id}.dkr.ecr.us-east-1.amazonaws.com/mythrun:{git-sha}` | Immutable, traceable |
| Command | `["node", "--max-old-space-size=768", "dist/server.js"]` | API server entry point. V8 heap capped at 768MB to prevent OOM kills (Fargate 1GB is a hard SIGKILL, not a graceful shutdown). |
| Stop timeout | 120 seconds | Must match ALB deregistration delay. Default 30s would SIGKILL the container while ALB is still draining. |
| Port mappings | 3000 (TCP) | Application port, mapped to ALB target group |
| Health check (liveness) | `CMD-SHELL, node -e "require('http').get('http://localhost:3000/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"` | ECS container-level liveness check. Uses Node.js (not curl — Alpine doesn't include curl). |
| Health check interval | 15s | |
| Health check timeout | 5s | |
| Health check retries | 3 | |
| Health check start period | 30s | Allows time for DB/Redis connection setup |
| Log driver | `awslogs` | Ships stdout/stderr to CloudWatch |
| Log group | `/mythrun/{env}/api` | Defined in Week 0 spec |

### 2.2 Environment Variables (Non-Secret)

**Amended 2026-04-22 (MYT-30 serving-infra design):** The app uses **decomposed** env vars, not pre-built `DATABASE_URL` / `REDIS_URL`. Task definitions inject `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_NAME` + `REDIS_HOST` / `REDIS_PORT` as plain env vars, and `DB_PASSWORD` + `REDIS_AUTH_TOKEN` via Secrets Manager. The app constructs `DATABASE_URL` / `REDIS_URL` at startup. This resolves the internal contradiction between the original §2.2 ("injected as URL") and §2.3 ("app constructs URL"). The decomposed form avoids putting secrets in env vars (URL contains the password) and keeps the task def JSON free of secret interpolation.

| Variable | Value | Source |
|----------|-------|--------|
| `NODE_ENV` | `production` or `staging` | Task definition |
| `PORT` | `3000` | Task definition |
| `DB_HOST` | RDS endpoint hostname | Task definition (from RDS endpoint output) |
| `DB_PORT` | `5432` | Task definition (from RDS port output) |
| `DB_USER` | `mythrun_${env}` | Task definition (fixed per env — matches user created by bootstrap-databases.sh) |
| `DB_NAME` | `mythrun_${env}` | Task definition (fixed per env) |
| `REDIS_HOST` | ElastiCache primary endpoint hostname | Task definition (from Redis endpoint output) |
| `REDIS_PORT` | `6379` | Task definition (from Redis port output) |
| `AUTH_MODE` | `real` | Always `real` in deployed environments |
| `AWS_REGION` | `us-east-1` | Task definition |
| `REGION_PREFIX` | `use1` | For Redis key namespacing (`{region}:session:{id}`) |

### 2.3 Secrets (Injected via Secrets Manager)

| Environment Variable | Secret ARN |
|---------------------|------------|
| `ANTHROPIC_API_KEY` | `mythrun/{env}/anthropic-api-key` |
| `STRIPE_SECRET_KEY` | `mythrun/{env}/stripe-secret-key` |
| `STRIPE_WEBHOOK_SECRET` | `mythrun/{env}/stripe-webhook-secret` |
| `COGNITO_CLIENT_SECRET` | `mythrun/{env}/cognito-client-secret` |
| `DB_PASSWORD` | `mythrun/{env}/rds-password` |
| `REDIS_AUTH_TOKEN` | `mythrun/shared/redis-auth` (**shared across envs** — amended 2026-04-22) |

**Amended 2026-04-22 (MYT-30 serving-infra design):** The Redis AUTH token is stored at `mythrun/shared/redis-auth` (not per-env) because the single shared ElastiCache replication group created in MYT-25 has one AUTH token used by both staging and future prod task roles. Both envs' task execution roles include this ARN explicitly. This also means a staging task-role compromise can read the prod Redis AUTH token — flagged in the MYT-30 design's Risks section; interim mitigation is staging-only until prod cutover.

The application constructs `DATABASE_URL` and `REDIS_URL` at startup by combining the non-secret host/port with the injected password/auth token.

### 2.4 Service Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Desired count | 1 (auto-scaling handles the rest) | Start lean, scale on demand |
| Min capacity | 1 | Always at least one task running |
| Max capacity | 4 | Covers peak of 200-500 concurrent sessions |
| Deployment type | Rolling update (`minimumHealthyPercent: 100`, `maximumPercent: 200`) | Zero-downtime: ECS spins up new task, waits for healthy, then drains old task. Simpler than CodeDeploy blue/green and sufficient at 1-4 tasks. |
| Deployment circuit breaker | Enabled with rollback | If new tasks fail health checks repeatedly, ECS automatically rolls back to previous task definition. Protects against crash loops at min_capacity=1. |
| Deregistration delay | 120 seconds | Time for in-flight LLM calls to complete |
| Subnets | `private-a`, `private-b` | Tasks run in private subnets |
| Security group | `sg-ecs` | Only accepts traffic from ALB on port 3000 |
| Assign public IP | No | Tasks are in private subnets behind NAT Gateway |

### 2.5 ALB Target Group

| Setting | Value |
|---------|-------|
| Name | `mythrun-{env}-api` |
| Protocol | HTTP |
| Port | 3000 |
| Target type | `ip` (required for Fargate awsvpc) |
| Health check path | `/health/ready` (readiness check — verifies Postgres + Redis connectivity, distinct from ECS liveness check) |
| Health check interval | 15s |
| Health check timeout | 5s |
| Healthy threshold | 1 (reduced from 2 to shave 15s off scale-out time; container liveness check already validates the process) |
| Unhealthy threshold | 3 |
| Deregistration delay | 120s |
| Stickiness | Disabled |

### 2.6 ALB Listener Rules

**Amended 2026-04-22 (MYT-30 serving-infra design):** Priority values are 100 (production) / 200 (staging) — not the original 1/2. ALB rule evaluation uses lower numeric priority as higher priority, so 100 wins if the two hosts ever collide (prod-wins-on-conflict is the intended safety default; the original 1/2 had staging winning, which was likely list-order, not intent). Priority range 100-299 is reserved for per-env API forward rules; 300+ for future preview environments.

| Priority | Condition | Action | Environment |
|----------|-----------|--------|-------------|
| 100 | Host: `api.mythrun.com` | Forward to production target group | Production |
| 200 | Host: `staging-api.mythrun.com` | Forward to staging target group | Staging |
| Default | None | Return 404 | — |

---

## 3. ECS Worker Service

The Worker service runs BullMQ workers that process pipeline jobs (world generation, character creation, session prep). It is not user-facing — it only communicates with Redis (job queue), Postgres (data persistence), and the Anthropic API (LLM calls).

### 3.1 Task Definition

Identical to the API service except:

| Setting | Value | Difference from API |
|---------|-------|-------------------|
| Family | `mythrun-{env}-worker` | Different name |
| Command | `["node", "dist/worker.js"]` | Worker entry point, not server |
| Port mappings | None | No inbound traffic |
| Health check | `CMD-SHELL, node -e "const http=require('http');http.get('http://localhost:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"` | Worker runs a minimal HTTP health server on port 3001 that checks BullMQ + Redis connectivity. A no-op check (`process.exit(0)`) would never detect deadlocked event loops or lost Redis connections. |
| Command | `["node", "--max-old-space-size=768", "dist/worker.js"]` | Worker entry point with V8 heap cap |
| Stop timeout | 120 seconds | Allow in-flight LLM pipeline calls to complete |

All other settings (CPU, memory, image, secrets, environment variables, log group `/mythrun/{env}/worker`) are identical to the API service.

### 3.2 Service Configuration

**Amended 2026-04-22 (MYT-30 serving-infra design):** The steady-state values below describe Prep Pipeline milestone onward — once a real `dist/worker.js` exists. During the interim (MYT-30 through the start of Prep Pipeline), the worker service is provisioned with `desired_count = 0` so that no task attempts to boot against the `:placeholder` ECR image. Flipped to `desired_count = 1` by the Prep Pipeline milestone's first CI deploy.

| Setting | Value | Rationale |
|---------|-------|-----------|
| Desired count | 1 (0 during MYT-30→Prep Pipeline interim) | Always-on, picks up jobs immediately |
| Min capacity | 1 | No scale-to-zero (avoids cold start on pipeline jobs) |
| Max capacity | 1 | No auto-scaling at launch; single worker handles the pipeline volume |
| Deployment type | Rolling update | Simpler than blue/green; no user-facing connections to drain |
| Subnets | `private-a`, `private-b` | Same as API |
| Security group | `sg-ecs` | Same SG as API (needs outbound to Anthropic, RDS, Redis) |
| ALB target group | None | Worker has no ALB registration |

### 3.3 Worker Scale-Up Path

At launch, one worker handles all pipeline jobs sequentially. BullMQ's concurrency control ensures only one pipeline stage runs at a time per campaign.

**When to add workers:**
- If pipeline queue depth (jobs waiting > 5 minutes) becomes a user-visible problem (users waiting too long for world gen)
- Scale by increasing `max_capacity` and `desired_count` in Terraform
- BullMQ handles job distribution across multiple workers automatically (each worker pulls from the same queue)

---

## 4. Docker Image

Defined in Week 0 spec (section 4.2). Summarized here for reference.

### 4.1 Multi-Stage Dockerfile

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
CMD ["node", "--max-old-space-size=768", "dist/server.js"]
```

### 4.2 Image Management

**Amended 2026-04-22 (MYT-30 serving-infra design):** ECR `image_tag_mutability` is `MUTABLE` (not IMMUTABLE). IMMUTABLE mode blocks overwriting *any* existing tag — CI's repeated `docker push :latest` would fail. Git-SHA tag immutability becomes a CI-discipline concern: CI must never re-push the same `{git-sha}` tag. The repo's lifecycle policy + CI's one-tag-per-SHA discipline together deliver the same immutability guarantee for SHA tags that IMMUTABLE mode would give.

| Setting | Value |
|---------|-------|
| ECR repository | `mythrun` |
| `image_tag_mutability` | `MUTABLE` (enables `:latest` convenience tag) |
| Tag strategy | `{git-sha}` (CI-enforced immutable) + `latest` (convenience, overwritten each build) |
| Lifecycle policy | Keep 20 most recent tagged images; expire untagged after 1 day |
| Scan on push | Enabled (ECR basic vulnerability scanning) |

### 4.3 Same Image, Different Entrypoints

The API and Worker services use the same image. The Worker overrides the CMD in its task definition:

```json
{
  "containerDefinitions": [{
    "command": ["node", "--max-old-space-size=768", "dist/worker.js"]
  }]
}
```

This ensures both services run identical code. A bug fix or feature change deploys the same artifact to both.

---

## 5. RDS PostgreSQL

### 5.1 Instance Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Engine | PostgreSQL 16 | Latest stable; UUIDv7 support via extension |
| Instance class | `db.t4g.micro` | 2 vCPU, 1GB RAM. Sufficient for launch scale. |
| Multi-AZ | No (Single-AZ) | Acceptable risk at <500 users. Upgrade when revenue justifies $13/mo. |
| Storage | 20 GB gp3 (3,000 baseline IOPS) | |
| Storage auto-scaling | Enabled, max 100 GB | Prevents write failures from storage exhaustion |
| Backup retention | 7 days (automated) | Point-in-time recovery within 7 days |
| Maintenance window | Sun 03:00-04:00 UTC | Low-traffic period |
| Backup window | Sun 02:00-03:00 UTC | Before maintenance |
| Deletion protection | Enabled (production) / Disabled (staging) | Prevent accidental deletion |
| Performance Insights | Enabled (free tier) | Helps diagnose slow queries |
| Encryption at rest | Enabled (AWS-managed key) | Default for new instances |
| Publicly accessible | No | Private subnet only, accessed via `sg-rds` |
| DB subnet group | `private-a`, `private-b` | Even though Single-AZ, subnet group spans both for future Multi-AZ upgrade |

### 5.2 Parameter Group

Custom parameter group based on `default.postgres16`:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `shared_buffers` | `{DBInstanceClassMemory/4}` | 25% of instance RAM (Postgres default, appropriate for micro) |
| `work_mem` | `2MB` | Per-operation sort memory. 4MB risks OOM under concurrent complex queries on 1GB instance. Workload is mostly simple key-value lookups. |
| `maintenance_work_mem` | `64MB` | For VACUUM and index creation |
| `effective_cache_size` | `{DBInstanceClassMemory*3/4}` | 75% of RAM (guides query planner) |
| `random_page_cost` | `1.1` | gp3 SSD storage — nearly sequential performance |
| `log_min_duration_statement` | `1000` | Log queries taking >1 second (slow query detection) |
| `log_connections` | `on` | Audit connection activity |
| `log_disconnections` | `on` | Detect connection churn |
| `idle_in_transaction_session_timeout` | `60000` | Kill idle-in-transaction after 60s (prevents connection leaks) |
| `statement_timeout` | `30000` | Kill queries after 30s (prevent runaway queries) |
| `max_connections` | `80` | Manually reduced from the RDS default (~112 for t4g.micro) to prevent memory pressure. Each connection consumes 5-10MB; 112 backends could exceed 1GB. 80 leaves headroom for 50 app connections + 30 for monitoring/migrations. |

### 5.3 Connection Strategy

No RDS Proxy at launch. Direct connections from ECS tasks via `pg` library with connection pooling.

| Setting | Value |
|---------|-------|
| Pool library | `pg.Pool` |
| Pool size — API containers | 10 |
| Pool size — Worker container | 4 (sequential pipeline stages don't need 10) |
| Connection timeout | 5 seconds |
| Idle timeout | 30 seconds |
| Max uses per connection | 10,000 (recycle to prevent memory leaks) |

**Connection budget:** API pool = 10, Worker pool = 4 (worker runs pipeline stages sequentially, doesn't need 10). At baseline: 1 x 10 + 1 x 4 = 14. At max scale: 4 x 10 + 1 x 4 = 44 connections. Well within the 80 max, leaving 36 for monitoring and migrations.

**Scale-up trigger:** Add RDS Proxy when total containers exceed 6 (60+ connections approaches the 80 limit).

### 5.4 Staging Database

Staging uses the same RDS instance with a different database name:

| Environment | Database Name | User |
|-------------|--------------|------|
| Production | `mythrun_prod` | `mythrun_prod` |
| Staging | `mythrun_staging` | `mythrun_staging` |

Separate users with separate passwords (from Secrets Manager). Each user has full privileges on their own database only.

### 5.5 Manual Snapshot Discipline

Before each production deploy:
1. CI pipeline triggers a manual RDS snapshot: `mythrun-prod-pre-deploy-{git-sha}`
2. Snapshot is retained for 7 days
3. If the deploy causes data issues, restore from this snapshot

This is a GitHub Actions step in the production deploy workflow (Stage 3 from Week 0 spec). The CI pipeline waits for snapshot completion before proceeding (poll `describe-db-snapshots` until `available`).

**Snapshot cleanup:** A scheduled GitHub Action (or Lambda) deletes manual snapshots older than 7 days. Manual snapshots do not auto-expire like automated backups.

### 5.6 Transaction Boundary Discipline

**Pipeline stages must NOT hold database transactions open across LLM API calls.** The `idle_in_transaction_session_timeout` (60s) will kill any connection that's idle inside a transaction for more than 60 seconds. Since Opus API calls can take 30-60+ seconds, a pattern like `BEGIN -> call Anthropic -> INSERT -> COMMIT` will be killed.

Correct pattern: read data (no transaction), call Anthropic API, then `BEGIN -> INSERT -> COMMIT` (fast, <1 second).

**Migrations** must `SET statement_timeout = 0` per-session, as `CREATE INDEX CONCURRENTLY` on large tables will exceed the 30-second default.

---

## 6. ElastiCache Redis

### 6.1 Instance Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Engine | Redis 7.1 or latest available (check `aws elasticache describe-cache-engine-versions --engine redis`) | ElastiCache may not offer 7.2; 7.1 is the likely latest. Alternatively, use the Valkey-compatible engine (functionally identical for pub/sub, BullMQ, basic data structures). Pin local Docker Compose to match the chosen version. |
| Node type | `cache.t4g.micro` | 0.5GB RAM. Sufficient for ~1,000 concurrent sessions (see memory math below). |
| Number of nodes | 1 (no replica) | Single node at launch. Add replica for Multi-AZ when justified. |
| Cluster mode | Disabled | Single shard. Enable cluster mode only if pub/sub sharding is needed (>5K sessions). |
| Encryption in transit | Enabled (TLS) | |
| Encryption at rest | Enabled | |
| AUTH token | From Secrets Manager (`mythrun/{env}/redis-auth`) | |
| Subnet group | `private-a`, `private-b` | Spans both AZs for future replica |
| Security group | `sg-redis` | Port 6379 from `sg-ecs` only |
| Maintenance window | Mon 03:00-04:00 UTC | |
| Snapshot retention | 1 day | Minimal — Redis data is transient; Postgres is the durable store |
| Parameter group | Custom (see below) | |

### 6.2 Parameter Group

Custom parameter group based on `default.redis7`:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `maxmemory-policy` | `volatile-lru` | Evicts keys with TTLs (least-recently-used first) when memory fills. Session state keys have 4-hour TTLs and can be reloaded from Postgres checkpoints if evicted (0-5 min data gap). BullMQ keys, rate limit counters, and pub/sub metadata have no TTLs and are never evicted. This prevents a memory pressure event from cascading into total system failure (which `noeviction` would cause — all writes fail including BullMQ, rate limiting, and pub/sub). |
| `notify-keyspace-events` | `""` (disabled) | Not needed; saves CPU |
| `timeout` | `0` | No idle timeout on connections (long-lived pub/sub subscriptions) |
| `tcp-keepalive` | `300` | Detect dead connections after 5 minutes |

### 6.3 Memory Budget

| Workload | Per-Unit Size | At 200 Sessions | At 500 Sessions |
|----------|--------------|-----------------|-----------------|
| Session state (FT history, summary, combat) | 200-800 KB/session (300KB median, 800KB for long/verbose sessions) | 60 MB (300KB avg) | 150 MB |
| Running summary per session | 2-5 KB | 0.6 MB | 1.5 MB |
| BullMQ job metadata | ~50 KB/active job | <5 MB | <10 MB |
| Rate limit counters | negligible | <1 MB | <1 MB |
| Message sequence counters | 8 bytes/session | negligible | negligible |
| Pub/sub channel metadata | negligible | <1 MB | <1 MB |
| **Total** | | **~70 MB** | **~165 MB** |

A `cache.t4g.micro` has ~460 MB usable memory (after OS overhead). At 500 concurrent sessions with median session sizes, usage is ~165 MB — about 36% capacity. On a heavy Friday night with longer sessions (500KB avg), usage could reach ~260 MB (56%).

With `volatile-lru`, if memory ever does fill, the oldest idle session states are evicted first and reloaded from Postgres on reconnect. No cascading failure.

**The 80% memory alarm** (from Week 0 spec) fires at ~368 MB usage, which corresponds to roughly **600-900 concurrent sessions** depending on session length. At that point, upgrade to `cache.t4g.small` (1.5 GB usable).

### 6.4 Staging Redis

Staging uses the same ElastiCache instance with key prefixes:

| Environment | Key Prefix | Example Key |
|-------------|-----------|-------------|
| Production | `prod:use1:` | `prod:use1:session:{campaignId}:state` |
| Staging | `staging:use1:` | `staging:use1:session:{campaignId}:state` |

The application prepends the environment + region prefix to all Redis keys. This is configured via the `REGION_PREFIX` and `NODE_ENV` environment variables.

### 6.5 Connection Strategy

| Setting | Value |
|---------|-------|
| Client library | `ioredis` |
| Connections — API container | 3-4 total: 1 general commands (session state, rate limiting, locks, sequence numbers) + 1 pub/sub subscriber + 1 BullMQ Queue (enqueue jobs) + optionally 1 QueueEvents |
| Connections — Worker container | 5-6 total: 2 BullMQ Worker (blocking + commands) + 1 BullMQ Queue + 1 QueueEvents + 1 general commands + 1 pub/sub subscriber |
| Total at max scale | 4 API x 4 + 1 Worker x 6 = **22 connections** (Redis supports 65K; this is not a constraint) |
| Reconnect strategy | Exponential backoff, 1s to 30s, unlimited retries |
| TLS | Enabled |
| Lazy connect | No (connect at startup, fail fast if Redis is unreachable) |

---

## 7. Auto-Scaling Policies

### 7.1 API Service Auto-Scaling

| Setting | Value |
|---------|-------|
| Service | `mythrun-{env}-api` |
| Min capacity | 1 |
| Max capacity | 4 |
| Scale-out cooldown | 60 seconds |
| Scale-in cooldown | 300 seconds (5 min) |

**Two scaling policies (highest wins):**

**Policy 1: CPU-based**

| Setting | Value |
|---------|-------|
| Metric | `ECSServiceAverageCPUUtilization` |
| Target value | 70% |
| Scale-out threshold | >70% for 3 consecutive 1-minute periods |
| Scale-in threshold | <30% for 10 consecutive 1-minute periods |

**Policy 2: Connection-count based (step scaling, custom metric)**

The API service publishes two custom CloudWatch metrics every 60 seconds:
- `MythrunTotalWebSocketConnections` — total across all tasks
- `MythrunMaxWebSocketConnectionsPerTask` — the highest single-task count (catches uneven distribution)

Step scaling policy (uses total connections to avoid the feedback loop that target tracking with per-task averages creates):

| Total Connections | Desired Tasks | Rationale |
|-------------------|---------------|-----------|
| 0-100 | 1 | Single task handles up to 100 connections |
| 101-200 | 2 | |
| 201-300 | 3 | |
| 301+ | 4 | Max capacity |

Scale-in uses the same thresholds with a 10-minute evaluation period (connections must stay below the lower threshold for 10 consecutive minutes before scaling in).

**How the two policies interact:** ECS uses the policy that results in the higher desired task count. CPU handles compute-bound spikes; connections handle session-count spikes.

**Policy 3: Scheduled scaling (weekend pre-warming)**

| Schedule | Min Capacity | Rationale |
|----------|-------------|-----------|
| Friday 17:00 UTC | 2 | Pre-scale before weekend evening peak |
| Sunday 01:00 UTC | 1 | Scale back after weekend |

This avoids the 5-7 minute reactive scale-out delay on Friday evening when traffic spikes.

### 7.2 Scale-In Behavior

Scale-in is conservative to protect WebSocket connections:

- **5-minute cooldown** after scale-in before another scale-in can happen
- **ECS connection draining**: When a task is selected for termination, the ALB deregisters it (120s deregistration delay) while the task receives SIGTERM and runs graceful shutdown
- **Task selection**: ECS selects a task in the AZ with the most tasks (AZ-balanced). On Fargate, the specific task within that AZ is not controllable — it may be the task with the most or fewest connections.
- **Application-level drain**: On SIGTERM, the container sends a WebSocket close frame with a `server_restart` message to all connected clients, allowing them to reconnect to healthy tasks. Without this, connections are SIGKILL'd when `stopTimeout` expires.

### 7.3 Worker Service

No auto-scaling at launch. Fixed at 1 task. Scale manually by updating Terraform if pipeline queue depth becomes a problem.

---

## 8. Scale-Up Triggers and Progression

A reference table for when to upgrade each component. Each upgrade is a Terraform parameter change unless noted otherwise.

### 8.1 Progression Table

| Trigger Condition | Action | Cost Impact | Terraform Change |
|-------------------|--------|-------------|-----------------|
| API CPU sustained >70% at max tasks | Increase API task CPU to 1024 (1 vCPU) and memory to 2048 (2GB) | +$48/mo per task | `ecs_api_cpu`, `ecs_api_memory` |
| API max tasks (4) consistently hit | Increase `max_capacity` to 8 | Variable (only pay when scaled out) | `ecs_api_max_capacity` |
| Redis memory alarm (>80%) | Upgrade to `cache.t4g.small` (1.5GB) | +$12/mo | `redis_node_type` |
| Redis pub/sub p99 latency >5ms during pipeline runs | Split to 2 Redis instances (real-time + batch) | +$12/mo | New module instance + app config change |
| Redis AZ failure unacceptable | Add replica (Multi-AZ) | +$12-24/mo | `redis_replicas = 1` |
| RDS CPU sustained >80% | Upgrade to `db.t4g.small` (2 vCPU, 2GB) | +$13/mo | `rds_instance_class` |
| RDS connections approaching 80 (6+ containers) | Add RDS Proxy | +$22/mo | New resource in `data` module |
| RDS AZ failure unacceptable | Enable Multi-AZ | +$13/mo | `rds_multi_az = true` |
| Pipeline queue depth >5min sustained | Add second worker task | +$24/mo | `ecs_worker_count = 2` |
| Slow queries identified via Performance Insights | Add read replica | +$13/mo | New resource in `data` module + app routing |
| AZ-a outage tolerance needed | Add second NAT Gateway in public-b, update private-b route table | +$32/mo | New NAT Gateway resource + per-AZ route tables |

### 8.2 Monitoring Alarms

Every progression trigger should have a corresponding CloudWatch alarm (email, not SMS — these are "scale up this week" notifications, not "wake up now" emergencies). Do not rely on weekly manual review; you will forget by week 3.

**Critical alarms** (SMS — from Week 0 spec): service down, RDS high CPU, Redis memory >80%, ALB 5xx spike.

**Scale-up warning alarms** (email):

| Metric | Source | Warning Threshold | Critical Threshold |
|--------|--------|-------------------|-------------------|
| CPU utilization (API) | ECS | >60% sustained | >80% sustained |
| CPU utilization (Worker) | ECS | >70% sustained | >90% sustained |
| Memory utilization (API) | ECS | >70% | >85% |
| Active WebSocket connections | Custom metric | >300 total | >400 total |
| RDS CPU | CloudWatch | >70% sustained | >90% sustained |
| RDS free storage | CloudWatch | <5 GB | <2 GB |
| RDS connections | CloudWatch | >50 | >70 |
| Redis memory usage | CloudWatch | >60% | >80% |
| Redis CPU | CloudWatch | >50% | >70% |
| Pipeline queue depth | Custom metric | >10 jobs waiting | >25 jobs waiting |
| NAT Gateway data transfer | CloudWatch | >50 GB/mo | >100 GB/mo (cost alert) |

---

## 9. Out of Scope

| Item | Deferred To |
|------|------------|
| Postgres schema, tables, and migrations | Database Migration sub-spec |
| Application-level health check implementation | Database Migration sub-spec (needs Postgres) |
| BullMQ worker implementation | Multiplayer Session Architecture sub-spec (defines the job types) |
| Custom CloudWatch metric publishing code | Observability & Hardening sub-spec |
| WebSocket connection tracking implementation | Multiplayer Session Architecture sub-spec |
| Auto-scaling dashboard | Observability & Hardening sub-spec |
| RDS Proxy configuration details | Deferred until scale-up trigger is hit |
| Redis Cluster mode | Deferred until >5K concurrent sessions |
| Multi-AZ for RDS and Redis | Deferred until revenue justifies cost |
| EC2/Reserved Instance migration | Deferred until compute costs dominate (they won't — LLM costs will always be 10-50x infrastructure) |
