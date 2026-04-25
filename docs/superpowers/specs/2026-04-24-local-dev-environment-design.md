# MYT-29: Local Dev Environment — Design Spec

> **Status:** v3 — incorporates round-1 (Pikachu/Charizard/Mewtwo) and round-2 (Bulbasaur/Squirtle/Snorlax) blind agent-team review fixes. Ready for Miklos final review and writing-plans.
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

1. Fresh clone + `cp backend/.env.development.example backend/.env.development` (sentinel values for `ANTHROPIC_API_KEY` and Stripe keys can stay as `REPLACE_ME_dev_only` since this ticket does not call those services) + `docker compose up -d --wait` + `pnpm --filter @mythrun/backend dev` results in:
   - All three services healthy in `docker compose ps`
   - Backend logs include `✓ Postgres ready`, `✓ Redis (realtime) ready`, `✓ Redis (batch) ready`, then `server listening on :3000`
   - `curl http://localhost:3000/health` returns `{"status":"ok"}` with HTTP 200
2. Stopping docker (`pnpm db:down`) and restarting `pnpm dev` causes the backend to retry the failing service, fail, and exit 1 with a named-service error in the log.
3. Restarting docker (`pnpm db:up`) and `pnpm dev` again succeeds without any state change.
4. Hitting Ctrl-C mid-boot (during the retry loop) closes any partially-created clients and exits cleanly without unhandled-rejection warnings.
5. `pnpm --filter @mythrun/backend test` runs the new unit tests (retry helper + boot-gate integration + env loader + signal handlers) and they pass without any running containers.
6. `pnpm typecheck` and `pnpm lint` pass cleanly.
7. Deploy pipeline (MYT-28) continues to go green — the production container picks up env vars from ECS task definition, not from `.env.development`. The boot gate exercises the same code path against RDS/ElastiCache once Backend Core wires production env vars (this ticket does not yet exercise that path in prod).

## 4. Non-goals

Explicit scope boundaries — work that sounds related but belongs to other tickets:

