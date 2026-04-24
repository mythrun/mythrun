# MYT-29: Local Dev Environment — Design Spec

> **Status:** v2 — incorporates round-1 blind agent-team review (Pikachu/Charizard/Mewtwo, 2026-04-24). Approved by Miklos 2026-04-24. Round 2 review pending.
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

1. Fresh clone + `cp .env.development.example .env.development` (then user fills sentinel values for `ANTHROPIC_API_KEY` and Stripe keys, or leaves them as `REPLACE_ME_dev_only` since this ticket does not call those services) + `docker compose up -d --wait` + `pnpm --filter @mythrun/backend dev` results in:
   - All three services healthy in `docker compose ps`
   - Backend logs include `✓ Postgres ready`, `✓ Redis (realtime) ready`, `✓ Redis (batch) ready`, then `server listening on :3000`
   - `curl http://localhost:3000/health` returns `{"status":"ok"}` with HTTP 200
2. Stopping docker (`pnpm db:down`) and restarting `pnpm dev` causes the backend to retry 5 times, fail, and exit 1 with a named-service error in the log.
3. Restarting docker (`pnpm db:up`) and `pnpm dev` again succeeds without any state change.
4. Hitting Ctrl-C mid-boot (during the retry loop) closes any partially-created clients and exits cleanly without unhandled-rejection warnings.
5. `pnpm --filter @mythrun/backend test` runs the new unit tests (retry helper + boot-gate integration + env loader) and they pass without any running containers.
6. `pnpm typecheck` and `pnpm lint` pass cleanly.
7. Deploy pipeline (MYT-28) continues to go green — the production container picks up env vars from ECS task definition, not from `.env.development`, and the boot gate exercises the same code path against RDS/ElastiCache (with prod-tuned retry budget — see §5.2).

## 4. Non-goals

Explicit scope boundaries — work that sounds related but belongs to other tickets:

- **Database schema / migrations.** Backend Core milestone. This ticket proves we can `SELECT 1`; it does not create tables.
- **ORM or query builder selection.** Backend Core. `pg` is a raw client; whatever ORM lands on top of it later will use the same pool.
- **BullMQ / job queue wiring.** Backend Core / multiplayer runtime work. This ticket proves Redis is reachable; it does not enqueue jobs.
- **Readiness endpoint (`/health/ready`) with per-request dep checks.** Tracked separately as bead `myth-nf3`. This ticket keeps `/health` as process-liveness only, checked once at boot via the startup gate.
- **Integration tests against the compose stack.** Backend Core. MYT-29 has unit tests for the retry logic and boot-gate integration only.
- **Wiki updates.** Handled by the standard PostToolUse hook-dispatched subagent after Linear issue close.
- **Production env-var injection changes.** ECS task definition already wires the env; no changes needed there. Production tunes retry budget via `BOOT_GATE_MAX_ATTEMPTS` / `BOOT_GATE_BACKOFF_MS` set in the task definition.
- **Synthetic data / seeded fixtures.** Future milestone. Dev DB starts empty; that's intentional for MYT-29.
- **Cloud-hosted dev environments, OnDemand-style preview environments, prod-data-scrubbing pipelines.** Roadmap items for post-launch; not in scope now.
- **Pre-commit secret scanning** (gitleaks etc.). Useful follow-up; tracked as a separate bead.

## 5. Architecture

### 5.1 Three-service local stack

```
┌─ docker-compose.yml (repo root) ──────────────────────┐
│                                                       │
│  postgres:16-alpine                                   │
│    bound 127.0.0.1:5432  (NOT 0.0.0.0)                │
│    ├─ named volume 'pgdata' at /var/lib/postgresql    │
│    ├─ POSTGRES_USER=mythrun  (hardcoded, local-only)  │
│    ├─ POSTGRES_PASSWORD=mythrun_dev  (ditto)          │
│    ├─ POSTGRES_DB=mythrun                             │
│    └─ healthcheck: pg_isready -h 127.0.0.1            │
│       (interval 2s, timeout 2s, retries 10,           │
│        start_period 10s)                              │
│                                                       │
│  redis-realtime:7.2-alpine                            │
│    bound 127.0.0.1:6379                               │
│    ├─ command: --save "" --appendonly no              │
│    │  (force RDB + AOF off; container's defaults are  │
│    │   to snapshot, which we don't want for dev)      │
│    └─ healthcheck: redis-cli ping (start_period 10s)  │
│                                                       │
│  redis-batch:7.2-alpine                               │
│    bound 127.0.0.1:6380                               │
│    ├─ command: --save "" --appendonly no              │
│    └─ healthcheck: redis-cli ping (start_period 10s)  │
│                                                       │
│  All three services:                                  │
│    logging: json-file, max-size 10m, max-file 3       │
│    (caps log volume so a tight retry loop in the      │
│     backend can't fill Docker Desktop's log dir)      │
│                                                       │
└───────────────────────────────────────────────────────┘
```

