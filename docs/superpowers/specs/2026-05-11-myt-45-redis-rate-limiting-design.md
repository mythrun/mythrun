# MYT-45 — Redis-backed rate limiting (design)

> **Status:** brainstorm complete; awaiting user review before writing-plans.
> **Linear:** MYT-45
> **Estimate per Linear:** ~0.5 working day.

## 1. Problem

`@fastify/rate-limit` is already wired into Mythrun at `backend/src/app.ts:123-127` and 18 routes already opt in via `config.rateLimit: { max, timeWindow }` declarations (users, invites, billing, webhook, sessions). The plugin's store is the default in-memory `LocalStore`, which counts per-task. With N ECS tasks behind the ALB, a "10/min/IP" route effectively becomes "10·N/min/IP" fleet-wide. Acceptable at staging's 1-task baseline; unacceptable for production.

This ticket swaps the store to Redis. Per-route `config.rateLimit` declarations stay identical — the registered `max` and `timeWindow` values become accurate fleet-wide instead of per-task. Plus one route-level opt-in to per-sub key derivation and a pair of tests proving cross-worker enforcement.

## 2. Decisions

Locked in during brainstorming (three AskUserQuestion rounds):

| # | Decision | Why |
|---|---|---|
| D1 | Back the limiter with `deps.redisRealtime` | Rate-limit decisions are on the hot request path. realtime is the latency-sensitive client; the future WS session-state cache also lives there. ~1 ms per request. |
| D2 | Per-IP default + per-sub opt-in via per-route `keyGenerator` | One counter per route. `POST /api/users/register` overrides to `req.user.sub` — the spec's named example, where the threat is one user trying many candidate usernames from one IP. Other 17 routes keep the default per-IP key. |
| D3 | Cross-worker test boots two `buildApp()` instances against same Redis | Spec wording: "asserts the Redis store is the source of truth, not in-memory." Two-instance integration matches the wording literally; mirrors the existing concurrency-test pattern (e.g., credits repo's separate-pool tests). |

## 3. Architecture

The plugin registration in `app.ts` gets two new fields (`redis`, `nameSpace`). No signature change on `AppDeps`; both fields are already exposed via `redisRealtime` and `redisKeyPrefix`. No new env vars, no new TF, no new IAM, no new package — `@fastify/rate-limit@10.3.0` already supports `redis` natively.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Fastify request                                                     │
│   │                                                                 │
│   ▼                                                                 │
│ @fastify/rate-limit pre-handler                                     │
│   ├─ keyGenerator(req) → string                                     │
│   │    default: request.ip   (trustProxy=1 already strips ALB hop)  │
│   │    override (register):  req.user.sub                           │
│   │                                                                 │
│   ├─ INCR  `staging:use1:rl:<routeId>:<key>`                        │
│   ├─ EXPIRE the same key (timeWindow seconds, first-INCR only)      │
│   │                                                                 │
│   ├─ count > max → 429 + Retry-After header                         │
│   └─ count ≤ max → next handler                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Two Redis ops per request (INCR + conditional EXPIRE), both pipelined under the hood by `@fastify/rate-limit`. Round-trip cost against ElastiCache: ~1 ms on cache hit (most rate-limit reads), ~2 ms on cold key (with EXPIRE).

## 4. Components

### 4.1 Plugin registration — `backend/src/app.ts`

Current code at lines 119-127:

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

Becomes:

```ts
// Rate-limit plugin — global=false so individual routes opt in via
// config.rateLimit. The 1000/min ceiling is a safety net only; per-route
// limits set tighter caps (e.g. /api/users/register = 5/min).
//
// Backed by redisRealtime so the limit applies across the ECS fleet,
// not per-task. Default key is request.ip (trustProxy=1 strips the
// ALB hop, so this is the real client). Routes that need per-sub
// limiting override via config.rateLimit.keyGenerator.
//
// On Redis failure the plugin fails OPEN (logs + lets the request
// through). Trade-off: rate-limit unavailability shouldn't take the
// service down; a transient Redis blip during deploy/failover
// shouldn't 503 the whole API.
await app.register(rateLimit, {
  global: false,
  max: 1000,
  timeWindow: '1 minute',
  redis: deps.redisRealtime,
  nameSpace: `${deps.redisKeyPrefix}rl:`,
})
```

`nameSpace` prefix shape: `staging:use1:rl:` for staging, `production:use1:rl:` for prod. The plugin appends its own route discriminator + the keyGenerator value, producing keys like `staging:use1:rl:/api/users/check-username/:candidate:198.51.100.42`. Sub-namespace isolation prevents collision with WS session-state keys (future tenant of the same `redisKeyPrefix`).

### 4.2 Per-route opt-in — `backend/src/routes/users.ts`

Existing config at line 73 (the only route that needs per-sub limiting in this ticket):

```ts
{
  config: {
    rateLimit: { max: 5, timeWindow: '1 minute' },
    ...,
  },
}
```

Becomes:

```ts
{
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest): string => req.user?.sub ?? req.ip,
      // ↑ fallback to req.ip closes a hypothetical
      //   "rate-limit fires before requireOnboarded attaches req.user"
      //   regression. requireOnboarded runs before the rate-limit
      //   pre-handler on this route today (because rate-limit is
      //   registered AFTER requireOnboarded — see app.ts), so the ??
      //   branch is defensive, not load-bearing. Keep it.
    },
    ...,
  },
}
```

Strict TS note: `req.user` is typed via the Fastify type extension installed by the JWT plugin; the optional-chain `?.sub` correctly types the result as `string | undefined`, and `?? req.ip` narrows to `string` for the plugin's `keyGenerator: (req) => string` contract.

No other route in this ticket gets a `keyGenerator` override. The 17 other rate-limited routes continue to use the default per-IP key — same axis as before MYT-45, just enforced fleet-wide now.

### 4.3 Tests

#### 4.3.1 `backend/src/__tests__/rate-limit-cross-worker.test.ts` (new)

Proves the Redis store is the source of truth. Spec wording: "per-IP limit enforced across two simulated workers."

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../app.js'
import { createRedisClient } from '../redis/client.js'
import type { FastifyInstance } from 'fastify'

describe('rate-limit cross-worker enforcement', () => {
  let appA: FastifyInstance
  let appB: FastifyInstance
  // Both apps share the same Redis URL (the dev redis container);
  // each gets its own ioredis connection (mirrors prod, where each
  // ECS task has its own connection but they hit the same cluster).

  beforeAll(async () => {
    // ... boot two apps with createRedisClient(env.redisRealtimeUrl) each.
    //     Use a unique nameSpace per test run (e.g., include uuidv7()) so
    //     re-runs don't carry over counters from a previous run.
  })

  afterAll(async () => { await Promise.all([appA.close(), appB.close()]) })

  it('hitting limit on appA produces 429 on appB for the same IP', async () => {
    // Pick a tight per-route override for this test: max=3, timeWindow='1 minute'
    // The actual production /api/users/check-username/:candidate is max=10;
    // testing with max=3 avoids running 10+ requests per test.

    // Send 3 successful requests at appA, all with x-forwarded-for=198.51.100.7
    for (let i = 0; i < 3; i++) {
      const res = await appA.inject({
        method: 'GET',
        url: '/api/users/check-username/foo',
        headers: { 'x-forwarded-for': '198.51.100.7' },
      })
      expect(res.statusCode).toBe(200)
    }

    // The 4th request at appB (NOT appA) for the SAME IP should be 429.
    // If the store is in-memory, appB has count=0 for this IP and returns 200.
    // If the store is Redis-backed, appB sees count=3 and returns 429.
    const res = await appB.inject({
      method: 'GET',
      url: '/api/users/check-username/foo',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.headers).toHaveProperty('retry-after')
  })
})
```

Test-instance configuration:

- `BOOT_GATE_ENABLED=0` in this test so we don't have to mock the full DB/Redis probe chain. The rate-limit plugin doesn't depend on the boot gate.
- Both apps need a real ioredis connection. The dev compose has Redis on `localhost:6379`. Test setup-env.ts already provides defaults for `REDIS_REALTIME_URL`.
- The route used for the test (`/api/users/check-username/:candidate`) exists today and is rate-limited at `max=10`. For test scoping we'll either override `max=3` for the test, OR send 11 requests and pin the assertion to req #11.

#### 4.3.2 `backend/src/__tests__/rate-limit-per-sub.test.ts` (new)

Proves the per-sub override on the register endpoint works.

```ts
describe('rate-limit per-sub key derivation', () => {
  // Mock the JWT plugin to inject a controlled req.user.sub for each request.
  // Same pattern as the existing access-control tests at
  // backend/src/auth/__tests__/access-control.test.ts.

  it('separate subs from same IP get separate counters', async () => {
    // 5 successful registers as sub-A, 1 successful as sub-B → 6 total
    // (would 429 the 6th if keyed on IP); assert sub-B's request is 200.
  })

  it('exhausted sub gets 429 even from a fresh IP', async () => {
    // 5 successful registers as sub-A from IP-1; 6th register as sub-A from
    // IP-2 returns 429 (sub-A's counter is shared across IPs).
  })
})
```

#### 4.3.3 Existing test impact

The integration test that already covers `/api/users/register`'s rate limit (in `backend/src/__tests__/onboarding-trial.test.ts` if applicable, or its sibling) keeps passing — the rate-limit decorator behavior at max=5 doesn't change; only the store backing it does. Cross-test isolation: each test that triggers the rate limiter must use a unique `keyGenerator` input (unique IP or unique sub) so a stale Redis counter from one test doesn't bleed into the next. The dev Redis is shared across vitest workers; the existing `setup-env.ts` doesn't FLUSHDB between tests. We'll either:

- Use unique IPs per test (`198.51.100.7`, `198.51.100.8`, ...) — cheap, clear.
- Or call `redisRealtime.del(...)` on the relevant keys in `afterEach` — more thorough but more code.

Pick the unique-IPs approach; document in the test file.

## 5. Operational notes

### 5.1 Failure mode if Redis is unreachable

`@fastify/rate-limit` defaults to "continueExceeding: false, skipOnError: true" — on Redis errors during INCR, the plugin logs the failure and ALLOWS the request through. Documented above in the plugin-registration code comment. Trade-off:

- **Pro:** rate-limit infrastructure failure shouldn't take the API down. A transient Redis blip during failover/deploy doesn't cause a 503 storm.
- **Con:** a sustained Redis outage temporarily removes rate-limit protection.

The trade-off direction matches Mythrun's stance elsewhere (the JWT plugin fails closed on signature verification because that's a correctness invariant; the rate limiter is best-effort defense-in-depth, not a correctness invariant).

### 5.2 Redis memory cost

Each rate-limit key TTLs to the route's `timeWindow` (60s for all current routes). At steady-state 100 req/s across 18 routes against a typical-IP pool of ~10K unique sources/min, that's ~10K keys in flight, each ~80 bytes (~800 KB). Negligible against ElastiCache's GB-class sizing.

### 5.3 Eviction policy

ElastiCache cluster uses the AWS default `volatile-lru`. Rate-limit keys all set TTL via the plugin, so they live in the `volatile` pool; they'd only get evicted under hard memory pressure. If memory pressure happens, evicting rate-limit keys is the right preference order (the WS session-state will be the load-bearing tenant once Session Runtime ships).

## 6. Out of scope

- **WebSocket connection rate limits.** WS upgrade routes need a different shape (ticket exchange runs HTTP, then WS upgrade is unrate-limited per Fastify). Tracked in Session Runtime milestone.
- **IP allowlist for ALB health-check internal IPs.** ALB internals don't hit rate-limited routes (`/health` and `/health/ready` aren't in the 18-route set).
- **Per-tier rate limits** (e.g., paid users get higher limits). Not in current product scope; would be a future ticket.
- **Distributed rate-limit telemetry** (e.g., CloudWatch metric for 429 rate). MYT-46 Launch hardening covers global observability; this ticket inherits whatever the existing Fastify logger emits.
- **Rate-limit headers exposing remaining budget** (`X-RateLimit-Remaining`, etc.). `@fastify/rate-limit` exposes these by default; we don't customize.
- **Per-cognito-sub keys on routes other than `/api/users/register`.** All 17 other rate-limited routes stay on per-IP. Adding per-sub to additional routes is a follow-up if abuse vectors emerge.

## 7. Acceptance criteria

- [ ] `app.ts` plugin registration includes `redis: deps.redisRealtime` and `nameSpace: \`${deps.redisKeyPrefix}rl:\``.
- [ ] `POST /api/users/register` has a `keyGenerator` returning `req.user?.sub ?? req.ip`.
- [ ] `backend/src/__tests__/rate-limit-cross-worker.test.ts` exists and passes: two `buildApp()` instances backed by the same Redis enforce the limit across requests injected at either app.
- [ ] `backend/src/__tests__/rate-limit-per-sub.test.ts` exists and passes: per-sub counter on `/api/users/register` is isolated from per-IP, and an exhausted sub returns 429 from any IP.
- [ ] Existing tests pass — the 17 other rate-limited routes still pass their integration tests at the same `max`/`timeWindow` values.
- [ ] `MYT-45 swaps to Redis-backed` TODO comment removed from `app.ts`.
- [ ] CloudWatch logs in staging show `staging:use1:rl:*` keys when traffic hits a rate-limited route (verifiable by exec into the Redis client or by running the app locally against the dev compose).
- [ ] Wiki page documenting the rate-limit plugin updated (see §8 below).

## 8. Wiki touch

`docs/wiki/content/runtime/` may have a page that mentions rate limiting (e.g., the auth/onboarding routes were documented in `auth-billing/onboarding.html`). The wiki-update subagent run at close will add a brief mention of the Redis-backed store + the per-sub override pattern. No new wiki page needed; the rate limit is one concern among many on the existing pages.

## 9. Open questions

None blocking. Items flagged in §6 (additional per-sub routes, per-tier limits, distributed telemetry) are downstream concerns not pre-requisites for this ticket.
