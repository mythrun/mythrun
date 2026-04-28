# MYT-35 Backend Core Prod Hardening — Design Spec

**Date:** 2026-04-28
**Linear:** MYT-35 (Platform milestone, due 2026-05-01)
**Closes beads:** myth-nf3, myth-g6g, myth-ccf
**Status:** v4 (post-Round-3 blind review by Coltrane / Mingus; Round 3 hit the diminishing-returns boundary — 2 CRITICAL test-correctness items + minor tightening; structural design is settled)
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
| 8 | **Deploy ordering: 5-step sequence** (Titan Round-2 C1 + H2 + Karakoram Round-1 H1). The serving module's ECS services have `lifecycle.ignore_changes = [task_definition]` (`infra/modules/serving/main.tf:341–344, 377`) so terraform DOES NOT roll the service onto a new task-def revision when env vars change — terraform registers the new revision but the service keeps pointing at whatever CI last deployed. To engage the boot gate AND swap the ALB path safely, the sequence is: (1) push code → CI deploys; (2) TF apply A registers a new task-def with `BOOT_GATE_ENABLED=1` (no ALB path change yet); (3) `aws ecs update-service --force-new-deployment` rolls the service onto the latest revision (which is the gate-enabled one); (4) TF apply B flips ALB target-group path to `/health/ready` against an already-rolled gate-on container; (5) verify. See "Deploy sequence" section. |
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
      new Promise<never>((_resolve, reject) =>
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
// Use pathToFileURL for cross-platform correctness (handles spaces,
// unicode, drive-letter casing on Windows). Europa Round-2 C2.
//
// PRODUCTION INVOCATION: this file is run ONLY via `node dist/worker.js`
// in the worker container. It is not run via `tsx` (no `dev:worker`
// script in package.json) and the entry-point guard would return false
// under `tsx watch` because process.argv[1] points at the tsx loader,
// not at this file (Coltrane Round-3 H4). If a future ticket adds a
// `dev:worker` runner, the guard needs an extra branch.
import { pathToFileURL } from 'node:url'
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  await main()
}
```

### `backend/src/__tests__/health-ready.test.ts`

Four cases against `buildApp(stubDeps)` with stub deps whose `query`/`ping` resolve or reject deterministically:

1. **all probes succeed** → 200 + `{ ready: true }`.
2. **pg.query rejects** → 503 + `{ ready: false, failed: ['pg'] }`.
3. **pg + redis-batch reject** → 503 + `failed` contains both names (order-insensitive — assert via `.sort()`).
4. **one probe hangs > 1s while the other two resolve** (Coltrane Round-3 H3: clarify only ONE probe never resolves; the other two return resolved stub promises so `Promise.all` settles after the timeout fires on the hung one). With `vi.useFakeTimers()`, kick off the request, then `await vi.advanceTimersByTimeAsync(1001)` (NOT the synchronous `advanceTimersByTime` — Europa Round-2 H2: the async variant is required to drain microtasks between the timer firing and the handler returning), then `await` the inject promise → handler returns 503 with `failed` containing only the hung probe's name.

Test helper: `__tests__/helpers/stub-deps.ts` exports `makeStubDeps({ pgQuery?, ping1?, ping2? })` so future tests don't reinvent the mock surface (Andes Round-1 M2). The helper returns shape-only stubs; it does NOT import from `redis/client.ts` or `db/postgres.ts` — a real client at test-import time would hang CI on connect-refused (Titan Round-2 H1).

### `backend/src/__tests__/worker.test.ts`

Imports `main` directly (not the whole module — the cross-platform entry-point guard is best-effort and tests should not rely on it being false). Mocks `loadEnv` + `createRedisClient` so `ping`/`quit` resolve.

**Real timers are required** (Coltrane Round-3 C1): `vi.waitFor()` polls via real `setTimeout`. If `vi.useFakeTimers()` is enabled at file or global scope, `vi.waitFor` deadlocks because its internal poll loop never advances. Add `vi.useRealTimers()` at the top of `beforeEach` to defend against another file enabling fake timers globally.

**`process.exit` mock pattern** (Coltrane Round-3 C2): use `vi.spyOn`, NOT a throw-sentinel. The SIGTERM handler is `() => void shutdown(signal)` — the `void` operator discards the promise, so a thrown sentinel inside `shutdown` has nowhere to be caught. Pattern (mirrors `server.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../worker.js'