The two Redis instances are separate services, not databases-within-one-instance, because production uses separate ElastiCache clusters so a batch workload can never saturate the real-time instance's CPU or connection pool. Mirroring that locally means code that accidentally uses the wrong connection fails in dev instead of staging.

**Why bind to 127.0.0.1 explicitly:** Docker Desktop on macOS publishes ports on `0.0.0.0` by default, exposing services to anyone on the local network. With dev-quality credentials in a Postgres container, a coffee-shop wifi co-tenant could connect. Explicit `127.0.0.1` binding makes the §7.8 trust-boundary argument actually correct.

**Why force Redis persistence off:** `redis:7.2-alpine` ships with the upstream default `save 3600 1 300 100 60 10000` (RDB snapshots) enabled. Dev expects ephemeral cache semantics — a `docker compose restart` reloading stale snapshots would diverge from prod (where ElastiCache caches are similarly volatile across node-replacement) and confuse debugging.

### 5.2 Boot-time connection gate

```
server.ts main():
  // Signal handlers installed FIRST, before any resource creation —
  // a SIGINT during boot must close partial clients cleanly.
  const abortController = new AbortController()
  installSignalHandlers(abortController)

  env = loadEnv()                                  // throws on missing required vars
  pg   = createPgPool(env.databaseUrl)             // pg.Pool, lazy connect
  rTR  = createRedisClient(env.redisRealtimeUrl)   // ioredis with lazyConnect: true
  rTB  = createRedisClient(env.redisBatchUrl)

  // Concurrent retry-with-backoff. Promise.allSettled (NOT Promise.all)
  // so we can collect all failures and present a consolidated error;
  // AbortController cancels sibling waiters when one fails so we don't
  // burn the full 3.7s budget after the first rejection.
  const results = await Promise.allSettled([
    waitFor({ label: 'Postgres',         probe: () => pg.query('SELECT 1'),
              maxAttempts, delays, signal: abortController.signal }),
    waitFor({ label: 'Redis (realtime)', probe: () => rTR.ping(),
              maxAttempts, delays, signal: abortController.signal }),
    waitFor({ label: 'Redis (batch)',    probe: () => rTB.ping(),
              maxAttempts, delays, signal: abortController.signal }),
  ])
  // On any rejection: log all failed services + cause; cleanup partials; exit 1.
  if (results.some(r => r.status === 'rejected')) {
    await closePartials(pg, rTR, rTB)
    process.exitCode = 1
    return
  }
  // Logs: ✓ Postgres ready / ✓ Redis (realtime) ready / ✓ Redis (batch) ready

  app = await buildApp({ pg, redisRealtime: rTR, redisBatch: rTB })
  await app.listen({ port: env.port, host: '0.0.0.0' })

  // createShutdown(app, pg, rTR, rTB) — extends MYT-28's shutdown helper
  // to drain HTTP first, then close pg, then quit redis (in that order;
  // see §7.9 for ordering rationale).
```

**Retry schedule (default):** `maxAttempts: 5`, backoff between attempts: 200ms, 500ms, 1000ms, 2000ms (4 intervals between 5 attempts). Worst-case wall time before exit 1: ~3.7s plus per-attempt connection overhead. On exhaustion: log all failed services with their last error, set `process.exitCode = 1`, return from `main()` (not `process.exit(1)` — gives the logger event-loop time to flush stdout cleanly).