- **Database schema / migrations.** Backend Core milestone. This ticket proves we can `SELECT 1`; it does not create tables.
- **ORM or query builder selection.** Backend Core. `pg` is a raw client; whatever ORM lands on top of it later will use the same pool.
- **BullMQ / job queue wiring.** Backend Core / multiplayer runtime work. This ticket proves Redis is reachable; it does not enqueue jobs.
- **Readiness endpoint (`/health/ready`) with per-request dep checks.** Tracked separately as bead `myth-nf3`. This ticket keeps `/health` as process-liveness only, checked once at boot via the startup gate.
- **Integration tests against the compose stack.** Backend Core. MYT-29 has unit tests for the retry logic and boot-gate integration only.
- **Wiki updates.** Handled by the standard PostToolUse hook-dispatched subagent after Linear issue close.
- **Production retry-budget tuning.** This ticket hardcodes a dev-appropriate schedule. Production tuning happens in the ticket that first connects ECS to RDS (Backend Core milestone), where the failover scenario is actually reachable.
- **Fastify decorator wiring (`app.decorate`) for pg / redis.** Backend Core's first plugin that consumes a client adds the decoration along with the corresponding `declare module 'fastify'` type augmentation. This ticket only establishes the dependency-injection shape via `buildApp(deps: AppDeps)`.
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
│    ├─ named volume 'pgdata' at                        │
│    │  /var/lib/postgresql/data                        │
│    ├─ POSTGRES_USER=mythrun  (NOT A SECRET, see §7.8) │
│    ├─ POSTGRES_PASSWORD=mythrun_dev                   │
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
│    └─ healthcheck: redis-cli -h 127.0.0.1 ping        │
│                    (start_period 10s)                 │
│                                                       │
│  redis-batch:7.2-alpine                               │
│    bound 127.0.0.1:6380                               │
│    ├─ command: --save "" --appendonly no              │
│    └─ healthcheck: redis-cli -h 127.0.0.1 ping        │
│                                                       │
│  Compose project name: mythrun (pinned)               │
│  All three services:                                  │
│    logging: json-file, max-size 10m, max-file 3       │
│                                                       │
└───────────────────────────────────────────────────────┘
```

The two Redis instances are separate services, not databases-within-one-instance, because production uses separate ElastiCache clusters so a batch workload can never saturate the real-time instance's CPU or connection pool. Mirroring that locally means code that accidentally uses the wrong connection fails in dev instead of staging.

**Why bind to 127.0.0.1 explicitly:** Docker Desktop on macOS publishes ports on `0.0.0.0` by default, exposing services to anyone on the local network. With dev-quality credentials in a Postgres container, a coffee-shop wifi co-tenant could connect. Explicit `127.0.0.1` binding makes the §7.8 trust-boundary argument actually correct (within the threat model of network-adjacent attackers).

**Why force Redis persistence off:** `redis:7.2-alpine` ships with the upstream default `save 3600 1 300 100 60 10000` (RDB snapshots) enabled. Dev expects ephemeral cache semantics — a `docker compose restart` reloading stale snapshots would diverge from prod (where ElastiCache caches are similarly volatile across node-replacement) and confuse debugging.

**Healthcheck caveat:** `redis-cli ping` does not exercise authentication. If `requirepass` is added in a future ticket, the healthcheck silently passes while real clients with wrong credentials fail. Tracked as future-work; comment in compose flags it.

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

  try {
    // Sequential awaits. Three local services starting in parallel with a
    // ~3.7s budget gain nothing from Promise.allSettled + AbortController
    // (and earlier drafts had a real bug where the abort signal never fired
    // because allSettled never rejects). Sequential is simpler and identical
    // for the developer: docker compose --wait already blocked until all
    // three are healthy, so first-attempt success is the common path.
    await waitFor({ label: 'Postgres',         probe: () => pg.query('SELECT 1'),
                    signal: abortController.signal })
    await waitFor({ label: 'Redis (realtime)', probe: () => rTR.ping(),
                    signal: abortController.signal })
    await waitFor({ label: 'Redis (batch)',    probe: () => rTB.ping(),
                    signal: abortController.signal })
  } catch (err) {
    log.error({ err }, '✗ Boot gate failed')
    await closePartials(pg, rTR, rTB)
    // Watchdog: if any client kept the event loop alive past closePartials,
    // force-exit. .unref() so it doesn't block exit when cleanup succeeds.
    setTimeout(() => process.exit(1), 5000).unref()
    process.exitCode = 1
    return
  }
  // Logs: ✓ Postgres ready / ✓ Redis (realtime) ready / ✓ Redis (batch) ready

  app = await buildApp({ pg, redisRealtime: rTR, redisBatch: rTB })
  await app.listen({ port: env.port, host: '0.0.0.0' })

  // createShutdown(app, pg, rTR, rTB) — extends MYT-28's shutdown helper
  // (which currently just handles SIGTERM/SIGINT to call app.close()) to
  // also drain HTTP first, then close pg, then quit redis (in that order;
  // see §7.9 for ordering rationale).
```

**Retry schedule (hardcoded constant in `boot/wait-for.ts`):** `maxAttempts: 5`, backoff between attempts: 200ms, 500ms, 1000ms, 2000ms (4 intervals between 5 attempts). Worst-case wall time per service before giving up: ~3.7s + per-attempt connection overhead. Three services sequentially, all failing, take ≤~12s before exit. The dev never waits this long in normal use because `docker compose up -d --wait` blocks until healthchecks pass; the retry loop only fires during the brief auth-subsystem-warmup window after `pg_isready` reports healthy.

**Why one schedule, no env tunables:** This ticket does not connect to production RDS — that's Backend Core. Adding env-tunable budgets now (`BOOT_GATE_MAX_ATTEMPTS` etc.) is YAGNI; the right schedule for prod failover scenarios will be obvious in the ticket that first reaches that scenario. Hardcoded constant keeps the surface area small.

**Why `AbortSignal` is still in the `waitFor` interface:** It supports the SIGINT-during-boot case (§9.7). When the user hits Ctrl-C while a probe is mid-retry, the signal handler aborts the controller, and the in-flight `waitFor` rejects with `AbortError` — far cleaner than letting the retry loop run to exhaustion before cleanup.

### 5.3 Env-loading strategy