describe('worker', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    vi.restoreAllMocks()
  })

  it('logs "worker started" then exits cleanly on SIGTERM', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    // ... mock loadEnv + createRedisClient ...

    void main() // never awaited — main blocks forever on Promise<never>

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('worker started')
    })

    process.emit('SIGTERM', 'SIGTERM')

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
  })
})
```

`process.emit('SIGTERM', 'SIGTERM')` may need a cast under `@types/node` strict mode: `process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)`.

**Listener hygiene** (Europa Round-2 H3): `main()` registers `process.on('SIGTERM', …)` + `process.on('SIGINT', …)` on the real Vitest worker process. The `afterEach` `removeAllListeners` is required to prevent leakage across tests.

### `backend/Dockerfile` change

The actual file uses `wget`, not `curl` (alpine ships wget by default; curl isn't installed). The diff preserves it (Titan Round-2 M2):

```diff
-HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
+HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
   CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
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

## Deploy sequence (load-bearing — 5 steps, DO NOT REORDER)

This is more involved than v1/v2 implied because the serving module's ECS services have `lifecycle.ignore_changes = [task_definition]` — terraform registers task-def revisions but the live service stays on whatever CI last deployed. To engage the boot gate AND swap the ALB path without an outage, two TF applies sandwich an `aws ecs update-service` call.

**Why not just one TF apply?** If the ALB path flip and the env-var change land together, terraform registers the new revision (with BOOT_GATE_ENABLED=1) but the service keeps running the old revision (`fallbackStart`). The old container's `/health/ready` returns 503 (the stub Pool throws synchronously by design — `repo unavailable: BOOT_GATE_ENABLED is off`). ALB now polls `/health/ready` against a 503 → unhealthy after 45s → outage. Two applies separated by an explicit service rollover avoids this.