**Retry schedule is env-tunable.** Both `BOOT_GATE_MAX_ATTEMPTS` (default 5) and `BOOT_GATE_BACKOFF_MS` (default `"200,500,1000,2000"` — comma-separated) are read in `env.ts`. Production ECS tasks override to `BOOT_GATE_MAX_ATTEMPTS=10` and `BOOT_GATE_BACKOFF_MS="500,1000,2000,4000,4000,4000,4000,4000,4000"` (~30s budget) so an RDS failover or ElastiCache node replacement doesn't crash-loop the task. Dev defaults stay tight for fast feedback.

**Why retry?** `docker compose up -d --wait` should already block on healthchecks, but there's a race between "healthcheck reports OK" and "Postgres can actually accept authenticated connections" (a second or two of startup after `pg_isready` flips green). Retry absorbs that without requiring the dev to time their commands.

**Why `Promise.allSettled` + AbortController:** `Promise.all` rejects on first failure but doesn't stop the sibling retry loops, so a fast Postgres failure followed by ~3 more seconds of Redis retries produces noisy logs and risks unhandled-rejection emissions after `process.exit`. The `AbortController` short-circuits the sibling waiters, and `allSettled` collects all failures so the error message can name every unhealthy service, not just the first to give up.

### 5.3 Env-loading strategy

Node's built-in `--env-file=<path>` flag (stable since Node 20.6) populates `process.env` before any module loads. This means:
- No `dotenv` dependency
- No code path change between dev and prod — production simply omits the flag, and ECS task-definition env vars fill the same slots
- `process.env.DATABASE_URL` is the only read interface; test code can inject via env vars without any bootstrap

**Silent-on-missing semantics:** Node's `--env-file` flag is non-fatal if the file doesn't exist (it logs a warning to stderr but does not exit). The failure surfaces via `env.ts` validation — a clear `Missing required env var: DATABASE_URL` thrown before any connection attempt. This is the *intended* UX (loud failure on real misconfig, not on missing flag) but is documented here so future maintainers don't reach for `dotenv` thinking the flag is broken.

**Dev/prod env divergence (DATABASE_URL TLS):**
- Dev `DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun` — no TLS (local container)
- Prod `DATABASE_URL=postgresql://...?sslmode=require` — TLS-required (RDS sets `rds.force_ssl=1`)

The `pg` library reads `sslmode` from the URL; the same `createPgPool(url)` code path handles both. The Boot-gate "exercises same code path" claim in §3.7 is therefore complete: identical client code, identical retry loop, identical shutdown order — only the URL differs.

The `backend/src/config/env.ts` module reads the expected vars, validates presence, freezes the result, and exports it. Missing-var errors happen before any connection attempt.

### 5.4 `buildApp()` decorator pattern

MYT-28's `buildApp()` currently takes no arguments. MYT-29 changes it to `buildApp({ pg, redisRealtime, redisBatch })`. Inside `buildApp()`, the three clients are immediately attached to the Fastify instance via `app.decorate(...)`:

```ts
export async function buildApp(deps: { pg: pg.Pool, redisRealtime: Redis, redisBatch: Redis }) {
  const app = fastify({ logger: true })
  app.decorate('pg', deps.pg)
  app.decorate('redisRealtime', deps.redisRealtime)
  app.decorate('redisBatch', deps.redisBatch)
  app.get('/health', async () => ({ status: 'ok' }))
  return app
}
```

