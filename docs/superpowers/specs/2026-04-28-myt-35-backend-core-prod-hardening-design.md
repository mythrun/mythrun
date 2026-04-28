# MYT-35 Backend Core Prod Hardening — Design Spec

**Date:** 2026-04-28
**Linear:** MYT-35 (Platform milestone, due 2026-05-01)
**Closes beads:** myth-nf3, myth-g6g, myth-ccf
**Status:** Draft (pre-blind-review)
**Author:** Claude (Miklos's instance)

## Goal

Three small operational pieces that together flip MYT-29's dormant boot gate ON in staging and add the missing pieces from Backend Core spec §6 + §7:

1. New `/health/ready` route that probes pg + redis-realtime + redis-batch per request and returns 200/503 accordingly. Existing `/health` stays as the liveness endpoint.
2. New `backend/src/worker.ts` entrypoint scaffold (env + redis-batch + log + idle).
3. Terraform: enable `BOOT_GATE_ENABLED=1` in staging's task def, swap ALB target-group health-check path to `/health/ready`, bump Dockerfile `HEALTHCHECK --start-period` to 30s.

After this, staging runs the full data-layer-aware boot path (validated end-to-end against the real RDS bootstrapped in myt-9qgb + myth-ml8); the ALB gates traffic on actual readiness instead of unconditional `/health` truthiness.

## Why this exists now

MYT-29 shipped the boot gate code with `BOOT_GATE_ENABLED` defaulting OFF so deploys could stay green at `/health`-only while the data layer was being built. Three preconditions had to land first:

- **Real DB exists in staging** (myth-ml8 — closed today, `mythrun_staging` DB + user + password)
- **Repository layer is wired into `app-deps.ts`** (MYT-34 — closed)
- **Backend Core data layer code (`createPgPool`, `createRedisClient`, `waitFor`) exists** (MYT-29 — closed)

All true now. MYT-35 is the small wire-up that engages the gate.

## Scope

**In scope:**
- `backend/src/routes/health-ready.ts` (new)
- `backend/src/__tests__/health-ready.test.ts` (new)
- `backend/src/app.ts` (modify — register the new route)
- `backend/src/worker.ts` (new)
- `backend/src/__tests__/worker.test.ts` (new — minimal smoke)
- `backend/Dockerfile` (modify — HEALTHCHECK `--start-period` 5s → 30s)
- `infra/modules/serving/variables.tf` (modify — add `var.extra_env` with default `[]`)
- `infra/modules/serving/main.tf` (modify — concat `var.extra_env` into common_env, swap ALB health-check path to `/health/ready`)
- `infra/environments/staging/main.tf` (modify — pass `extra_env = [{ name = "BOOT_GATE_ENABLED", value = "1" }]` into the serving module)
- Wiki updates (sources tracked by `infra/serving.html`, `data/repository.html`, etc., will drift from the *.tf edits — refresh hashes; runbook page mentions of `/health` / boot-gate update where they describe the staging path)

**Out of scope:**
- **Production environment**: no prod Terraform workspace exists yet. Prod composition lands at the Launch milestone; `BOOT_GATE_ENABLED=1` flips for prod when prod is composed.
- **Worker queue subscriptions**: `worker.ts` is a scaffold; actual BullMQ Worker registrations land in Prep Pipeline / Session Runtime milestones once queue topology is decided.
- **Anthropic / Stripe / Cognito readiness probes**: external-service health is intentionally NOT gating ALB traffic — those vendors having outages shouldn't 503 the API. Diagnostic surfaces for them ship later if there's actual operational need.
- **Migrations table check**: a startup invariant, not a per-request liveness signal.
- **Worker container health-check probe**: scaffold doesn't expose HTTP; ECS task-stop semantics are the watchdog for now. Revisit when worker has real load.

## Locked design decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **`/health/ready` probes data layer only** (pg `SELECT 1` + 2× redis `PING`). Matches Backend Core §6 verbatim. | Anthropic / Stripe outages should not gate ALB traffic. Migrations check is a startup-time invariant, not a runtime liveness signal. |
| 2 | **Probes run in parallel via `Promise.allSettled`** with a 1s per-probe timeout via `Promise.race`. Failures collected; 503 body lists which probes failed. | Faster than sequential. Multi-failure visibility is operationally useful for "DB and Redis both flapping" cases. |
| 3 | **1s per-probe timeout.** | ALB health-check timeout is 5s (`infra/modules/serving/main.tf:266`); 1s × 3 parallel = 1s wall-time worst case, well under ALB's window. A hung pg/redis client doesn't stall ALB response into timeout territory. |
| 4 | **`worker.ts` is a bare scaffold.** Env load → redis-batch client → log → signal handlers → idle. No queue subscriptions. | Spec §6 says "scaffold"; queue topology belongs in Prep Pipeline / Session Runtime. Premature BullMQ Worker registration commits to queue names before consumers exist. |
| 5 | **ALB target-group health-check path swaps to `/health/ready`** in this PR. | The whole point: gate ALB on real readiness. Two-step (route now, swap later) only adds a follow-up bead for no safety gain. |
| 6 | **Dockerfile `HEALTHCHECK --start-period = 30s`** (was 5s). | Boot gate cold start = pg connect + 2× redis TLS handshake + 2× ping; 10–20s typical. 30s gives margin without over-tolerating real regressions. The `HEALTHCHECK` command itself stays at `curl /health` — that's the liveness check, NOT readiness. |
| 7 | **Staging-only `BOOT_GATE_ENABLED=1` flip** via per-env `extra_env` arg into the serving module. | No prod env workspace yet (lands at Launch). Per-env override (vs. shared module local) keeps each environment explicitly declaring its gate state. |

## Architecture

```
backend/src/
├── app.ts                        ── registers /health (existing) + /health/ready (new)
├── server.ts                     ── unchanged; boot gate code already exists from MYT-29
├── worker.ts                     ── NEW: scaffold entrypoint for the worker container
├── routes/
│   └── health-ready.ts           ── NEW: the readiness route + probe helpers
└── __tests__/
    ├── app.test.ts               ── existing (covers /health liveness)
    ├── health-ready.test.ts      ── NEW: 3 cases — all-ok / pg-fail / multi-fail
    └── worker.test.ts            ── NEW: minimal smoke — main() boots + signal handler exits

backend/Dockerfile                ── HEALTHCHECK --start-period 5s → 30s

infra/modules/serving/
├── variables.tf                  ── + var.extra_env (list, default [])
└── main.tf                       ── concat var.extra_env into common_env;
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
  error?: string
}

async function probe(name: string, fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`probe timeout after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
      ),
    ])
    return { name, ok: true }
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerReadyRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health/ready', async (_req, reply) => {
    const results = await Promise.allSettled([
      probe('pg', () => deps.pg.query('SELECT 1')),
      probe('redis-realtime', () => deps.redisRealtime.ping()),
      probe('redis-batch', () => deps.redisBatch.ping()),
    ])

    const failed = results
      .map((r) => (r.status === 'fulfilled' ? r.value : { name: 'unknown', ok: false }))
      .filter((r) => !r.ok)
      .map((r) => r.name)

    if (failed.length > 0) {
      return reply.code(503).send({ ready: false, failed })
    }
    return reply.code(200).send({ ready: true })
  })
}
```

### `backend/src/app.ts` (modification)

Add one import + one registration line after the existing `/health` route. The existing `/health` body stays unchanged; that endpoint remains the liveness probe used by ECS container health-checks.

### `backend/src/worker.ts`

```ts
import { loadEnv } from './config/env.js'
import { createRedisClient } from './redis/client.js'