**Step 1 — Push code to `main`.** `pnpm test` + `pnpm typecheck` + `pnpm lint` pass locally. `git push origin main`. CI builds the new image (now containing `/health/ready` route + `worker.ts` + the Dockerfile change) and deploys a new ECS task-def revision. **BOOT_GATE_ENABLED is still unset → `fallbackStart` runs → `/health/ready` returns 503 in this state. That is expected and harmless because ALB is still polling `/health` (path hasn't flipped yet).** Verify only `/health`:

```bash
curl -fsS https://staging-api.mythrun.com/health   # expect: {"status":"ok"}
# Do NOT curl /health/ready yet — fallbackStart's stub Pool throws by design.
```

**Step 2 — TF apply A (env-var only).** Edit `infra/environments/staging/main.tf` to add `extra_env = [{ name = "BOOT_GATE_ENABLED", value = "1" }]` on `module "serving"`. Do NOT yet edit `infra/modules/serving/main.tf`'s ALB `health_check.path`.

```bash
cd infra/environments/staging
terraform plan
# Expected:
#   +/- aws_ecs_task_definition.api    (replacement: BOOT_GATE_ENABLED added; create_before_destroy)
#   +/- aws_ecs_task_definition.worker (replacement: BOOT_GATE_ENABLED added; service desired_count=0 so no actual rollout)
# (No aws_lb_target_group change yet — that's step 4.)
terraform apply
```

After this apply: new task-def revisions are registered. The live service is **still running the old revision** because of `lifecycle.ignore_changes = [task_definition]`. Nothing observable changes yet.

**Step 3 — Force the service onto the new revision.**

**Pause concurrent CI deploys first** (Mingus Round-3 H1). The `$LATEST_REV` lookup returns the highest-numbered revision in the family. If a Deploy workflow is in flight between TF apply A (step 2) and the lookup below, it can register a NEWER revision without `BOOT_GATE_ENABLED=1`; the rollover then lands on a non-gated container and step 5 verification will incorrectly pass. Confirm no Deploy run is in flight before proceeding:

```bash
gh run list --workflow Deploy --status in_progress --limit 5
# If any rows are returned: wait for them to finish (or `gh run cancel` if you
# can re-trigger them later) before continuing.
```

```bash
# Get the latest registered revision number (the one TF just produced).
LATEST_REV=$(aws ecs describe-task-definition \
  --task-definition mythrun-staging-api \
  --query 'taskDefinition.revision' --output text)
echo "Rolling onto revision $LATEST_REV"

aws ecs update-service \
  --cluster mythrun \
  --service mythrun-staging-api \
  --task-definition "mythrun-staging-api:$LATEST_REV" \
  --force-new-deployment

# Wait for the rollover to complete.
aws ecs wait services-stable --cluster mythrun --services mythrun-staging-api
```

The new task starts with `BOOT_GATE_ENABLED=1`, runs the boot gate (`waitFor` against pg + redis-realtime + redis-batch), succeeds, calls `app.listen`. CloudWatch will now show:

```
✓ Postgres ready
✓ Redis (realtime) ready
✓ Redis (batch) ready
```

ALB is still polling `/health`, sees 200, target stays healthy. Now `/health/ready` also returns 200 because the boot gate succeeded and the deps are real.

```bash
# Confirm /health/ready is now answering 200 from the new container.
curl -fsS https://staging-api.mythrun.com/health/ready | jq .
# Expect: { "ready": true }
```

**Step 4 — TF apply B (ALB path flip).** Edit `infra/modules/serving/main.tf`: change `aws_lb_target_group.api.health_check.path` from `/health` to `/health/ready`. (And update the stale `bead myth-nf3` comment on the same line to cite MYT-35.)

```bash
cd infra/environments/staging
terraform plan
# Expected:
#   ~ aws_lb_target_group.api  (in-place: health_check.path → /health/ready)
terraform apply
```

ALB now polls `/health/ready` against a service that's already serving 200 there. No flap.

**Step 5 — Verify.** See Acceptance criteria. Force a transient probe failure (point pg at a bogus host briefly via test) and confirm `aws logs filter-log-events --filter-pattern '"health-ready probe failed"'` returns the structured log line — proves the post-week false-positive review query actually works (Europa Round-2 H1).

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

If the boot gate is genuinely failing for a reason that can't be quickly diagnosed AND the ALB path has already been flipped to `/health/ready` (i.e., we're past step 4 of the forward deploy), do these in order. **Step 1 of the rollback (flip ALB path back to `/health`) must come FIRST** (Mingus Round-3 M4: with the path on `/health/ready`, force-rollover to a `BOOT_GATE_ENABLED=0` revision yields a `fallbackStart` container whose `/health/ready` returns 503 — ALB stays unhealthy and the rollback prolongs the outage).