**Why decorators rather than passing args through to plugins:** Backend Core will register many Fastify plugins (auth, repository, queues) and the canonical Fastify pattern is for plugins to read `app.pg` etc. via the decorator interface. Threading clients explicitly through every plugin signature is noisy and `app.decorate` is the standard Fastify convention. Doing the decoration now (even though `/health` doesn't read these) gives Backend Core a concrete extension point and avoids the "unused destructured args" lint flag.

The constructor-injection pattern (`buildApp` receives clients as args, doesn't construct them) keeps tests trivially able to swap in fakes without `vi.mock()` gymnastics, and prevents accidental module-level singletons that leak state between test runs.

## 6. File-level design

### New files

| Path | Responsibility |
|---|---|
| `docker-compose.yml` (root) | Three services with healthchecks, log caps, named volume for Postgres, explicit 127.0.0.1 binding, Redis persistence disabled. |
| `.env.development.example` (root) | Committed template. Sentinel `REPLACE_ME_dev_only` placeholders for secrets — see Appendix A. |
| `backend/src/config/env.ts` | Reads and validates `process.env`. Exports a frozen `Env` object. Missing-var throws before any connection attempt. Reads `BOOT_GATE_MAX_ATTEMPTS` + `BOOT_GATE_BACKOFF_MS` with sensible defaults. |
| `backend/src/boot/wait-for.ts` | Generic `waitFor({ label, probe, maxAttempts, delays, signal })` retry helper. Probe is any `() => Promise<unknown>`. Signal allows mid-boot cancellation. Used by both Postgres and Redis. |
| `backend/src/boot/signal-handlers.ts` | `installSignalHandlers(controller)` wires SIGINT/SIGTERM to abort the controller, so mid-boot Ctrl-C cancels in-flight retries cleanly. |
| `backend/src/boot/shutdown.ts` | `createShutdown(app, pg, redisRealtime, redisBatch)` — extends MYT-28's shutdown helper. Drain order: `app.close()` → `pg.end()` → `redis.quit()` (NOT `disconnect()`, which abandons in-flight commands). 10s timeout per stage; force-kill if exceeded. |
| `backend/src/db/postgres.ts` | `createPgPool(url)` returns a `pg.Pool`. Honors `?sslmode=require` from URL. Thin wrapper. |
| `backend/src/redis/redis.ts` | `createRedisClient(url)` returns an `ioredis` Redis instance configured with `lazyConnect: true`, `maxRetriesPerRequest: 1`, `retryStrategy: () => null`, `enableOfflineQueue: false`. Lets `waitFor` own all retry behavior. Thin wrapper. |
| `backend/src/db/__tests__/postgres.test.ts` | Tests `createPgPool` URL handling + `?sslmode=require` propagation. |
| `backend/src/redis/__tests__/redis.test.ts` | Tests `createRedisClient` config (lazyConnect: true, etc.). |
| `backend/src/boot/__tests__/wait-for.test.ts` | The big test file: success on first attempt, retry-then-success, exhaustion-throws, AbortSignal cancellation, label appears in error message, fake-timer backoff verification. |
| `backend/src/boot/__tests__/signal-handlers.test.ts` | Tests SIGINT/SIGTERM handlers abort the passed controller. |
| `backend/src/__tests__/server.test.ts` | Boot-gate integration: mocks the three `waitFor` calls, asserts one rejection consolidates errors and sets `exitCode = 1` without calling `app.listen()`. |
| `backend/src/config/__tests__/env.test.ts` | Tests env validation, `BOOT_GATE_BACKOFF_MS` parsing, `PORT` numeric coercion, sentinel-value detection (warns or fails on `REPLACE_ME_dev_only` once the relevant client is wired — this ticket: just presence). |

### Modified files

| Path | Change |
|---|---|
| `backend/src/server.ts` | Replace existing entrypoint with the new boot gate (signal handlers → load env → create clients → `Promise.allSettled` waitFor → log → buildApp → listen). On retry exhaustion: cleanup, exitCode=1, return. |
| `backend/src/app.ts` | `buildApp()` accepts `{ pg, redisRealtime, redisBatch }` and decorates the Fastify instance. `/health` route unchanged. |
| `backend/package.json` | Add deps: `pg`, `@types/pg`, `ioredis`. Update `dev` script: `tsx watch --env-file=../.env.development src/server.ts` (the `../` is intentional — repo-root anchored; comment in package.json explains). |
| `package.json` (root) | Add scripts: `db:up` (`docker compose up -d --wait`), `db:down` (`docker compose down`), `db:reset` (`docker compose down -v && docker compose up -d --wait`). |
| `.gitignore` | Use `.env*` glob with `!.env.development.example` negation. Plus `docker-compose.override.yml`. |

### Files explicitly NOT touched

- `.github/workflows/*.yml` — no CI changes; CI has its own data-layer story (Backend Core).
- `infra/**/*.tf` — no Terraform changes; local dev doesn't touch AWS.
- `backend/Dockerfile` — production image is unaffected; ECS injects env vars and the boot gate code path is identical.

## 7. Design decisions

### 7.1 Why `pg` + `ioredis` (not postgres.js, not node-redis)

- `pg` is the canonical node-postgres driver. Every ORM built on Node (Drizzle, Prisma, Kysely, TypeORM) uses it underneath. Picking `pg` now doesn't prejudge the ORM choice in Backend Core.
- `ioredis` is the de-facto Redis client for Node (BullMQ requires it; `node-redis` had a multi-year stability drift through v3→v4 that `ioredis` avoided). If/when we add BullMQ, the same client instance is reusable.
- `ioredis` configured with `{ lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, enableOfflineQueue: false }`. By default, `ioredis` aggressively auto-connects and retries forever; without these flags it would fight `waitFor` and emit unhandled `error` events after `process.exit(1)`.

### 7.2 Why the boot gate lives in `server.ts`, not `app.ts`

MYT-28 deliberately split `app.ts` (HTTP surface, returns configured Fastify instance) from `server.ts` (process concerns, signal handlers, listen). Connection gating is a process-level concern — "should this process be alive?" — not an HTTP-routing concern. Placing it in `server.ts` preserves the boundary. Future work that needs to assert deps-are-ready (per-request readiness checks in `myth-nf3`) goes into `app.ts` as a Fastify plugin.

### 7.3 Why `--env-file` instead of `dotenv`

- Zero additional dependency.
- Node-native behavior: env vars are populated by the runtime before any `import` runs, so code never sees a transient "env not loaded" state.
- In production, ECS injects env vars directly — omitting `--env-file` is a no-op, and the same code reads `process.env` identically. No "dev-only bootstrap" code path.
- `tsx` passes unknown flags through to Node, so `tsx watch --env-file=…` works without a custom launcher. (Pinned tsx version verified in CI.)
- Silent-on-missing-file behavior is documented in §5.3; the env validator (`env.ts`) provides the loud failure on actual misconfig.

### 7.4 Why `docker compose up -d --wait`

The `--wait` flag makes compose block until all services report their healthchecks as passing. Without it, `pnpm dev` races a still-starting Postgres and the retry loop runs 2-3 times before connecting — works, but produces noisy logs on every fresh start. With `--wait`, first-attempt success is the common path.

### 7.5 Why retry even with `--wait`

Because Postgres's healthcheck (`pg_isready`) only checks that the socket accepts connections, not that the authentication subsystem is ready. There's a ~1-2 second window where `pg_isready` reports healthy but `SELECT 1` returns "the database system is starting up." Retry absorbs this invisibly. The `start_period: 10s` on the healthcheck (Charizard #1.3) further reduces false-negatives during cold start.

### 7.6 Why one retry schedule (not configurable per service)

YAGNI. The three services have similar startup characteristics (all Alpine-based, all sub-3-second cold starts). One schedule keeps the helper interfaces identical and the docs short. The schedule IS configurable per-environment (dev tight, prod loose) via env vars (§5.2) — the dimension that actually matters.

### 7.7 Why pass clients into `buildApp()` as constructor args

- Tests can pass fakes without `vi.mock()` hoisting tricks.
- Shutdown cleanup is centralized in `server.ts` (which owns the client lifetimes).
- Prevents accidental module-level singletons that leak state between test runs.
- Costs nothing — the signature change is a single object parameter, immediately stashed on Fastify decorators (§5.4).

### 7.8 Why hardcode `mythrun_dev` as the Postgres password in compose

The compose file declares `POSTGRES_PASSWORD: mythrun_dev` in plaintext. This is safe because:
- The Postgres container is bound explicitly to `127.0.0.1:5432` — unreachable from outside the developer's machine, including from other devices on the same wifi.
- The database contains fake seeded data, never production data.
- There is no secret rotation or leak concern because the password is not secret.

Production uses Secrets Manager with rotation (see `infra/environments/staging/main.tf` `bootstrap_secrets`). Different trust boundary, different rules.

### 7.9 Shutdown ordering: app.close → pg.end → redis.quit

Order matters when shutting down a process holding active database state:

1. **`app.close()` first.** Fastify stops accepting new connections, waits for in-flight requests to drain. Without this, `pg.end()` would throw on requests mid-query.
2. **`pg.end()` next.** Closes the connection pool cleanly, including waiting for in-flight queries to complete.
3. **`redis.quit()` last.** Sends Redis `QUIT` command, allowing the server to acknowledge buffer flushes. **Not `disconnect()`** — `disconnect()` rips the socket without acking, abandoning in-flight commands. `quit()` is the graceful shutdown.

10s timeout per stage; if a stage hangs beyond 10s, log the offender and force-exit. Production ECS sends SIGTERM with a 30s grace period (matching task definition's `stopTimeout: 30`); this fits comfortably.

### 7.10 Why `Promise.allSettled` + AbortController for the boot gate

`Promise.all` rejects on first failure but doesn't cancel sibling Promise rejection-on-rejection. Symptoms: noisy logs (sibling retries print for the next ~3s), and unhandled rejections firing after `process.exit(1)` is scheduled. `Promise.allSettled` lets us collect every service's failure for a consolidated error message ("Postgres failed: ECONNREFUSED. Redis (batch) failed: NR Cluster auth required."), and the shared `AbortSignal` short-circuits sibling retry loops the moment one fails.

### 7.11 Why the shared `boot/wait-for.ts` helper

The original draft proposed two near-identical retry helpers (`waitForPostgres`, `waitForRedis`). A unified `waitFor({ label, probe, ... })` shared by both Postgres and Redis (and any future S3/SES/etc. boot gates) prevents the retry pattern from drifting between services as the codebase grows. Thin wrappers in `db/postgres.ts` and `redis/redis.ts` bind the probe; the retry/backoff/abort/error-formatting logic lives once in `wait-for.ts`.

### 7.12 Why `redis/` not `cache/`

The directory name should match what the modules actually do. Mythrun has two Redis instances doing pub/sub, session state, and (later) BullMQ queues. Calling that directory `cache/` will mislead grep-based exploration once BullMQ lands. `redis/` is semantic-neutral and mirrors `db/`.

### 7.13 Why Redis persistence forced off via `command:`

`redis:7.2-alpine` ships with `save 3600 1 300 100 60 10000` (RDB snapshotting) enabled by default. Dev expects ephemeral cache semantics, and a `docker compose restart` reloading stale RDB would break the "fresh state" mental model that prod (where ElastiCache node replacement is similarly volatile) maintains. `command: ["redis-server", "--save", "", "--appendonly", "no"]` makes Redis behavior in dev match Redis behavior in prod for our use case.

## 8. Test strategy

### 8.1 Unit tests (committed in this ticket)

Six test files using Vitest and mock clients:

- `backend/src/boot/__tests__/wait-for.test.ts`:
  - First-attempt success returns immediately.
  - Retries on transient failure, eventually succeeds.
  - Exhausts retries and throws with the `label` in the error message and the last underlying cause attached.
  - Backoff delays match the schedule (use fake timers).
  - `AbortSignal.abort()` mid-loop rejects with `AbortError` and stops further attempts.

- `backend/src/boot/__tests__/signal-handlers.test.ts`:
  - SIGINT triggers `controller.abort()`.
  - SIGTERM triggers `controller.abort()`.
  - Multiple signals are idempotent.

- `backend/src/__tests__/server.test.ts` (the boot-gate integration test):
  - Mocks `waitFor` to reject for one service.
  - Asserts `process.exitCode === 1` after main() returns.
  - Asserts `app.listen` was NOT called.
  - Asserts the consolidated error log lists the failed service's label.

- `backend/src/db/__tests__/postgres.test.ts`:
  - `createPgPool` parses `?sslmode=require` from URL.
  - Default has `?sslmode=disable` semantics (or whatever `pg` defaults to with no flag).

- `backend/src/redis/__tests__/redis.test.ts`:
  - `createRedisClient` returns an `ioredis` instance with `lazyConnect: true`, `maxRetriesPerRequest: 1`, etc.

- `backend/src/config/__tests__/env.test.ts`:
  - All required vars present → returns frozen object.
  - Missing `DATABASE_URL` → throws "Missing required env var: DATABASE_URL".
  - `PORT` coerces from string to number; non-numeric throws.
  - `BOOT_GATE_BACKOFF_MS="200,500,1000"` parses to `[200, 500, 1000]`.
  - `BOOT_GATE_MAX_ATTEMPTS=10` parses correctly.
  - Attempts to mutate the returned object throw in strict mode.

Tests use `vi.useFakeTimers()` to advance through backoff intervals without real waiting. No Docker required for CI.

### 8.2 Manual verification (documented in Done-when §3)

Five-minute smoke check covering the golden path, the negative path (docker down), the recovery path (docker back up), and the abort path (Ctrl-C mid-retry). Not automated because the Backend Core milestone will introduce proper integration tests against a Postgres test container managed by Vitest's globalSetup.

### 8.3 Production CI (no change)

The MYT-28 deploy workflow runs `pnpm test` which now includes the new unit tests. No new CI dependencies (no Docker-in-Docker, no test containers). Production container continues to hit RDS/ElastiCache URLs from its ECS task-definition env vars; the boot gate exercises the exact same code path remotely with prod-tuned retry budget.

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

If the production ECS task can't reach RDS for any reason (security group misconfig, DNS, IAM), the container exits 1 after the retry budget elapses (default 5 attempts / 3.7s, prod-tuned to ~30s via `BOOT_GATE_*` env vars) and ECS's deployment circuit breaker catches it (see `infra/modules/serving/main.tf`). This is strictly better than the current behavior (the MYT-28 container silently started because it made no DB calls). The failure mode is well-instrumented and already has a recovery procedure documented in MYT-30 Risks §6. The env-var tunable in §5.2 is what makes this safe — without it, an RDS failover (60-120s) would crash-loop the prod task with the dev-tight 3.7s budget.

### 9.6 `.env.development` not created (silent flag, loud env validator)

`--env-file` flag is non-fatal on missing file. The first signal of a missing `.env.development` is the `env.ts` "Missing required env var: DATABASE_URL" throw. Documented in §5.3. Future maintainers may attempt to "fix" this by re-adding `dotenv`; the mitigation is the §7.3 commentary explaining the design choice.

### 9.7 Mid-boot Ctrl-C resource leak

Hitting Ctrl-C while the retry loop is still running used to (in the v1 spec) leave open `pg.Pool` sockets and `ioredis` connection retries running. v2 fixes this with the AbortController + `installSignalHandlers` BEFORE client creation, plus the `closePartials()` cleanup path. Done-when §3.4 verifies this manually.

### 9.8 Production secret leak via committed `.env.development`

A dev who pastes their real `ANTHROPIC_API_KEY` into `.env.development.example` (instead of `.env.development`) and commits would push an Anthropic key to GitHub. Mitigation: example file uses sentinel `REPLACE_ME_dev_only` (does not match the `sk-ant-` prefix that triggers Anthropic's auto-revocation, but also is loudly fake). The `.env*` gitignore + `!.env.development.example` negation ensures other env files never get tracked. A pre-commit secret scan (gitleaks etc.) is the proper belt-and-suspenders; tracked as a follow-up bead.

## 10. Open questions

None. All design decisions locked in via Miklos approval on 2026-04-24 (round 1) and round-1 review fixes (this v2).

## 11. Decisions log

| # | Decision | Alternatives considered | Why this one |
|---|---|---|---|
| 1 | Scope = containers + connection proof (option 2 of 3) | Option 1 (containers only, no backend change); Option 3 (also fold /live + /ready split) | Proves the plumbing works end-to-end without absorbing myth-nf3's scope or the Backend Core schema work. |
| 2 | Retry with backoff on connection failure | Fail-fast; log-warn-keep-running | Matches ECS health-check-grace-period pattern; plays nicely with the spec's literal `docker compose up -d && pnpm dev` command. |
| 3 | `/health` stays liveness-only; myth-nf3 handles the /live + /ready split later | Fold dep-checks into /health now; do the split in this ticket | Respects bead boundary; the k8s liveness-vs-readiness distinction is worth having as two endpoints. |
| 4 | `pg` + `ioredis` as clients, with explicit ioredis disable-auto-retry config | `postgres.js` + `node-redis`; default ioredis config | Canonical, universally used underneath every Node ORM, compatible with BullMQ. Disabling auto-retry prevents fight with our own waitFor. |
| 5 | Boot gate in `server.ts`, not `app.ts` | Inline in buildApp | Preserves MYT-28's process-vs-HTTP split. |
| 6 | `--env-file` flag, no dotenv | dotenv; fastify-env plugin | Zero deps, Node-native, no dev-only code path. |
| 7 | Clients passed into `buildApp()` and immediately attached via `app.decorate(...)` | Module-level singletons; thread through every plugin signature | Testable; centralized shutdown; standard Fastify convention; no hidden globals. |
| 8 | `docker compose up -d --wait` | `docker compose up -d` | Blocks until healthchecks pass; quieter first-run logs. |
| 9 | `Promise.allSettled` + shared `AbortController` for the boot gate | `Promise.all`; sequential awaits | Cancels sibling retries on first failure; collects all failures for consolidated error message; avoids unhandled rejections after exit. |
| 10 | Single `boot/wait-for.ts` helper used by both pg and redis (and future deps) | One helper per service | DRY; prevents pattern drift; one test file to maintain. |
| 11 | `backend/src/redis/` not `backend/src/cache/` | `cache/` matching the v1 draft | Redis instances do pub/sub + queues + caching; `cache/` is misleading once BullMQ lands. |
| 12 | Bind compose ports to `127.0.0.1` explicitly | Default `"5432:5432"` (binds to 0.0.0.0 on Docker Desktop / macOS) | Coffee-shop wifi co-tenants would otherwise reach dev Postgres; makes the trust-boundary argument actually correct. |
| 13 | Retry budget tunable via `BOOT_GATE_MAX_ATTEMPTS` + `BOOT_GATE_BACKOFF_MS` env vars | Hardcoded schedule | Dev wants tight feedback; prod needs ~30s for RDS failover; same code path, env-different config. |
| 14 | Force Redis persistence off via `command:` flag | Rely on image defaults | `redis:7.2-alpine` defaults RDB ON; we want ephemeral cache semantics matching prod ElastiCache behavior. |
| 15 | Sentinel `REPLACE_ME_dev_only` for example-file API keys | Pattern-matching placeholders like `sk-ant-xxx` | Avoids GitHub secret-scanning false-positive on accidental commits and Anthropic auto-revocation. |
| 16 | `.env*` glob with `!.env.development.example` negation | Explicit list of env-file names | Future-proofs against `.env.production` etc. accidentally committed. |
| 17 | Shutdown order: `app.close()` → `pg.end()` → `redis.quit()` | Reverse order; concurrent shutdown | Drain HTTP first or `pg.end()` throws on mid-flight queries. `redis.quit()` not `disconnect()` so in-flight commands flush. |
| 18 | Log driver `json-file` with 10m × 3 caps on all services | Default unbounded | A bad retry loop in the backend won't fill Docker Desktop's log dir. |
| 19 | Document prod `?sslmode=require` divergence | Pretend dev ≡ prod | Honest about the one connection-string difference; same code handles both. |
| 20 | Wiki updates via standard post-close hook | Inline wiki edits during implementation | Consistent with other tickets; wiki-check workflow gates on freshness. |

---

## Appendix A: `.env.development.example` (verbatim)

```
# Data layer (docker-compose)
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun
REDIS_REALTIME_URL=redis://localhost:6379
REDIS_BATCH_URL=redis://localhost:6380

# External services — replace sentinels with real keys before exercising the
# corresponding integrations. Sentinels are obviously-fake to avoid GitHub
# secret-scanning false positives if this file is accidentally edited.
ANTHROPIC_API_KEY=REPLACE_ME_dev_only
STRIPE_SECRET_KEY=REPLACE_ME_dev_only
STRIPE_WEBHOOK_SECRET=REPLACE_ME_dev_only

# Auth mode: bypass (dev) | real (staging/prod)
AUTH_MODE=bypass

# Server
PORT=3000

# Boot-gate retry tuning. Defaults shown. Production overrides via ECS task
# definition (~30s budget) so RDS failover does not crash-loop the task.
BOOT_GATE_MAX_ATTEMPTS=5
BOOT_GATE_BACKOFF_MS=200,500,1000,2000
```

## Appendix B: `docker-compose.yml` (verbatim)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "127.0.0.1:5432:5432"
    environment:
      POSTGRES_USER: mythrun
      POSTGRES_PASSWORD: mythrun_dev
      POSTGRES_DB: mythrun
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mythrun -d mythrun -h 127.0.0.1"]
      interval: 2s
      timeout: 2s
      retries: 10
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  redis-realtime:
    image: redis:7.2-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    ports:
      - "127.0.0.1:6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 10
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  redis-batch:
    image: redis:7.2-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    ports:
      - "127.0.0.1:6380:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 10
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  pgdata:
```
