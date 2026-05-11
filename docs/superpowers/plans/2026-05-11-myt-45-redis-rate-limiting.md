# MYT-45 Redis-Backed Rate Limiting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap `@fastify/rate-limit`'s in-memory store for a Redis-backed shared store so rate limits enforce across the ECS fleet instead of per-task.

**Architecture:** One plugin-registration change in `app.ts` adds `redis: deps.redisRealtime` + a `nameSpace` sub-namespace to the existing `@fastify/rate-limit` config. The 18 routes that already opt in via `config.rateLimit: { max, timeWindow }` keep working unchanged; only the store under them moves. One route (`POST /api/users/register`) gets a `keyGenerator` override to key per `req.user.sub` (the spec's named example — defends against one user trying many candidate usernames behind one IP). Two new integration tests prove cross-worker enforcement and per-sub isolation.

**Tech Stack:** TypeScript, Fastify v5, `@fastify/rate-limit@10.3.0` (already installed), `ioredis` (existing `deps.redisRealtime`), Vitest.

---

## File Structure

**Modified:**
- `backend/src/app.ts` — plugin-registration call gets `redis` + `nameSpace` fields; TODO comment removed
- `backend/src/routes/users.ts` — register endpoint's `config.rateLimit` gets a `keyGenerator` field

**New:**
- `backend/src/__tests__/rate-limit-cross-worker.test.ts` — two `buildApp()` instances against same dev Redis; per-IP limit enforced across both
- `backend/src/__tests__/rate-limit-per-sub.test.ts` — single instance; per-sub key derivation verified by exhausting limit from one IP, then hitting the same sub from a fresh IP

**Touched at close:**
- `docs/wiki/content/auth-billing/onboarding.html` (or wherever rate limiting is currently mentioned in the wiki) — brief mention of Redis-backed store + per-sub register override

---

## Task 1: Cross-worker test + Redis-backed plugin

**Files:**
- Create: `backend/src/__tests__/rate-limit-cross-worker.test.ts`
- Modify: `backend/src/app.ts:119-127`

- [ ] **Step 1: Write the failing cross-worker test**

Path: `backend/src/__tests__/rate-limit-cross-worker.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { buildApp } from '../app.js'
import { createPgPool } from '../db/postgres.js'
import { createRedisClient } from '../redis/client.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import { createRepo } from '../repo/index.js'
import type { AppDeps } from '../app-deps.js'
import { makeStubEnv } from './_helpers/stub-env.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => undefined }
  return pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
}

describe('rate-limit cross-worker enforcement', () => {
  let pool: Pool
  let redisA: Redis
  let redisB: Redis
  let appA: Awaited<ReturnType<typeof buildApp>>
  let appB: Awaited<ReturnType<typeof buildApp>>

  // Unique per-file IP base. fileParallelism=false in vitest.config.ts so
  // sequential file execution avoids cross-file IP collisions; the
  // increment-per-test keeps within-file tests isolated.
  const IP_BASE = '198.51.100.'
  let ipCounter = 50

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })

    // Real ioredis clients against the dev Redis. The plugin's INCR/EXPIRE
    // operations must hit a real server to prove cross-worker semantics.
    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redisA = createRedisClient(redisUrl)
    redisB = createRedisClient(redisUrl)
    await redisA.connect()
    await redisB.connect()

    const repo = createRepo(pool)

    // Use a unique nameSpace per test-file run so re-runs don't carry
    // counters from a prior run. The redisKeyPrefix is consumed as
    // `${prefix}rl:` by the plugin (see app.ts).
    const uniquePrefix = `test:rl-cross-${Date.now()}:`

    const depsA: AppDeps = {
      pg: pool,
      redisRealtime: redisA,
      redisBatch: { ping: () => Promise.resolve('PONG'), quit: () => Promise.resolve('OK') } as unknown as Redis,
      redisKeyPrefix: uniquePrefix,
      repo,
    }
    const depsB: AppDeps = { ...depsA, redisRealtime: redisB }

    appA = await buildApp(depsA, { mode: 'bypass' }, {
      frontendBaseUrl: 'http://localhost:5173',
      env: makeStubEnv({ frontendBaseUrl: 'http://localhost:5173' }),
    })
    appB = await buildApp(depsB, { mode: 'bypass' }, {
      frontendBaseUrl: 'http://localhost:5173',
      env: makeStubEnv({ frontendBaseUrl: 'http://localhost:5173' }),
    })
  })

  afterAll(async () => {
    await appA?.close()
    await appB?.close()
    await redisA?.quit()
    await redisB?.quit()
    await pool?.end()
  })

  beforeEach(() => {
    ipCounter += 1
  })

  it('hitting per-IP limit on appA produces 429 on appB for the same IP', async () => {
    const ip = `${IP_BASE}${ipCounter}`
    // /api/users/check-username has max: 10/min, per-IP (default keyGenerator).
    // Send 10 successful GETs at appA from this IP.
    for (let i = 0; i < 10; i++) {
      const res = await appA.inject({
        method: 'GET',
        url: '/api/users/check-username?username=foo',
        headers: { 'x-forwarded-for': ip },
      })
      expect(res.statusCode).toBe(200)
    }

    // The 11th request at appB for the same IP must be 429 — proves the
    // Redis store is shared between the two app instances. With the
    // in-memory store, appB has count=0 for this IP and would return 200.
    const res = await appB.inject({
      method: 'GET',
      url: '/api/users/check-username?username=foo',
      headers: { 'x-forwarded-for': ip },
    })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
```

- [ ] **Step 2: Verify the test boilerplate `_helpers/stub-env.ts` exists**

Run: `ls backend/src/__tests__/_helpers/stub-env.ts`

If absent, the existing test files import it elsewhere — grep to find:

```bash
grep -rn "makeStubEnv\|stub-env" backend/src/__tests__/ | head -3
```

Use whatever import path / function name the existing tests use. The point of this step is to match the existing test bootstrap pattern (see `backend/src/__tests__/invite-flow.test.ts:140-160`) rather than reinvent it.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter backend exec vitest run src/__tests__/rate-limit-cross-worker.test.ts --reporter=dot`

Expected: FAIL on the assertion `expect(res.statusCode).toBe(429)` — appB returns 200 because the in-memory store on each app instance is independent.

- [ ] **Step 4: Wire the Redis-backed store in app.ts**

Modify `backend/src/app.ts`, current lines 119-127:

```ts
  // Rate-limit plugin — global=false so individual routes opt in via
  // config.rateLimit. The 1000/min ceiling is a safety net only; per-route
  // limits set tighter caps (e.g. /api/users/register = 5/min). Default
  // in-memory store; MYT-45 swaps to Redis-backed.
  await app.register(rateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
  })
