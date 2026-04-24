# MYT-29: Local Dev Environment — Design Spec

> **Status:** Approved by Miklos 2026-04-24. Ready for blind agent-team review, then implementation planning.
> **Linear issue:** [MYT-29](https://linear.app/mythrun/issue/MYT-29)
> **Milestone:** Ops Foundation
> **Due:** 2026-04-27
> **Parent specs:** `docs/specs/2026-04-20-setup-guide.md` §Phase 6 (primary), `docs/specs/2026-04-06-production-architecture-overview.md` (Redis split rationale)

## 1. Context

MYT-28 shipped the production CI/CD pipeline and a minimal `/health` container running on staging ECS. The backend has no persistence wiring yet: no database client, no Redis client, no env-var loading beyond `PORT`. Writing that wiring directly against AWS RDS/ElastiCache would be slow, expensive, and impossible without production secrets, so the standard pattern is to mirror the data layer locally.

MYT-29 is the last ticket in the Ops Foundation milestone. Its purpose is to give the solo developer a single-command local loop that mirrors the three data-layer services production will use, so the Backend Core milestone (schema + repository + domain models) can iterate against a real Postgres + real Redis without touching cloud infrastructure.

## 2. Goal

`docker compose up -d --wait && pnpm dev` on a fresh clone produces a running backend that has:
- Connected to a local Postgres (`SELECT 1` succeeded)
- Connected to a local Redis "real-time" instance (`PING` succeeded)
- Connected to a local Redis "batch" instance (`PING` succeeded)

…and is serving `/health` returning 200 on `localhost:3000`. If any of the three fail after a bounded retry window, the backend process exits with status 1 and a clear error message naming the failing service.

## 3. Done-when

1. Fresh clone + `cp .env.development.example .env.development` (no edits) + `docker compose up -d --wait` + `pnpm --filter @mythrun/backend dev` results in:
   - All three services healthy in `docker compose ps`
   - Backend logs include `✓ Postgres ready`, `✓ Redis (realtime) ready`, `✓ Redis (batch) ready`, then `server listening on :3000`
   - `curl http://localhost:3000/health` returns `{"status":"ok"}` with HTTP 200
2. Stopping docker (`pnpm db:down`) and restarting `pnpm dev` causes the backend to retry 5 times, fail, and exit 1 with a named-service error.
3. Restarting docker (`pnpm db:up`) and `pnpm dev` again succeeds without any state change.
4. `pnpm --filter @mythrun/backend test` runs the new retry-helper unit tests and they pass without any running containers.
5. `pnpm typecheck` and `pnpm lint` pass cleanly.
6. Deploy pipeline (MYT-28) continues to go green — the production container picks up env vars from ECS task definition, not from `.env.development`, and the boot gate exercises the same code path against RDS/ElastiCache.

## 4. Non-goals

Explicit scope boundaries — work that sounds related but belongs to other tickets:

- **Database schema / migrations.** Backend Core milestone. This ticket proves we can `SELECT 1`; it does not create tables.
- **ORM or query builder selection.** Backend Core. `pg` is a raw client; whatever ORM lands on top of it later will use the same pool.
- **BullMQ / job queue wiring.** Backend Core / multiplayer runtime work. This ticket proves Redis is reachable; it does not enqueue jobs.
- **Readiness endpoint (`/health/ready`) with per-request dep checks.** Tracked separately as bead `myth-nf3`. This ticket keeps `/health` as process-liveness only, checked once at boot via the startup gate.
- **Integration tests against the compose stack.** Backend Core. MYT-29 has unit tests for the retry logic only.
- **Wiki updates.** Handled by the standard PostToolUse hook-dispatched subagent after Linear issue close.
- **Production env-var injection changes.** ECS task definition already wires the env; no changes needed there.
- **Synthetic data / seeded fixtures.** Future milestone. Dev DB starts empty; that's intentional for MYT-29.
- **Cloud-hosted dev environments, OnDemand-style preview environments, prod-data-scrubbing pipelines.** Roadmap items for post-launch; not in scope now.

## 5. Architecture

### 5.1 Three-service local stack

```
┌─ docker-compose.yml (repo root) ──────────────────────┐
│                                                       │
│  postgres:16-alpine       host :5432                  │
│    ├─ named volume 'pgdata' at /var/lib/postgresql    │
│    ├─ POSTGRES_USER=mythrun  (hardcoded, local-only)  │
│    ├─ POSTGRES_PASSWORD=mythrun_dev  (ditto)          │
│    ├─ POSTGRES_DB=mythrun                             │
│    └─ healthcheck: pg_isready -U mythrun              │
│                                                       │
│  redis-realtime:7.2-alpine  host :6379                │
│    ├─ no persistence (RDB/AOF off by default)         │
│    └─ healthcheck: redis-cli ping                     │
│                                                       │
│  redis-batch:7.2-alpine     host :6380                │
│    ├─ no persistence                                  │
│    └─ healthcheck: redis-cli ping                     │
│                                                       │
└───────────────────────────────────────────────────────┘
```

The two Redis instances are separate services, not databases-within-one-instance, because production uses separate ElastiCache clusters so a batch workload can never saturate the real-time instance's CPU or connection pool. Mirroring that locally means code that accidentally uses the wrong connection fails in dev instead of staging.

### 5.2 Boot-time connection gate

```
server.ts main():
  env = loadEnv()                        // throws on missing required vars
  pg   = createPgPool(env.databaseUrl)
  rTR  = createRedisClient(env.redisRealtimeUrl)
  rTB  = createRedisClient(env.redisBatchUrl)

  await Promise.all([
    waitForPostgres(pg,           { maxAttempts: 5, delays: [200, 500, 1000, 2000] }),
    waitForRedis(rTR, 'realtime', { maxAttempts: 5, delays: [200, 500, 1000, 2000] }),
    waitForRedis(rTB, 'batch',    { maxAttempts: 5, delays: [200, 500, 1000, 2000] }),
  ])
  // Logs: ✓ Postgres ready / ✓ Redis (realtime) ready / ✓ Redis (batch) ready

  app = buildApp({ pg, redisRealtime: rTR, redisBatch: rTB })
  await app.listen({ port: env.port, host: '0.0.0.0' })

  // Signal handlers from MYT-28 stay; extend to close pg + redis clients on shutdown.
```

**Retry schedule:** `maxAttempts: 5`, backoff between attempts: 200ms, 500ms, 1000ms, 2000ms (4 intervals between 5 attempts). Worst-case wall time before exit 1: ~3.7s plus per-attempt connection overhead. On exhaustion: log the last error with the named service, `process.exit(1)`. Parallel `Promise.all` means slow startup of one service doesn't serialize the others — total wait is `max(pg, redis_rt, redis_batch)`, not the sum.

**Why retry?** `docker compose up -d --wait` should already block on healthchecks, but there's a race between "healthcheck reports OK" and "Postgres can actually accept authenticated connections" (a second or two of startup after `pg_isready` flips green). Retry absorbs that without requiring the dev to time their commands.

### 5.3 Env-loading strategy

Node's built-in `--env-file=<path>` flag (stable since Node 20.6) populates `process.env` before any module loads. This means:
- No `dotenv` dependency
- No code path change between dev and prod — production simply omits the flag, and ECS task-definition env vars fill the same slots
- `process.env.DATABASE_URL` is the only read interface; test code can inject via env vars without any bootstrap

The `backend/src/config/env.ts` module reads the expected vars, validates presence, freezes the result, and exports it. Missing-var errors happen before any connection attempt, with a message like `Missing required env var: DATABASE_URL`.

### 5.4 `buildApp()` signature change

MYT-28's `buildApp()` currently takes no arguments. MYT-29 changes it to `buildApp({ pg, redisRealtime, redisBatch })`. The three clients are passed by reference. Future repository / cache code inside plugins reads them off `app.` (Fastify decorators) or via imports from a context module — to be decided in Backend Core.

The constructor injection pattern (vs. module-level singletons) keeps tests trivially able to swap in fakes without `vi.mock()` gymnastics, and prevents accidental global state sharing between test runs.

## 6. File-level design

### New files

| Path | Responsibility |
|---|---|
| `docker-compose.yml` (root) | Three services with healthchecks and a named volume for Postgres. |
| `.env.development.example` (root) | Committed template. Copy to `.env.development` on first clone. |
| `backend/src/config/env.ts` | Reads and validates process.env. Exports a frozen `Env` object. |
| `backend/src/db/postgres.ts` | `createPgPool()` + `waitForPostgres(pool, opts)` retry helper. |
| `backend/src/cache/redis.ts` | `createRedisClient(url)` + `waitForRedis(client, label, opts)` retry helper. |
| `backend/src/db/__tests__/postgres.test.ts` | Unit tests for retry loop using mock client. |
| `backend/src/cache/__tests__/redis.test.ts` | Unit tests for retry loop using mock client. |
| `backend/src/config/__tests__/env.test.ts` | Unit tests for env validation and error messages. |

### Modified files

| Path | Change |
|---|---|
| `backend/src/server.ts` | Add boot gate (load env → create clients → waitFor* in parallel → log → listen). Extend `createShutdown()` to close pg + redis on signal. |
| `backend/src/app.ts` | `buildApp()` accepts `{ pg, redisRealtime, redisBatch }` (unused by `/health` but threaded through for future plugins). |
| `backend/package.json` | Add deps: `pg`, `@types/pg`, `ioredis`. Update `dev` script: `tsx watch --env-file=../.env.development src/server.ts`. |
| `package.json` (root) | Add scripts: `db:up` (`docker compose up -d --wait`), `db:down` (`docker compose down`), `db:reset` (`docker compose down -v && docker compose up -d --wait`). |
| `.gitignore` | Add `.env`, `.env.local`, `.env.development`, `docker-compose.override.yml`. Keep `.env.development.example` tracked. |

### Files explicitly NOT touched

- `.github/workflows/*.yml` — no CI changes; CI has its own data-layer story.
- `infra/**/*.tf` — no Terraform changes; local dev doesn't touch AWS.
- `backend/Dockerfile` — production image is unaffected; ECS injects env vars directly.

## 7. Design decisions

### 7.1 Why `pg` + `ioredis` (not postgres.js, not node-redis)

- `pg` is the canonical node-postgres driver. Every ORM built on Node (Drizzle, Prisma, Kysely, TypeORM) uses it underneath. Picking `pg` now doesn't prejudge the ORM choice in Backend Core.
- `ioredis` is the de-facto Redis client for Node (BullMQ requires it; `node-redis` had a multi-year stability drift through v3→v4 that `ioredis` avoided). If/when we add BullMQ, the same client instance is reusable.

### 7.2 Why the boot gate lives in `server.ts`, not `app.ts`

MYT-28 deliberately split `app.ts` (HTTP surface, returns configured Fastify instance) from `server.ts` (process concerns, signal handlers, listen). Connection gating is a process-level concern — "should this process be alive?" — not an HTTP-routing concern. Placing it in `server.ts` preserves the boundary. Future work that needs to assert deps-are-ready (per-request readiness checks in `myth-nf3`) goes into `app.ts` as a Fastify plugin.

### 7.3 Why `--env-file` instead of `dotenv`

- Zero additional dependency.
- Node-native behavior: env vars are populated by the runtime before any `import` runs, so code never sees a transient "env not loaded" state.
- In production, ECS injects env vars directly — omitting `--env-file` is a no-op, and the same code reads `process.env` identically. No "dev-only bootstrap" code path.
- `tsx` passes unknown flags through to Node, so `tsx watch --env-file=…` works without a custom launcher.

### 7.4 Why `docker compose up -d --wait`

The `--wait` flag makes compose block until all services report their healthchecks as passing. Without it, `pnpm dev` races a still-starting Postgres and the retry loop runs 2-3 times before connecting — works, but produces noisy logs on every fresh start. With `--wait`, first-attempt success is the common path.

### 7.5 Why retry even with `--wait`

Because Postgres's healthcheck (`pg_isready`) only checks that the socket accepts connections, not that the authentication subsystem is ready. There's a ~1-2 second window where `pg_isready` reports healthy but `SELECT 1` returns "the database system is starting up." Retry absorbs this invisibly.

### 7.6 Why one retry schedule (not configurable per service)

YAGNI. The three services have similar startup characteristics (all Alpine-based, all sub-3-second cold starts). One schedule keeps the helper interfaces identical and the docs short. If a real divergence emerges, we extract per-service tuning then.

### 7.7 Why pass clients into `buildApp()` as constructor args

- Tests can pass fakes without `vi.mock()` hoisting tricks.
- Shutdown cleanup is centralized in `server.ts` (which owns the client lifetimes).
- Prevents accidental module-level singletons that leak state between test runs.
- Costs nothing — the signature change is a single object parameter.

### 7.8 Why hardcode `mythrun_dev` as the Postgres password in compose

The compose file declares `POSTGRES_PASSWORD: mythrun_dev` in plaintext. This is safe because:
- The Postgres container is only bound to `localhost:5432` — unreachable from outside the developer's machine.
- The database contains fake seeded data, never production data.
- There is no secret rotation or leak concern because the password is not secret.

Production uses Secrets Manager with rotation (see `infra/environments/staging/main.tf` `bootstrap_secrets`). Different trust boundary, different rules.

## 8. Test strategy

### 8.1 Unit tests (committed in this ticket)

Three test files using Vitest and mock clients:

- `backend/src/db/__tests__/postgres.test.ts`:
  - `waitForPostgres` returns on first-attempt success.
  - `waitForPostgres` retries on transient failure, eventually succeeds.
  - `waitForPostgres` exhausts retries and throws with a named error and the last underlying cause.
  - Backoff delays match the schedule (use fake timers).

- `backend/src/cache/__tests__/redis.test.ts`:
  - Same three behaviors as Postgres.
  - Error message includes the `label` param ("realtime" / "batch") so failures are disambiguable.

- `backend/src/config/__tests__/env.test.ts`:
  - All required vars present → returns frozen object.
  - Missing `DATABASE_URL` → throws with exact message "Missing required env var: DATABASE_URL".
  - `PORT` coerces from string to number; non-numeric throws.
  - Attempts to mutate the returned object throw in strict mode.

Tests use `vi.useFakeTimers()` to advance through backoff intervals without real waiting. No Docker required for CI.

### 8.2 Manual verification (documented in Done-when §3)

Five-minute smoke check covering the golden path, the negative path (docker down), and the recovery path (docker back up). Not automated because the Backend Core milestone will introduce proper integration tests against a Postgres test container managed by Vitest's globalSetup.

### 8.3 Production CI (no change)

The MYT-28 deploy workflow runs `pnpm test` which now includes the new unit tests. No new CI dependencies (no Docker-in-Docker, no test containers). Production container continues to hit RDS/ElastiCache URLs from its ECS task-definition env vars; the boot gate exercises the exact same code path remotely.

## 9. Risks

### 9.1 Port 5432 / 6379 / 6380 collisions on the dev machine

If the developer already runs another project on one of these ports (or has Homebrew's `postgresql` service running), `docker compose up` fails with `address already in use`. Mitigation: document `docker-compose.override.yml` as the escape hatch (gitignored; developer can remap host ports without affecting the team's compose file). Low probability for Miklos's specific Mac, high readability of the failure mode if it happens.

### 9.2 First-clone experience on a cold Docker Desktop

Pulling `postgres:16-alpine` + `redis:7.2-alpine` takes ~30-60 seconds on first run. `docker compose up -d --wait` will sit silently during the pull phase. Mitigation: the `--wait` flag shows per-service pull progress in newer Docker versions, and 30-60s is an acceptable one-time cost.

### 9.3 Stale `.env.development` after future env-var additions

If Backend Core adds a new required env var and the developer hasn't re-diffed against `.env.development.example`, they'll hit the "Missing required env var" throw. This is the *intended* behavior — better than silent misconfiguration — but worth noting so developers know to diff the example file when pulling changes. Mitigation: eventually, a `pnpm env:check` script or a pre-commit hook; out of scope now.

### 9.4 Named volume `pgdata` accumulates across the project's lifetime

`docker compose down` preserves the volume (intentional — tables survive restarts). Over months, the volume may grow large if schema + fixtures bloat. Mitigation: `pnpm db:reset` removes the volume. Standard dev hygiene, not worth engineering around.

### 9.5 Production boot-gate failure mode

If the production ECS task can't reach RDS for any reason (security group misconfig, DNS, IAM), the container exits 1 after 7.7s and ECS's deployment circuit breaker catches it (see `infra/modules/serving/main.tf`). This is strictly better than the current behavior (the MYT-28 container silently started because it made no DB calls). The failure mode is well-instrumented and already has a recovery procedure documented in MYT-30 Risks §6.

## 10. Open questions

None. All design decisions locked in via Miklos approval on 2026-04-24.

## 11. Decisions log

| # | Decision | Alternatives considered | Why this one |
|---|---|---|---|
| 1 | Scope = containers + connection proof (option 2 of 3) | Option 1 (containers only, no backend change); Option 3 (also fold /live + /ready split) | Proves the plumbing works end-to-end without absorbing myth-nf3's scope or the Backend Core schema work. |
| 2 | Retry with backoff on connection failure | Fail-fast; log-warn-keep-running | Matches ECS health-check-grace-period pattern; plays nicely with the spec's literal `docker compose up -d && pnpm dev` command. |
| 3 | `/health` stays liveness-only; myth-nf3 handles the /live + /ready split later | Fold dep-checks into /health now; do the split in this ticket | Respects bead boundary; the k8s liveness-vs-readiness distinction is worth having as two endpoints. |
| 4 | `pg` + `ioredis` as clients | `postgres.js` + `node-redis` | Canonical, universally used underneath every Node ORM, compatible with BullMQ when it arrives. |
| 5 | Boot gate in `server.ts`, not `app.ts` | Inline in buildApp | Preserves MYT-28's process-vs-HTTP split. |
| 6 | `--env-file` flag, no dotenv | dotenv; fastify-env plugin | Zero deps, Node-native, no dev-only code path. |
| 7 | Clients passed into `buildApp()` as constructor arg | Module-level singletons | Testable; centralized shutdown; no hidden globals. |
| 8 | `docker compose up -d --wait` | `docker compose up -d` | Blocks until healthchecks pass; quieter first-run logs. |
| 9 | Wiki updates via standard post-close hook | Inline wiki edits during implementation | Consistent with other tickets; wiki-check workflow gates on freshness. |

---

## Appendix A: `.env.development.example` (verbatim)

```
# Data layer (docker-compose)
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun
REDIS_REALTIME_URL=redis://localhost:6379
REDIS_BATCH_URL=redis://localhost:6380

# External services (dev credentials — safe to commit as placeholders)
ANTHROPIC_API_KEY=sk-ant-xxx
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Auth mode: bypass (dev) | real (staging/prod)
AUTH_MODE=bypass

# Server
PORT=3000
```

## Appendix B: `docker-compose.yml` (verbatim)

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
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mythrun -d mythrun"]
      interval: 2s
      timeout: 2s
      retries: 10

  redis-realtime:
    image: redis:7.2-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 10

  redis-batch:
    image: redis:7.2-alpine
    ports:
      - "6380:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 10

volumes:
  pgdata:
```