Node's built-in `--env-file=<path>` flag (stable since Node 20.6) populates `process.env` before any module loads. This means:
- No `dotenv` dependency
- No code path change between dev and prod — production simply omits the flag, and ECS task-definition env vars fill the same slots
- `process.env.DATABASE_URL` is the only read interface; test code can inject via env vars without any bootstrap

**Silent-on-missing semantics:** Node's `--env-file` flag is non-fatal if the file doesn't exist (it logs a warning to stderr but does not exit). The failure surfaces via `env.ts` validation — a clear `Missing required env var: DATABASE_URL` thrown before any connection attempt. This is the *intended* UX (loud failure on real misconfig, not on missing flag) but is documented here so future maintainers don't reach for `dotenv` thinking the flag is broken.

**File location:** `.env.development.example` lives at `backend/.env.development.example` (NOT repo root). The `dev` script's `--env-file=.env.development` resolves relative to the backend package's CWD, eliminating the brittle `../` relative path. `docker-compose.yml` stays at repo root because it's a cross-cutting infra concern; the env file belongs with the consumer.

**Dev/prod env divergence (DATABASE_URL TLS):**
- Dev `DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun` — no TLS (local container)
- Prod `DATABASE_URL=postgresql://...?sslmode=require` — TLS-required (RDS sets `rds.force_ssl=1`)

`createPgPool` parses `sslmode` from the URL explicitly and sets `pg`'s `ssl` option. The `pg` library does NOT auto-derive TLS from the URL alone — it requires explicit `ssl: true` (or an `ssl` object) in the Pool config. The same `createPgPool(url)` code path handles both dev and prod; only the URL differs. (Tested in `db/__tests__/postgres.test.ts`.)

The `backend/src/config/env.ts` module reads the expected vars, validates presence, freezes the result, and exports it. Missing-var errors happen before any connection attempt.

### 5.4 `buildApp()` accepts an `AppDeps` interface

MYT-28's `buildApp()` currently takes no arguments. MYT-29 changes it to `buildApp(deps: AppDeps)` where `AppDeps` is defined in `backend/src/app-deps.ts`:

```ts
// backend/src/app-deps.ts
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
export interface AppDeps {
  pg: Pool
  redisRealtime: Redis
  redisBatch: Redis
}
```

```ts
// backend/src/app.ts
export async function buildApp(_deps: AppDeps) {
  const app = fastify({ logger: true })
  app.get('/health', async () => ({ status: 'ok' }))
  return app
}
```

**Why an interface, not inline destructuring:** When Backend Core adds repositories, auth, queues, the dep object grows. An interface edit is cheaper than a signature edit churning every test. Defining the type now (one file, ~10 lines) costs nothing.

**Why `_deps` (intentionally unused) and not `app.decorate(...)` here:** Decoration without a consumer requires Fastify type-augmentation (`declare module 'fastify' { interface FastifyInstance { pg: Pool; ... } }`) to satisfy strict TS. That augmentation is a non-trivial file to add correctly and will get drift-prone if added speculatively. Backend Core's first plugin that reads `app.pg` adds the decoration *and* the augmentation in the same PR — natural unit of work. The `_` prefix signals to lint configs that this destructured arg is intentionally unused this ticket.

