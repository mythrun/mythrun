# MYT-29: Local Dev Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `docker compose up -d --wait && pnpm dev` as the single-command local dev loop — Postgres + 2 Redis instances in Docker, backend that retries-then-fails-loudly on connection problems, all unit-tested without containers.

**Architecture:** Three-service docker-compose (Postgres 16 + 2× Redis 7.2) bound to 127.0.0.1 with healthchecks. Backend reads URL strings from `.env.development` via Node's native `--env-file` flag, instantiates `pg.Pool` + 2× `ioredis.Redis` clients, runs a sequential boot gate that probes each with retry-backoff before `app.listen()`. Caller code (now and in Backend Core) sees library-native types (`pg.Pool`, `ioredis.Redis`) — no hand-rolled abstraction layer; env-divergence compresses entirely into URL strings.

**Tech Stack:** Node 24, TypeScript (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), Fastify 5, pnpm workspaces, Vitest, `pg` 8.x, `ioredis` 5.x, Docker Compose v2.

**Spec reference:** `docs/superpowers/specs/2026-04-24-local-dev-environment-design.md` (v3, Miklos-approved 2026-04-24, two rounds of blind agent-team review).

**Linear:** [MYT-29](https://linear.app/mythrun/issue/MYT-29) — Ops Foundation milestone, due 2026-04-27.

---

## File map

### New files

| Path | Purpose |
|---|---|
| `docker-compose.yml` (root) | Three services with healthchecks, log caps, named volume, 127.0.0.1 binding, `name: mythrun` project pin. |
| `docker-compose.override.yml.example` (root, **committed**) | Port-remap template for devs hitting Homebrew Postgres collision. |
| `backend/.env.development.example` | Sentinel `REPLACE_ME_dev_only` placeholders for secrets. |
| `backend/src/app-deps.ts` | `AppDeps` interface — `{ pg: Pool; redisRealtime: Redis; redisBatch: Redis }`. |
| `backend/src/config/env.ts` | Reads + validates `process.env`. Returns frozen `Env` object. |
| `backend/src/config/__tests__/env.test.ts` | Tests for env validation. |
| `backend/src/boot/wait-for.ts` | Generic `waitFor({ label, probe, signal })` retry helper. Hardcoded retry constant. |
| `backend/src/boot/__tests__/wait-for.test.ts` | Comprehensive retry-helper tests (fake timers). |
| `backend/src/boot/signal-handlers.ts` | `installSignalHandlers(controller)` — wires SIGINT/SIGTERM to `controller.abort()`. |
| `backend/src/boot/__tests__/signal-handlers.test.ts` | Signal-handler tests. |
| `backend/src/db/postgres.ts` | `createPgPool(url)` thin wrapper; parses `?sslmode=require` and sets `pg`'s `ssl` option. |
| `backend/src/redis/client.ts` | `createRedisClient(url)` thin wrapper; configures `lazyConnect: true`, etc. |
| `backend/src/__tests__/server.test.ts` | Boot-gate integration test. Mocks probes (not `waitFor`). |

### Modified files

| Path | Change |
|---|---|
| `backend/src/server.ts` | Replace 9-line entrypoint with boot gate (signal handlers → load env → create clients → sequential `waitFor` → buildApp → listen). Export `main()` for testability. |
| `backend/src/app.ts` | `buildApp(_deps: AppDeps)` (signature change; `_` prefix marks deps as intentionally-unused this ticket). Extend `createShutdown` to drain pg + redis after `app.close()`. |
| `backend/src/__tests__/app.test.ts` | Update to pass mock `AppDeps` to `buildApp`. |
| `backend/src/__tests__/shutdown.test.ts` | Add tests for the extended drain order (app → pg → redis). |
| `backend/package.json` | Add `pg`, `@types/pg`, `ioredis` deps. Update `dev` script to `tsx watch --env-file=.env.development src/server.ts`. |
| `package.json` (root) | Add `db:up`, `db:down`, `db:reset` scripts. |
| `.gitignore` | Add `docker-compose.override.yml`. (Existing `.env.*` + `!.env.*.example` pattern already handles env files.) |

---

## Task ordering rationale

Bottom-up TDD: infra files first (no code dependencies), then types + deps, then leaf helpers (env loader, retry helper, signal handlers, factory wrappers — each independently testable), then `app.ts` signature change (existing tests need update), then `server.ts` boot gate (depends on all the leaves).

Tasks are sized for hours-to-half-day each. Numbered T1–T11.

---

## Task T1: Docker Compose stack

**Files:**
- Create: `docker-compose.yml`
- Create: `docker-compose.override.yml.example`

- [ ] **Step 1: Write `docker-compose.yml`**

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

- [ ] **Step 2: Write `docker-compose.override.yml.example`**

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

- [ ] **Step 3: Validate compose syntax**

Run: `docker compose config > /dev/null`
Expected: silent success (no errors).

- [ ] **Step 4: Smoke-test bring-up**

Run: `docker compose up -d --wait`
Expected: three services reach healthy within ~15s. `docker compose ps` shows `(healthy)` for all three.

Then: `docker compose down` (preserves volume).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.override.yml.example
git commit -m "feat(myt-29): docker-compose for local Postgres + 2× Redis

Three-service stack mirroring prod data layer (RDS + 2× ElastiCache).
Bound to 127.0.0.1 only, healthchecks with start_period, log caps,
Redis persistence forced off via command override.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T2: Env-file template + gitignore + root scripts

**Files:**
- Create: `backend/.env.development.example`
- Modify: `.gitignore`
- Modify: `package.json` (root)

- [ ] **Step 1: Write `backend/.env.development.example`**

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

- [ ] **Step 2: Update `.gitignore` — append one line**

Add at the end of `.gitignore`:

```
docker-compose.override.yml
```

(Existing `.env` + `.env.*` + `!.env.*.example` lines already handle env files correctly.)

- [ ] **Step 3: Update root `package.json` scripts**

In root `package.json` `"scripts"` block, add three new lines after the existing `"dev"` line:

```json
    "dev": "pnpm --filter backend dev",
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d --wait",
```

- [ ] **Step 4: Verify the example file is NOT gitignored**

Run: `git check-ignore -v backend/.env.development.example; echo $?`
Expected: exits with `1` (NOT ignored). The `!.env.*.example` negation in `.gitignore` keeps it tracked.

Also: `git check-ignore -v backend/.env.development; echo $?`
Expected: exits with `0` (IS ignored).

- [ ] **Step 5: Commit**

```bash
git add backend/.env.development.example .gitignore package.json
git commit -m "feat(myt-29): env-file template + db:* root scripts

backend/.env.development.example uses sentinel REPLACE_ME_dev_only
placeholders to avoid secret-scanning false positives. Root scripts
db:up/db:down/db:reset wrap docker compose for daily dev loop.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T3: Install client deps + AppDeps interface

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/app-deps.ts`

- [ ] **Step 1: Add deps to `backend/package.json`**

Inside `backend/package.json`, add to `"dependencies"`:

```json
    "fastify": "^5.1.0",
    "ioredis": "^5.4.0",
    "pg": "^8.13.0"
```

And to `"devDependencies"` (alongside existing `@types/node` etc.):

```json
    "@types/pg": "^8.11.0"
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: lockfile updates, no errors. `pnpm-lock.yaml` should be modified.

- [ ] **Step 3: Write `backend/src/app-deps.ts`**

```ts
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

export interface AppDeps {
  pg: Pool
  redisRealtime: Redis
  redisBatch: Redis
}
```

- [ ] **Step 4: Verify typecheck still passes**

Run: `pnpm --filter backend typecheck`
Expected: PASS (no errors). The `AppDeps` interface is referenced nowhere yet, but should still typecheck.

- [ ] **Step 5: Commit**

```bash
git add backend/package.json pnpm-lock.yaml backend/src/app-deps.ts
git commit -m "feat(myt-29): add pg + ioredis deps; AppDeps interface

AppDeps lives in its own module so future deps grow via type edits,
not function-signature churn across every test.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T4: Env loader (TDD)

**Files:**
- Create: `backend/src/config/env.ts`
- Create: `backend/src/config/__tests__/env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/config/__tests__/env.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadEnv } from '../env.js'

describe('loadEnv', () => {
  const REQUIRED = {
    DATABASE_URL: 'postgresql://u:p@h:5432/d',
    REDIS_REALTIME_URL: 'redis://h:6379',
    REDIS_BATCH_URL: 'redis://h:6380',
    PORT: '3000',
  }
  const original = { ...process.env }
  beforeEach(() => {
    for (const k of Object.keys(REQUIRED)) delete process.env[k]
  })
  afterEach(() => {
    process.env = { ...original }
  })

  it('returns a frozen Env object when all required vars are present', () => {
    Object.assign(process.env, REQUIRED)
    const env = loadEnv()
    expect(env.databaseUrl).toBe('postgresql://u:p@h:5432/d')
    expect(env.redisRealtimeUrl).toBe('redis://h:6379')
    expect(env.redisBatchUrl).toBe('redis://h:6380')
    expect(env.port).toBe(3000)
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('throws "Missing required env var: DATABASE_URL" when DATABASE_URL is absent', () => {
    Object.assign(process.env, { ...REQUIRED, DATABASE_URL: undefined })
    delete process.env.DATABASE_URL
    expect(() => loadEnv()).toThrow('Missing required env var: DATABASE_URL')
  })

  it('throws when REDIS_REALTIME_URL is absent', () => {
    Object.assign(process.env, REQUIRED)
    delete process.env.REDIS_REALTIME_URL
    expect(() => loadEnv()).toThrow('Missing required env var: REDIS_REALTIME_URL')
  })

  it('throws when REDIS_BATCH_URL is absent', () => {
    Object.assign(process.env, REQUIRED)
    delete process.env.REDIS_BATCH_URL
    expect(() => loadEnv()).toThrow('Missing required env var: REDIS_BATCH_URL')
  })

  it('coerces PORT from string to number', () => {
    Object.assign(process.env, REQUIRED, { PORT: '8080' })
    expect(loadEnv().port).toBe(8080)
  })

  it('throws when PORT is not numeric', () => {
    Object.assign(process.env, REQUIRED, { PORT: 'abc' })
    expect(() => loadEnv()).toThrow(/PORT must be numeric/)
  })

  it('returned object cannot be mutated (strict mode)', () => {
    Object.assign(process.env, REQUIRED)
    const env = loadEnv() as { port: number }
    expect(() => {
      env.port = 9999
    }).toThrow(TypeError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test src/config`
Expected: FAIL — `Cannot find module '../env.js'` or similar.

- [ ] **Step 3: Implement `backend/src/config/env.ts`**

```ts
export interface Env {
  readonly databaseUrl: string
  readonly redisRealtimeUrl: string
  readonly redisBatchUrl: string
  readonly port: number
}

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_REALTIME_URL',
  'REDIS_BATCH_URL',
  'PORT',
] as const

export function loadEnv(): Env {
  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`)
    }
  }
  const portRaw = process.env.PORT ?? ''
  const port = Number(portRaw)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be numeric, got: ${portRaw}`)
  }
  return Object.freeze({
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisRealtimeUrl: process.env.REDIS_REALTIME_URL ?? '',
    redisBatchUrl: process.env.REDIS_BATCH_URL ?? '',
    port,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter backend test src/config`