async function main(): Promise<void> {
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

  // Block forever — keep the event loop alive. Subsequent milestones replace
  // this with BullMQ Worker registrations whose own loops keep us alive.
  await new Promise(() => undefined)
}

await main()
```

### `backend/src/__tests__/health-ready.test.ts`

Three test cases against `buildApp(stubDeps)` with stubbed pg/redis whose `query`/`ping` resolve or reject deterministically:

1. **all probes resolve** → assert `200` + body `{ ready: true }`
2. **pg.query rejects** → assert `503` + body `{ ready: false, failed: ['pg'] }`
3. **pg + redis-batch reject** → assert `503` + body `failed` array contains both names (order-insensitive)

### `backend/src/__tests__/worker.test.ts`

Minimal smoke: import worker module under a stubbed env (mock `loadEnv` + `createRedisClient` so `ping`/`quit` resolve), assert that `console.log('worker started')` was called within ~50ms, then send SIGTERM and assert the shutdown branch runs without throwing. Don't actually exit the process under test — mock `process.exit`.

### `backend/Dockerfile` change

Single-line edit:

```diff
-HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
+HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
   CMD curl -f http://localhost:3000/health || exit 1
```

The HEALTHCHECK COMMAND deliberately stays at `/health` (liveness), not `/health/ready` (readiness). Container-level health is "is the event loop responsive"; ALB-level health is "are dependencies up." Conflating them produces flapping containers when, e.g., Redis briefly drops.

### `infra/modules/serving/variables.tf` addition

```hcl
variable "extra_env" {
  description = "Additional environment variables to inject into both API and Worker task definitions, on top of common_env. Used for per-env switches (e.g., BOOT_GATE_ENABLED in staging) without polluting the shared module locals."
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}
```

### `infra/modules/serving/main.tf` modifications

1. **common_env concatenation**:
   ```hcl
   # Merge per-env extras into the shared base.
   common_env = concat([
     { name = "NODE_ENV", value = var.environment },
     ... (existing entries) ...
     { name = "REDIS_PORT", value = tostring(var.redis_port) },
   ], var.extra_env)
   ```

2. **ALB target-group health-check path**:
   ```diff
    health_check {
      enabled             = true
   -  path                = "/health" # current backend endpoint; refactor to /health/ready when Backend Core lands (bead myth-nf3)
   +  path                = "/health/ready" # MYT-35 closed myth-nf3; ALB gates on data-layer readiness
      protocol            = "HTTP"
   ```

### `infra/environments/staging/main.tf` modification

Inside the existing `module "serving"` block, add:

```hcl
  # MYT-35: flip the boot gate ON in staging. Production stays at default
  # OFF until the prod stack is composed at the Launch milestone.
  extra_env = [
    { name = "BOOT_GATE_ENABLED", value = "1" },
  ]
```

## Data flow

**Request to `/health/ready`:**

1. ALB GET `/health/ready` (every 15s per target-group config).
2. Fastify routes to `health-ready.ts` handler.
3. Handler runs three `Promise.allSettled([probe(pg), probe(redisRealtime), probe(redisBatch)])` concurrently. Each `probe` wraps the underlying client call in a 1s `Promise.race` timeout.
4. Wall time ≤ 1s.
5. If all three OK → 200 + `{ready:true}`. If any failed → 503 + `{ready:false, failed:[…]}`.
6. ALB marks target healthy on 2 consecutive 200s; unhealthy after 3 consecutive non-200s.

**Boot path (already exists, just newly engaged in staging):**

1. ECS task starts API container.
2. `server.ts` reads `BOOT_GATE_ENABLED=1` → runs the gated path.
3. `loadEnv()` validates env, throws on missing required vars.
4. `createPgPool` + 2× `createRedisClient`.
5. Sequential `waitFor` against pg `SELECT 1`, redis-realtime `PING`, redis-batch `PING`. Each retries with backoff; first success unblocks.
6. `app.listen` → ECS marks container healthy via `HEALTHCHECK curl /health`.
7. ALB starts polling `/health/ready` → 200 → target healthy → traffic flows.

## Error handling

- **Probe rejects within 1s**: handler collects `{name, ok:false, error}` and returns 503 with the failed list. Logs nothing extra (probe errors are too noisy at 4 req/min from ALB to be useful in CloudWatch — operators inspect on-demand via `aws logs filter`).
- **Probe times out at 1s**: same path as a synthetic rejection (`probe timeout after 1000ms`). Counted as failed.
- **All probes succeed but Fastify response throws** (impossible by inspection): Fastify default 500. ALB sees non-200 and unhealthy-counts.
- **Worker `redis.ping()` fails at startup**: `main()` rejects, top-level await throws, process exits non-zero. ECS task-def `essential=true` causes the task to stop; ECS service restarts. No special handling needed.
- **Worker `redis.quit()` fails during shutdown**: caught with `.catch(() => undefined)`. We're exiting anyway; quit failure shouldn't block exit.

## Testing

| Layer | What | How |
|---|---|---|
| `/health/ready` happy path | All three probes succeed → 200 `{ready:true}` | `backend/src/__tests__/health-ready.test.ts` case 1 — stub deps with resolving query/ping |
| `/health/ready` single failure | pg fails → 503 `{ready:false, failed:['pg']}` | Case 2 — stub pg.query rejects |
| `/health/ready` multi-failure | pg + redis-batch fail → 503 with both names in `failed` | Case 3 — stub two clients reject |
| `/health/ready` timeout | A probe hangs > 1s → counted as failed | Case 4 — stub query returns a never-resolving promise; assert handler responds within ~1.5s with 503 |
| `worker.ts` startup | Logs "worker started" after redis ping resolves | `worker.test.ts` smoke — mock loadEnv + createRedisClient, capture console.log |
| `worker.ts` shutdown | SIGTERM → quit + exit | `worker.test.ts` smoke — mock process.exit, send signal, assert mocks called |
| Dockerfile sanity | `--start-period=30s` parses; image still builds | Existing CI build job catches a malformed Dockerfile |
| Terraform plan | Adds BOOT_GATE_ENABLED to common_env; updates target-group path | Plan diff in CI / pre-apply review |
| End-to-end | After deploy: ALB sees /health/ready → 200 + container logs show three "✓ X ready" lines | Manual: `curl https://staging-api.mythrun.com/health/ready` returns 200; `aws logs tail /ecs/mythrun-staging-api --since 5m` shows the boot gate sequence |

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Boot gate fails on first staging deploy → ECS rolls back, alarm spam | The boot gate's `waitFor` retries with backoff before throwing; transient cold-start network blips self-heal. If it really fails, it fails loudly in CloudWatch with a specific dep name; recovery is rerun apply or fix the dep. |
| `/health/ready` 1s probe timeout is too tight under load | Worst-case probe-time on a healthy RDS at <100 req/min is single-digit ms. If we ever see 1s timeouts in real traffic, that itself is a signal the dep is stressed — turning that into a 503 is the correct behavior. Bump to 2s if the false-positive rate is non-trivial after a week of operation. |
| ALB swap to `/health/ready` causes brief unhealthy-flap during deploy | Existing `health_check_grace_period_seconds = 60` on the ECS service forgives the first minute; combined with `--start-period=30s`, the cold container has time to boot before ALB starts grading. |
| Worker container exits silently and ECS doesn't notice | `essential=true` on the worker container in the task def means container exit → task exit → service restarts. ECS service desiredCount=1 keeps a worker alive. Real "is the worker doing work" alarms come at the Observability milestone. |
| HEALTHCHECK 30s start period delays auto-rollback signals on real boot regressions | 30s is a lower-bound on how fast we know about a regression; combined with ALB 2 healthy checks × 15s = 30s, total rollback signal is ~60s post-task-start. Acceptable for a pre-launch staging environment. |
| `Promise.race` against a never-resolving probe leaks the probe's underlying promise | Acceptable: the probe completes eventually (or the connection is GC'd when the request ends), and Node's GC handles unresolved promises without growing the heap meaningfully at 4 req/min. Not worth the AbortController wiring for this rate. |