```

Replace with:

```ts
  // Rate-limit plugin — global=false so individual routes opt in via
  // config.rateLimit. The 1000/min ceiling is a safety net only; per-route
  // limits set tighter caps (e.g. /api/users/register = 5/min).
  //
  // Backed by redisRealtime so the limit applies across the ECS fleet,
  // not per-task. Default keyGenerator returns request.ip (the real
  // client because trustProxy: 1 strips the ALB hop). Routes that need
  // per-sub limiting override via config.rateLimit.keyGenerator.
  //
  // Fails OPEN if Redis is unreachable: @fastify/rate-limit's default
  // skipOnError logs the error and allows the request through. Trade-off
  // accepted — rate-limit infra failure should not 503 the service.
  await app.register(rateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
    redis: deps.redisRealtime,
    nameSpace: `${deps.redisKeyPrefix}rl:`,
  })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter backend exec vitest run src/__tests__/rate-limit-cross-worker.test.ts --reporter=dot`

Expected: PASS — appB's 11th request returns 429 with a `Retry-After` header because the Redis store is shared.

If FAIL with `ECONNREFUSED` against Redis: start the dev stack with `pnpm db:up` (which brings up Redis too) and re-run.

- [ ] **Step 6: Run lint + typecheck**

```bash
pnpm --filter backend lint
pnpm --filter backend typecheck
```

Expected: both clean (0 errors).

- [ ] **Step 7: Commit**

```bash
git add backend/src/__tests__/rate-limit-cross-worker.test.ts backend/src/app.ts
git commit -m "feat(myt-45): Redis-backed @fastify/rate-limit store"
```

---

## Task 2: Per-sub keyGenerator on POST /api/users/register

**Files:**
- Modify: `backend/src/routes/users.ts:68-75`
- Create: `backend/src/__tests__/rate-limit-per-sub.test.ts`

- [ ] **Step 1: Write the failing per-sub test**

Path: `backend/src/__tests__/rate-limit-per-sub.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { buildApp } from '../app.js'
import { createPgPool } from '../db/postgres.js'
import { createRedisClient } from '../redis/client.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import { createRepo } from '../repo/index.js'
import type { AppDeps } from '../app-deps.js'
import { makeStubEnv } from './_helpers/stub-env.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => undefined }
  return pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
}