1. **Flip the ALB path back to `/health`.** Edit `infra/modules/serving/main.tf`, change `health_check.path` from `/health/ready` back to `/health`. `terraform -chdir=infra/environments/staging apply`. ALB now polls `/health`, which the running container answers regardless of gate state.
2. **Edit `infra/environments/staging/main.tf`** — change the `extra_env` value `"1"` to `"0"`. (Avoid `sed -i` invocations in incident playbooks: BSD `sed -i ''` and GNU `sed -i` differ; copy-paste fails on whichever shell you don't usually use. Editor.)
3. **Apply:** `terraform -chdir=infra/environments/staging apply`. Registers a new task-def revision with the gate disabled.
4. **Force-rollover the service** (because of `ignore_changes [task_definition]`):
   ```bash
   LATEST_REV=$(aws ecs describe-task-definition \
     --task-definition mythrun-staging-api \
     --query 'taskDefinition.revision' --output text)
   aws ecs update-service \
     --cluster mythrun \
     --service mythrun-staging-api \
     --task-definition "mythrun-staging-api:$LATEST_REV" \
     --force-new-deployment
   aws ecs wait services-stable --cluster mythrun --services mythrun-staging-api
   ```

This restores MYT-28 fallback behavior. Investigate, fix, re-engage with the 5-step deploy.

If the failure happened BEFORE step 4 of the forward deploy (ALB path is still `/health`), skip rollback step 1; the service can be rolled back via steps 2–4 alone.

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
| `/health/ready` timeout | `vi.useFakeTimers()`; one probe never resolves (others resolve fast); `await vi.advanceTimersByTimeAsync(1001)` | Case 4 |
| `worker.ts` startup | Mock `loadEnv` + `createRedisClient`; call `main()`; assert `console.log('worker started')` | `worker.test.ts` |
| `worker.ts` shutdown | Mock `process.exit`; emit SIGTERM; assert `redis.quit` awaited + exit called | `worker.test.ts` |
| Dockerfile sanity | `--start-period=30s` parses; image still builds | Existing CI build job |
| Terraform plan | Adds BOOT_GATE_ENABLED to common_env; updates target-group path | Plan diff in pre-apply review (NOT a literal grep) |
| End-to-end | After full deploy: ALB → `/health/ready` → 200; CloudWatch shows three `✓ X ready` lines | Manual: `curl https://staging-api.mythrun.com/health/ready` + `aws logs tail` |

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Boot gate fails on first staging deploy → ECS rolls back, alarm spam | `waitFor` retries with backoff; transient cold-start blips self-heal. Hard failure surfaces with a specific dep name in CloudWatch. **Recovery: emergency rollback** flips `BOOT_GATE_ENABLED=0` and re-applies (see runbook). Bad-deploy-detection window: container `HEALTHCHECK` `startPeriod=60` + `interval=15s` × `retries=3` = **~1.75 min** before ECS replaces the task (Titan Round-2 H3 corrected from prior `interval=30`); circuit-breaker fires after ~10 failed task starts × ~30–60s each = **~5–10 min total** before automatic rollback. CI's `wait-for-service-stability: true` + 15-min job timeout backstops this on the deploy-action side. Acceptable for staging — no real users. |
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

# 3. Code push to main triggers deploy → goes green at /health.
#    /health/ready returns 503 by design at this stage because BOOT_GATE_ENABLED
#    is still unset → fallbackStart's stub Pool throws → probe fails → 503
#    with failed:['pg']. ALB still polls /health, so this is harmless.
#    DO NOT curl /health/ready here — wait until step 6.
git push origin main
# wait for the deploy workflow to land
curl -fsS https://staging-api.mythrun.com/health        # expect: {"status":"ok"}

# 4–5. Two TF applies + a force-rollover in between (see Deploy sequence).
#    A) TF apply A: env-var only (no ALB path change yet).
#       Expected diff: +/- aws_ecs_task_definition.{api,worker} (replacement:
#       BOOT_GATE_ENABLED added; ECS service ignore_changes [task_definition]
#       means the service stays on its current revision until step B below).
#    B) Force-rollover the API service onto the freshly registered revision:
#         LATEST_REV=$(aws ecs describe-task-definition --task-definition mythrun-staging-api --query 'taskDefinition.revision' --output text)
#         aws ecs update-service --cluster mythrun --service mythrun-staging-api --task-definition "mythrun-staging-api:$LATEST_REV" --force-new-deployment
#         aws ecs wait services-stable --cluster mythrun --services mythrun-staging-api
#       NOTE: pause concurrent deploys before this step (Mingus Round-3 H1):
#         gh run list --workflow Deploy --status in_progress --limit 1
#       (If a Deploy run is in flight, wait for it; otherwise it could land a
#       newer revision without BOOT_GATE_ENABLED between TF apply A and the
#       describe-task-definition lookup.)
#    C) TF apply B: ALB path flip /health → /health/ready.
#       Expected diff: ~ aws_lb_target_group.api (in-place: health_check.path).
cd infra/environments/staging
# Apply A:
terraform apply  # after editing staging/main.tf to add extra_env
# (run the update-service block from B above)
# Apply B:
terraform apply  # after editing modules/serving/main.tf for the path flip

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

## Round-3 follow-ups (v4)

| Round-3 finding | Resolution |
|---|---|
| Coltrane C1: `vi.waitFor` deadlocks under fake timers | `worker.test.ts` requires `vi.useRealTimers()` in `beforeEach`. |
| Coltrane C2: `process.exit` mock pattern wrong (throw-sentinel can't be caught inside `void shutdown(...)`) | Switched to `vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)` + assertion via `await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))`. Mirrors `server.test.ts`. |
| Coltrane H3: case 4 ambiguity ("a probe hangs" — singular vs all-three) | Clarified: ONE probe hangs, the other two return resolved stub promises so `Promise.all` settles after the timeout fires on the hung one. |
| Coltrane H4: tsx-watch entry-point guard mismatch | Comment in `worker.ts` documents production-only invocation via `node dist/worker.js`; no `dev:worker` script exists. |
| Coltrane H1/H5/M1/M2/M3: typing/EOPT rationale drift, `Promise<never>` snippet missing the explicit generic | Snippet updated to `new Promise<never>((_resolve, reject) => …)`. Other rationale-wording items left as-is (cosmetic). |
| Mingus H1: CI race on `$LATEST_REV` between TF apply A and `update-service` | Step 3 now requires `gh run list --workflow Deploy --status in_progress --limit 5` first. Operator must wait for any in-flight Deploy run before proceeding. |
| Mingus M2: Acceptance criteria step 3 still curls `/health/ready` (returns 503 by design pre-rollover) | Acceptance step 3 now only curls `/health`; documents that `/health/ready` is verified at step 6 (after the ALB flip + rollover). |
| Mingus M4: Emergency rollback ordering — flip ALB back FIRST, not "optionally" | Rollback section reordered. Step 1 of rollback is now ALB-path-flip-back (when forward step 4 has already happened); steps 2–4 are env flip + apply + force-rollover. Conditional "if you're pre-step-4 of forward deploy, skip rollback step 1" added. |
| Mingus H2/M1/M3: minor wording (deps flow assumption, plan-output formatting, worker rollout justification) | Acknowledged; left as cosmetic. |

## Round-2 follow-ups (v3)

| Round-2 finding | Resolution |
|---|---|
| Titan C1: ECS service `lifecycle.ignore_changes = [task_definition]` means TF apply does NOT roll the service onto a new revision | Deploy sequence rewritten as 5 steps: push code → TF apply A (env var) → `update-service --force-new-deployment` → TF apply B (ALB path) → verify. Two TF applies sandwich an explicit service rollover. |
| Titan H2: `/health/ready` returns 503 in step 1 because `fallbackStart`'s stub Pool throws synchronously by design | Step 1 verification dropped the `/health/ready` curl. Only `/health` is checked while gate is OFF. Documented that step-1 503 on `/health/ready` is expected and harmless (ALB still polls `/health`). |
| Titan H3: Risks-table arithmetic uses `interval=30` but actual is `interval=15` | Corrected to `~1.75 min` (60+15×3) for the container watchdog. Also explicit about CI's `wait-for-service-stability` backstop. |
| Titan M1: `sed -i ''` is BSD-only, breaks GNU sed | Emergency rollback restated as "edit the file" — no shell command for the substitution. The terraform + AWS CLI commands are portable. |
| Titan M2: spec showed `curl` in HEALTHCHECK; actual file uses `wget` | Diff updated to preserve `wget`. |
| Titan L4: Round-1-resolutions table was author-claimed before Round 2 verified | Round-1 follow-ups still listed below as the v2-author's resolutions; Round-2 then independently re-reviewed and the present (v3) section captures what actually held vs needed re-fixing. |
| Europa C1: untyped `new Promise((_, reject) => …)` resolver | Use `new Promise<never>((_resolve, reject) => …)` with explicit `never` generic; the unused-arg rule's leading-underscore convention saves the `_resolve` lint. |
| Europa C2: `import.meta.url === \`file://${process.argv[1]}\`` is platform-fragile | Use `pathToFileURL(process.argv[1]).href` from `node:url`. Updated in Components above. |
| Europa H1: CloudWatch filter pattern unverified against rendered pino JSON | Step 5 of the deploy sequence forces a transient probe failure post-deploy and confirms the filter query returns. |
| Europa H2: `vi.advanceTimersByTime` (sync) won't drain microtasks between timer-fire and handler-return | Test plan now explicitly requires `vi.advanceTimersByTimeAsync` (async). |
| Europa H3: `process.on('SIGTERM', …)` registration leaks across Vitest tests | `afterEach` requirement spelled out; `main()` is invoked via `void main()` + `vi.waitFor(...)` rather than awaited (it blocks forever). |
| Europa M1: double-iteration in handler (filter + log loop) | Acknowledged; trivial; left as-is for clarity. |
| Europa M2: `probe()` swallows programming errors as if they're dep failures | Acknowledged in the Error handling section; trade-off accepted (probe-internal errors logged identically to dep failures; future work could split a "programming error" surface). |

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