## Acceptance criteria (paste-runnable)

```bash
# 1. All backend tests pass.
pnpm --filter @mythrun/backend test

# 2. Type-check + lint clean.
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint

# 3. Docker build succeeds with new HEALTHCHECK start-period.
docker build -f backend/Dockerfile --target=runner -t mythrun-test .

# 4. Terraform plan shows expected diffs only.
cd infra/environments/staging
terraform plan -no-color | grep -E '^(  #|Plan:)'
# Expect:
#   ~ aws_ecs_task_definition.api (BOOT_GATE_ENABLED added)
#   ~ aws_ecs_task_definition.worker (BOOT_GATE_ENABLED added)
#   ~ aws_lb_target_group.api (health_check.path /health → /health/ready)
#   Plan: 0 to add, 3 to change, 0 to destroy.

# 5. Apply + deploy.
terraform apply
git push                      # triggers MYT-28 deploy workflow

# 6. Wait for deploy to land, then verify /health/ready answers 200.
curl -fsS https://staging-api.mythrun.com/health/ready | jq .
# Expect: { "ready": true }

# 7. Boot-gate sequence visible in CloudWatch.
aws logs tail /ecs/mythrun-staging-api --since 10m --format short \
  | grep -E '✓ (Postgres|Redis) ready'
# Expect: three lines — Postgres, Redis (realtime), Redis (batch).

# 8. ALB target-group health-check has flipped.
aws elbv2 describe-target-groups --names mythrun-staging-api \
  --query 'TargetGroups[0].HealthCheckPath' --output text
# Expect: /health/ready

# 9. Beads close cleanly.
bd close myth-nf3 myth-g6g myth-ccf
```

## Memory pointers

- `feedback_context_coherence.md` — `/health/ready` consumers (ALB, future operator dashboards) all exist now; nothing is being designed in isolation.
- `feedback_blind_review_pendulum.md` — Round 1 + maybe one more round is the right cap for a 3-file ticket.
- `feedback_production_lens.md` — `essential=true` on worker, 30s start-period, structured shutdown, fail-loud rather than silently-degrade.
- `feedback_push_and_close.md` — push + Linear flip after verified-shipped is standing auth.
