# MYT-35 Backend Core Prod Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engage MYT-29's dormant boot gate in staging by adding a `/health/ready` route + `worker.ts` scaffold + Terraform changes that flip `BOOT_GATE_ENABLED=1`, swap the ALB target-group health-check path, and bump the local-dev Dockerfile HEALTHCHECK start-period.

**Architecture:** Three small surfaces stitch together: (1) a new Fastify route `/health/ready` runs three parallel data-layer probes (pg + 2× redis) with a 1s per-probe timeout via `Promise.race`, returning 200/503; (2) a new `worker.ts` entrypoint loads env, pings redis-batch, blocks forever on signal-driven shutdown — exports `main()` for testability; (3) Terraform adds an `extra_env` per-env override so staging declares `BOOT_GATE_ENABLED=1` without polluting the shared module, and swaps the ALB target-group `health_check.path` to `/health/ready`. Deploy is a 5-step sequence (push → TF apply A → ECS force-rollover → TF apply B → verify) because `lifecycle.ignore_changes = [task_definition]` on the ECS service prevents terraform from rolling the live service onto a new task-def revision.

**Tech Stack:** TypeScript (strict + EOPT) + Fastify + pino + Vitest + pg + ioredis; Terraform AWS provider v6.x + ECS Fargate + ALB; alpine-based Docker image.

**Spec:** `docs/superpowers/specs/2026-04-28-myt-35-backend-core-prod-hardening-design.md` (v4).

**Linear:** MYT-35 (Platform milestone, due 2026-05-01).

**Closes beads:** myth-nf3, myth-g6g, myth-ccf.

---

## Pre-flight notes for the implementer

- **TDD where it fits.** Tasks 1, 2 (route + helper) get failing test → impl. Tasks 3 (worker.ts) gets failing test → impl. Terraform tasks (4, 5, 6) don't have unit tests; the gate is `terraform fmt -check` + `terraform validate` + plan-diff review. Dockerfile change (task 7) is a one-line edit with no test.
- **Per CLAUDE.md parallel-agent-commits rule:** if multiple subagents are dispatched in parallel, the **controller** stages and commits each task's files; implementers do NOT run `git add`/`git commit`.
- **Operator actions are flagged explicitly.** The 5-step deploy sequence (Tasks 9–13) requires Miklos to run terraform applies and AWS CLI commands. Surface each one and wait for confirmation.

---

## Task 1: Stub-deps test helper

**Files:**
- Create: `backend/src/__tests__/helpers/stub-deps.ts`

This helper is consumed by Tasks 2 and 3's tests. Shape-only stubs — no real `ioredis` or `pg` clients (would hang CI on connect-refused).

- [ ] **Step 1: Create the helper file**

```ts
// backend/src/__tests__/helpers/stub-deps.ts
//
// Shape-only stubs for backend tests. NO real ioredis / pg clients —
// importing the real modules at test-load time can hang CI on
// connect-refused retry loops (Titan Round-2 H1).

import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from '../../app-deps.js'
import { createRepo } from '../../repo/index.js'

export interface StubDepsOverrides {
  pgQuery?: () => Promise<unknown>
  pingRealtime?: () => Promise<string>
  pingBatch?: () => Promise<string>
}

export function makeStubDeps(overrides: StubDepsOverrides = {}): AppDeps {
  const pg = {
    query: overrides.pgQuery ?? (async () => ({ rows: [] })),
    end: async () => undefined,
  } as unknown as Pool
  const redisRealtime = {
    ping: overrides.pingRealtime ?? (async () => 'PONG'),
    quit: async () => 'OK',
  } as unknown as Redis
  const redisBatch = {
    ping: overrides.pingBatch ?? (async () => 'PONG'),
    quit: async () => 'OK',
  } as unknown as Redis
  return {
    pg,
    redisRealtime,
    redisBatch,
    repo: createRepo(pg),
  }
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @mythrun/backend typecheck
```

Expected: passes (the helper is referenced by no test yet, but compiles standalone).

- [ ] **Step 3: Commit**

```bash
git add backend/src/__tests__/helpers/stub-deps.ts
git commit -m "feat(myt-35): add stub-deps test helper"
```

---

## Task 2: `/health/ready` route + tests

**Files:**
- Create: `backend/src/routes/health-ready.ts`
- Create: `backend/src/__tests__/health-ready.test.ts`
- Modify: `backend/src/app.ts` (add route registration; drop `_deps` underscore)

