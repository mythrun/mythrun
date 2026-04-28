# MYT-35 Backend Core Prod Hardening — Design Spec

**Date:** 2026-04-28
**Linear:** MYT-35 (Platform milestone, due 2026-05-01)
**Closes beads:** myth-nf3, myth-g6g, myth-ccf
**Status:** v2 (post-Round-1 blind review by Andes / Atlas / Karakoram)
**Author:** Claude (Miklos's instance)

## Goal

Three small operational pieces that engage MYT-29's dormant boot gate in staging now that the data layer + the real RDS bootstrap (myth-ml8) + the repository layer (MYT-34) all exist:

1. New `/health/ready` route — pg + 2× redis ping per request, 1s per-probe timeout, returns 200/503 with which probes failed. `/health` stays as the liveness endpoint (ECS container check).
2. New `backend/src/worker.ts` entrypoint scaffold — env load + redis-batch ping + log + signal handlers + idle-await. No queue subscriptions yet.
3. Terraform: per-env `extra_env` arg on `modules/serving` so each environment declares its boot-gate state explicitly; flip `BOOT_GATE_ENABLED=1` in staging only; swap ALB target-group health-check path `/health` → `/health/ready`. Dockerfile `HEALTHCHECK --start-period` bumps for local-dev consistency.

After this lands, staging runs the full data-layer-aware boot path against the real RDS bootstrapped today; the ALB gates traffic on real readiness.

## Why this exists now

MYT-29 shipped the boot-gate code with `BOOT_GATE_ENABLED` defaulting OFF so deploys could stay green at `/health` while the data layer was being built. Three preconditions had to land:

- Real DB exists in staging (myth-ml8 — closed today)
- Repository layer wired into `app-deps.ts` (MYT-34 — closed)
- Backend Core data-layer code (`createPgPool`, `createRedisClient`, `waitFor`) (MYT-29 — closed)

All true. MYT-35 is the wire-up that engages the gate.

## Scope

**In scope:**
- `backend/src/routes/health-ready.ts` (new)
- `backend/src/__tests__/health-ready.test.ts` (new)
- `backend/src/app.ts` (modify — register the new route + drop the `_deps` underscore once consumed)
- `backend/src/worker.ts` (new — exports `main()`, conditionally invokes when entry-point)
- `backend/src/__tests__/worker.test.ts` (new — imports `main` directly, mocks env+redis, no top-level execution side-effect)
- `backend/Dockerfile` (modify — local-dev `HEALTHCHECK --start-period` 5s → 30s; **note: overridden by Fargate task-def's `healthCheck.startPeriod=60` in production — this bump is local-`docker compose`-only**)
- `infra/modules/serving/variables.tf` (modify — add `var.extra_env` with default `[]`)
- `infra/modules/serving/main.tf` (modify — concat `var.extra_env` into common_env, swap ALB health-check path to `/health/ready`, update stale comment that referenced myth-nf3)
- `infra/environments/staging/main.tf` (modify — pass `extra_env = [{ name = "BOOT_GATE_ENABLED", value = "1" }]`)
- Wiki refreshes (source-hash gates on serving.html, repository.html, infra/data.html will trip from the *.tf + script edits — refresh inline)

**Out of scope:**
- **Production environment**: no prod TF workspace exists yet. Prod composition lands at Launch; that ticket explicitly sets its own `extra_env = [{ name = "BOOT_GATE_ENABLED", value = "1" }]` (NOTE: a follow-up bead is filed to make sure prod doesn't silently launch with the gate OFF — the default-`[]` `extra_env` is a footgun if forgotten).
- **Worker queue subscriptions**: scaffold only. Queue topology lives in Prep Pipeline / Session Runtime.
- **Worker desired_count**: stays at 0 (the scaffold ships but doesn't run in staging until a later milestone bumps it). Spec calls this out so a reader doesn't expect to see worker logs after this PR.
- Anthropic / Stripe / Cognito readiness probes — vendor-side outages should not gate ALB traffic.
- Migrations-table check — startup-time invariant, not a per-request signal.

## Locked design decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **`/health/ready` probes data layer only** (pg `SELECT 1` + redis-realtime `PING` + redis-batch `PING`). | Backend Core §6 verbatim. Vendor outages shouldn't gate ALB; migrations are a startup invariant. |
| 2 | **Probes run in parallel via `Promise.all`** (NOT `allSettled`). Each probe call always resolves to a `ProbeResult` (the `try`/`catch` swallows internally), so `Promise.all` works correctly and avoids the dead `'unknown'` fallback that the previous `allSettled` design implied (Andes Round-1 H1). |
| 3 | **1s per-probe timeout via `Promise.race`** wrapper inside the `probe` helper. ALB health-check timeout is 5s; 1s × 3 parallel = 1s wall-time worst case. **Resource-leak caveat (acknowledged, not eliminated):** if a probe times out via `Promise.race`, the underlying `pg.Pool.query` or `ioredis.ping()` keeps running until its own internal timeout. At pool max=10 and ALB rate ~4 req/min, steady-state risk is bounded; in a wedged-pg scenario the container's overall liveness suffers and ECS replaces the task via the container `HEALTHCHECK` watchdog. Promise.race guarantees a fast HTTP response, NOT resource cleanup. (Andes Round-1 H2.) |
| 4 | **`worker.ts` is a bare scaffold.** Env load → redis-batch client → ping → log → signal handlers → idle. **Exports `main()`; conditional invocation via `if (import.meta.url === ...)` so tests can import without executing.** (Andes Round-1 H3 fix.) |
| 5 | **ALB target-group health-check path swaps to `/health/ready`** in this PR. |
| 6 | **`HEALTHCHECK --start-period = 30s`** in the Dockerfile (was 5s) — local-dev relevance only. The production Fargate `startPeriod = 60` (`infra/modules/serving/main.tf:196`) is the real knob and is already correct. The Dockerfile bump keeps `docker compose up --wait` from giving up too early on a local boot-gate-on cold start. (Atlas Round-1 M4.) |
| 7 | **Staging-only `BOOT_GATE_ENABLED=1`** via per-env `extra_env`. The serving module's worker container also receives this env (since it shares `common_env`), but `worker.ts` doesn't read `BOOT_GATE_ENABLED` — harmless. (Atlas Round-1 H1: clarified intent.) |
| 8 | **Deploy ordering: code push first, terraform apply second** (Karakoram Round-1 H1: critical). The reverse ordering creates a 5–15-minute staging outage because the running OLD image lacks the `/health/ready` route, so an ALB path flip at that moment 404s every health check. Push-first means the new image with the route lands while ALB still polls `/health`; once the new image is healthy, terraform apply flips the ALB path against an image that already serves the route. |
| 9 | **`error: string \| undefined`** on `ProbeResult` with explicit `error: undefined` on success — required under `tsconfig.exactOptionalPropertyTypes: true`. (Andes Round-1 C1.) |
| 10 | **Acceptance criteria does NOT pattern-match a literal "Plan: 0 to add, 3 to change, 0 to destroy" line.** Task-def env-var changes against `lifecycle { create_before_destroy = true }` produce a replacement (`+/-`), NOT an in-place change (`~`). The actual plan is closer to **2 add + 1 change + 2 destroy**. Acceptance enumerates expected resources and the operator eyeballs the plan; we don't grep on the count line. (Atlas Round-1 C1.) |

## Architecture

```
backend/src/
├── app.ts                       ── registers /health (existing) + /health/ready (new)
│                                   _deps underscore comes off (now consumed by registerReadyRoute)
├── server.ts                    ── unchanged (boot gate code already exists from MYT-29)
├── worker.ts                    ── NEW: exports main(), conditional entry-point invocation
├── routes/
│   └── health-ready.ts          ── NEW: readiness route + probe helpers
└── __tests__/
    ├── app.test.ts              ── existing (covers /health liveness)
    ├── health-ready.test.ts     ── NEW: 4 cases — all-ok / pg-fail / multi-fail / timeout
    └── worker.test.ts           ── NEW: imports main, mocks env+redis, asserts log+shutdown

backend/Dockerfile               ── HEALTHCHECK --start-period 5s → 30s (local-dev only)

infra/modules/serving/
├── variables.tf                 ── + var.extra_env (list, default [])
└── main.tf                      ── concat var.extra_env into common_env;
                                   aws_lb_target_group.api.health_check.path: /health → /health/ready

infra/environments/staging/main.tf ── module "serving": pass extra_env = [{
                                       name = "BOOT_GATE_ENABLED", value = "1"
                                    }]
```

## Components

### `backend/src/routes/health-ready.ts`

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app-deps.js'

const PROBE_TIMEOUT_MS = 1000

interface ProbeResult {
  name: string
  ok: boolean
  error: string | undefined
}

async function probe(name: string, fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`probe timeout after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
      ),
    ])
    return { name, ok: true, error: undefined }
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerReadyRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health/ready', async (_req, reply) => {
    // probe() always resolves to a ProbeResult — Promise.all is sufficient
    // (NOT allSettled, which would imply a third "rejected" branch we never
    // hit, leaving dead code that masks real failure modes).
    const results = await Promise.all([
      probe('pg', () => deps.pg.query('SELECT 1')),
      probe('redis-realtime', () => deps.redisRealtime.ping()),
      probe('redis-batch', () => deps.redisBatch.ping()),
    ])

    const failed = results.filter((r) => !r.ok).map((r) => r.name)

    if (failed.length > 0) {
      // Log structured probe failures so operators can grep CloudWatch.
      // Format anchored: "health-ready probe failed: <name> (<error>)" per probe.
      for (const r of results) {
        if (!r.ok) app.log.warn({ probe: r.name, err: r.error }, 'health-ready probe failed')
      }
      return reply.code(503).send({ ready: false, failed })
    }
    return reply.code(200).send({ ready: true })
  })
}
```

(Karakoram Round-1 M1: structured `app.log.warn` per failed probe gives operators a `aws logs filter '"health-ready probe failed"'` query for the "after a week, is the 1s timeout giving false positives?" review. CloudWatch metric emission is a separate, optional follow-up.)

### `backend/src/app.ts` modification

Add one import and one call after the existing `/health` registration. Drop the `_deps` underscore + the `eslint-disable-next-line` comment if present, since `deps` is now used.

```ts
import { registerReadyRoute } from './routes/health-ready.js'
// ... existing imports + buildApp signature ...
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))   // unchanged: liveness
  registerReadyRoute(app, deps)                  // NEW: readiness
  // ... rest unchanged ...
}
```

### `backend/src/worker.ts`

```ts
import { loadEnv } from './config/env.js'
import { createRedisClient } from './redis/client.js'

export async function main(): Promise<void> {
  const env = loadEnv()
  const redis = createRedisClient(env.redisBatchUrl)
  // Force the connection so failures surface at startup, not at first job.
  await redis.ping()
  console.log('worker started')

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`worker stopping (${signal})`)
    await redis.quit().catch(() => undefined)
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal))
  }

  // Block forever — keep the event loop alive. Everything below this line
  // is unreachable; shutdown only happens via the signal handler above
  // (which calls process.exit). Subsequent milestones replace this with
  // BullMQ Worker registrations whose own loops keep the event loop alive.
  await new Promise<never>(() => undefined)
}

// Conditional invocation — only run main() when this file is the entry
// point. Tests import `main` and execute under their own control.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
```

### `backend/src/__tests__/health-ready.test.ts`

Four cases against `buildApp(stubDeps)` with stub deps whose `query`/`ping` resolve or reject deterministically:

1. **all probes succeed** → 200 + `{ ready: true }`.
2. **pg.query rejects** → 503 + `{ ready: false, failed: ['pg'] }`.
3. **pg + redis-batch reject** → 503 + `failed` contains both names (order-insensitive — assert via `.sort()`).
4. **a probe hangs > 1s** → with `vi.useFakeTimers()`, advance to 1001ms → handler returns 503 with `failed` including the hung probe.

Test helper: `__tests__/helpers/stub-deps.ts` exports `makeStubDeps({ pgQuery?, ping1?, ping2? })` so future tests don't reinvent the mock surface (Andes Round-1 M2).

### `backend/src/__tests__/worker.test.ts`

Imports `main` directly (not the module — that would execute the conditional invocation in some test runners). Mocks `loadEnv` + `createRedisClient` so `ping`/`quit` resolve. Asserts `console.log('worker started')` is called. Sends `process.emit('SIGTERM', 'SIGTERM')`, asserts `quit` is awaited and `process.exit(0)` is called (mock `process.exit` to throw a sentinel error so the test can catch it instead of actually exiting).

### `backend/Dockerfile` change

```diff
-HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
+HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
   CMD curl -f http://localhost:3000/health || exit 1
```

The HEALTHCHECK command stays at `/health` (liveness). **In Fargate this is overridden by the task-def `healthCheck` block** — the bump only matters for local `docker compose up --wait` waiting longer for the boot-gate-enabled cold start. Production is governed by `infra/modules/serving/main.tf:196` which is already at `startPeriod = 60`.

### `infra/modules/serving/variables.tf` addition

```hcl
variable "extra_env" {
  description = "Additional environment variables to inject into both API and Worker task definitions, on top of common_env. Used for per-env switches (e.g., BOOT_GATE_ENABLED in staging) without polluting the shared module locals. Keys here override matching keys in common_env only insofar as Docker honors last-write semantics on duplicate names — extras should be additive, not redefining shared keys."
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}
```

### `infra/modules/serving/main.tf` modifications

```hcl
locals {
  common_env = concat([
    { name = "NODE_ENV", value = var.environment },
    # ... existing entries ...
    { name = "REDIS_PORT", value = tostring(var.redis_port) },
  ], var.extra_env)
  # ... common_secrets unchanged ...
}

resource "aws_lb_target_group" "api" {
  # ...
  health_check {
    enabled             = true
    path                = "/health/ready" # MYT-35: ALB gates on data-layer readiness; closes myth-nf3
    # ... rest unchanged ...
  }
}
```

The target-group `path` change is an in-place modification (no replacement). The TG ARN is stable; the listener-rule reference + the ECS service `load_balancer` block both point at it by ARN — neither churns.

### `infra/environments/staging/main.tf` modification

```hcl
module "serving" {
  # ... existing args ...

  # MYT-35: flip the boot gate ON in staging. Production stays at default
  # OFF until the prod stack is composed at the Launch milestone, at which
  # point the prod environment workspace must explicitly set this — the
  # default-[]] extra_env IS a footgun if forgotten (see follow-up bead).
  extra_env = [
    { name = "BOOT_GATE_ENABLED", value = "1" },
  ]
}
```

## Deploy sequence (load-bearing — DO NOT REORDER)

1. **Code push to `main`.** `pnpm test` + lint + typecheck pass locally; push. The MYT-28 deploy workflow builds the new image (now containing `/health/ready` route + `worker.ts` + Dockerfile change) and deploys a new ECS task-def revision. **At this point: BOOT_GATE_ENABLED is still unset in the deployed task-def — gate stays default OFF, fallbackStart runs.** ALB still health-checks `/health` (terraform hasn't applied yet), the new container responds 200. ALB target stays healthy. Verify via:
   ```bash
   curl -fsS https://staging-api.mythrun.com/health           # expect: {"status":"ok"}
   curl -fsS https://staging-api.mythrun.com/health/ready     # expect: {"ready":true}  -- new route works
   ```
2. **`terraform -chdir=infra/environments/staging plan`.** Review the diff: `aws_lb_target_group.api` in-place modify (`health_check.path`); `aws_ecs_task_definition.api` and `aws_ecs_task_definition.worker` BOTH show as `+/- replacement` (NOT `~ in-place`) because of `lifecycle { create_before_destroy = true }` + `essential = true` on both containers. Surface the plan to operator; do NOT pattern-match a literal change-count line.
3. **`terraform apply`.** Two effects in one apply:
   - ALB target-group `health_check.path: /health → /health/ready`. The currently-running container already has this route from step 1 → no health-check disruption.
   - Both task-defs get a new revision with `BOOT_GATE_ENABLED=1`. ECS rolls API service to the new revision. New container starts with gate ON → `waitFor` runs → succeeds (DB exists from myth-ml8) → app.listen → ALB sees `/health/ready` 200 → traffic flows. `deployment_minimum_healthy_percent = 100` keeps the old task serving until the new one is healthy.
   - Worker service gets a new task-def revision but `desired_count = 0` so nothing actually rolls (Karakoram Round-1 L2: scaffold ships, doesn't run yet — by design).
4. **Verify boot gate engaged.** CloudWatch shows `✓ Postgres ready / ✓ Redis (realtime) ready / ✓ Redis (batch) ready` lines in the new task's logs. ALB target-group reports `Healthy` against the new task.

## First-time operator runbook (Karakoram Round-1 H2)

### Pre-flight (before pushing)

- Confirm staging RDS is reachable from the ECS SG: `aws rds describe-db-instances --query 'DBInstances[?DBInstanceIdentifier==`mythrun`].DBInstanceStatus' --output text` returns `available`.
- Confirm `mythrun/staging/rds-password` is a real value (not `PLACEHOLDER`): `aws secretsmanager describe-secret --secret-id mythrun/staging/rds-password --query VersionIdsToStages` returns at least one `AWSCURRENT` mapping.
- Confirm Redis AUTH secret is intact: `aws secretsmanager describe-secret --secret-id mythrun/shared/redis-auth --query VersionIdsToStages` likewise.

### During the deploy

Two surfaces to watch:
- GH Actions run page (`gh run watch`) — build + deploy step success.
- CloudWatch `/ecs/mythrun-staging-api` log group — `aws logs tail /ecs/mythrun-staging-api --follow` after the apply.

### Failure-mode tree

| Symptom | Likely cause | First check / action |
|---|---|---|
| `✗ Boot gate failed: Postgres ...` in CloudWatch | RDS SG didn't propagate the bootstrap-db rule; or `DB_PASSWORD` Secrets Manager value is stale | `aws ec2 describe-security-groups --group-ids $RDS_SG_ID` looking for the ECS SG ingress; `aws secretsmanager get-secret-value --secret-id mythrun/staging/rds-password --query VersionId` to confirm it's the current version |
| `✗ Boot gate failed: Redis ...` | Redis AUTH token rotated and ECS task-def points at an outdated secret version | `aws elasticache describe-replication-groups --query 'ReplicationGroups[0].AuthTokenLastModifiedDate'` vs. the secret version creation date |
| ALB target-group reports `Unhealthy` after deploy goes green | `/health/ready` answering 503 — check the structured probe-failed log lines: `aws logs filter-log-events --log-group-name /ecs/mythrun-staging-api --filter-pattern 'health-ready probe failed'` | The log line tells you which probe; jump to the corresponding row above |
| Circuit breaker rolled back the deploy | ECS replaced 10+ failing tasks within `wait-for-minutes: 15` | `aws ecs describe-services --cluster mythrun --services mythrun-staging-api --query 'services[0].deployments[*].failureReason'` |
| Deploy stuck for >5 min on a probe that won't time out | Probe timeout is firing but pg/redis client is wedged; pool depletion | See **Emergency rollback** |

### Emergency rollback

If the boot gate is genuinely failing for a reason that can't be quickly diagnosed:

```bash
# 1. Flip BOOT_GATE_ENABLED back OFF in staging.
sed -i '' 's/{ name = "BOOT_GATE_ENABLED", value = "1" }/{ name = "BOOT_GATE_ENABLED", value = "0" }/' infra/environments/staging/main.tf

# 2. Apply.
terraform -chdir=infra/environments/staging apply

# 3. Optionally, also flip ALB health-check path back to /health for the duration.
#    (Manually edit modules/serving/main.tf or use a -target apply.)
```

This restores the MYT-28 fallback behavior. Investigate, fix, re-apply.

### What's NOT affected during a boot-gate-failure rollback

Boot-gate failures occur *before* `app.listen`; the failing task never accepts requests. The OLD task continues serving until the new revision is healthy or the circuit breaker rolls back. No in-flight requests are affected. This is why `deployment_minimum_healthy_percent = 100` matters here.

## Liveness vs. readiness (why both, not cargo-cult)

Same Fastify app instance serves both endpoints. If the app crashes (event loop wedged, OOM, unhandled rejection), both fail simultaneously — that's fine. The distinction is in the **action**:

- **`/health` (liveness)** is the ECS container `HEALTHCHECK`. Failure → ECS kills + replaces the container. This is the recovery path for "process is alive but stuck" / "process is dead."
- **`/health/ready` (readiness)** is the ALB target-group health-check. Failure → ALB stops routing, container keeps running and may self-heal (Redis reconnects, pg pool recovers). Recovery path for "dependency briefly flapped."

The cost of conflating them: a Redis blip → 30 seconds of unhealthy → ECS restarts the container → cold-start → 30s of warmup → Redis was actually fine the whole time. We've seen this pattern bite teams; the split is deliberate.

## Error handling

- **Probe rejects within 1s**: `probe()` catches, `app.log.warn` records `{probe, err}` for ops grep, handler returns 503 with `failed` list.
- **Probe times out at 1s**: same path — `Promise.race`'s synthetic rejection (`probe timeout after 1000ms`) is treated identically.
- **Promise.race timeout fires but underlying call is still wedged**: see Decision §3 caveat. The HTTP response is fast; the underlying connection may be held until pg/redis client's own timeout. Container HEALTHCHECK is the watchdog.
- **All probes succeed but Fastify response throws** (impossible by inspection): Fastify default 500 → ALB unhealthy.
- **Worker `redis.ping()` fails at startup**: `main()` rejects, top-level await throws (when entry-point), process exits non-zero. `essential = true` on the worker container (`infra/modules/serving/main.tf:219`) → task stops → service replaces. With `desired_count = 0` today this is moot until the worker is exercised.
- **Worker `redis.quit()` fails during shutdown**: caught with `.catch(() => undefined)`. Exit anyway.

## Testing

| Layer | What | How |
|---|---|---|
| `/health/ready` happy | All three probes succeed → 200 `{ready:true}` | Case 1 in `health-ready.test.ts` |
| `/health/ready` single fail | pg fails → 503 + `failed:['pg']` | Case 2 |
| `/health/ready` multi-fail | pg + redis-batch fail → 503, `failed` order-insensitive | Case 3 |
| `/health/ready` timeout | `vi.useFakeTimers()`; probe never resolves; `vi.advanceTimersByTime(1001)` | Case 4 |
| `worker.ts` startup | Mock `loadEnv` + `createRedisClient`; call `main()`; assert `console.log('worker started')` | `worker.test.ts` |
| `worker.ts` shutdown | Mock `process.exit`; emit SIGTERM; assert `redis.quit` awaited + exit called | `worker.test.ts` |
| Dockerfile sanity | `--start-period=30s` parses; image still builds | Existing CI build job |
| Terraform plan | Adds BOOT_GATE_ENABLED to common_env; updates target-group path | Plan diff in pre-apply review (NOT a literal grep) |
| End-to-end | After full deploy: ALB → `/health/ready` → 200; CloudWatch shows three `✓ X ready` lines | Manual: `curl https://staging-api.mythrun.com/health/ready` + `aws logs tail` |

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Boot gate fails on first staging deploy → ECS rolls back, alarm spam | `waitFor` retries with backoff; transient cold-start blips self-heal. Hard failure surfaces with a specific dep name in CloudWatch. **Recovery: emergency rollback** flips `BOOT_GATE_ENABLED=0` and re-applies (see runbook). Bad-deploy-detection window: container `HEALTHCHECK` `startPeriod=60` + `interval=30s` × `retries=3` = ~2.5 min, then ECS task replacement; circuit-breaker fires after ~10 failed task starts × ~30–60s each = **5–10 min total** before automatic rollback. Acceptable for staging — no real users. |
| `/health/ready` 1s probe timeout is too tight under load | Worst-case healthy-DB probe time at <100 req/min is single-digit ms. If false-positive 503s appear, the `app.log.warn` lines are grep-able: `aws logs filter-log-events --log-group-name /ecs/mythrun-staging-api --filter-pattern '"health-ready probe failed"'`. Calendar reminder one week post-deploy to inspect. If non-trivial false-positive rate, bump to 2s and revisit. |
| ALB swap to `/health/ready` causes brief unhealthy-flap during deploy | Decision §8 (deploy ordering) eliminates this: the new image with the route lands BEFORE the ALB path flip. Combined with `health_check_grace_period_seconds = 120` (NOT 60) and `--start-period=30s` local-dev / `startPeriod=60` Fargate, cold containers have ample time. |
| Worker container exits silently and ECS doesn't notice | `essential = true` (verified at `infra/modules/serving/main.tf:219`) → container exit → task exit → service restart. With `desired_count = 0` today, scaffold doesn't run; mitigation engages when Prep Pipeline bumps the count. |
| Promise.race timeout leaks pg pool client | Acknowledged (Decision §3). At ALB rate ~4 req/min and pool max=10, steady-state risk is bounded. Wedged-pg → container HEALTHCHECK fail → ECS replaces task. Spec does NOT claim cleanup; it claims fast HTTP response. |
| Prod env workspace forgets to set `extra_env = [{ BOOT_GATE_ENABLED = "1" }]` at Launch | Default-`[]` is a footgun. Follow-up bead: when prod workspace lands, validate that the boot gate is wired on. Atlas Round-1 L2. |

## Acceptance criteria (paste-runnable)

```bash
# 1. All backend tests + lint + typecheck pass.
pnpm --filter @mythrun/backend test
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint

# 2. Docker build succeeds with new HEALTHCHECK start-period.
docker build -f backend/Dockerfile --target=runner -t mythrun-test .

# 3. Code push to main triggers deploy → goes green at /health (no boot
#    gate yet because tfvars hasn't applied). Verify the new route is
#    served by the new image:
git push origin main
# wait for the deploy workflow to land
curl -fsS https://staging-api.mythrun.com/health        # expect: {"status":"ok"}
curl -fsS https://staging-api.mythrun.com/health/ready  # expect: {"ready":true}

# 4. Plan + review (NOT a grep — eyeball the diff):
cd infra/environments/staging
terraform plan
# Expected resources to mutate:
#   ~ aws_lb_target_group.api          (in-place: health_check.path → /health/ready)
#   +/- aws_ecs_task_definition.api    (replacement: BOOT_GATE_ENABLED added)
#   +/- aws_ecs_task_definition.worker (replacement: BOOT_GATE_ENABLED added; service desired_count=0 means no actual rollout)

# 5. Apply.
terraform apply

# 6. Post-apply: ALB health-check path flipped, boot gate visible in logs.
aws elbv2 describe-target-groups --names mythrun-staging-api \
  --query 'TargetGroups[0].HealthCheckPath' --output text
# Expect: /health/ready

aws logs tail /ecs/mythrun-staging-api --since 10m --format short \
  | grep -E '✓ (Postgres|Redis) ready'
# Expect: three lines — Postgres, Redis (realtime), Redis (batch)

curl -fsS https://staging-api.mythrun.com/health/ready | jq .
# Expect: {"ready":true}

# 7. Beads close.
bd close myth-nf3 myth-g6g myth-ccf
```

## Round-1 follow-ups (v2)

| Round-1 finding | Resolution |
|---|---|
| Andes C1: `error?: string` violates EOPT | Switched to `error: string \| undefined` with explicit `error: undefined` on success path. |
| Andes C2: top-level await | Documented — matches `server.ts` pattern. |
| Andes H1: dead `'unknown'` branch + needless `Promise.allSettled` | Switched to `Promise.all`. `probe` always resolves to `ProbeResult`; no fallback needed. |
| Andes H2: `Promise.race` leaks pg pool clients on timeout | Acknowledged in Decision §3 + Risks table. We accept the leak; container `HEALTHCHECK` is the wedged-pg watchdog. AbortController + per-call pg `query_timeout` rejected as over-engineering for ALB's ~4 req/min rate. |
| Andes H3: top-level await makes `worker.test.ts` unimportable | Restructured `worker.ts`: exports `main()`, conditional invocation via `import.meta.url === ...`. Tests import `main` directly. |
| Andes H4: `await new Promise(() => undefined)` interaction with signal handler exit | Added explicit comment that everything below is unreachable; shutdown is signal-handler-driven. |
| Andes M1: `_deps` underscore | Drop the underscore + eslint-disable when consumed by `registerReadyRoute`. |
| Andes M2: stub-deps helper | Extract `__tests__/helpers/stub-deps.ts` factory. |
| Andes M3: `essential=true` on worker | Verified at `infra/modules/serving/main.tf:219`; cited inline. |
| Andes M5: timing-fragile timeout test | Use `vi.useFakeTimers()` per Vitest convention. |
| Atlas C1: literal plan-count grep won't match (replacements vs. in-place) | Acceptance criteria removed the grep; replaced with explicit resource enumeration + operator eyeball. |
| Atlas H1: `extra_env` reaches worker too | Decision §7 explicitly states this is intended-but-harmless (worker doesn't read BOOT_GATE_ENABLED). |
| Atlas H2/H3 + Karakoram H3: wrong constants/arithmetic in Risks table | Corrected: grace_period is **120s** (not 60s); bad-deploy detection is **5–10 min** for boot-gate failures (not 60s). |
| Atlas M2: target-group path is in-place | Stated explicitly in Components section. |
| Atlas M3: extra_env override-semantics | Variable description notes additive-only contract. |
| Atlas M4: Dockerfile HEALTHCHECK is dead code on Fargate | Decision §6 + Components clarify this is local-dev-only; Fargate uses task-def `startPeriod=60`. |
| Atlas L2: prod could silently launch with gate OFF | Follow-up bead noted in Risks table. |
| Karakoram H1: deploy ordering creates 5–15 min outage | **Critical**: Decision §8 + the "Deploy sequence" section now mandate code-push-FIRST, terraform-apply-SECOND. |
| Karakoram H2: missing first-time operator runbook | Added "First-time operator runbook" section with pre-flight + failure-mode tree + emergency rollback. |
| Karakoram M1: probe-failure signal collection plan missing | `app.log.warn` per failed probe; documented `aws logs filter-log-events` query for the post-week review. |
| Karakoram M2: liveness/readiness action distinction | Added "Liveness vs. readiness" section explaining the ECS-specific actions. |
| Karakoram M3: in-flight requests during boot-gate rollback | Stated in runbook: failures occur before `app.listen`, no in-flight on failing task. |
| Karakoram L1: direct push to main | Confirmed in deploy sequence. |
| Karakoram L2: worker doesn't run after this PR | Stated in scope and risks (`desired_count = 0`). |

## Memory pointers

- `feedback_blind_review_pendulum.md` — Round 1 surfaced 3 CRITICAL + 8 HIGH; v2 above resolves all of them. Cap at ~3 rounds; if Round 2 returns mostly LOW, ship.
- `feedback_production_lens.md` — production-grade defaults: structured logging via Fastify pino, signal handlers, fail-loud rather than silently-degrade.
- `feedback_context_coherence.md` — `/health/ready` consumers (ALB) and `worker.ts` consumers (BullMQ later) match in-context vs. deferred. The worker scaffold is justified by Backend Core spec §6 — not consumer-driven, but spec-mandated.
- `feedback_push_and_close.md` — direct push to main + Linear flip after verified ship is standing auth.