Expected: PASS — all 7 test cases green.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter backend typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/env.ts backend/src/config/__tests__/env.test.ts
git commit -m "feat(myt-29): env loader with frozen Env object

Validates DATABASE_URL, REDIS_REALTIME_URL, REDIS_BATCH_URL, PORT.
Throws 'Missing required env var: KEY' before any connection attempt.
Object.freeze prevents downstream mutation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T5: `waitFor` retry helper (TDD)

**Files:**
- Create: `backend/src/boot/wait-for.ts`
- Create: `backend/src/boot/__tests__/wait-for.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/boot/__tests__/wait-for.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitFor, RETRY_DELAYS_MS } from '../wait-for.js'

describe('waitFor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves on first-attempt success', async () => {
    const probe = vi.fn().mockResolvedValue('ok')
    const promise = waitFor({ label: 'svc', probe })
    await expect(promise).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('retries on transient failure and resolves when probe eventually succeeds', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockRejectedValueOnce(new Error('still not ready'))
      .mockResolvedValue('ok')
    const promise = waitFor({ label: 'svc', probe })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1])
    await expect(promise).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting all attempts; error names label and includes last cause', async () => {
    const lastError = new Error('final failure')
    const probe = vi.fn().mockRejectedValue(lastError)
    const promise = waitFor({ label: 'mySvc', probe })
    // Total wait: sum of all RETRY_DELAYS_MS
    const totalDelay = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    await vi.advanceTimersByTimeAsync(totalDelay)
    await expect(promise).rejects.toThrow(/mySvc/)
    await expect(promise).rejects.toThrow(/final failure/)
    expect(probe).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1)
  })

  it('respects backoff schedule between attempts', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('nope'))
    const promise = waitFor({ label: 'svc', probe })
    // After 199ms, only the first attempt has fired
    await vi.advanceTimersByTimeAsync(199)
    expect(probe).toHaveBeenCalledTimes(1)
    // After 200ms total, the second attempt fires
    await vi.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledTimes(2)
    // Catch the rejection so the test doesn't fail with unhandled
    await vi.advanceTimersByTimeAsync(100_000)
    await expect(promise).rejects.toThrow()
  })

  it('aborts when AbortSignal fires mid-loop', async () => {
    const controller = new AbortController()
    const probe = vi.fn().mockRejectedValue(new Error('nope'))
    const promise = waitFor({ label: 'svc', probe, signal: controller.signal })
    // First attempt fires, fails, sleeping for backoff
    await vi.advanceTimersByTimeAsync(50)
    expect(probe).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)
    // No further probe attempts after abort
    const calls = probe.mock.calls.length
    await vi.advanceTimersByTimeAsync(100_000)
    expect(probe).toHaveBeenCalledTimes(calls)
  })

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const probe = vi.fn()
    const promise = waitFor({ label: 'svc', probe, signal: controller.signal })
    await expect(promise).rejects.toThrow(/abort/i)
    expect(probe).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test src/boot/__tests__/wait-for`