- [ ] **Step 1: Write the failing test file**

```ts
// backend/src/__tests__/health-ready.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { makeStubDeps } from './helpers/stub-deps.js'

describe('GET /health/ready', () => {
  let app: ReturnType<typeof buildApp> | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
    vi.useRealTimers()
  })

  it('returns 200 {ready:true} when all probes succeed', async () => {
    app = buildApp(makeStubDeps())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ready: true })
  })

  it('returns 503 with failed:[\'pg\'] when pg.query rejects', async () => {
    app = buildApp(
      makeStubDeps({
        pgQuery: async () => {
          throw new Error('connection refused')
        },
      }),
    )
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ready: false, failed: ['pg'] })
  })

  it('returns 503 with both failed names when pg + redis-batch reject', async () => {
    app = buildApp(
      makeStubDeps({
        pgQuery: async () => {
          throw new Error('pg down')
        },
        pingBatch: async () => {
          throw new Error('redis-batch down')
        },
      }),
    )
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json() as { ready: boolean; failed: string[] }
    expect(body.ready).toBe(false)
    expect(body.failed.sort()).toEqual(['pg', 'redis-batch'])
  })

  it('returns 503 when one probe hangs > 1s (others resolve)', async () => {
    vi.useFakeTimers()
    app = buildApp(
      makeStubDeps({
        // Hang forever — Promise.race timeout should kick in.
        pgQuery: () => new Promise(() => undefined),
      }),
    )
    const responsePromise = app.inject({ method: 'GET', url: '/health/ready' })
    await vi.advanceTimersByTimeAsync(1001)
    const res = await responsePromise
    expect(res.statusCode).toBe(503)
    const body = res.json() as { ready: boolean; failed: string[] }
    expect(body.failed).toEqual(['pg'])
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
pnpm --filter @mythrun/backend test -- health-ready
```

Expected: FAIL — Fastify returns 404 because `/health/ready` doesn't exist yet.

- [ ] **Step 3: Create the route file**

```ts
// backend/src/routes/health-ready.ts
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
        setTimeout(
          () => reject(new Error(`probe timeout after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        ),
      ),
    ])
    return { name, ok: true, error: undefined }
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerReadyRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health/ready', async (_req, reply) => {
    const results = await Promise.all([
      probe('pg', () => deps.pg.query('SELECT 1')),
      probe('redis-realtime', () => deps.redisRealtime.ping()),
      probe('redis-batch', () => deps.redisBatch.ping()),
    ])

    const failed = results.filter((r) => !r.ok).map((r) => r.name)

    if (failed.length > 0) {
      for (const r of results) {
        if (!r.ok) app.log.warn({ probe: r.name, err: r.error }, 'health-ready probe failed')
      }
      return reply.code(503).send({ ready: false, failed })
    }
    return reply.code(200).send({ ready: true })
  })
}
```

- [ ] **Step 4: Wire route into app.ts**

Replace the contents of `backend/src/app.ts` lines 1–16 with:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from './app-deps.js'
import { registerReadyRoute } from './routes/health-ready.js'

export const buildApp = (deps: AppDeps): FastifyInstance => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))   // liveness — ECS container check
  registerReadyRoute(app, deps)                  // readiness — ALB target-group check
  return app
}
```

The eslint-disable comment + `_deps` underscore come off because `deps` is now consumed. Lines 18–49 (`createShutdown`, types) are unchanged.

- [ ] **Step 5: Run the test, verify it passes**

```bash
pnpm --filter @mythrun/backend test -- health-ready
```

Expected: 4 tests PASS.

- [ ] **Step 6: Verify the existing app tests still pass**

```bash
pnpm --filter @mythrun/backend test -- app
```

Expected: existing `/health` test still passes; no regressions.

- [ ] **Step 7: Type-check + lint clean**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/health-ready.ts \
        backend/src/__tests__/health-ready.test.ts \
        backend/src/app.ts
git commit -m "feat(myt-35): /health/ready route with parallel data-layer probes