The constructor-injection pattern (`buildApp` receives clients as args, doesn't construct them) keeps tests trivially able to swap in fakes without `vi.mock()` gymnastics, and prevents accidental module-level singletons that leak state between test runs. `server.ts` retains the client references for shutdown cleanup.

## 6. File-level design

### New files

| Path | Responsibility |
|---|---|
| `docker-compose.yml` (repo root) | Three services with healthchecks, log caps, named volume for Postgres, explicit 127.0.0.1 binding, Redis persistence disabled, project name pinned. |
| `docker-compose.override.yml.example` (repo root, **committed**) | Template showing how to remap host ports for dev port-collision. Devs copy to `docker-compose.override.yml` (gitignored). |
| `backend/.env.development.example` (committed) | Sentinel `REPLACE_ME_dev_only` placeholders for secrets — see Appendix A. Lives next to the consumer; `dev` script reads it without any `../`. |
| `backend/src/app-deps.ts` | `AppDeps` interface declaration. Imported by `buildApp` and tests. |
| `backend/src/config/env.ts` | Reads and validates `process.env`. Exports a frozen `Env` object. Missing-var throws before any connection attempt. |
| `backend/src/boot/wait-for.ts` | Generic `waitFor({ label, probe, signal })` retry helper. Probe is any `() => Promise<unknown>`. Signal allows mid-boot cancellation (SIGINT/SIGTERM). Hardcoded retry schedule constant. |
| `backend/src/boot/signal-handlers.ts` | `installSignalHandlers(controller)` wires SIGINT/SIGTERM to abort the controller, so mid-boot Ctrl-C cancels in-flight retries cleanly. |
| `backend/src/boot/shutdown.ts` | `createShutdown(app, pg, redisRealtime, redisBatch)` — extends MYT-28's shutdown helper. Drain order: `app.close()` → `pg.end()` → `redis.quit()` (NOT `disconnect()`, which abandons in-flight commands). 10s timeout per stage; force-kill if exceeded. |
| `backend/src/db/postgres.ts` | `createPgPool(url)` returns a `pg.Pool`. Parses `?sslmode=require` from URL and sets `pg`'s `ssl` option explicitly. Thin wrapper. |
| `backend/src/redis/client.ts` | `createRedisClient(url)` returns an `ioredis` Redis instance configured with `lazyConnect: true`, `maxRetriesPerRequest: 1`, `retryStrategy: () => null`, `enableOfflineQueue: false`. Lets `waitFor` own all retry behavior. Thin wrapper. |
| `backend/src/boot/__tests__/wait-for.test.ts` | The big test file: success on first attempt, retry-then-success, exhaustion-throws, AbortSignal cancellation mid-loop, label appears in error message, fake-timer backoff verification. |
| `backend/src/boot/__tests__/signal-handlers.test.ts` | Tests SIGINT/SIGTERM handlers abort the passed controller; idempotent on multiple signals. |
| `backend/src/__tests__/server.test.ts` | Boot-gate integration test. Mocks the three *probes* (not `waitFor` — that's tested separately). Asserts: a probe rejection causes `process.exitCode === 1` after main() returns; `app.listen` was NOT called; the consolidated error log names the failed service; `closePartials` was called. |
| `backend/src/config/__tests__/env.test.ts` | Tests env validation. Required vars present → frozen object. Missing `DATABASE_URL` → throws with exact message. `PORT` numeric coercion; non-numeric throws. |

### Modified files

| Path | Change |
|---|---|
| `backend/src/server.ts` | Replace existing entrypoint with the new boot gate (signal handlers → load env → create clients → sequential `waitFor` → log → buildApp → listen). On retry exhaustion: cleanup, watchdog, exitCode=1, return. |
| `backend/src/app.ts` | `buildApp(_deps: AppDeps)` accepts deps; `_` prefix signals intentional non-use this ticket. `/health` route unchanged. |
| `backend/package.json` | Add deps: `pg`, `@types/pg`, `ioredis`. Update `dev` script: `tsx watch --env-file=.env.development src/server.ts` (no `../`; env file lives at `backend/.env.development`). |
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
- `tsx` passes unknown flags through to Node, so `tsx watch --env-file=…` works without a custom launcher.
- Silent-on-missing-file behavior is documented in §5.3; the env validator (`env.ts`) provides the loud failure on actual misconfig.

### 7.4 Why `docker compose up -d --wait`

The `--wait` flag makes compose block until all services report their healthchecks as passing. Without it, `pnpm dev` races a still-starting Postgres and the retry loop runs 2-3 times before connecting — works, but produces noisy logs on every fresh start. With `--wait`, first-attempt success is the common path.

### 7.5 Why retry even with `--wait`

Postgres's healthcheck (`pg_isready`) only verifies that the postmaster is accepting TCP connections. It does NOT authenticate, run SQL, or check that the database subsystem has finished initialization. There's a ~1-2 second window where `pg_isready` reports healthy but `SELECT 1` returns "the database system is starting up" or fails auth. Retry absorbs this invisibly. The `start_period: 10s` on the healthcheck further reduces false-negatives during cold start.

### 7.6 Why one fixed retry schedule (no env tunables in this ticket)

YAGNI. This ticket does not connect to prod RDS — that's Backend Core. The argument for env-tunable budgets in v2 was "RDS failover takes 60-120s, prod needs longer retries" — a real concern, but one that isn't reachable until ECS actually connects to RDS. Adding the tunable now would require getting prod retry math right *before* having any production data on what failover actually looks like. The right schedule for prod will be obvious when the prod failure mode is exercised; that ticket adds the env knob.

### 7.7 Why pass clients into `buildApp()` via `AppDeps` interface

- Tests can pass fakes without `vi.mock()` hoisting tricks.
- Shutdown cleanup is centralized in `server.ts` (which owns the client lifetimes).
- Prevents accidental module-level singletons that leak state between test runs.
- The interface (vs. inline destructuring) means future deps grow via type edits, not signature edits across every test.
- No `app.decorate` in this ticket — that's Backend Core's first-consumer-plugin to add along with the Fastify type augmentation.

### 7.8 Why hardcode `mythrun_dev` as the Postgres password in compose

The compose file declares `POSTGRES_PASSWORD: mythrun_dev` in plaintext. This is safe within the network-adjacent threat model because:
- The Postgres container is bound explicitly to `127.0.0.1:5432` — unreachable from any other device on the network.
- The database contains fake seeded data, never production data.
- There is no secret rotation or leak concern because the password is not secret.

(Out-of-scope: localhost-CSRF style attacks from other processes on the dev's own machine. Low risk for a dev-only DB; not worth engineering around.)

Production uses Secrets Manager with rotation (see `infra/environments/staging/main.tf` `bootstrap_secrets`). Different trust boundary, different rules. Compose file gets a `# NOT A SECRET — local-only, 127.0.0.1-bound` comment to flag intent for any future secret-scanner / corp-security pass.

### 7.9 Shutdown ordering: app.close → pg.end → redis.quit

Order matters when shutting down a process holding active database state:

1. **`app.close()` first.** Fastify stops accepting new connections, waits for in-flight requests to drain. Without this, `pg.end()` would throw on requests mid-query.
2. **`pg.end()` next.** Closes the connection pool cleanly, including waiting for in-flight queries to complete.
3. **`redis.quit()` last.** Sends Redis `QUIT` command, allowing the server to acknowledge buffer flushes. **Not `disconnect()`** — `disconnect()` rips the socket without acking, abandoning in-flight commands. `quit()` is the graceful shutdown.

10s timeout per stage; if a stage hangs beyond 10s, log the offender and force-exit. Production ECS sends SIGTERM with a 30s grace period (matching task definition's `stopTimeout: 30`); this fits comfortably.

The MYT-28 shutdown helper currently handles SIGTERM/SIGINT to call `app.close()`. MYT-29 extends `createShutdown` to additionally close pg + redis in the documented order.

### 7.10 Why sequential awaits in the boot gate (not Promise.allSettled)

Three local services starting under a `docker compose up -d --wait` umbrella all become healthy at the same moment. After `--wait` returns, the common case is "all three probes succeed first-try, in microseconds." Sequential awaits and parallel awaits produce identical wall time on the success path. On the failure path, sequential exits as soon as the first service fails its retry budget (~3.7s) — same as parallel with proper abort wiring would. The `Promise.allSettled` + `AbortController` pattern in v2 was both more complex AND had a real bug (`allSettled` never rejects, so the abort signal was never triggered as written). Sequential awaits are simpler, correct, and have identical UX.

### 7.11 Why the shared `boot/wait-for.ts` helper

A unified `waitFor({ label, probe, signal })` shared by Postgres, Redis, and any future S3/SES/etc. boot gates prevents the retry pattern from drifting between services as the codebase grows. Thin wrappers in `db/postgres.ts` and `redis/client.ts` bind the probe; the retry/backoff/abort/error-formatting logic lives once in `wait-for.ts`. The wrappers themselves are 5-10 lines each — they're a fine seam for tests to mock, but don't deserve dedicated test files (their behavior is exercised via `waitFor` tests + the boot-gate integration test).

### 7.12 Why `redis/` not `cache/`

The directory name should match what the modules actually do. Mythrun has two Redis instances doing pub/sub, session state, and (later) BullMQ queues. Calling that directory `cache/` will mislead grep-based exploration once BullMQ lands. `redis/` is semantic-neutral and mirrors `db/`. The file inside is `client.ts` (not `redis.ts`) to avoid stuttering paths.

### 7.13 Why Redis persistence forced off via `command:`

`redis:7.2-alpine` ships with `save 3600 1 300 100 60 10000` (RDB snapshotting) enabled by default. Dev expects ephemeral cache semantics, and a `docker compose restart` reloading stale RDB would break the "fresh state" mental model that prod (where ElastiCache node replacement is similarly volatile) maintains. `command: ["redis-server", "--save", "", "--appendonly", "no"]` makes Redis behavior in dev match Redis behavior in prod for our use case.

## 8. Test strategy

### 8.1 Unit tests (committed in this ticket)

Five test files using Vitest and mock probes:

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
  - Mocks the three *probes* (e.g., a mock `pg.query` that rejects, mock `redis.ping` that resolves).
  - Asserts: a probe rejection causes `process.exitCode === 1` after main() returns.
  - Asserts: `app.listen` was NOT called.
  - Asserts: the consolidated error log names the failed service.
  - Asserts: `closePartials` was called.

- `backend/src/config/__tests__/env.test.ts`:
  - All required vars present → returns frozen object.
  - Missing `DATABASE_URL` → throws "Missing required env var: DATABASE_URL".
  - `PORT` coerces from string to number; non-numeric throws.
  - Attempts to mutate the returned object throw in strict mode.

(`createPgPool` and `createRedisClient` are thin wrappers over library constructors; their behavior is exercised via the integration test and `waitFor` tests. No dedicated unit test files for them.)

Tests use `vi.useFakeTimers()` to advance through backoff intervals without real waiting. No Docker required for CI.

### 8.2 Manual verification (documented in Done-when §3)

Five-minute smoke check covering the golden path, the negative path (docker down), the recovery path (docker back up), and the abort path (Ctrl-C mid-retry). Not automated because the Backend Core milestone will introduce proper integration tests against a Postgres test container managed by Vitest's globalSetup.

### 8.3 Production CI (no change)

The MYT-28 deploy workflow runs `pnpm test` which now includes the new unit tests. No new CI dependencies (no Docker-in-Docker, no test containers). Production container continues to hit RDS/ElastiCache URLs from its ECS task-definition env vars (when Backend Core wires them); the boot gate exercises the exact same code path remotely.

## 9. Risks

### 9.1 Port 5432 / 6379 / 6380 collisions on the dev machine

If the developer already runs another project on one of these ports (or has Homebrew's `postgresql` service running), `docker compose up` fails with `address already in use`. Mitigation: ship `docker-compose.override.yml.example` (committed, copy to gitignored `docker-compose.override.yml`) showing the host-port-remap pattern. Common Homebrew Postgres collision is the most likely first encounter; a working override template makes the fix a 30-second copy.

### 9.2 First-clone experience on a cold Docker Desktop

Pulling `postgres:16-alpine` + `redis:7.2-alpine` takes ~30-60 seconds on first run. `docker compose up -d --wait` will sit silently during the pull phase. Mitigation: the `--wait` flag shows per-service pull progress in newer Docker versions, and 30-60s is an acceptable one-time cost.

### 9.3 Stale `.env.development` after future env-var additions

If Backend Core adds a new required env var and the developer hasn't re-diffed against `.env.development.example`, they'll hit the "Missing required env var" throw. This is the *intended* behavior — better than silent misconfiguration — but worth noting so developers know to diff the example file when pulling changes. Mitigation: eventually, a `pnpm env:check` script or a pre-commit hook; out of scope now.

### 9.4 Named volume `pgdata` accumulates across the project's lifetime

`docker compose down` preserves the volume (intentional — tables survive restarts). Over months, the volume may grow large if schema + fixtures bloat. Mitigation: `pnpm db:reset` removes the volume. Standard dev hygiene, not worth engineering around.

### 9.5 Production boot-gate failure mode (out of scope this ticket)

This ticket does not connect to prod RDS. When Backend Core (or a future ticket) does, the hardcoded ~3.7s dev retry schedule will be insufficient for an RDS Multi-AZ failover (60-120s typical). That ticket introduces env-tunable retry budget AND the prod-tuned values, exercised against the actual failover scenario. The current dev-only schedule is fine for this ticket's scope; the ticket that wires prod is the one that owns the prod-tuning correctness.

### 9.6 `.env.development` not created (silent flag, loud env validator)

`--env-file` flag is non-fatal on missing file. The first signal of a missing `.env.development` is the `env.ts` "Missing required env var: DATABASE_URL" throw. Documented in §5.3. Future maintainers may attempt to "fix" this by re-adding `dotenv`; the mitigation is the §7.3 commentary explaining the design choice.

### 9.7 Mid-boot Ctrl-C resource leak

Hitting Ctrl-C while the retry loop is still running used to (in early drafts) leave open `pg.Pool` sockets and `ioredis` connection retries running. v3 fixes this with `installSignalHandlers` BEFORE client creation, the AbortController plumbed into `waitFor`, the `closePartials()` cleanup path, and a 5-second `setTimeout(...).unref()` watchdog that force-exits if any client kept the event loop alive past cleanup. Done-when §3.4 verifies this manually.

### 9.8 Production secret leak via committed `.env.development`

A dev who pastes their real `ANTHROPIC_API_KEY` into `.env.development.example` (instead of `.env.development`) and commits would push an Anthropic key to GitHub. Mitigation: example file uses sentinel `REPLACE_ME_dev_only` (loudly fake; does not match `sk-ant-` prefix that triggers GitHub secret-scanning). The `.env*` gitignore + `!.env.development.example` negation ensures other env files never get tracked. A pre-commit secret scan (gitleaks etc.) is the proper belt-and-suspenders; tracked as a follow-up bead.

## 10. Open questions

None. All design decisions locked in via Miklos approval (rounds 1, 2, and 3) and consolidated agent-team review feedback.

## 11. Decisions log

| # | Decision | Alternatives considered | Why this one |
|---|---|---|---|
| 1 | Scope = containers + connection proof (option 2 of 3) | Option 1 (containers only, no backend change); Option 3 (also fold /live + /ready split) | Proves the plumbing works end-to-end without absorbing myth-nf3's scope or the Backend Core schema work. |
| 2 | Retry with backoff on connection failure | Fail-fast; log-warn-keep-running | Matches ECS health-check-grace-period pattern; plays nicely with the spec's literal `docker compose up -d && pnpm dev` command. |
| 3 | `/health` stays liveness-only; myth-nf3 handles the /live + /ready split later | Fold dep-checks into /health now; do the split in this ticket | Respects bead boundary; the k8s liveness-vs-readiness distinction is worth having as two endpoints. |
| 4 | `pg` + `ioredis` as clients, with explicit ioredis disable-auto-retry config | `postgres.js` + `node-redis`; default ioredis config | Canonical, universally used underneath every Node ORM, compatible with BullMQ. Disabling auto-retry prevents fight with our own waitFor. |
| 5 | Boot gate in `server.ts`, not `app.ts` | Inline in buildApp | Preserves MYT-28's process-vs-HTTP split. |
| 6 | `--env-file` flag, no dotenv | dotenv; fastify-env plugin | Zero deps, Node-native, no dev-only code path. |
| 7 | `buildApp(deps: AppDeps)` accepts the dep interface; no `app.decorate` in this ticket | Module-level singletons; decorate now with type augmentation | Testable; centralized shutdown; no hidden globals. Decoration + augmentation lands with the first consuming plugin in Backend Core. |
| 8 | `docker compose up -d --wait` | `docker compose up -d` | Blocks until healthchecks pass; quieter first-run logs. |
| 9 | Sequential `await waitFor(...)` in boot gate | `Promise.all` / `Promise.allSettled` + AbortController | Identical UX, simpler code, fixes a real bug in v2's allSettled+AbortController pattern (allSettled never rejects, so abort never fires). |
| 10 | Single `boot/wait-for.ts` helper used by both pg and redis (and future deps) | One helper per service | DRY; prevents pattern drift; one test file to maintain. |
| 11 | `backend/src/redis/client.ts` (not `cache/redis.ts` or `redis/redis.ts`) | `cache/`; stuttering `redis/redis.ts` | Redis instances do pub/sub + queues + caching; `cache/` is misleading. `client.ts` avoids path stutter. |
| 12 | Bind compose ports to `127.0.0.1` explicitly | Default `"5432:5432"` (binds to 0.0.0.0 on Docker Desktop / macOS) | Coffee-shop wifi co-tenants would otherwise reach dev Postgres; makes the trust-boundary argument actually correct. |
| 13 | Hardcoded retry schedule constant; no env tunables this ticket | Env-tunable budget (BOOT_GATE_*) | YAGNI — this ticket doesn't connect to prod RDS; right schedule for failover scenarios will be obvious in the ticket that exercises them. |
| 14 | Force Redis persistence off via `command:` flag | Rely on image defaults | `redis:7.2-alpine` defaults RDB ON; we want ephemeral cache semantics matching prod ElastiCache behavior. |
| 15 | Sentinel `REPLACE_ME_dev_only` for example-file API keys | Pattern-matching placeholders like `sk-ant-xxx` | Avoids GitHub secret-scanning false-positive on accidental commits. |
| 16 | `.env*` glob with `!.env.development.example` negation | Explicit list of env-file names | Future-proofs against `.env.production` etc. accidentally committed. |
| 17 | Shutdown order: `app.close()` → `pg.end()` → `redis.quit()` | Reverse order; concurrent shutdown | Drain HTTP first or `pg.end()` throws on mid-flight queries. `redis.quit()` not `disconnect()` so in-flight commands flush. |
| 18 | Log driver `json-file` with 10m × 3 caps on all services | Default unbounded | A bad retry loop in the backend won't fill Docker Desktop's log dir. |
| 19 | Document prod `?sslmode=require` divergence; explicit `ssl` parsing in `createPgPool` | Pretend dev ≡ prod; rely on `pg` URL auto-derive | `pg` does NOT auto-derive TLS from URL alone. Explicit parse keeps both paths honest. |
| 20 | `.env.development.example` lives at `backend/`, not repo root | Repo root with `--env-file=../` | Removes brittle `../` relative path; env file lives with consumer. |
| 21 | `AppDeps` interface declared in `app-deps.ts` | Inline destructuring | Future deps grow via type edits, not signature churn. |
| 22 | Watchdog `setTimeout(...).unref()` after `closePartials` | Trust `closePartials` to release everything | Belt-and-suspenders against client implementations that keep event loop alive past nominal cleanup. |
| 23 | Wiki updates via standard post-close hook | Inline wiki edits during implementation | Consistent with other tickets; wiki-check workflow gates on freshness. |

---

## Appendix A: `backend/.env.development.example` (verbatim)

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
```

## Appendix B: `docker-compose.yml` (verbatim)

```yaml
# NOT A SECRET: POSTGRES_PASSWORD below is local-only, 127.0.0.1-bound,
# fake-data only. See spec §7.8.
name: mythrun

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

  # Note: redis-cli ping does NOT exercise auth. If requirepass is added
  # later, healthchecks pass while real clients with wrong creds fail.
  redis-realtime:
    image: redis:7.2-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    ports:
      - "127.0.0.1:6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "-h", "127.0.0.1", "ping"]
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
      test: ["CMD", "redis-cli", "-h", "127.0.0.1", "ping"]
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

## Appendix C: `docker-compose.override.yml.example` (verbatim, **committed**)

```yaml
# Copy to docker-compose.override.yml (gitignored) and edit if you need to
# remap host ports — e.g., when Homebrew Postgres on 5432 conflicts with the
# project's compose stack.
#
# Compose merges override.yml on top of compose.yml automatically.

services:
  postgres:
    ports:
      - "127.0.0.1:15432:5432"   # change host-side; container side stays 5432
  redis-realtime:
    ports:
      - "127.0.0.1:16379:6379"
  redis-batch:
    ports:
      - "127.0.0.1:16380:6379"
```