describe('rate-limit per-sub key derivation (POST /api/users/register)', () => {
  let pool: Pool
  let redis: Redis
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })

    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redis = createRedisClient(redisUrl)
    await redis.connect()

    const repo = createRepo(pool)
    const deps: AppDeps = {
      pg: pool,
      redisRealtime: redis,
      redisBatch: { ping: () => Promise.resolve('PONG'), quit: () => Promise.resolve('OK') } as unknown as Redis,
      redisKeyPrefix: `test:rl-sub-${Date.now()}:`,
      repo,
    }
    app = await buildApp(deps, { mode: 'bypass' }, {
      frontendBaseUrl: 'http://localhost:5173',
      env: makeStubEnv({ frontendBaseUrl: 'http://localhost:5173' }),
    })
  })

  afterAll(async () => {
    await app?.close()
    await redis?.quit()
    await pool?.end()
  })

  it('per-sub limit enforced regardless of source IP', async () => {
    // Under bypass auth every request is the same sub `bypass:dev-1`.
    // The register endpoint's keyGenerator returns req.user.sub, so all
    // requests below count against the same counter regardless of IP.
    //
    // Burn 5 requests from IP-A. We don't care about the 2xx/4xx
    // distribution here — the body parsers / DB row creation may yield
    // 200 / 4xx / 5xx depending on username availability and order;
    // rate-limit fires BEFORE the handler body. Each request still
    // increments the rate-limit counter.

    const IP_A = '198.51.100.180'
    const IP_B = '198.51.100.181'

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-forwarded-for': IP_A, 'content-type': 'application/json' },
        payload: { username: `subtest_${i}`, displayName: `Subtest ${i}` },
      })
      // 200 (first time), 4xx (collision / already-registered) — both fine.
      // The point is rate-limit didn't yet fire (status != 429).
      expect(res.statusCode).not.toBe(429)
    }

    // 6th request from a FRESH IP. Same bypass sub → keyGenerator key
    // matches the prior 5 counter → returns 429. With per-IP keying
    // (pre-fix), IP_B has count=0 and would return some non-429 code.
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/register',
      headers: { 'x-forwarded-for': IP_B, 'content-type': 'application/json' },
      payload: { username: 'subtest_last', displayName: 'Subtest Last' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter backend exec vitest run src/__tests__/rate-limit-per-sub.test.ts --reporter=dot`

Expected: FAIL — the 6th request from IP_B returns a non-429 code (likely 200 or 409 depending on username state) because the limiter currently keys on IP, and IP_B has count=0.

- [ ] **Step 3: Add the keyGenerator override on /api/users/register**

In `backend/src/routes/users.ts`, modify the config block at lines 68-75:

```ts
  app.post(
    '/api/users/register',
    {
      config: {
        auth: 'jwt-no-db',
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
```

Replace with:

```ts
  app.post(
    '/api/users/register',
    {
      config: {
        auth: 'jwt-no-db',
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          // Per-sub keying — defends against one user trying many candidate
          // usernames from one IP. The fallback to req.ip is defensive: the
          // route is `auth: 'jwt-no-db'` so req.user is set by the JWT plugin
          // BEFORE the rate-limit pre-handler runs. The ?? branch only fires
          // if some future call-shape regression strips req.user.
          keyGenerator: (req): string => req.user?.sub ?? req.ip,
        },
      },
    },
```

- [ ] **Step 4: Run the per-sub test to verify it passes**

Run: `pnpm --filter backend exec vitest run src/__tests__/rate-limit-per-sub.test.ts --reporter=dot`

Expected: PASS — 6th request from fresh IP returns 429 with Retry-After.

- [ ] **Step 5: Run lint + typecheck**

```bash
pnpm --filter backend lint
pnpm --filter backend typecheck
```

Expected: both clean. The `keyGenerator: (req): string => ...` form satisfies `@fastify/rate-limit`'s `KeyGeneratorFunction` type without explicit type imports.

If typecheck errors with "req has implicit any" or similar, add the import + annotation:

```ts
import type { FastifyRequest } from 'fastify'
// ...
keyGenerator: (req: FastifyRequest): string => req.user?.sub ?? req.ip,
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/__tests__/rate-limit-per-sub.test.ts backend/src/routes/users.ts
git commit -m "feat(myt-45): per-sub keyGenerator on POST /api/users/register"
```

---

## Task 3: Full-suite verification + wiki sync + push + Linear close

**Files:**
- Optionally modify: `docs/wiki/content/auth-billing/onboarding.html` (brief mention of Redis-backed store + the per-sub register override)
- (No code changes if the wiki page doesn't currently mention rate limiting.)

- [ ] **Step 1: Run the full backend suite**

```bash
pnpm --filter backend exec vitest run --reporter=dot
```

Expected: 0 failures. The 17 other rate-limited routes' tests should pass — same `max`/`timeWindow` values, only the store changed. Cross-test IP collisions are guarded by the existing unique-IP pattern (see `invite-flow.test.ts:113-119`).

If a test fails because its IP collides with a counter left over from an earlier test in the same vitest run, switch the test to a unique IP (incrementing module-scoped counter) — no logic change needed.

- [ ] **Step 2: Check wiki for rate-limit mentions**

```bash
grep -rn "rate-limit\|@fastify/rate-limit\|rateLimit" docs/wiki/content/ | head -10
```

If hits exist, edit the relevant page(s) to add a brief note: "Backed by Redis (the realtime client) so limits apply fleet-wide. `POST /api/users/register` uses a per-sub key so the limit follows the user, not the IP."

If no hits, skip wiki edits — there's nothing to update.

- [ ] **Step 3: Run wiki build + check**

```bash
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm wiki:build
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm wiki:check
```

If drift on pages that declare `backend/src/app.ts` or `backend/src/routes/users.ts` as sources: run `pnpm wiki:accept-drift` to refresh source-hashes; if narrative-level changes are warranted (rare for this ticket), edit then re-run check.

Expected end state: `wiki:check` exits 0.

- [ ] **Step 4: Run format check + lint + typecheck once more**

```bash
pnpm format:check
pnpm --filter backend lint
pnpm --filter backend typecheck
```

Expected: all three exit 0. If format fails on any file you touched, run `pnpm exec prettier --write <file>` and re-check.

- [ ] **Step 5: Commit any wiki updates**

```bash
git status --short
# Stage only intended files — do NOT use git add -A. Wiki commits should be
# wiki-only to avoid retriggering Deploy on a paired backend change.
git add docs/wiki/
git commit -m "docs(wiki): sync for MYT-45 — Redis-backed rate limiting"
```

Skip this step if `wiki:check` was already clean with no edits.

- [ ] **Step 6: Push**

```bash
git push origin main
```

Auto-fires Deploy (the backend changed) + Wiki + Auth Lint. Watch Deploy:

```bash
gh run watch "$(gh run list --workflow=Deploy --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: Deploy green. The boot-gate probe still passes (no schema change). New rate-limit code runs on the next task that boots.

- [ ] **Step 7: Smoke-verify the deployed limiter**

After Deploy is green, optionally hit a rate-limited endpoint and assert the Redis key materializes:

```bash
# Hit /api/users/check-username 11 times from one source against the
# deployed API. Expect the 11th to return 429.
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code} " "https://staging-api.mythrun.com/api/users/check-username?username=foo" \
    -H "Authorization: Bearer $(aws secretsmanager get-secret-value --secret-id mythrun/staging/smoke-test-user --query SecretString --output text | jq -r .access_token)"
done
# Expected output: 200 200 200 200 200 200 200 200 200 200 429
```

This step is optional. If the smoke is awkward (auth token retrieval is operationally heavy), trust the cross-worker test and skip.

- [ ] **Step 8: Flip Linear MYT-45 → Done**

Via the Linear MCP tool:

```ts
mcp__linear-server__save_issue({ id: 'MYT-45', state: 'Done' })
```

Per `feedback_push_and_close.md` the user has standing auth for this after a verified ship.

---

## Self-review notes

**Spec coverage check:**

| Spec section | Plan task |
|---|---|
| §4.1 Plugin registration | T1 Step 4 |
| §4.2 Per-route opt-in (register) | T2 Step 3 |
| §4.3.1 Cross-worker test | T1 Step 1 |
| §4.3.2 Per-sub test | T2 Step 1 |
| §4.3.3 Existing test impact | T3 Step 1 (full suite run) |
| §5 Operational notes (fail-open) | T1 Step 4 (comment in app.ts) |
| §7 Acceptance criteria | T1+T2+T3 collectively |
| §8 Wiki touch | T3 Steps 2–5 |

**Placeholder scan:** none. Every step has concrete code or commands.

**Type consistency:** `keyGenerator: (req) => req.user?.sub ?? req.ip` returns `string` (Fastify v5 types `req.ip` as `string`); fallback chain types cleanly. The `redis` and `nameSpace` fields on `@fastify/rate-limit`'s `RateLimitPluginOptions` are documented at the plugin v10 surface and accept `Redis` (ioredis) and `string` respectively. `AppDeps.redisRealtime` is `Redis` and `AppDeps.redisKeyPrefix` is `string` (see `backend/src/app-deps.ts`).