Expected: FAIL — `Cannot find module '../wait-for.js'`.

- [ ] **Step 3: Implement `backend/src/boot/wait-for.ts`**

```ts
export const RETRY_DELAYS_MS = [200, 500, 1000, 2000] as const

export interface WaitForOptions {
  readonly label: string
  readonly probe: () => Promise<unknown>
  readonly signal?: AbortSignal
}

export async function waitFor(opts: WaitForOptions): Promise<void> {
  const { label, probe, signal } = opts
  if (signal?.aborted) {
    throw new Error(`waitFor(${label}): aborted before first attempt`)
  }
  const totalAttempts = RETRY_DELAYS_MS.length + 1
  let lastError: unknown
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error(`waitFor(${label}): aborted`)
    }
    try {
      await probe()
      return
    } catch (err) {
      lastError = err
      if (attempt === totalAttempts - 1) break
      const delay = RETRY_DELAYS_MS[attempt] ?? 0
      await sleepWithAbort(delay, signal)
    }
  }
  const cause = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`waitFor(${label}): exhausted ${String(totalAttempts)} attempts; last error: ${cause}`)
}

function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('aborted during backoff sleep'))
      }
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('aborted during backoff sleep'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter backend test src/boot/__tests__/wait-for`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Run typecheck + lint**

Run: `pnpm --filter backend typecheck && pnpm --filter backend lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/boot/wait-for.ts backend/src/boot/__tests__/wait-for.test.ts
git commit -m "feat(myt-29): waitFor retry helper with abort support

Generic boot-gate retry over any probe. Hardcoded backoff [200,500,1000,2000]
ms / 5 attempts. AbortSignal cancels mid-loop or pre-empts entirely.
Tested with fake timers; no real waiting in CI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T6: Signal handlers (TDD)

**Files:**
- Create: `backend/src/boot/signal-handlers.ts`
- Create: `backend/src/boot/__tests__/signal-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/boot/__tests__/signal-handlers.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installSignalHandlers } from '../signal-handlers.js'