- New route under backend/src/routes/health-ready.ts
- 1s per-probe timeout via Promise.race
- Promise.all (NOT allSettled — probe always resolves)
- 503 body lists failed probe names; structured warn log per failure
- /health stays as liveness; /health/ready is readiness
- Drop _deps underscore on buildApp (deps now consumed)"
```

---

## Task 3: `worker.ts` scaffold + tests

**Files:**
- Create: `backend/src/worker.ts`
- Create: `backend/src/__tests__/worker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/__tests__/worker.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    redisBatchUrl: 'redis://localhost:6379',
    // Other fields not consumed by main()
  }),
}))

const pingMock = vi.fn(async () => 'PONG')
const quitMock = vi.fn(async () => 'OK')

vi.mock('../redis/client.js', () => ({
  createRedisClient: () => ({
    ping: pingMock,
    quit: quitMock,
  }),
}))

describe('worker.main()', () => {
  beforeEach(() => {
    vi.useRealTimers()
    pingMock.mockClear()
    quitMock.mockClear()
  })

  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    vi.restoreAllMocks()
  })

  it('logs "worker started" then exits cleanly on SIGTERM', async () => {
    const { main } = await import('../worker.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    void main() // never awaited — main blocks forever on Promise<never>

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('worker started')
    })
    expect(pingMock).toHaveBeenCalledTimes(1)

    process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
    expect(quitMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
pnpm --filter @mythrun/backend test -- worker
```

Expected: FAIL — `Cannot find module '../worker.js'`.

- [ ] **Step 3: Create the worker file**

```ts
// backend/src/worker.ts
import { pathToFileURL } from 'node:url'
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
  // is unreachable; shutdown only happens via signal handler.
  await new Promise<never>(() => undefined)
}

// PRODUCTION INVOCATION: this file runs ONLY via `node dist/worker.js` in
// the worker container. Not run via `tsx` (no `dev:worker` script today)
// — the entry-point guard would return false under `tsx watch` because
// process.argv[1] points at the tsx loader, not at this file.
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  await main()
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
pnpm --filter @mythrun/backend test -- worker
```

Expected: PASS.

- [ ] **Step 5: Type-check + lint clean**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/worker.ts backend/src/__tests__/worker.test.ts
git commit -m "feat(myt-35): worker.ts scaffold (env + redis-batch + signal handlers)

- exports main() for testability (top-level await happens only when
  this file is the entry point, gated via pathToFileURL comparison)
- pings redis at startup so connection failures surface loud
- SIGTERM/SIGINT shutdown drains redis.quit then process.exit(0)
- block-forever via Promise<never>; queue subscriptions land in
  Prep Pipeline / Session Runtime milestones
- production invocation ONLY via node dist/worker.js"
```

---

## Task 4: Terraform — `var.extra_env` in `modules/serving`

**Files:**
- Modify: `infra/modules/serving/variables.tf` (append)
- Modify: `infra/modules/serving/main.tf` (concat in `local.common_env`)

- [ ] **Step 1: Append `var.extra_env` to variables.tf**

Append at the end of `infra/modules/serving/variables.tf`:

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

- [ ] **Step 2: Concat into common_env in main.tf**

Find `locals { common_env = [ ... ] ... }` (around line 125 in `infra/modules/serving/main.tf`). Wrap the existing list literal in `concat([...], var.extra_env)`. The full updated block is:

```hcl
locals {
  common_env = concat([
    { name = "NODE_ENV", value = var.environment },
    { name = "PORT", value = "3000" },
    { name = "AWS_REGION", value = "us-east-1" },
    { name = "REGION_PREFIX", value = "use1" },
    { name = "AUTH_MODE", value = "real" },
    # DB_* consistent across HOST/PORT/USER/NAME/PASSWORD. App constructs
    # DATABASE_URL at startup per Infra §2.3.
    { name = "DB_HOST", value = var.rds_host },
    { name = "DB_PORT", value = tostring(var.rds_port) },
    { name = "DB_USER", value = "mythrun_${var.environment}" },
    { name = "DB_NAME", value = "mythrun_${var.environment}" },
    # REDIS_* parallels DB_*.
    { name = "REDIS_HOST", value = var.redis_host },
    { name = "REDIS_PORT", value = tostring(var.redis_port) },
  ], var.extra_env)
  # ... common_secrets unchanged ...
```

The `common_secrets` block on the next lines stays as-is. Only the `common_env` literal is wrapped.

- [ ] **Step 3: Validate**

```bash
terraform -chdir=infra/modules/serving fmt -check
terraform -chdir=infra/modules/serving validate
```

Expected: both pass. (If `validate` complains about init: `terraform -chdir=infra/modules/serving init -backend=false` first.)

- [ ] **Step 4: Commit**

```bash
git add infra/modules/serving/variables.tf infra/modules/serving/main.tf
git commit -m "feat(myt-35): add var.extra_env to serving module

Per-env override list concatenated into common_env. Empty default keeps
existing prod-not-yet-composed posture safe; staging will pass
BOOT_GATE_ENABLED=1 via this in Task 6."
```

---

## Task 5: Terraform — ALB target-group health-check path

**Files:**
- Modify: `infra/modules/serving/main.tf` (the `aws_lb_target_group.api` block)

- [ ] **Step 1: Update the path + comment**

Find the `aws_lb_target_group.api` resource (around line 250). In its `health_check {}` block, change the `path` line:

```diff
   health_check {
     enabled             = true
-    path                = "/health" # current backend endpoint; refactor to /health/ready when Backend Core lands (bead myth-nf3)
+    path                = "/health/ready" # MYT-35 closed myth-nf3; ALB gates on data-layer readiness
     protocol            = "HTTP"
```

Nothing else in the resource changes.

- [ ] **Step 2: Validate**

```bash
terraform -chdir=infra/modules/serving fmt -check
terraform -chdir=infra/modules/serving validate
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add infra/modules/serving/main.tf
git commit -m "feat(myt-35): swap ALB target-group health-check to /health/ready

In-place modify; no replacement; TG ARN stable so listener-rule and ECS
service load_balancer references don't churn. Application of this
change is staged via the 5-step deploy in the spec — DO NOT apply this
TF change until step 4 of that sequence."
```

---

## Task 6: Terraform — staging `extra_env` flip

**Files:**
- Modify: `infra/environments/staging/main.tf` (add `extra_env` to `module "serving"` block)

- [ ] **Step 1: Add `extra_env` to the staging module instantiation**

Find the `module "serving" { ... }` block in `infra/environments/staging/main.tf`. Add the following inside the block, after the existing args (before the closing `}` at the end of the block):

```hcl
  # MYT-35: flip the boot gate ON in staging. Production stays at default
  # OFF until the prod stack is composed at the Launch milestone, at which
  # point the prod environment workspace must explicitly set this — the
  # default-[] extra_env IS a footgun if forgotten (follow-up bead filed).
  extra_env = [
    { name = "BOOT_GATE_ENABLED", value = "1" },
  ]
```

- [ ] **Step 2: Validate**

```bash
terraform -chdir=infra/environments/staging fmt -check
terraform -chdir=infra/environments/staging validate
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add infra/environments/staging/main.tf
git commit -m "feat(myt-35): flip BOOT_GATE_ENABLED=1 in staging via extra_env

Application of this TF change is staged via the 5-step deploy in the
spec — applied as part of TF apply A in step 2 of that sequence."
```

---

## Task 7: Dockerfile HEALTHCHECK start-period bump

**Files:**
- Modify: `backend/Dockerfile` (line 37)

- [ ] **Step 1: Bump the start-period**

```diff
-HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
+HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
   CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
```

Note: this affects local `docker compose` only. In Fargate, the task-def's `healthCheck.startPeriod=60` (`infra/modules/serving/main.tf:196`) overrides this — the production knob is already correct.

- [ ] **Step 2: Smoke-test the build**

```bash
docker build -f backend/Dockerfile --target=runner -t mythrun-test .
```

Expected: build succeeds. (No need to run the container; HEALTHCHECK is local-dev only.)

- [ ] **Step 3: Commit**

```bash
git add backend/Dockerfile
git commit -m "feat(myt-35): bump Dockerfile HEALTHCHECK --start-period 5s → 30s

Local-dev only — Fargate uses the task-def healthCheck block which is
already at startPeriod=60. Closes myth-ccf."
```

---

## Task 8: Push code to main + watch CI deploy

**Files:**
- (None — operator action.)

This is **step 1 of the 5-step deploy**. Code is being deployed; boot gate is still OFF on the deployed task. ALB still polls `/health` (path hasn't flipped yet).

- [ ] **Step 1: Verify all backend gates pass**

```bash
pnpm --filter @mythrun/backend test
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Expected: all pass.

- [ ] **Step 2: Push to main**

```bash
git push origin main
```

- [ ] **Step 3: Watch the CI deploy**

```bash
RUN_ID=$(gh run list --workflow Deploy --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

Expected: deploy succeeds. The new image with `/health/ready` route + `worker.ts` + Dockerfile change lands. `BOOT_GATE_ENABLED` is still unset → `fallbackStart` runs → `/health/ready` returns 503 by design (stub Pool throws). ALB still polls `/health`, all green.

- [ ] **Step 4: Verify `/health` (only)**

```bash
curl -fsS https://staging-api.mythrun.com/health
```

Expected: `{"status":"ok"}`. **Do NOT curl `/health/ready` yet** — it returns 503 in this state by design.

---

## Task 9: TF apply A — register new task-def with BOOT_GATE_ENABLED=1

**Files:**
- (None — operator action against committed code from Task 6.)

This is **step 2 of the 5-step deploy**.

- [ ] **Step 1: Plan**

```bash
cd infra/environments/staging
terraform plan
```

Expected diff (don't grep on counts; eyeball):
- `+/- aws_ecs_task_definition.api` — replacement: `BOOT_GATE_ENABLED` added; `create_before_destroy` lifecycle keeps the family pointing at a valid revision throughout
- `+/- aws_ecs_task_definition.worker` — replacement: same env added; `desired_count = 0` + `ignore_changes [task_definition]` mean no rollout (by design)
- **NO `aws_lb_target_group.api` change yet** — that's step 4

If the plan shows the ALB path change too, abort: `infra/modules/serving/main.tf` was applied early. Roll forward by removing the path change, re-validating, and re-planning.

- [ ] **Step 2: Apply**

Surface the command for Miklos:

```bash
cd infra/environments/staging
terraform apply
```

After apply: new task-def revisions are registered. The live service is **still running the old revision** (because of `lifecycle.ignore_changes = [task_definition]`). Nothing observable changes yet — that's expected. Step 3 forces the rollover.

---

## Task 10: Force ECS service rollover onto the new revision

**Files:**
- (None — operator action.)

This is **step 3 of the 5-step deploy**.

- [ ] **Step 1: Pause concurrent CI deploys**

```bash
gh run list --workflow Deploy --status in_progress --limit 5
```

Expected: empty list. If any rows: wait for them to finish (or `gh run cancel` if re-triggerable). A concurrent Deploy run could land a NEWER revision without `BOOT_GATE_ENABLED` between TF apply A and the describe-task-definition lookup below — the rollover would then land on a non-gated container.

- [ ] **Step 2: Capture the new revision number**

```bash
LATEST_REV=$(aws ecs describe-task-definition \
  --task-definition mythrun-staging-api \
  --query 'taskDefinition.revision' --output text)
echo "Rolling onto revision $LATEST_REV"
```

Expected: a number, the new revision TF just registered.

- [ ] **Step 3: Force the rollover**

```bash
aws ecs update-service \
  --cluster mythrun \
  --service mythrun-staging-api \
  --task-definition "mythrun-staging-api:$LATEST_REV" \
  --force-new-deployment
aws ecs wait services-stable --cluster mythrun --services mythrun-staging-api
```

Expected: command returns when the new task is healthy. The new container starts with `BOOT_GATE_ENABLED=1` → `waitFor` runs → succeeds (DB exists from myth-ml8) → `app.listen` → `/health/ready` returns 200.

- [ ] **Step 4: Confirm the boot gate engaged**

```bash
aws logs tail /ecs/mythrun-staging-api --since 5m --format short \
  | grep -E '(Postgres|Redis) ready'
```

Expected: three lines mentioning `Postgres ready`, `Redis (realtime) ready`, `Redis (batch) ready`. (The `✓` checkmark in the source code is UTF-8 — `grep` without locale issues handles it, but the pattern omits it for portability.)

- [ ] **Step 5: Confirm `/health/ready` answers 200**

```bash
curl -fsS https://staging-api.mythrun.com/health/ready | jq .
```

Expected: `{"ready": true}`.

ALB is still polling `/health` (path hasn't flipped yet); the target-group is healthy via that path. Step 4 of the deploy will swap to `/health/ready`.

---

## Task 11: TF apply B — flip ALB target-group path to `/health/ready`

**Files:**
- (None — operator action against committed code from Task 5.)

This is **step 4 of the 5-step deploy**.

- [ ] **Step 1: Plan**

```bash
cd infra/environments/staging
terraform plan
```

Expected diff:
- `~ aws_lb_target_group.api` — in-place: `health_check.path` changes from `/health` to `/health/ready`
- No other changes

- [ ] **Step 2: Apply**

```bash
cd infra/environments/staging
terraform apply
```

ALB now polls `/health/ready` against the gate-enabled service from Task 10 → 200 → target stays healthy. No flap because the service is already serving 200 on that path.

---

## Task 12: End-to-end verification

**Files:**
- (None — operator action.)

This is **step 5 of the 5-step deploy**.

- [ ] **Step 1: ALB target-group health-check has flipped**

```bash
aws elbv2 describe-target-groups --names mythrun-staging-api \
  --query 'TargetGroups[0].HealthCheckPath' --output text
```

Expected: `/health/ready`.

- [ ] **Step 2: Target is healthy**

```bash
TG_ARN=$(aws elbv2 describe-target-groups --names mythrun-staging-api --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[*].TargetHealth.State'
```

Expected: all targets show `healthy`.

- [ ] **Step 3: `/health` and `/health/ready` both return 200**

```bash
curl -fsS https://staging-api.mythrun.com/health        # liveness
curl -fsS https://staging-api.mythrun.com/health/ready  # readiness
```

Expected: `{"status":"ok"}` and `{"ready":true}` respectively.

- [ ] **Step 4: Verify the structured probe-failure log query works**

Force a transient probe failure to confirm operators can grep CloudWatch for failures. Easiest way: temporarily detach the bootstrap SG from RDS so probes fail (DON'T do this if the staging DB is being used for anything else right now). Or simulate by checking the existing log group has the warn-level pino output format:

```bash
# First check there are NO probe-failed lines (system is healthy):
aws logs filter-log-events \
  --log-group-name /ecs/mythrun-staging-api \
  --filter-pattern '"health-ready probe failed"' \
  --start-time $(($(date +%s) * 1000 - 300000)) \
  --query 'events[*].message' --output text \
  | head -5
```

Expected: empty result (no failures since the system is healthy). The query mechanism is verified by the empty-but-valid response.

If you want to confirm the filter pattern catches a real failure: dispatch a Deploy with a deliberate bad `DB_HOST` env override and watch the warn lines appear, then revert. (Out of scope for this task; flag if you want to actually exercise it.)

- [ ] **Step 5: Beads close**

```bash
bd close myth-nf3 myth-g6g myth-ccf
```

- [ ] **Step 6: Linear ticket flips to Done**

Per the standing auth in saved memory `feedback_push_and_close.md`: flip MYT-35 to Done.

---

## Self-review notes (controller — completed before plan was saved)

**Spec coverage check:** every section of the v4 spec maps to a task above:
- v4 Decision §1 (data-layer probes only) → Task 2
- v4 Decision §2 (Promise.all) → Task 2
- v4 Decision §3 (Promise.race timeout) → Task 2
- v4 Decision §4 (worker scaffold) → Task 3
- v4 Decision §5 (ALB path swap) → Task 5 + applied in Task 11
- v4 Decision §6 (Dockerfile bump) → Task 7
- v4 Decision §7 (staging-only flip) → Task 6 + applied in Task 9
- v4 Decision §8 (5-step deploy) → Tasks 8–12
- v4 Decision §9 (EOPT-correct ProbeResult) → Task 2's route file
- v4 Decision §10 (no literal plan-count grep) → Tasks 9 and 11 use eyeball-the-diff
- v4 Components/Test plan (vi.useRealTimers, process.exit spy, removeAllListeners) → Task 3's test
- v4 Round-3 Coltrane H4 (worker tsx-watch comment) → Task 3's worker.ts comment
- v4 Round-3 Mingus H1 (CI race pause) → Task 10 step 1
- v4 Round-3 Mingus M2 (acceptance criteria post-push only curls /health) → Task 8 step 4
- v4 Round-3 Mingus M4 (rollback ordering) → spec section, no task here (not exercised in happy path)

**Placeholder check:** every code block contains the literal content the implementer types. No "TBD" / "TODO" / "implement later" / "similar to Task N" anywhere.

**Type/name consistency:** `ProbeResult` shape, `registerReadyRoute` signature, `makeStubDeps` signature, `main()` export — used consistently across Tasks 1–3. `var.extra_env` and `extra_env` argument are matched between Tasks 4 and 6. Acceptance commands match the spec's runbook exactly.