describe('installSignalHandlers', () => {
  let listeners: Array<{ signal: NodeJS.Signals; fn: NodeJS.SignalsListener }>

  beforeEach(() => {
    listeners = []
    vi.spyOn(process, 'on').mockImplementation(((sig: NodeJS.Signals, fn: NodeJS.SignalsListener) => {
      listeners.push({ signal: sig, fn })
      return process
    }) as unknown as typeof process.on)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls controller.abort when SIGINT fires', () => {
    const controller = new AbortController()
    installSignalHandlers(controller)
    const sigint = listeners.find((l) => l.signal === 'SIGINT')
    expect(sigint).toBeDefined()
    sigint?.fn('SIGINT')
    expect(controller.signal.aborted).toBe(true)
  })

  it('calls controller.abort when SIGTERM fires', () => {
    const controller = new AbortController()
    installSignalHandlers(controller)
    const sigterm = listeners.find((l) => l.signal === 'SIGTERM')
    expect(sigterm).toBeDefined()
    sigterm?.fn('SIGTERM')
    expect(controller.signal.aborted).toBe(true)
  })

  it('is idempotent on multiple signals (does not throw on second abort)', () => {
    const controller = new AbortController()
    installSignalHandlers(controller)
    const sigint = listeners.find((l) => l.signal === 'SIGINT')
    expect(() => {
      sigint?.fn('SIGINT')
      sigint?.fn('SIGINT')
    }).not.toThrow()
    expect(controller.signal.aborted).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test src/boot/__tests__/signal-handlers`
Expected: FAIL — `Cannot find module '../signal-handlers.js'`.

- [ ] **Step 3: Implement `backend/src/boot/signal-handlers.ts`**

```ts
const SIGNALS = ['SIGINT', 'SIGTERM'] as const satisfies readonly NodeJS.Signals[]

export function installSignalHandlers(controller: AbortController): void {
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (!controller.signal.aborted) {
        controller.abort()
      }
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter backend test src/boot/__tests__/signal-handlers`
Expected: PASS — all 3 cases green.

- [ ] **Step 5: Run typecheck + lint**

Run: `pnpm --filter backend typecheck && pnpm --filter backend lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/boot/signal-handlers.ts backend/src/boot/__tests__/signal-handlers.test.ts
git commit -m "feat(myt-29): installSignalHandlers for boot-time abort

Wires SIGINT/SIGTERM to AbortController.abort(). Used by server.ts
to install handlers BEFORE creating any clients, so a Ctrl-C during
the retry loop cancels in-flight probes cleanly.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T7: Postgres pool factory (thin wrapper, no dedicated test)

**Files:**
- Create: `backend/src/db/postgres.ts`

This module is a 15-line wrapper around `new Pool(config)` whose behavior is exercised by the boot-gate integration test in T10. Per spec §8.1 / §7.11, no dedicated unit test (would just assert the constructor literal).

- [ ] **Step 1: Implement `backend/src/db/postgres.ts`**

```ts
import { Pool, type PoolConfig } from 'pg'

export function createPgPool(url: string): Pool {
  // pg does NOT auto-derive TLS from `?sslmode=require` in the URL alone.
  // Parse explicitly and set the `ssl` option so prod (RDS, sslmode=require)
  // and dev (localhost, no TLS) both work from the same call site.
  const sslMode = new URL(url).searchParams.get('sslmode')
  const config: PoolConfig = { connectionString: url }
  if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
    config.ssl = { rejectUnauthorized: sslMode !== 'require' }
  }
  return new Pool(config)
}
```

- [ ] **Step 2: Run typecheck + lint**

Run: `pnpm --filter backend typecheck && pnpm --filter backend lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/postgres.ts
git commit -m "feat(myt-29): createPgPool with explicit sslmode parsing

pg does not auto-derive TLS from ?sslmode= in the URL alone — needs
explicit ssl in PoolConfig. Same call site works for dev (no TLS) and
prod (RDS, sslmode=require). No dedicated test; behavior exercised
by the boot-gate integration test.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T8: Redis client factory (thin wrapper, no dedicated test)

**Files:**
- Create: `backend/src/redis/client.ts`

Per spec, ioredis must be configured with `lazyConnect: true` + retry-disable so it doesn't fight `waitFor`'s retry loop and doesn't emit unhandled errors after `process.exit(1)`.

- [ ] **Step 1: Implement `backend/src/redis/client.ts`**

```ts
import { Redis, type RedisOptions } from 'ioredis'

export function createRedisClient(url: string): Redis {
  // Prevent ioredis's default infinite-retry behavior from fighting our
  // own waitFor loop and from emitting unhandled 'error' events after
  // process.exit(1). All retry policy lives in waitFor.
  const options: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  }
  return new Redis(url, options)
}
```

- [ ] **Step 2: Run typecheck + lint**

Run: `pnpm --filter backend typecheck && pnpm --filter backend lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/redis/client.ts
git commit -m "feat(myt-29): createRedisClient with retry disabled

ioredis defaults to aggressive auto-connect + infinite retry, which
would fight waitFor and emit unhandled errors after process.exit.
lazyConnect:true + retryStrategy:()=>null hands all retry policy to
waitFor.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T9: `buildApp` accepts `AppDeps`; update existing test

**Files:**
- Modify: `backend/src/app.ts`
- Modify: `backend/src/__tests__/app.test.ts`

This task changes `buildApp`'s signature. The existing `app.test.ts` calls `buildApp()` with no args; we update it to pass mock deps. Existing `shutdown.test.ts` also calls `buildApp()` and needs the same update — handled in T10 along with the createShutdown extension.

- [ ] **Step 1: Update `backend/src/__tests__/app.test.ts` to pass mock deps**

Replace the contents of `backend/src/__tests__/app.test.ts` with:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

const mockDeps: AppDeps = {
  pg: {} as Pool,
  redisRealtime: {} as Redis,
  redisBatch: {} as Redis,
}

describe('buildApp', () => {
  let app: ReturnType<typeof buildApp> | undefined
  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it('builds a Fastify instance with no side effects on import', () => {
    app = buildApp(mockDeps)
    expect(app).toBeDefined()
  })

  it('/health returns {status:"ok"}', async () => {
    app = buildApp(mockDeps)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test src/__tests__/app.test`
Expected: FAIL — `buildApp` does not yet accept arguments. Specifically TS errors and runtime "expected 0 arguments, got 1" (or equivalent).

- [ ] **Step 3: Update `buildApp` signature in `backend/src/app.ts`**

Modify `backend/src/app.ts`. Keep `createShutdown` unchanged for now (T10 extends it). Replace `buildApp` only:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from './app-deps.js'

// Deps held by server.ts for shutdown; Backend Core's first plugin will
// add `app.decorate('pg', deps.pg)` and the FastifyInstance type
// augmentation. This ticket only establishes the dependency-injection
// shape via AppDeps. The `_` prefix marks the param as intentionally
// unused this ticket (satisfies @typescript-eslint/no-unused-vars).
export const buildApp = (_deps: AppDeps): FastifyInstance => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))
  return app
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'

export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>

export const createShutdown = (app: FastifyInstance): ShutdownHandler => {
  return async (signal) => {
    try {
      app.log.info({ signal }, 'shutting down')
      // Yield once so pino's async log queue drains before close.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }
}
// MYT-28 idempotency marker — verifies second push produces new task-def revision
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter backend test src/__tests__/app.test`
Expected: PASS — both cases green.

- [ ] **Step 5: Verify other call sites of `buildApp` still typecheck**

Run: `pnpm --filter backend typecheck`
Expected: FAIL — `server.ts` calls `buildApp()` with no args, and `shutdown.test.ts` calls `buildApp()` with no args. This is expected; T10 fixes shutdown.test.ts and T11 fixes server.ts. To unblock typecheck for the moment, **temporarily** update `backend/src/server.ts`:

```ts
import { buildApp, createShutdown } from './app.js'
import type { AppDeps } from './app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

const stubDeps: AppDeps = {
  pg: {} as Pool,
  redisRealtime: {} as Redis,
  redisBatch: {} as Redis,
}
const app = buildApp(stubDeps)
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })

const handleShutdown = createShutdown(app)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void handleShutdown(signal))
}
```

And **temporarily** update the first line of each `it(...)` block in `backend/src/__tests__/shutdown.test.ts`:

Find:
```ts
    const app = buildApp()
```
Replace (in both occurrences):
```ts
    const app = buildApp({} as AppDeps)
```

And add to imports at top of `shutdown.test.ts`:
```ts
import type { AppDeps } from '../app-deps.js'
```

- [ ] **Step 6: Re-run typecheck + full test suite**

Run: `pnpm --filter backend typecheck && pnpm --filter backend test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/app.ts backend/src/server.ts backend/src/__tests__/app.test.ts backend/src/__tests__/shutdown.test.ts
git commit -m "feat(myt-29): buildApp accepts AppDeps interface

Signature change establishes dependency-injection shape. Deps held
by server.ts for shutdown lifetime; Backend Core's first plugin will
add app.decorate + FastifyInstance type augmentation.

Server.ts and shutdown.test.ts use stub deps temporarily; the real
boot gate lands in T10/T11.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T10: Extend `createShutdown` to drain pg + redis (TDD)

**Files:**
- Modify: `backend/src/app.ts`
- Modify: `backend/src/__tests__/shutdown.test.ts`

- [ ] **Step 1: Update `backend/src/__tests__/shutdown.test.ts` with new test cases for the extended drain order**

Replace the contents with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createShutdown, buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

type ExitFn = (code?: string | number | null) => never

interface MockClients {
  pg: { end: ReturnType<typeof vi.fn> } & Partial<Pool>
  redisRealtime: { quit: ReturnType<typeof vi.fn> } & Partial<Redis>
  redisBatch: { quit: ReturnType<typeof vi.fn> } & Partial<Redis>
}

function makeMockClients(): MockClients {
  return {
    pg: { end: vi.fn().mockResolvedValue(undefined) },
    redisRealtime: { quit: vi.fn().mockResolvedValue('OK') },
    redisBatch: { quit: vi.fn().mockResolvedValue('OK') },
  }
}

describe('createShutdown', () => {
  let exitSpy: ReturnType<typeof vi.fn<ExitFn>>
  const originalExit: ExitFn = process.exit.bind(process)

  beforeEach(() => {
    exitSpy = vi.fn<ExitFn>(() => undefined as never)
    process.exit = exitSpy
  })
  afterEach(() => {
    process.exit = originalExit
  })

  it('drains in order: app.close → pg.end → redis.quit (both), then exit(0)', async () => {
    const app = buildApp({} as AppDeps)
    const clients = makeMockClients()
    const callOrder: string[] = []

    vi.spyOn(app, 'close').mockImplementation(
      (() => {
        callOrder.push('app.close')
        return Promise.resolve()
      }) as unknown as typeof app.close,
    )
    clients.pg.end.mockImplementation(() => {
      callOrder.push('pg.end')
      return Promise.resolve()
    })
    clients.redisRealtime.quit.mockImplementation(() => {
      callOrder.push('redis-realtime.quit')
      return Promise.resolve('OK')
    })
    clients.redisBatch.quit.mockImplementation(() => {
      callOrder.push('redis-batch.quit')
      return Promise.resolve('OK')
    })
    exitSpy.mockImplementation((code) => {
      callOrder.push(`exit:${String(code)}`)
      return undefined as never
    })

    const handler = createShutdown(app, {
      pg: clients.pg as Pool,
      redisRealtime: clients.redisRealtime as Redis,
      redisBatch: clients.redisBatch as Redis,
    })
    await handler('SIGTERM')

    expect(callOrder).toEqual([
      'app.close',
      'pg.end',
      'redis-realtime.quit',
      'redis-batch.quit',
      'exit:0',
    ])
  })

  it('exits with code 1 if app.close throws', async () => {
    const app = buildApp({} as AppDeps)
    const clients = makeMockClients()
    vi.spyOn(app, 'close').mockImplementation(
      (() => Promise.reject(new Error('boom'))) as unknown as typeof app.close,
    )

    const handler = createShutdown(app, {
      pg: clients.pg as Pool,
      redisRealtime: clients.redisRealtime as Redis,
      redisBatch: clients.redisBatch as Redis,
    })
    await handler('SIGTERM')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with code 1 if pg.end throws (after app.close succeeded)', async () => {
    const app = buildApp({} as AppDeps)
    const clients = makeMockClients()
    vi.spyOn(app, 'close').mockImplementation(
      (() => Promise.resolve()) as unknown as typeof app.close,
    )
    clients.pg.end.mockRejectedValue(new Error('pg boom'))

    const handler = createShutdown(app, {
      pg: clients.pg as Pool,
      redisRealtime: clients.redisRealtime as Redis,
      redisBatch: clients.redisBatch as Redis,
    })
    await handler('SIGTERM')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test src/__tests__/shutdown`
Expected: FAIL — `createShutdown` only accepts one argument (app); the new test passes two. TS error and runtime error.

- [ ] **Step 3: Extend `createShutdown` in `backend/src/app.ts`**

Replace the existing `createShutdown` block in `backend/src/app.ts` with:

```ts
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'
export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>

interface ShutdownClients {
  readonly pg: Pool
  readonly redisRealtime: Redis
  readonly redisBatch: Redis
}

export const createShutdown = (
  app: FastifyInstance,
  clients: ShutdownClients,
): ShutdownHandler => {
  return async (signal) => {
    try {
      app.log.info({ signal }, 'shutting down')
      // Yield once so pino's async log queue drains before close.
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Drain order matters: HTTP first (no in-flight queries), then pg pool,
      // then redis QUIT (graceful, flushes in-flight commands; vs disconnect
      // which rips the socket).
      await app.close()
      await clients.pg.end()
      await clients.redisRealtime.quit()
      await clients.redisBatch.quit()
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }
}
```

(Add `import type { Pool } from 'pg'` and `import type { Redis } from 'ioredis'` at the top of `app.ts` alongside the existing imports.)

- [ ] **Step 4: Run shutdown tests to verify pass**

Run: `pnpm --filter backend test src/__tests__/shutdown`
Expected: PASS — all 3 cases green.

- [ ] **Step 5: Update temporary stub in `server.ts` (will be replaced in T11)**

The temporary stub in `server.ts` from T9 still passes only `app` to `createShutdown`. Update it to pass clients too — temporary stubs since real clients land in T11. Replace `backend/src/server.ts` with:

```ts
import { buildApp, createShutdown } from './app.js'
import type { AppDeps } from './app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

const stubDeps: AppDeps = {
  pg: { end: () => Promise.resolve() } as unknown as Pool,
  redisRealtime: { quit: () => Promise.resolve('OK') } as unknown as Redis,
  redisBatch: { quit: () => Promise.resolve('OK') } as unknown as Redis,
}
const app = buildApp(stubDeps)
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })

const handleShutdown = createShutdown(app, stubDeps)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void handleShutdown(signal))
}
```

- [ ] **Step 6: Run full test suite + typecheck**

Run: `pnpm --filter backend test && pnpm --filter backend typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/app.ts backend/src/__tests__/shutdown.test.ts backend/src/server.ts
git commit -m "feat(myt-29): extend createShutdown to drain pg + redis

Order: app.close → pg.end → redis.quit (both). app.close first so no
in-flight queries hit the closing pool. quit (not disconnect) so
in-flight Redis commands flush.

server.ts uses stub clients temporarily; real boot gate in T11.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T11: Server boot gate (TDD)

**Files:**
- Modify: `backend/src/server.ts`
- Create: `backend/src/__tests__/server.test.ts`

This is the integration task: wires `loadEnv` + `createPgPool` + `createRedisClient` + `installSignalHandlers` + `waitFor` + `buildApp` + `createShutdown` together. The test mocks the **probes** (not `waitFor`), per spec.

- [ ] **Step 1: Refactor `server.ts` to expose `main()` for testability**

Replace `backend/src/server.ts` with the final boot-gate implementation:

```ts
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { buildApp, createShutdown } from './app.js'
import { loadEnv } from './config/env.js'
import { installSignalHandlers } from './boot/signal-handlers.js'
import { waitFor } from './boot/wait-for.js'
import { createPgPool } from './db/postgres.js'
import { createRedisClient } from './redis/client.js'

async function closePartials(
  pg: Pool | undefined,
  rTR: Redis | undefined,
  rTB: Redis | undefined,
): Promise<void> {
  await Promise.allSettled([
    pg ? pg.end() : Promise.resolve(),
    rTR ? rTR.quit() : Promise.resolve(),
    rTB ? rTB.quit() : Promise.resolve(),
  ])
}

export async function main(): Promise<void> {
  // Signal handlers FIRST, before any resource creation. A SIGINT during
  // boot must close partial clients cleanly (see spec §9.7).
  const abortController = new AbortController()
  installSignalHandlers(abortController)

  let pg: Pool | undefined
  let rTR: Redis | undefined
  let rTB: Redis | undefined

  try {
    const env = loadEnv()
    pg = createPgPool(env.databaseUrl)
    rTR = createRedisClient(env.redisRealtimeUrl)
    rTB = createRedisClient(env.redisBatchUrl)

    // Sequential awaits per spec §7.10. Three local services starting
    // under `docker compose up -d --wait` reach healthy at the same
    // moment; sequential and parallel produce identical wall time.
    await waitFor({
      label: 'Postgres',
      probe: () => pg!.query('SELECT 1'),
      signal: abortController.signal,
    })
    console.log('✓ Postgres ready')
    await waitFor({
      label: 'Redis (realtime)',
      probe: () => rTR!.ping(),
      signal: abortController.signal,
    })
    console.log('✓ Redis (realtime) ready')
    await waitFor({
      label: 'Redis (batch)',
      probe: () => rTB!.ping(),
      signal: abortController.signal,
    })
    console.log('✓ Redis (batch) ready')

    const app = buildApp({ pg, redisRealtime: rTR, redisBatch: rTB })
    await app.listen({ port: env.port, host: '0.0.0.0' })

    const handleShutdown = createShutdown(app, {
      pg,
      redisRealtime: rTR,
      redisBatch: rTB,
    })
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => void handleShutdown(signal))
    }
  } catch (err) {
    console.error('✗ Boot gate failed:', err instanceof Error ? err.message : err)
    await closePartials(pg, rTR, rTB)
    // Watchdog: if any client kept the event loop alive past closePartials,
    // force-exit. unref() so this doesn't block exit when cleanup succeeds.
    setTimeout(() => process.exit(1), 5000).unref()
    process.exitCode = 1
  }
}

await main()
```

- [ ] **Step 2: Write the failing integration test**

Create `backend/src/__tests__/server.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

// Mocks must be declared before the dynamic import of server.ts inside tests.
const mockPgQuery = vi.fn()
const mockPgEnd = vi.fn().mockResolvedValue(undefined)
const mockRtrPing = vi.fn()
const mockRtrQuit = vi.fn().mockResolvedValue('OK')
const mockRtbPing = vi.fn()
const mockRtbQuit = vi.fn().mockResolvedValue('OK')
const mockListen = vi.fn().mockResolvedValue(undefined)

vi.mock('../db/postgres.js', () => ({
  createPgPool: () => ({ query: mockPgQuery, end: mockPgEnd }) as unknown as Pool,
}))
vi.mock('../redis/client.js', () => ({
  createRedisClient: vi.fn().mockImplementationOnce(
    () => ({ ping: mockRtrPing, quit: mockRtrQuit }) as unknown as Redis,
  ).mockImplementationOnce(
    () => ({ ping: mockRtbPing, quit: mockRtbQuit }) as unknown as Redis,
  ),
}))
vi.mock('../app.js', async () => {
  const actual = await vi.importActual<typeof import('../app.js')>('../app.js')
  return {
    ...actual,
    buildApp: () => ({
      listen: mockListen,
      log: { info: vi.fn(), error: vi.fn() },
      close: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  REDIS_REALTIME_URL: 'redis://h:6379',
  REDIS_BATCH_URL: 'redis://h:6380',
  PORT: '3000',
}

describe('server boot gate', () => {
  const origEnv = { ...process.env }
  let exitSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    process.env = { ...origEnv, ...REQUIRED_ENV }
    exitSpy = vi.fn(() => undefined as never)
    vi.spyOn(process, 'exit').mockImplementation(exitSpy as unknown as typeof process.exit)
  })
  afterEach(() => {
    process.env = origEnv
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('happy path: all probes succeed → app.listen called, no exitCode', async () => {
    mockPgQuery.mockResolvedValue({})
    mockRtrPing.mockResolvedValue('PONG')
    mockRtbPing.mockResolvedValue('PONG')

    const { main } = await import('../server.js')
    await main()

    expect(mockPgQuery).toHaveBeenCalled()
    expect(mockRtrPing).toHaveBeenCalled()
    expect(mockRtbPing).toHaveBeenCalled()
    expect(mockListen).toHaveBeenCalledWith({ port: 3000, host: '0.0.0.0' })
    expect(process.exitCode).not.toBe(1)
  })

  it('Postgres probe fails → exitCode=1, app.listen NOT called, closePartials runs', async () => {
    mockPgQuery.mockRejectedValue(new Error('connection refused'))
    mockRtrPing.mockResolvedValue('PONG')
    mockRtbPing.mockResolvedValue('PONG')

    const { main } = await import('../server.js')
    await main()

    expect(process.exitCode).toBe(1)
    expect(mockListen).not.toHaveBeenCalled()
    expect(mockPgEnd).toHaveBeenCalled()
    expect(mockRtrQuit).toHaveBeenCalled()
    expect(mockRtbQuit).toHaveBeenCalled()
  })

  it('Redis (realtime) probe fails → exitCode=1, named in error log', async () => {
    mockPgQuery.mockResolvedValue({})
    mockRtrPing.mockRejectedValue(new Error('redis down'))
    mockRtbPing.mockResolvedValue('PONG')

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { main } = await import('../server.js')
    await main()

    expect(process.exitCode).toBe(1)
    expect(mockListen).not.toHaveBeenCalled()
    const allErrCalls = errSpy.mock.calls.flat().join(' ')
    expect(allErrCalls).toContain('Redis (realtime)')
    errSpy.mockRestore()
  })

  it('Missing DATABASE_URL → exitCode=1 from env validation, no clients created', async () => {
    delete process.env.DATABASE_URL
    const { main } = await import('../server.js')
    await main()
    expect(process.exitCode).toBe(1)
    expect(mockPgQuery).not.toHaveBeenCalled()
    expect(mockListen).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter backend test src/__tests__/server`
Expected: PASS — all 4 cases green.

If a test fails, common issues:
- `vi.mock` hoisting: if Node ESM hoisting trips up, ensure `vi.mock` calls are at the very top of the test file before any dynamic imports.
- Top-level `await main()` runs on import: that's why we use `vi.resetModules()` in afterEach and dynamic `import('../server.js')` inside each test.

- [ ] **Step 4: Run full test suite + typecheck + lint**

Run: `pnpm --filter backend test && pnpm --filter backend typecheck && pnpm --filter backend lint`
Expected: PASS across all suites.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/__tests__/server.test.ts
git commit -m "feat(myt-29): server boot gate with retry-then-fail-loud

Sequential waitFor probes against pg + 2× redis. Signal handlers
installed BEFORE client creation. On any probe exhaustion: log error,
closePartials, watchdog setTimeout.unref(), exitCode=1.

Tests mock probes (not waitFor) per spec. Cover happy path, each probe
failing, and missing env var.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task T12: Update `dev` script + manual verification

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Update `backend/package.json` `dev` script**

In `backend/package.json`, change the `"dev"` line to use `--env-file`:

```json
    "dev": "tsx watch --env-file=.env.development src/server.ts",
```

(Path is relative to `backend/` since pnpm filters CWD to the package; the env file lives at `backend/.env.development`, no `../` needed.)

- [ ] **Step 2: Bring up containers**

Run: `pnpm db:up`
Expected: ~15s, `docker compose ps` shows three services healthy.

- [ ] **Step 3: Copy the env example**

Run: `cp backend/.env.development.example backend/.env.development`

(Note: this file is gitignored — `git status` will not show it.)

- [ ] **Step 4: Start the backend**

Run: `pnpm dev`

Expected output (within ~3 seconds):
```
✓ Postgres ready
✓ Redis (realtime) ready
✓ Redis (batch) ready
{"level":30,"time":...,"msg":"Server listening at http://0.0.0.0:3000"}
```

- [ ] **Step 5: Smoke-test `/health`**

In another terminal:

Run: `curl -s http://localhost:3000/health`
Expected: `{"status":"ok"}`

- [ ] **Step 6: Test the negative path (containers down)**

Stop the backend (Ctrl-C). Then:

Run: `pnpm db:down && pnpm dev`

Expected (after ~3.7s per service, ~12s total):
```
✗ Boot gate failed: waitFor(Postgres): exhausted 5 attempts; last error: ...
```
Process exits with code 1.

- [ ] **Step 7: Test the recovery path**

Run: `pnpm db:up && pnpm dev`

Expected: same successful startup as Step 4.

- [ ] **Step 8: Test the abort path**

With `pnpm db:down` again, start `pnpm dev` and hit Ctrl-C while it's mid-retry (within ~3 seconds). Expected:
- Process exits cleanly within 1 second.
- No "unhandled promise rejection" warnings in stderr.

- [ ] **Step 9: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS across all packages (backend + wiki).

- [ ] **Step 10: Commit**

```bash
git add backend/package.json
git commit -m "feat(myt-29): dev script uses --env-file=.env.development

Final wiring. backend/.env.development is loaded by Node's native
--env-file flag (no dotenv dep). Manual verification covers happy
path, dependency-down path, recovery, and Ctrl-C-mid-retry abort.

Closes MYT-29.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 11: Push to main**

```bash
git push
```

This triggers the MYT-28 deploy workflow. The backend changes preserve the production code path (env vars from ECS task def, not `.env.development`); the deploy should go green.

---

## Self-review

### Spec coverage check

| Spec section | Covered by task |
|---|---|
| §3 Done-when #1 (fresh-clone happy path) | T12 Steps 2-5 |
| §3 Done-when #2 (negative path → exit 1) | T12 Step 6 |
| §3 Done-when #3 (recovery path) | T12 Step 7 |
| §3 Done-when #4 (Ctrl-C mid-boot) | T6 (signal handlers), T11 (boot gate AbortSignal wiring), T12 Step 8 |
| §3 Done-when #5 (unit tests pass without containers) | T4, T5, T6, T9, T10, T11 |
| §3 Done-when #6 (typecheck + lint) | Each task includes typecheck + lint verification |
| §3 Done-when #7 (deploy pipeline green) | T12 Step 11 |
| §5.1 Three-service compose | T1 |
| §5.2 Boot-time gate | T11 (with helpers from T4-T8) |
| §5.3 Env loader | T2, T4, T12 (dev script) |
| §5.4 buildApp(deps: AppDeps) | T9 |
| §5.5 Dev/prod parity | T7 (sslmode parsing); rest is property of the design |
| §6 File-level design | All tasks combined produce every file in the table |
| §7 Decisions log | Implementation matches each decision |
| §8.1 Unit tests (5 files) | T4 (env), T5 (waitFor), T6 (signals), T9-T10 (app/shutdown), T11 (server) |
| §8.2 Manual verification | T12 |
| §9.7 Mid-boot Ctrl-C | T11 watchdog + closePartials |

No gaps.

### Placeholder scan

Searched the plan for: TBD, TODO, "implement later", "fill in details", "add appropriate", "similar to Task". None found. Every code step contains the actual code; every command step contains the actual command.

### Type / signature consistency

- `AppDeps` interface (T3) has `pg: Pool`, `redisRealtime: Redis`, `redisBatch: Redis` — referenced consistently in T9, T10, T11.
- `loadEnv()` returns frozen `Env` with `databaseUrl`, `redisRealtimeUrl`, `redisBatchUrl`, `port` — used in T11.
- `waitFor({ label, probe, signal })` (T5) — same destructure used in T11.
- `installSignalHandlers(controller: AbortController)` (T6) — same signature used in T11.
- `createPgPool(url: string): Pool` (T7) — used in T11.
- `createRedisClient(url: string): Redis` (T8) — used in T11.
- `createShutdown(app, clients: ShutdownClients)` (T10) — used in T11 with `{ pg, redisRealtime, redisBatch }` matching `ShutdownClients`.

All consistent.

### Bead-sizing check

Each task is 1-4 hours of focused work:
- T1: ~30 min (yaml + smoke test)
- T2: ~20 min (template + scripts + verification)
- T3: ~20 min (deps install + interface)
- T4: ~1 hour (env loader TDD)
- T5: ~2 hours (waitFor — most complex; fake timers + abort)
- T6: ~45 min (signal handlers TDD)
- T7: ~20 min (postgres factory)
- T8: ~15 min (redis factory)
- T9: ~45 min (signature change + existing test updates)
- T10: ~1 hour (createShutdown extension TDD)
- T11: ~2-3 hours (boot gate + integration test — vi.mock setup is fiddly)
- T12: ~30 min (manual verification across paths)

Total: ~10-13 hours of work. Reasonable for a single-day implementation if focused.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-24-local-dev-environment.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh Opus subagent per task, two-stage review (spec compliance + code quality) between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for human review

Which approach?
