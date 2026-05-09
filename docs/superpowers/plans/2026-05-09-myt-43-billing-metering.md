# MYT-43 — Billing Metering + Trial Mutual Exclusion + Demo World Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the data plane for per-session cost metering (`recordUsage` / `budgetSummary`), the credit-debit primitive (`tryDebitForSession`), trial-paid mutual exclusion via auto-burn (`grantInTx` extension + `consumedSourceType`), demo-world scaffolding, and a daily Anthropic-pricing drift check. Closes the Platform milestone.

**Architecture:** Postgres-only durable record for cost (no Redis layer for this subsystem). One row per session in `session_usage`, mutated cumulatively per LLM call. `recordUsage` returns running totals so the future Session Runtime can compute wrap-up signals inline. Trial credit is auto-burned on first paid grant; `atomicDebit` returns `consumedSourceType` so SR knows trial-vs-paid. Pricing constants are hardcoded; a daily CI cron extracts Anthropic's pricing docs page via Haiku and alarms on any drift.

**Tech Stack:** Node.js 24, Fastify v5 (no new routes — repo + script work only), TypeScript strict, pg, ioredis (touched only for unrelated tests), Vitest, Vercel AI SDK v6 + Zod (for the drift-check script's structured output), GitHub Actions (daily cron).

**Spec:** `docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md`

**Source spec (mutates in this commit):** `docs/specs/2026-04-13-billing-cost-controls.md` §6 / §7 / §8 / §10, plus two other source-of-truth files (Task 15).

---

## File Structure

**New files:**

| Path | Responsibility |
|------|----------------|
| `backend/migrations/008_billing_metering.sql` | Schema changes: drop `session_usage.budget_limit_tokens`, add `cache_write_tokens` / `cache_read_tokens` columns, add `idx_session_usage_one_per_session` unique index, add `worlds.is_demo BOOLEAN` + `idx_worlds_one_demo` partial unique index. Seed `system` users row + placeholder demo world. |
| `backend/src/repo/uuidv5.ts` | Deterministic UUIDv5 generator wrapping `node:crypto`'s SHA-1 with RFC 4122 byte-twiddling. Used by trial-burn `source_id` derivation. |
| `backend/src/repo/__tests__/uuidv5.test.ts` | Unit tests: deterministic same-input-same-output, different-input-different-output, valid UUID format. |
| `backend/src/billing/model-pricing.ts` | `MODEL_PRICING` constants (4 rates per model), `MODEL_DISPLAY_NAMES` slug map, `computeCostUsd(model, deltas)` with 1-hour cache rejection. |
| `backend/src/billing/__tests__/model-pricing.test.ts` | Unit tests for `computeCostUsd` across mixed-model + cached scenarios. |
| `backend/src/llm/prompts/billing/pricing-extract.txt` | Haiku system prompt for the drift-check (per `loadPrompt('billing','pricing-extract')` convention). |
| `backend/scripts/check-pricing-drift.ts` | Daily drift-check: fetch Anthropic docs, extract via Haiku, sanity-bound, diff against MODEL_PRICING, exit non-zero on any drift. |
| `.github/workflows/llm-pricing-drift.yml` | Daily 14:00 UTC cron running the drift check. |

**Modified files:**

| Path | Why |
|------|-----|
| `backend/src/repo/types.ts` | Add `SessionUsage` type, `AtomicDebitResult` interface, `TryDebitResult` discriminated union; add `isDemo: boolean` to `World`. |
| `backend/src/repo/mappers.ts` | Add `toSessionUsage` + `SessionUsageDbRow`; update `toWorld` + `WorldDbRow` to map `is_demo`. |
| `backend/src/repo/credits.ts` | Extend `atomicDebit` to return `{entry, consumedSourceType}`; modify `grantInTx` (and exported standalone) to burn trial credits when `sourceType` is `'purchase'` or `'subscription'`; add `tryDebitForSession(userId, sessionId)` wrapper. |
| `backend/src/repo/sessions.ts` | Add `recordUsage(sessionId, model, deltas) → SessionUsage` (UPSERT keyed on session_id, returns post-update row, throws `SessionNotFoundError` on no-match) and `budgetSummary(sessionId) → SessionUsage \| null`. |
| `backend/src/repo/sessions-errors.ts` | NEW — `SessionNotFoundError` class. (Mirrors `credits-errors.ts` pattern.) |
| `backend/src/repo/worlds.ts` | Add `getDemo(): Promise<World \| null>` helper. Update `worlds.create` to optionally accept `isDemo: boolean` for completeness (default false). |
| `backend/src/repo/__tests__/_helpers/reset-data.ts` | Modify so the system user + demo world are re-seeded after TRUNCATE (otherwise every test wipes them). |
| `backend/src/repo/__tests__/credits.test.ts` | Add tests for trial-burn idempotency, `consumedSourceType` returns, `tryDebitForSession` typed result. |
| `backend/src/repo/__tests__/sessions.test.ts` | Add tests for `recordUsage` / `budgetSummary` / split columns / SessionNotFoundError. |
| `backend/src/repo/__tests__/worlds.test.ts` | Add tests for `getDemo` + `is_demo` mapping. |
| `backend/src/db/__tests__/migrate-schema.test.ts` | Add migration 008 to expected migrations list; add new indexes (`idx_session_usage_one_per_session`, `idx_worlds_one_demo`) to expected-indexes set. |
| `docs/specs/2026-04-13-billing-cost-controls.md` | Source-spec edits per design §10.1. |
| `docs/specs/2026-04-13-backend-core.md` | Update session_usage schema block per design §10.2. |
| `docs/specs/2026-04-06-production-architecture-overview.md` | Update threshold language + session_usage schema per design §10.3. |

---

## Task Sequencing Notes

Tasks 1–4 are foundational (migration, test-infra fix, helpers, types). Tasks 5–10 build the repo primitives in dependency order. Tasks 11–13 ship the drift-check infrastructure. Task 14 updates the schema-parity test for the new migration. Task 15 is doc-only source-spec sync. Task 16 is final verification + wiki sync + push + Linear close.

Each task ends with a commit. The implementation does NOT push until Task 16.

---

## Task 1: Migration 008 — schema changes + seeds

**Files:**
- Create: `backend/migrations/008_billing_metering.sql`

- [ ] **Step 1: Create the migration file**

Create `backend/migrations/008_billing_metering.sql`:

```sql
-- 008_billing_metering.sql
-- MYT-43: per-session cost metering (data plane), trial mutual-exclusion,
-- demo-world scaffolding. Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md

-- 4.1 session_usage: drop the abandoned token-budget column.
ALTER TABLE session_usage DROP COLUMN budget_limit_tokens;

-- 4.1b session_usage: split input-side token classes into separate columns
-- so analytics doesn't lose the cache-vs-uncached breakdown. Per design §8.1.
ALTER TABLE session_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_usage ADD COLUMN cache_read_tokens  INTEGER NOT NULL DEFAULT 0;

-- 4.2 session_usage: pin one-row-per-session contract.
-- recordUsage uses ON CONFLICT (session_id) DO UPDATE; this index makes
-- that work and prevents accidental dup rows.
CREATE UNIQUE INDEX idx_session_usage_one_per_session
  ON session_usage (session_id);

-- 4.3 worlds: add is_demo flag with at-most-one-demo enforcement.
ALTER TABLE worlds ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX idx_worlds_one_demo ON worlds (is_demo) WHERE is_demo = true;

-- 4.4 Seed: system users row.
-- Owns platform-seeded content (demo world today). Has no Cognito identity;
-- suspended_at sentinel ensures it can never authenticate even if a JWT
-- were somehow routed to its sub. Column list matches post-migration-005
-- users shape (email/avatar_url/auth_provider were dropped in 005).
INSERT INTO users (
  id, cognito_sub, display_name, username,
  free_trial_used, suspended_at
)
VALUES (
  '019700e0-0000-7000-8000-000000000001'::uuid,
  'system:mythrun',
  'Mythrun System',
  'system',
  true,
  '1970-01-01 00:00:00+00'::timestamptz
);

-- 4.5 Seed: placeholder demo world.
-- Real narrative content is a separate authoring task; this row exists
-- so the trial flow has something to fork from once Session Runtime ships.
INSERT INTO worlds (
  id, created_by, name, concept, status, language,
  is_public, is_demo
)
VALUES (
  '019700e0-0000-7000-8000-000000000002'::uuid,
  '019700e0-0000-7000-8000-000000000001'::uuid,
  'Demo Adventure',
  'Trial-mode demo world. Narrative content authored separately.',
  'complete',
  'en',
  false,
  true
);
```

- [ ] **Step 2: Apply the migration to local Postgres**

```
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm --filter backend db:migrate
```

Expected: migration 008 applies cleanly, no errors.

- [ ] **Step 3: Verify the schema changes**

```
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c "\d session_usage"
```

Expected: no `budget_limit_tokens` column, new `cache_write_tokens` + `cache_read_tokens` columns visible.

```
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c "SELECT id, cognito_sub, username FROM users WHERE cognito_sub = 'system:mythrun'"
```

Expected: one row returned, `id = 019700e0-0000-7000-8000-000000000001`.

```
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c "SELECT id, name, is_demo FROM worlds WHERE is_demo = true"
```

Expected: one row, `id = 019700e0-0000-7000-8000-000000000002`, name = `Demo Adventure`.

- [ ] **Step 4: Verify the partial unique index rejects a second demo world**

```
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c \
  "INSERT INTO worlds (id, created_by, name, concept, status, language, is_public, is_demo) \
   VALUES ('019700e0-0000-7000-8000-000000000099'::uuid, '019700e0-0000-7000-8000-000000000001'::uuid, \
           'Second demo', 'should fail', 'complete', 'en', false, true)"
```

Expected: `ERROR:  duplicate key value violates unique constraint "idx_worlds_one_demo"`. Rolls back.

- [ ] **Step 5: Commit**

```
git add backend/migrations/008_billing_metering.sql
git commit -m "feat(myt-43): migration 008 — billing metering schema + system user + demo world seed"
```

---

## Task 2: Test infra — `resetData` re-seeds system rows

**Files:**
- Modify: `backend/src/repo/__tests__/_helpers/reset-data.ts`

The test infra TRUNCATEs `users` + `worlds` between tests. After migration 008, every test wipes the seeded system user + demo world. `resetData` needs to re-insert them after truncate.

- [ ] **Step 1: Read the existing resetData**

```
cat backend/src/repo/__tests__/_helpers/reset-data.ts
```

Note the structure (export of `TABLES`, `resetData(pool)` function with TRUNCATE).

- [ ] **Step 2: Modify `resetData` to re-seed system rows**

Append re-seed logic after the TRUNCATE in `backend/src/repo/__tests__/_helpers/reset-data.ts`:

```typescript
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)

  // MYT-43 seed re-insert: migration 008 seeded a system user and a demo
  // world; TRUNCATE wipes both. Tests that touch users/worlds rely on
  // these rows existing (e.g. world.created_by FK to system user for the
  // demo world). Re-insert here so the post-resetData state matches the
  // post-migration state.
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used, suspended_at)
     VALUES (
       '019700e0-0000-7000-8000-000000000001'::uuid,
       'system:mythrun',
       'Mythrun System',
       'system',
       true,
       '1970-01-01 00:00:00+00'::timestamptz
     )`,
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status, language, is_public, is_demo)
     VALUES (
       '019700e0-0000-7000-8000-000000000002'::uuid,
       '019700e0-0000-7000-8000-000000000001'::uuid,
       'Demo Adventure',
       'Trial-mode demo world. Narrative content authored separately.',
       'complete',
       'en',
       false,
       true
     )`,
  )
```

- [ ] **Step 3: Run the existing repo test suite to verify resetData still works**

```
cd backend && pnpm exec vitest run src/repo/__tests__/ --reporter=dot
```

Expected: all existing tests pass (the new INSERT statements don't break anything).

- [ ] **Step 4: Commit**

```
git add backend/src/repo/__tests__/_helpers/reset-data.ts
git commit -m "test(myt-43): re-seed system user + demo world after resetData TRUNCATE"
```

---

## Task 3: UUIDv5 helper

**Files:**
- Create: `backend/src/repo/uuidv5.ts`
- Create: `backend/src/repo/__tests__/uuidv5.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/repo/__tests__/uuidv5.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { uuidv5 } from '../uuidv5.js'

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

describe('uuidv5', () => {
  it('returns a valid UUID', () => {
    const result = uuidv5('test', NAMESPACE)
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('is deterministic — same name + namespace produces same UUID', () => {
    expect(uuidv5('alice', NAMESPACE)).toBe(uuidv5('alice', NAMESPACE))
  })

  it('different names produce different UUIDs', () => {
    expect(uuidv5('alice', NAMESPACE)).not.toBe(uuidv5('bob', NAMESPACE))
  })

  it('different namespaces produce different UUIDs', () => {
    const ns2 = '019700e0-0000-7000-8000-000000000003'
    expect(uuidv5('alice', NAMESPACE)).not.toBe(uuidv5('alice', ns2))
  })

  it('matches RFC 4122 known test vector for DNS namespace + "example.com"', () => {
    const dnsNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
    const result = uuidv5('example.com', dnsNamespace)
    expect(result).toBe('cfbff0d1-9375-5685-968a-48ce8b50ca33')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd backend && pnpm exec vitest run src/repo/__tests__/uuidv5.test.ts --reporter=dot
```

Expected: all 5 tests fail (module not found).

- [ ] **Step 3: Implement `uuidv5.ts`**

Create `backend/src/repo/uuidv5.ts`:

```typescript
// backend/src/repo/uuidv5.ts
//
// Deterministic UUIDv5 generator (RFC 4122 §4.3). SHA-1(namespace_bytes ||
// name_bytes), first 16 bytes, with version 5 and variant 10 bits set.
//
// Used by the MYT-43 trial-burn flow to derive a stable source_id from
// (userId, creditType) — the credit_ledger.source_id column is UUID-typed,
// so a string-based key would fail the type check.
//
// Pure function; no I/O. Implementation note: we don't depend on the
// `uuid` npm package because UUIDv5 is the only flavor we need from it
// (UUIDv7 already lives in repo/uuidv7.ts), and node:crypto's SHA-1 is
// sufficient.

import { createHash } from 'node:crypto'

export function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = parseUuidToBytes(namespace)
  const nameBytes = Buffer.from(name, 'utf8')
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50  // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80  // variant 10
  return bytesToUuid(bytes)
}

function parseUuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) throw new Error(`uuidv5: invalid namespace UUID: ${uuid}`)
  return Buffer.from(hex, 'hex')
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm exec vitest run src/repo/__tests__/uuidv5.test.ts --reporter=dot
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```
git add backend/src/repo/uuidv5.ts backend/src/repo/__tests__/uuidv5.test.ts
git commit -m "feat(myt-43): UUIDv5 helper for deterministic source_id derivation"
```

---

## Task 4: Types + mapper + SessionNotFoundError

**Files:**
- Modify: `backend/src/repo/types.ts`
- Modify: `backend/src/repo/mappers.ts`
- Create: `backend/src/repo/sessions-errors.ts`

- [ ] **Step 1: Add `SessionUsage` type to `types.ts`**

In `backend/src/repo/types.ts`, after the existing `Session` interface block, add:

```typescript
// ─── Session Usage (MYT-43) ──────────────────────────────────────────────

export interface SessionUsage {
  readonly id: string
  readonly sessionId: string
  readonly campaignId: string
  readonly userId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheWriteTokens: number
  readonly cacheReadTokens: number
  readonly estimatedCostUsd: number
  readonly createdAt: Date
}

// ─── Atomic Debit Result (MYT-43) ────────────────────────────────────────

export interface AtomicDebitResult {
  readonly entry: CreditEntry
  /** The source_type of the credit being consumed. Under the trial/paid
   *  mutual-exclusion invariant maintained by grantInTx's auto-burn, all
   *  unexpired positive credits at any moment are the same source-type-
   *  class. The Session Runtime reads this to decide trial-mode vs full-mode. */
  readonly consumedSourceType: 'trial' | 'purchase' | 'subscription' | 'gift' | 'refund'
}

// ─── Try-Debit Result (MYT-43) ───────────────────────────────────────────

export type TryDebitResult =
  | { readonly ok: true; readonly consumedSourceType: AtomicDebitResult['consumedSourceType'] }
  | {
      readonly ok: false
      readonly code: 'insufficient_credits'
      readonly available: number
      readonly required: number
    }
```

- [ ] **Step 2: Add `isDemo` to `World` interface**

In `backend/src/repo/types.ts`, find the existing `World` interface and add `isDemo`:

```typescript
export interface World {
  // ... existing fields ...
  readonly moderationStatus: 'unreviewed' | 'approved' | 'flagged' | 'removed'
  readonly isDemo: boolean  // NEW
  readonly createdAt: Date
  readonly updatedAt: Date
}
```

(Place `isDemo` near the end before `createdAt` — order matches the schema.)

- [ ] **Step 3: Add `SessionUsageDbRow` + `toSessionUsage` to mappers.ts**

In `backend/src/repo/mappers.ts`, after the existing `toSession` block, add:

```typescript
export interface SessionUsageDbRow {
  id: string
  session_id: string
  campaign_id: string
  user_id: string
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  estimated_cost_usd: string  // pg returns NUMERIC as string
  created_at: Date
}

export function toSessionUsage(row: SessionUsageDbRow): SessionUsage {
  return {
    id: row.id,
    sessionId: row.session_id,
    campaignId: row.campaign_id,
    userId: row.user_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    estimatedCostUsd: Number(row.estimated_cost_usd),
    createdAt: row.created_at,
  }
}
```

Add `SessionUsage` to the existing `import type` from `./types.js`.

- [ ] **Step 4: Update `WorldDbRow` + `toWorld` to include `is_demo`**

In `backend/src/repo/mappers.ts`, find `WorldDbRow` and add `is_demo: boolean`. Find `toWorld` and add `isDemo: row.is_demo` to the returned object.

- [ ] **Step 5: Create `sessions-errors.ts`**

Create `backend/src/repo/sessions-errors.ts`:

```typescript
// backend/src/repo/sessions-errors.ts
//
// Typed errors thrown by the sessions repo. Mirrors the credits-errors.ts
// pattern (UserNotFoundError / InsufficientCreditsError / etc.) so callers
// can use instanceof narrowing.

export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found' as const
  constructor(public readonly sessionId: string) {
    super(`SessionNotFoundError: no session with id ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}
```

- [ ] **Step 6: Run typecheck — verify no breakage from the new types**

```
pnpm --filter backend typecheck
```

Expected: clean. If anything errors, the most likely cause is an existing `World` construction site (in tests/fixtures) that doesn't set `isDemo`. Add `isDemo: false` to those.

- [ ] **Step 7: Run full test suite**

```
pnpm exec vitest run --reporter=dot
```

Expected: all tests pass. If any fail because of `isDemo` not being set on a fixture, fix the fixture (default `isDemo: false`).

- [ ] **Step 8: Commit**

```
git add backend/src/repo/types.ts backend/src/repo/mappers.ts backend/src/repo/sessions-errors.ts
git commit -m "feat(myt-43): SessionUsage / AtomicDebitResult / TryDebitResult types + isDemo on World + SessionNotFoundError"
```

If any test fixtures needed `isDemo: false` updates, include those files in the same commit.

---

## Task 5: `model-pricing.ts` + `computeCostUsd`

**Files:**
- Create: `backend/src/billing/model-pricing.ts`
- Create: `backend/src/billing/__tests__/model-pricing.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/billing/__tests__/model-pricing.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { MODEL_PRICING, MODEL_DISPLAY_NAMES, computeCostUsd } from '../model-pricing.js'

describe('MODEL_PRICING', () => {
  it('contains the three Mythrun-known model slugs', () => {
    expect(MODEL_PRICING).toHaveProperty('claude-opus-4-7')
    expect(MODEL_PRICING).toHaveProperty('claude-sonnet-4-6')
    expect(MODEL_PRICING).toHaveProperty('claude-haiku-4-5-20251001')
  })

  it('every model has 4 rates: input / output / cacheWrite / cacheRead', () => {
    for (const [slug, rates] of Object.entries(MODEL_PRICING)) {
      expect(rates).toHaveProperty('input')
      expect(rates).toHaveProperty('output')
      expect(rates).toHaveProperty('cacheWrite')
      expect(rates).toHaveProperty('cacheRead')
      expect(rates.input).toBeGreaterThan(0)
      expect(rates.output).toBeGreaterThan(0)
    }
  })

  it('cacheWrite is approximately 1.25× input for every model', () => {
    for (const rates of Object.values(MODEL_PRICING)) {
      const ratio = rates.cacheWrite / rates.input
      expect(ratio).toBeCloseTo(1.25, 2)
    }
  })

  it('cacheRead is approximately 0.10× input for every model', () => {
    for (const rates of Object.values(MODEL_PRICING)) {
      const ratio = rates.cacheRead / rates.input
      expect(ratio).toBeCloseTo(0.10, 2)
    }
  })
})

describe('MODEL_DISPLAY_NAMES', () => {
  it('every display name maps to a known slug', () => {
    for (const slug of Object.values(MODEL_DISPLAY_NAMES)) {
      expect(MODEL_PRICING).toHaveProperty(slug)
    }
  })
})

describe('computeCostUsd', () => {
  it('haiku 1M input + 1M output: $1 input + $5 output = $6.00', () => {
    const cost = computeCostUsd('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBe(6.00)
  })

  it('sonnet 100K cacheWrite + 1M cacheRead: 0.375 + 0.30 = 0.675', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 100_000,
      cacheReadTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.675, 6)
  })

  it('opus mixed: 10K input + 5K output + 2K cacheWrite + 50K cacheRead', () => {
    const cost = computeCostUsd('claude-opus-4-7', {
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheWriteTokens: 2_000,
      cacheReadTokens: 50_000,
    })
    // 10K * 5 + 5K * 25 + 2K * 6.25 + 50K * 0.50, all / 1M
    // = 50 + 125 + 12.5 + 25 = 212.5 / 1M = 0.0002125
    expect(cost).toBeCloseTo(0.0002125, 8)
  })

  it('undefined cacheWriteTokens / cacheReadTokens default to 0', () => {
    const cost = computeCostUsd('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(cost).toBe(1.00)
  })

  it('throws when 1-hour cache tokens are passed in (we don\'t use 1h cache)', () => {
    expect(() =>
      computeCostUsd('claude-sonnet-4-6', {
        inputTokens: 100,
        outputTokens: 100,
        cacheWrite1hTokens: 1,
      }),
    ).toThrow(/1-hour cache/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm exec vitest run src/billing/__tests__/model-pricing.test.ts --reporter=dot
```

Expected: all tests fail (module not found).

- [ ] **Step 3: Implement `model-pricing.ts`**

Create `backend/src/billing/model-pricing.ts`:

```typescript
// backend/src/billing/model-pricing.ts
//
// USD per million tokens for each model we use, across the four rate
// categories Anthropic publishes:
//   - input:           base prompt tokens
//   - output:          generated tokens
//   - cacheWrite:      5-min cache write tokens (1.25× input)
//   - cacheRead:       cache read tokens at any TTL (0.10× input)
//
// THIS IS APPROXIMATE COST FOR OBSERVABILITY, NOT BILLING.
// Stripe charges users a fixed $/session price; these rates power
// internal cost-cap signaling, dashboards, and CloudWatch alarms.
//
// Drift detection: scripts/check-pricing-drift.ts runs daily under
// .github/workflows/llm-pricing-drift.yml — fetches Anthropic's
// pricing docs page, extracts rates via Haiku (Zod-validated +
// sanity-bounded), diffs against this constant, alarms on any drift
// (with floating-point epsilon).
//
// Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md §5

export const MODEL_PRICING = {
  'claude-opus-4-7':           { input: 5.00, output: 25.00, cacheWrite: 6.25, cacheRead: 0.50 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 1.00, output:  5.00, cacheWrite: 1.25, cacheRead: 0.10 },
} as const

/** Display name (as listed on Anthropic's docs page) → MODEL_PRICING slug.
 *  Used by the daily drift-check; the docs page lists models by display
 *  name only, not by SDK slug. */
export const MODEL_DISPLAY_NAMES: Record<string, keyof typeof MODEL_PRICING> = {
  'Claude Opus 4.7':   'claude-opus-4-7',
  'Claude Sonnet 4.6': 'claude-sonnet-4-6',
  'Claude Haiku 4.5':  'claude-haiku-4-5-20251001',
}

export type Model = keyof typeof MODEL_PRICING

export interface UsageDeltas {
  readonly inputTokens: number
  readonly outputTokens: number
  /** 5-minute cache write tokens. Default 0. */
  readonly cacheWriteTokens?: number
  /** Cache read tokens (any TTL). Default 0. */
  readonly cacheReadTokens?: number
  /** 1-hour cache write tokens. Mythrun does not use 1-hour cache; if
   *  this is non-zero, computeCostUsd throws — we don't silently mis-
   *  charge by treating these as 5-min-rate writes. */
  readonly cacheWrite1hTokens?: number
}

export function computeCostUsd(model: Model, deltas: UsageDeltas): number {
  if ((deltas.cacheWrite1hTokens ?? 0) > 0) {
    throw new Error(
      `computeCostUsd: 1-hour cache_creation tokens (${String(deltas.cacheWrite1hTokens)}) ` +
        `received but not priced. Mythrun uses 5-min cache only; see design §6.`,
    )
  }
  const p = MODEL_PRICING[model]
  const cacheWrite = deltas.cacheWriteTokens ?? 0
  const cacheRead = deltas.cacheReadTokens ?? 0
  return (
    deltas.inputTokens * p.input +
    deltas.outputTokens * p.output +
    cacheWrite * p.cacheWrite +
    cacheRead * p.cacheRead
  ) / 1_000_000
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm exec vitest run src/billing/__tests__/model-pricing.test.ts --reporter=dot
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```
git add backend/src/billing/model-pricing.ts backend/src/billing/__tests__/model-pricing.test.ts
git commit -m "feat(myt-43): MODEL_PRICING + computeCostUsd with 1h-cache rejection"
```

---

## Task 6: `atomicDebit` returns `consumedSourceType`

**Files:**
- Modify: `backend/src/repo/credits.ts`
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Update existing tests for the new return shape**

Find every test that calls `atomicDebit(...)` and asserts on the returned `CreditEntry`. Update assertions to match the new shape `{ entry, consumedSourceType }`. Existing assertions like `expect(result.amount).toBe(-1)` become `expect(result.entry.amount).toBe(-1)`.

- [ ] **Step 2: Add new tests for `consumedSourceType`**

Append to `backend/src/repo/__tests__/credits.test.ts`:

```typescript
describe('atomicDebit — consumedSourceType', () => {
  it('trial-only user: consumedSourceType === "trial"', async () => {
    const userId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES ($1, $2, 'Trial User', $2, false)`,
      [userId, `cs:${userId}`],
    )
    await repo.grant({
      userId, creditType: 'session', amount: 1, sourceType: 'trial',
    })
    const result = await repo.atomicDebit({
      userId, creditType: 'session', amount: 1, sourceId: uuidv7(),
    })
    expect(result.consumedSourceType).toBe('trial')
  })

  it('purchase-only user: consumedSourceType === "purchase"', async () => {
    const userId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES ($1, $2, 'Purchase User', $2, false)`,
      [userId, `cs:${userId}`],
    )
    const purchaseId = uuidv7()
    await pool.query(
      `INSERT INTO purchases (id, user_id, stripe_payment_intent_id, lookup_key, amount_minor, currency, status)
       VALUES ($1, $2, $3, 'sku_session', 500, 'usd', 'succeeded')`,
      [purchaseId, userId, `pi_${userId}`],
    )
    await repo.grant({
      userId, creditType: 'session', amount: 1, sourceType: 'purchase',
      sourcePurchaseId: purchaseId,
    })
    const result = await repo.atomicDebit({
      userId, creditType: 'session', amount: 1, sourceId: uuidv7(),
    })
    expect(result.consumedSourceType).toBe('purchase')
  })
})
```

(Adjust the user / purchase setup to match the existing test infrastructure's helpers; the snippets above show the shape.)

- [ ] **Step 3: Run tests to verify they fail**

```
pnpm exec vitest run src/repo/__tests__/credits.test.ts --reporter=dot
```

Expected: the new `consumedSourceType` tests fail. The existing tests may also fail because they expected the old `CreditEntry` return shape.

- [ ] **Step 4: Modify `atomicDebit` to return the new shape**

In `backend/src/repo/credits.ts`, find the `atomicDebit` function. After the balance check passes (around line 287, before the INSERT at line 300), insert the source-type lookup:

```typescript
        // After the balance check passes, look up the source_type of
        // the FIFO-oldest unexpired positive credit row. Under the
        // mutual-exclusion invariant maintained by grantInTx's auto-
        // burn, all unexpired positive credits at any moment are the
        // same source-type-class. Returned to the caller so the
        // Session Runtime can decide trial-mode vs full-mode.
        const sourceTypeResult = await client.query<{ source_type: string }>(
          `SELECT source_type FROM credit_ledger
            WHERE user_id = $1 AND credit_type = $2
              AND amount > 0
              AND (expires_at IS NULL OR expires_at > now())
            ORDER BY granted_at ASC, id ASC
            LIMIT 1`,
          [input.userId, input.creditType],
        )
        const sourceTypeRow = sourceTypeResult.rows[0]
        if (!sourceTypeRow) {
          // Balance check passed (available >= amount), so by construction
          // at least one positive unexpired row exists. If we reach here,
          // something is structurally wrong — bail loudly.
          await client.query('ROLLBACK')
          inTransaction = false
          throw new Error(
            `atomicDebit: balance check passed but no positive unexpired ` +
              `credit row found for user ${input.userId} (${input.creditType}). ` +
              `Possible ledger inconsistency.`,
          )
        }
        const consumedSourceType = sourceTypeRow.source_type as AtomicDebitResult['consumedSourceType']
```

Then change the return:

```typescript
        const row = insertResult.rows[0]
        if (!row) throw new Error('atomicDebit: INSERT returned no row')
        return { entry: toCreditEntry(row), consumedSourceType }
```

Update the function's return type annotation: `Promise<AtomicDebitResult>` (import from `./types.js`).

- [ ] **Step 5: Run tests to verify they pass**

```
pnpm exec vitest run src/repo/__tests__/credits.test.ts --reporter=dot
```

Expected: all tests pass (existing assertions updated in Step 1, new tests for consumedSourceType pass).

- [ ] **Step 6: Run typecheck — catch any callers of atomicDebit that need updating**

```
pnpm --filter backend typecheck
```

Expected: clean. If any non-test caller is broken, fix the call site.

- [ ] **Step 7: Commit**

```
git add backend/src/repo/credits.ts backend/src/repo/__tests__/credits.test.ts
git commit -m "feat(myt-43): atomicDebit returns {entry, consumedSourceType}"
```

---

## Task 7: Trial-burn in `grantInTx`

**Files:**
- Modify: `backend/src/repo/credits.ts`
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/repo/__tests__/credits.test.ts`:

```typescript
describe('grantInTx — trial-burn on first paid grant', () => {
  async function setupTrialUser(): Promise<string> {
    const userId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES ($1, $2, 'Trial User', $2, true)`,
      [userId, `cs:${userId}`],
    )
    await repo.grant({
      userId, creditType: 'session', amount: 1, sourceType: 'trial',
    })
    return userId
  }

  it('granting a "purchase" credit when trial credit exists → trial credit burned', async () => {
    const userId = await setupTrialUser()
    const purchaseId = uuidv7()
    await pool.query(
      `INSERT INTO purchases (id, user_id, stripe_payment_intent_id, lookup_key, amount_minor, currency, status)
       VALUES ($1, $2, $3, 'sku_session', 500, 'usd', 'succeeded')`,
      [purchaseId, userId, `pi_${userId}`],
    )
    await repo.grant({
      userId, creditType: 'session', amount: 5, sourceType: 'purchase',
      sourcePurchaseId: purchaseId,
    })

    // Balance: -1 (trial burned) + 1 (trial grant) + 5 (paid grant) = 5
    const balance = await repo.balance(userId, 'session')
    expect(balance).toBe(5)

    // Burn row exists with deterministic source_id
    const burnRows = await pool.query(
      `SELECT * FROM credit_ledger WHERE user_id = $1 AND source_type = 'debit' AND amount < 0`,
      [userId],
    )
    expect(burnRows.rows.length).toBe(1)
    expect(burnRows.rows[0].amount).toBe(-1)
  })

  it('granting "subscription" when trial credit exists → trial credit burned', async () => {
    const userId = await setupTrialUser()
    const billingHistoryId = uuidv7()
    await pool.query(
      `INSERT INTO billing_history (id, user_id, stripe_invoice_id, lookup_key, period_start, period_end, status)
       VALUES ($1, $2, $3, 'tier_wayfarer', now(), now() + interval '30 days', 'paid')`,
      [billingHistoryId, userId, `in_${userId}`],
    )
    await repo.grant({
      userId, creditType: 'session', amount: 4, sourceType: 'subscription',
      sourceBillingHistoryId: billingHistoryId,
    })

    const balance = await repo.balance(userId, 'session')
    expect(balance).toBe(4)
  })

  it('granting "gift" when trial credit exists → NO burn', async () => {
    const userId = await setupTrialUser()
    await repo.grant({
      userId, creditType: 'session', amount: 2, sourceType: 'gift',
    })

    const balance = await repo.balance(userId, 'session')
    expect(balance).toBe(3)  // 1 trial + 2 gift, no burn

    const burnRows = await pool.query(
      `SELECT * FROM credit_ledger WHERE user_id = $1 AND source_type = 'debit'`,
      [userId],
    )
    expect(burnRows.rows.length).toBe(0)
  })

  it('granting "purchase" with no trial credit → no burn row written', async () => {
    const userId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES ($1, $2, 'No Trial', $2, false)`,
      [userId, `cs:${userId}`],
    )
    const purchaseId = uuidv7()
    await pool.query(
      `INSERT INTO purchases (id, user_id, stripe_payment_intent_id, lookup_key, amount_minor, currency, status)
       VALUES ($1, $2, $3, 'sku_session', 500, 'usd', 'succeeded')`,
      [purchaseId, userId, `pi_${userId}`],
    )
    await repo.grant({
      userId, creditType: 'session', amount: 5, sourceType: 'purchase',
      sourcePurchaseId: purchaseId,
    })

    const burnRows = await pool.query(
      `SELECT * FROM credit_ledger WHERE user_id = $1 AND source_type = 'debit'`,
      [userId],
    )
    expect(burnRows.rows.length).toBe(0)
  })

  it('second "purchase" grant after first burn → ON CONFLICT no-ops the second burn', async () => {
    const userId = await setupTrialUser()
    const purchaseId1 = uuidv7()
    const purchaseId2 = uuidv7()
    for (const pid of [purchaseId1, purchaseId2]) {
      await pool.query(
        `INSERT INTO purchases (id, user_id, stripe_payment_intent_id, lookup_key, amount_minor, currency, status)
         VALUES ($1, $2, $3, 'sku_session', 500, 'usd', 'succeeded')`,
        [pid, userId, `pi_${pid}`],
      )
    }
    await repo.grant({
      userId, creditType: 'session', amount: 5, sourceType: 'purchase',
      sourcePurchaseId: purchaseId1,
    })
    await repo.grant({
      userId, creditType: 'session', amount: 5, sourceType: 'purchase',
      sourcePurchaseId: purchaseId2,
    })

    // Balance: -1 (one burn) + 1 (trial) + 5 + 5 = 10
    const balance = await repo.balance(userId, 'session')
    expect(balance).toBe(10)

    const burnRows = await pool.query(
      `SELECT * FROM credit_ledger WHERE user_id = $1 AND source_type = 'debit'`,
      [userId],
    )
    expect(burnRows.rows.length).toBe(1)  // ON CONFLICT idempotent
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm exec vitest run src/repo/__tests__/credits.test.ts --reporter=dot
```

Expected: the trial-burn tests fail (no burn logic yet).

- [ ] **Step 3: Implement trial-burn in `grantInTx`**

In `backend/src/repo/credits.ts`, modify the standalone `grantInTx` function (lines 32-78). After the user-row FOR UPDATE check (around line 47-48), before the INSERT (around line 57), insert:

```typescript
  // Trial-burn: when granting a paid credit, burn any unexpired trial
  // credits in the same tx. Maintains the trial/paid mutual-exclusion
  // invariant the Session Runtime relies on.
  if (input.sourceType === 'purchase' || input.sourceType === 'subscription') {
    await burnUnexpiredTrialCredits(tx, input.userId, input.creditType)
  }
```

Then add the helper function (also at module level, since it's exported from credits.ts internally):

```typescript
/** Mythrun-pinned namespace UUID for trial-burn source_ids. Generated
 *  once and never changes; rotating it would orphan existing burn rows
 *  from their idempotency check. */
const TRIAL_BURN_NAMESPACE = '019700e0-0000-7000-8000-000000000003'

async function burnUnexpiredTrialCredits(
  tx: ClientLike,
  userId: string,
  creditType: CreditType,
): Promise<void> {
  const trialSum = await tx.query<{ trial_balance: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS trial_balance
       FROM credit_ledger
      WHERE user_id = $1 AND credit_type = $2
        AND source_type = 'trial' AND amount > 0
        AND (expires_at IS NULL OR expires_at > now())`,
    [userId, creditType],
  )
  const balance = Number(trialSum.rows[0]?.trial_balance ?? 0)
  if (balance <= 0) return

  // Idempotent burn: source_id is a deterministic UUIDv5 derived from
  // (userId, creditType). ON CONFLICT DO NOTHING handles webhook
  // redelivery: the second call sees the existing burn row and skips.
  const burnSourceId = uuidv5(`${userId}:${creditType}`, TRIAL_BURN_NAMESPACE)
  await tx.query(
    `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
     VALUES ($1, $2, $3, $4, 'debit', $5)
     ON CONFLICT (user_id, credit_type, source_id) WHERE source_type = 'debit' DO NOTHING`,
    [uuidv7(), userId, creditType, -balance, burnSourceId],
  )
}
```

Add the imports at the top of `credits.ts`:

```typescript
import { uuidv5 } from './uuidv5.js'
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm exec vitest run src/repo/__tests__/credits.test.ts --reporter=dot
```

Expected: all 5 trial-burn tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```
git add backend/src/repo/credits.ts backend/src/repo/__tests__/credits.test.ts
git commit -m "feat(myt-43): grantInTx auto-burns trial credit on first paid grant"
```

---

## Task 8: `tryDebitForSession` wrapper

**Files:**
- Modify: `backend/src/repo/credits.ts`
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/repo/__tests__/credits.test.ts`:

```typescript
describe('tryDebitForSession', () => {
  it('sufficient balance: ok=true with consumedSourceType', async () => {
    const userId = uuidv7()
    const sessionId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES ($1, $2, 'Player', $2, false)`,
      [userId, `cs:${userId}`],
    )
    await repo.grant({
      userId, creditType: 'session', amount: 1, sourceType: 'trial',
    })

    const result = await repo.tryDebitForSession(userId, sessionId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.consumedSourceType).toBe('trial')
    }
  })

  it('insufficient balance: ok=false with code/available/required', async () => {
    const userId = uuidv7()
    const sessionId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES ($1, $2, 'Empty Player', $2, false)`,
      [userId, `cs:${userId}`],
    )

    const result = await repo.tryDebitForSession(userId, sessionId)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('insufficient_credits')
      expect(result.available).toBe(0)
      expect(result.required).toBe(1)
    }
  })

  it('non-existent user: throws UserNotFoundError', async () => {
    const fakeUserId = uuidv7()
    await expect(repo.tryDebitForSession(fakeUserId, uuidv7())).rejects.toBeInstanceOf(UserNotFoundError)
  })

  it('idempotency: same sessionId twice returns same prior debit', async () => {
    const userId = uuidv7()
    const sessionId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES ($1, $2, 'Player', $2, false)`,
      [userId, `cs:${userId}`],
    )
    await repo.grant({ userId, creditType: 'session', amount: 1, sourceType: 'trial' })

    const r1 = await repo.tryDebitForSession(userId, sessionId)
    const r2 = await repo.tryDebitForSession(userId, sessionId)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    // Only one debit row should exist
    const debits = await pool.query(
      `SELECT * FROM credit_ledger WHERE user_id = $1 AND source_type = 'debit' AND source_id = $2`,
      [userId, sessionId],
    )
    expect(debits.rows.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm exec vitest run src/repo/__tests__/credits.test.ts --reporter=dot
```

Expected: tryDebitForSession tests fail (function not defined).

- [ ] **Step 3: Implement `tryDebitForSession`**

In `backend/src/repo/credits.ts`, inside the `createCreditsRepo` return object (after `atomicDebit` near line 333), add:

```typescript
    /**
     * Wrap atomicDebit with a typed result for the "out of credits" path.
     * Always debits 1 session credit; the per-session $/cost is observability-
     * only (Stripe charges a fixed $/session at the consumer surface).
     *
     * The HTTP route that consumes this responds 402 Payment Required +
     * {code, available, required} on the !ok path. See design §7.4.
     */
    tryDebitForSession: async (
      userId: string,
      sessionId: string,
    ): Promise<TryDebitResult> => {
      try {
        const result = await this.atomicDebit({
          userId,
          creditType: 'session',
          amount: 1,
          sourceId: sessionId,
        })
        return { ok: true, consumedSourceType: result.consumedSourceType }
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return {
            ok: false,
            code: 'insufficient_credits',
            available: err.available,
            required: err.required,
          }
        }
        throw err
      }
    },
```

Note: `this` doesn't work inside an object literal in TS the same way as in a class. Replace `this.atomicDebit` with a direct call to the local function — restructure if needed (the existing `atomicDebit` method's body could be hoisted to a module-private function, then both `atomicDebit` and `tryDebitForSession` call it).

Simpler: have `tryDebitForSession` invoke the same SQL recipe directly, OR refactor the createCreditsRepo factory to make `atomicDebit` a closure-bound function visible to `tryDebitForSession`.

Add `TryDebitResult` to the imports from `./types.js`.

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm exec vitest run src/repo/__tests__/credits.test.ts --reporter=dot
```

Expected: all 4 tryDebitForSession tests pass.

- [ ] **Step 5: Commit**

```
git add backend/src/repo/credits.ts backend/src/repo/__tests__/credits.test.ts
git commit -m "feat(myt-43): tryDebitForSession wrapper with typed insufficient-credits result"
```

---

## Task 9: `recordUsage` + `budgetSummary`

**Files:**
- Modify: `backend/src/repo/sessions.ts`
- Modify: `backend/src/repo/__tests__/sessions.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/repo/__tests__/sessions.test.ts`:

```typescript
describe('recordUsage / budgetSummary', () => {
  async function makeSession(): Promise<{ userId: string; campaignId: string; sessionId: string }> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const sessionId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES ($1, $2, 'Player', $2, false)`,
      [userId, `cs:${userId}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status, language)
       VALUES ($1, $2, 'World', 'concept', 'complete', 'en')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status, language)
       VALUES ($1, $2, $3, 'Campaign', 'active', 'en')`,
      [campaignId, worldId, userId],
    )
    await pool.query(
      `INSERT INTO sessions (id, campaign_id, session_number, status)
       VALUES ($1, $2, 1, 'active')`,
      [sessionId, campaignId],
    )
    return { userId, campaignId, sessionId }
  }

  it('first call inserts row with deltas + computed cost', async () => {
    const { sessionId } = await makeSession()
    const result = await repo.recordUsage(sessionId, 'claude-sonnet-4-6', {
      inputTokens: 1000,
      outputTokens: 500,
    })
    expect(result.inputTokens).toBe(1000)
    expect(result.outputTokens).toBe(500)
    // sonnet: 1000 * 3 + 500 * 15 = 3000 + 7500 = 10500 / 1M = 0.0105
    expect(result.estimatedCostUsd).toBeCloseTo(0.0105, 6)
  })

  it('second call increments existing row', async () => {
    const { sessionId } = await makeSession()
    await repo.recordUsage(sessionId, 'claude-haiku-4-5-20251001', {
      inputTokens: 1000, outputTokens: 100,
    })
    const result = await repo.recordUsage(sessionId, 'claude-sonnet-4-6', {
      inputTokens: 500, outputTokens: 50,
    })
    expect(result.inputTokens).toBe(1500)
    expect(result.outputTokens).toBe(150)
  })

  it('cacheWriteTokens + cacheReadTokens go to separate columns', async () => {
    const { sessionId } = await makeSession()
    const result = await repo.recordUsage(sessionId, 'claude-sonnet-4-6', {
      inputTokens: 100,
      outputTokens: 50,
      cacheWriteTokens: 200,
      cacheReadTokens: 1000,
    })
    expect(result.inputTokens).toBe(100)
    expect(result.cacheWriteTokens).toBe(200)
    expect(result.cacheReadTokens).toBe(1000)
  })

  it('budgetSummary returns null for sessions with no usage', async () => {
    const { sessionId } = await makeSession()
    const result = await repo.budgetSummary(sessionId)
    expect(result).toBeNull()
  })

  it('budgetSummary returns the row after recordUsage', async () => {
    const { sessionId } = await makeSession()
    await repo.recordUsage(sessionId, 'claude-haiku-4-5-20251001', {
      inputTokens: 1000, outputTokens: 100,
    })
    const result = await repo.budgetSummary(sessionId)
    expect(result).not.toBeNull()
    expect(result!.inputTokens).toBe(1000)
  })

  it('recordUsage on non-existent session throws SessionNotFoundError', async () => {
    const fakeId = uuidv7()
    await expect(
      repo.recordUsage(fakeId, 'claude-haiku-4-5-20251001', {
        inputTokens: 100, outputTokens: 50,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError)
  })

  it('returned cumulative totals match what budgetSummary returns', async () => {
    const { sessionId } = await makeSession()
    const r1 = await repo.recordUsage(sessionId, 'claude-haiku-4-5-20251001', {
      inputTokens: 1000, outputTokens: 100,
    })
    const summary = await repo.budgetSummary(sessionId)
    expect(summary).toEqual(r1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm exec vitest run src/repo/__tests__/sessions.test.ts --reporter=dot
```

Expected: 7 new tests fail (functions not defined).

- [ ] **Step 3: Implement `recordUsage` + `budgetSummary`**

In `backend/src/repo/sessions.ts`, inside the `createSessionsRepo` return object, add:

```typescript
    recordUsage: async (
      sessionId: string,
      model: Model,
      deltas: UsageDeltas,
    ): Promise<SessionUsage> => {
      const cost = computeCostUsd(model, deltas)
      const result = await pool.query<SessionUsageDbRow>(
        `INSERT INTO session_usage
           (id, session_id, campaign_id, user_id,
            input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
            estimated_cost_usd)
         SELECT $1, s.id, s.campaign_id, c.created_by, $3, $4, $5, $6, $7
           FROM sessions s
           JOIN campaigns c ON c.id = s.campaign_id
          WHERE s.id = $2
         ON CONFLICT (session_id) DO UPDATE
           SET input_tokens       = session_usage.input_tokens       + EXCLUDED.input_tokens,
               output_tokens      = session_usage.output_tokens      + EXCLUDED.output_tokens,
               cache_write_tokens = session_usage.cache_write_tokens + EXCLUDED.cache_write_tokens,
               cache_read_tokens  = session_usage.cache_read_tokens  + EXCLUDED.cache_read_tokens,
               estimated_cost_usd = session_usage.estimated_cost_usd + EXCLUDED.estimated_cost_usd
         RETURNING *`,
        [
          uuidv7(),
          sessionId,
          deltas.inputTokens,
          deltas.outputTokens,
          deltas.cacheWriteTokens ?? 0,
          deltas.cacheReadTokens ?? 0,
          cost,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new SessionNotFoundError(sessionId)
      return toSessionUsage(row)
    },

    budgetSummary: async (sessionId: string): Promise<SessionUsage | null> => {
      const result = await pool.query<SessionUsageDbRow>(
        `SELECT * FROM session_usage WHERE session_id = $1`,
        [sessionId],
      )
      const row = result.rows[0]
      return row ? toSessionUsage(row) : null
    },
```

Add imports at the top of `sessions.ts`:

```typescript
import { computeCostUsd, type Model, type UsageDeltas } from '../billing/model-pricing.js'
import { toSessionUsage, type SessionUsageDbRow } from './mappers.js'
import type { Session, SessionUsage, ... } from './types.js'
import { SessionNotFoundError } from './sessions-errors.js'
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm exec vitest run src/repo/__tests__/sessions.test.ts --reporter=dot
```

Expected: all new tests pass.

- [ ] **Step 5: Commit**

```
git add backend/src/repo/sessions.ts backend/src/repo/__tests__/sessions.test.ts
git commit -m "feat(myt-43): sessions.recordUsage + budgetSummary (Postgres-only, no Redis)"
```

---

## Task 10: `worlds.getDemo`

**Files:**
- Modify: `backend/src/repo/worlds.ts`
- Modify: `backend/src/repo/__tests__/worlds.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/repo/__tests__/worlds.test.ts`:

```typescript
describe('worlds.getDemo', () => {
  it('returns the seeded demo world', async () => {
    const result = await repo.getDemo()
    expect(result).not.toBeNull()
    expect(result!.isDemo).toBe(true)
    expect(result!.id).toBe('019700e0-0000-7000-8000-000000000002')
    expect(result!.name).toBe('Demo Adventure')
  })

  it('returns null when no demo world exists', async () => {
    // Temporarily flip the demo flag off
    await pool.query(`UPDATE worlds SET is_demo = false WHERE id = $1`, [
      '019700e0-0000-7000-8000-000000000002',
    ])
    try {
      const result = await repo.getDemo()
      expect(result).toBeNull()
    } finally {
      // Restore for next test (resetData would also fix this, but let's be tidy)
      await pool.query(`UPDATE worlds SET is_demo = true WHERE id = $1`, [
        '019700e0-0000-7000-8000-000000000002',
      ])
    }
  })

  it('toWorld correctly maps is_demo', async () => {
    const result = await repo.getDemo()
    expect(result!.isDemo).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm exec vitest run src/repo/__tests__/worlds.test.ts --reporter=dot
```

Expected: tests fail (function not defined).

- [ ] **Step 3: Implement `getDemo`**

In `backend/src/repo/worlds.ts`, inside `createWorldsRepo`'s return object, add:

```typescript
    getDemo: async (): Promise<World | null> => {
      const result = await pool.query<WorldDbRow>(
        `SELECT * FROM worlds WHERE is_demo = true LIMIT 1`,
      )
      const row = result.rows[0]
      return row ? toWorld(row) : null
    },
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm exec vitest run src/repo/__tests__/worlds.test.ts --reporter=dot
```

Expected: 3 new tests pass.

- [ ] **Step 5: Commit**

```
git add backend/src/repo/worlds.ts backend/src/repo/__tests__/worlds.test.ts
git commit -m "feat(myt-43): worlds.getDemo helper"
```

---

## Task 11: Pricing-extract Haiku prompt template

**Files:**
- Create: `backend/src/llm/prompts/billing/pricing-extract.txt`

- [ ] **Step 1: Write the prompt template**

Create the directory + file:

```
mkdir -p backend/src/llm/prompts/billing
```

Create `backend/src/llm/prompts/billing/pricing-extract.txt`:

```
You are extracting the API pricing table from an Anthropic documentation page. The page text follows below; produce a structured JSON response matching the schema you've been given.

Rules for extraction:

1. Extract one entry per Claude model that has pricing rates listed on the page (e.g., "Claude Opus 4.7", "Claude Sonnet 4.6", "Claude Haiku 4.5"). Use the exact display name as it appears on the page (the human-readable name, not the SDK slug).

2. Each entry must have four numeric rates, all in USD per million tokens (USD/MTok):
   - inputPerMTok: the base prompt token rate.
   - outputPerMTok: the generated token rate.
   - cacheWritePerMTok: the 5-minute cache write rate. The page may also list a "1-hour cache write" rate (typically 2× input) — IGNORE that one. Use the 5-minute rate (typically 1.25× input).
   - cacheReadPerMTok: the cache read rate (the same value applies to both 5-minute and 1-hour cache reads, typically 0.10× input).

3. Output rates as plain numbers (e.g., 3.00, 0.30). No currency symbols, no per-million-token suffix, no commas.

4. If the page lists multiple cache write rates, the 5-minute rate is the smaller of the two (1.25× input < 2× input).

5. Skip any model that doesn't have a complete set of four rates listed. Skip Claude legacy models (3.x) unless they're prominently in the current pricing table.

6. Do not invent rates. If a value isn't on the page, the model entry should not be included in the response.

Return only the structured JSON your schema requires.
```

- [ ] **Step 2: Verify the prompt directory loads correctly**

The `loadPrompt` function in `backend/src/llm/prompts.ts` reads from `src/llm/prompts/<area>/<name>.txt`. Verify with a quick test:

```
cd backend && node --input-type=module -e "
const { loadPrompt } = await import('./src/llm/prompts.ts')
console.log(loadPrompt('billing', 'pricing-extract').slice(0, 100))
"
```

Expected: prints the first 100 chars of the prompt. (If `loadPrompt` doesn't exist or has a different signature, fall back to direct fs.readFileSync at the call site.)

- [ ] **Step 3: Update `backend/Dockerfile` if it explicitly copies prompt files**

Check whether the Dockerfile bundles the prompts:

```
grep -n 'prompts' backend/Dockerfile
```

If a `cp -r src/llm/prompts dist/llm/prompts` or similar exists in the build script, the new `billing/pricing-extract.txt` is automatically included via the directory copy. No further action needed.

- [ ] **Step 4: Commit**

```
git add backend/src/llm/prompts/billing/pricing-extract.txt
git commit -m "feat(myt-43): pricing-extract Haiku prompt template for daily drift check"
```

---

## Task 12: `check-pricing-drift.ts` script

**Files:**
- Create: `backend/scripts/check-pricing-drift.ts`

- [ ] **Step 1: Implement the drift-check script**

Create `backend/scripts/check-pricing-drift.ts`:

```typescript
// backend/scripts/check-pricing-drift.ts
//
// Daily job: fetch Anthropic pricing docs, extract via Haiku with a Zod
// schema + sanity bounds, diff against MODEL_PRICING. Exit non-zero with
// a clear per-rate diff if anything differs.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md §5.2
// CI:   .github/workflows/llm-pricing-drift.yml (daily 14:00 UTC)

import { generateText, Output } from 'ai'
import { z } from 'zod'
import { HAIKU } from '../src/llm/models.js'
import { MODEL_PRICING, MODEL_DISPLAY_NAMES } from '../src/billing/model-pricing.js'
import { loadPrompt } from '../src/llm/prompts.js'

const PRICING_DOC_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const PAGE_MARKER = 'MTok'
const USER_AGENT = 'Mythrun-Pricing-Drift/1.0 (ops@mythrun.com)'

const ABSOLUTE_INPUT_RANGE = [0.10, 50] as const
const ABSOLUTE_OUTPUT_RANGE = [0.50, 250] as const
const CACHE_WRITE_MULT_RANGE = [1.0, 2.5] as const
const CACHE_READ_MULT_RANGE = [0.05, 0.20] as const
const DRIFT_EPSILON = 1e-6

const PricingSchema = z.object({
  models: z.array(
    z.object({
      displayName: z.string(),
      inputPerMTok: z.number(),
      outputPerMTok: z.number(),
      cacheWritePerMTok: z.number(),
      cacheReadPerMTok: z.number(),
    }),
  ),
})

async function main(): Promise<void> {
  const pageResponse = await fetch(PRICING_DOC_URL, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'manual',
  })
  if (pageResponse.status >= 300 && pageResponse.status < 400) {
    console.error(`pricing-drift: docs URL redirected (status ${String(pageResponse.status)}); manual review required`)
    process.exit(1)
  }
  if (!pageResponse.ok) {
    console.error(`pricing-drift: docs fetch failed ${String(pageResponse.status)}`)
    process.exit(1)
  }
  const pageText = await pageResponse.text()
  if (!pageText.includes(PAGE_MARKER)) {
    console.error(`pricing-drift: page does not contain '${PAGE_MARKER}' marker; doc structure may have changed`)
    process.exit(1)
  }

  const result = await generateText({
    model: HAIKU,
    output: Output.object({ schema: PricingSchema }),
    system: loadPrompt('billing', 'pricing-extract'),
    prompt: pageText,
  })

  for (const m of result.output.models) {
    if (m.inputPerMTok < ABSOLUTE_INPUT_RANGE[0] || m.inputPerMTok > ABSOLUTE_INPUT_RANGE[1]) {
      bailOnSanity(m.displayName, 'input', m.inputPerMTok, ABSOLUTE_INPUT_RANGE)
    }
    if (m.outputPerMTok < ABSOLUTE_OUTPUT_RANGE[0] || m.outputPerMTok > ABSOLUTE_OUTPUT_RANGE[1]) {
      bailOnSanity(m.displayName, 'output', m.outputPerMTok, ABSOLUTE_OUTPUT_RANGE)
    }
    const cwMult = m.cacheWritePerMTok / m.inputPerMTok
    if (cwMult < CACHE_WRITE_MULT_RANGE[0] || cwMult > CACHE_WRITE_MULT_RANGE[1]) {
      bailOnSanity(m.displayName, 'cacheWrite_mult', cwMult, CACHE_WRITE_MULT_RANGE)
    }
    const crMult = m.cacheReadPerMTok / m.inputPerMTok
    if (crMult < CACHE_READ_MULT_RANGE[0] || crMult > CACHE_READ_MULT_RANGE[1]) {
      bailOnSanity(m.displayName, 'cacheRead_mult', crMult, CACHE_READ_MULT_RANGE)
    }
  }

  const drifts: string[] = []
  const newModels: string[] = []
  for (const m of result.output.models) {
    const slug = MODEL_DISPLAY_NAMES[m.displayName]
    if (!slug) {
      newModels.push(m.displayName)
      continue
    }
    const ours = MODEL_PRICING[slug]
    if (!ours) {
      newModels.push(`${m.displayName} → ${slug} (mapping exists but constant missing)`)
      continue
    }
    const checks: [string, number, number][] = [
      ['input', ours.input, m.inputPerMTok],
      ['output', ours.output, m.outputPerMTok],
      ['cacheWrite', ours.cacheWrite, m.cacheWritePerMTok],
      ['cacheRead', ours.cacheRead, m.cacheReadPerMTok],
    ]
    for (const [name, oursRate, theirsRate] of checks) {
      if (Math.abs(oursRate - theirsRate) > DRIFT_EPSILON) {
        drifts.push(
          `${slug}.${name}: ours=${String(oursRate)} docs=${String(theirsRate)} delta=${(theirsRate - oursRate).toFixed(4)}`,
        )
      }
    }
  }
  for (const slug of Object.keys(MODEL_PRICING)) {
    const present = result.output.models.some((m) => MODEL_DISPLAY_NAMES[m.displayName] === slug)
    if (!present) drifts.push(`${slug}: not present in docs (model may have been retired or display-name renamed)`)
  }

  for (const m of newModels) console.log(`pricing-drift: new model on docs page (informational): ${m}`)
  if (drifts.length > 0) {
    console.error('pricing-drift: DRIFT DETECTED')
    for (const d of drifts) console.error(`  ${d}`)
    process.exit(3)
  }
  console.log('pricing-drift: OK — all rates match')
}

function bailOnSanity(displayName: string, field: string, val: number, range: readonly [number, number]): never {
  console.error(`pricing-drift: ${displayName}.${field} = ${String(val)} outside sanity bounds [${String(range[0])}, ${String(range[1])}]`)
  process.exit(2)
}

main().catch((err: unknown) => {
  console.error('pricing-drift: unhandled error', err)
  process.exit(1)
})
```

- [ ] **Step 2: Verify the script typechecks**

```
pnpm --filter backend typecheck
```

Expected: clean.

- [ ] **Step 3: Run the script locally against the live docs page (smoke test)**

```
cd backend && ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY .env.development | cut -d= -f2) \
  pnpm exec tsx scripts/check-pricing-drift.ts
```

Expected: `pricing-drift: OK — all rates match`. If drift is reported, either MODEL_PRICING is wrong (update it) or Anthropic just changed prices (update both).

- [ ] **Step 4: Commit**

```
git add backend/scripts/check-pricing-drift.ts
git commit -m "feat(myt-43): daily Anthropic-pricing drift-check script"
```

---

## Task 13: GitHub Actions workflow for daily drift check

**Files:**
- Create: `.github/workflows/llm-pricing-drift.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/llm-pricing-drift.yml`:

```yaml
name: LLM pricing drift check
on:
  schedule:
    - cron: '0 14 * * *'  # daily 14:00 UTC ≈ 9am US Eastern
  workflow_dispatch:

jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_DRIFT_CHECK }}
        run: pnpm --filter backend exec tsx scripts/check-pricing-drift.ts
```

- [ ] **Step 2: Document the manual prerequisite**

The `ANTHROPIC_API_KEY_DRIFT_CHECK` secret needs to be added to the repository's GitHub Actions secrets manually. **You'll do this after the push.** (Sub-skill: this step requires a human action; do not block the implementer on it.)

Add a one-line note in the workflow file's leading comment:

```yaml
# Requires repo secret ANTHROPIC_API_KEY_DRIFT_CHECK (a separate Anthropic key
# scoped to the drift-check use case — keeps prod-key blast radius zero if
# this CI key ever leaks). Add via Settings → Secrets and variables → Actions.
```

- [ ] **Step 3: Commit**

```
git add .github/workflows/llm-pricing-drift.yml
git commit -m "ci(myt-43): daily LLM pricing-drift workflow"
```

---

## Task 14: Schema-parity test update

**Files:**
- Modify: `backend/src/db/__tests__/migrate-schema.test.ts`

- [ ] **Step 1: Read the test file's expected-migrations + expected-indexes lists**

```
grep -n "EXPECTED_MIGRATIONS\|EXPECTED_IDX_NAMES" backend/src/db/__tests__/migrate-schema.test.ts
```

- [ ] **Step 2: Add migration 008 to the expected list**

In `backend/src/db/__tests__/migrate-schema.test.ts`, find the `EXPECTED_MIGRATIONS` constant and append `'008_billing_metering.sql'` to the array.

- [ ] **Step 3: Add the new indexes to the expected-indexes set**

Find the `EXPECTED_IDX_NAMES` constant and append:

```typescript
  'idx_session_usage_one_per_session',
  'idx_worlds_one_demo',
```

- [ ] **Step 4: Run the schema-parity tests**

```
pnpm exec vitest run src/db/__tests__/migrate-schema.test.ts --reporter=dot
```

Expected: all tests pass against the post-008 schema.

- [ ] **Step 5: Run the full test suite**

```
pnpm exec vitest run --reporter=dot
```

Expected: all tests pass. The new resetData behavior + new repo functions all integrate cleanly.

- [ ] **Step 6: Commit**

```
git add backend/src/db/__tests__/migrate-schema.test.ts
git commit -m "test(myt-43): pin migration 008 + new indexes in schema-parity test"
```

---

## Task 15: Source-spec sync

**Files:**
- Modify: `docs/specs/2026-04-13-billing-cost-controls.md`
- Modify: `docs/specs/2026-04-13-backend-core.md`
- Modify: `docs/specs/2026-04-06-production-architecture-overview.md`

- [ ] **Step 1: `billing-cost-controls.md` §6 Token Budget table**

Find the §6 token-budget table (around line 287-294). Insert before it:

> **✓ Superseded in MYT-43:** the model-blind 500K-output-tokens cap below is replaced by cost-cap + FT-context-cap + Slow-Thinker narrative-wrap. A model-blind token budget gives ~19× cost variance across model mixes (Opus-heavy at 500K = $37.50; Haiku-heavy = $2). Cost is the meaningful enforcement metric. The original table is preserved below for historical context.

- [ ] **Step 2: `billing-cost-controls.md` §6 Token Accumulation**

Find §6 Token Accumulation (around line 297-305). Replace with:

> Live cost tracking is Postgres-only. Every LLM call invokes `repo.sessions.recordUsage(sessionId, model, deltas)`, which UPSERTs the per-session row in `session_usage` and returns the running totals. The Slow Thinker's wrap-up signal is computed inline from the returned cost.
>
> Cost-cap-approaching is the **primary** session-end trigger — when accumulated cost hits the warn threshold (e.g., 80% of cap), the ST is signaled to ramp toward a graceful narrative close. The cost cap is a config value (env var or `settings` table), not a hardcoded constant. FT context cap and Slow-Thinker narrative-driven wrap are the other two end signals; all three end via the same ST-driven graceful-close path.

- [ ] **Step 3: `billing-cost-controls.md` §6 Cost Estimation**

Find §6 Cost Estimation. Replace with:

> Cost estimation uses 4 rates per model: input, output, 5-minute cache write (1.25× input), and cache read at any TTL (0.10× input). Rates are hardcoded in `backend/src/billing/model-pricing.ts`; a daily CI job (`.github/workflows/llm-pricing-drift.yml`) fetches Anthropic's pricing docs and alarms on any drift. Mythrun does not use the 1-hour cache (see MYT-43 design §6); `computeCostUsd` throws if a 1-hour cache token count is ever passed in.
>
> Cost is computed at write time per LLM call and accumulated in `session_usage.estimated_cost_usd`. This is **observability-grade approximate**, not billing-grade exact — Stripe charges users a fixed $/session price; this number powers internal cost-cap signaling, dashboards, and CloudWatch alarms.

- [ ] **Step 4: `billing-cost-controls.md` §7 Implementation**

Find §7 Implementation (lines 333-339). Replace the trial-FIRST consumption paragraph with:

> Trial credit and paid credit are **mutually exclusive states**. On the user's first paid grant (`source_type` = `'purchase'` or `'subscription'`), `grantInTx` writes a debit row burning any unexpired trial credits in the same transaction. After the burn, the user's balance is paid credits only; the next session's `atomicDebit` consumes a paid row, and `consumedSourceType === 'purchase' | 'subscription'` is the full-mode signal to the Session Runtime. (`consumedSourceType === 'trial'` is the trial-mode signal — used pre-burn only.)
>
> The burn `source_id` is a deterministic UUIDv5 derived from `(userId, creditType)`, so webhook redelivery is idempotent — the second burn ON CONFLICTs to no-op while the new paid grant lands its own row.
>
> `users.free_trial_used` remains the canonical "trial issued" flag. There is no `users.trial_granted_at` column; trial grant timestamp is derivable from `credit_ledger.granted_at WHERE source_type='trial'`.

- [ ] **Step 5: `billing-cost-controls.md` §8 Per-Session Cost Tracking schema block**

Find §8 schema (lines 366-381). Replace with the post-008 shape:

```sql
CREATE TABLE session_usage (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  user_id UUID NOT NULL REFERENCES users(id),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_session_usage_one_per_session ON session_usage (session_id);
```

- [ ] **Step 6: `billing-cost-controls.md` §10 Edge Cases — trial-FIRST row**

Find any "Trial-FIRST invariant" mention in §10's edge-case table. Replace with:

> Mutual-exclusion invariant: trial and paid credit never coexist (auto-burn at first paid grant maintains).

- [ ] **Step 7: `backend-core.md` session_usage schema block**

Find the session_usage schema reference (around line 535, the `budget_limit_tokens INTEGER NOT NULL` line) and update to match Step 5's block.

- [ ] **Step 8: `production-architecture-overview.md` §5/§7 references**

Find the session-start flow + threshold language (around lines 392, 566, 740, 744). Update threshold language to "warn at 80% of cost cap → ST wrap-up signal" rather than "warn at 80% / wind-down at 90% / hard cap at 120%". Update displayed `session_usage` schema to match Step 5.

- [ ] **Step 9: Verify no stale references remain**

```
grep -rn "budget_limit_tokens" docs/ 2>/dev/null
grep -rn "Trial-FIRST consumption" docs/ 2>/dev/null
grep -rn "trial_granted_at" docs/ 2>/dev/null
```

Expected: empty (or only matches in MYT-43-design.md's deviation tables, which deliberately reference the old terms as historical context).

- [ ] **Step 10: Commit**

```
git add docs/specs/2026-04-13-billing-cost-controls.md \
        docs/specs/2026-04-13-backend-core.md \
        docs/specs/2026-04-06-production-architecture-overview.md
git commit -m "spec(myt-43): sync source specs to MYT-43 design (Redis-dropped, mutual-exclusion, 4-rate pricing)"
```

---

## Task 16: Final verification + wiki sync + push + Linear close

**Files:** none modified by the engineer; verification + close-the-loop.

- [ ] **Step 1: Run the full backend gate**

```
pnpm --filter backend typecheck
pnpm --filter backend lint
pnpm --filter backend test
pnpm --filter backend build
```

Expected: all four green.

- [ ] **Step 2: Run wiki:check**

```
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm wiki:check
```

Expected: drift on the wiki pages whose source files MYT-43 touched (most likely `auth-billing/billing-routes.html`, `auth-billing/billing-webhook.html`, `data/repository.html`, `data/migrations.html`, `data/schema.html`, `runtime/llm.html` if cost tracking is documented there). The wiki-update subagent in Step 3 fixes this.

- [ ] **Step 3: Dispatch the wiki-update subagent**

Per `docs/wiki/AUTHORING.md`. The subagent:
1. Reads the Linear issue (`MYT-43`).
2. Reads the design + plan docs.
3. Maps changes to wiki pages.
4. Either rewrites pages (mental-model changed) or accepts drift (source-only-format-touch).
5. Builds `wiki:build` + `wiki:check`.
6. Commits the wiki changes locally. **Does NOT push** (controller does the push in Step 5).

Use `Agent` with `subagent_type: 'general-purpose'`, `model: 'opus'`, prompt parameterized with `MYT-43`.

- [ ] **Step 4: Verify the local commit log**

```
git log --oneline main..HEAD
```

Expected: ~16-18 commits in the form `feat(myt-43): ...` / `test(myt-43): ...` / `spec(myt-43): ...` / `docs(wiki): myt-43 ...` / `ci(myt-43): ...`.

- [ ] **Step 5: Push**

```
git push origin main
```

Watch the staging deploy (`gh run watch`). The new migration 008 needs to apply to staging Postgres — the bootstrap-databases.sh path or migration runner handles this. Confirm:

```
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c "SELECT * FROM _migrations ORDER BY name DESC LIMIT 3"
```

(Or the equivalent against staging Postgres if you have access — typically not in dev.)

- [ ] **Step 6: Smoke-test against staging**

```
pnpm smoke:staging
```

The smoke script doesn't yet exercise MYT-43 surfaces (no session-create endpoint exists yet — that's Session Runtime). The smoke just validates the auth chain still works post-deploy. If it passes, the deploy didn't regress.

- [ ] **Step 7: Manually add the GitHub Actions secret for the drift check**

Go to repo Settings → Secrets and variables → Actions → New repository secret:

- Name: `ANTHROPIC_API_KEY_DRIFT_CHECK`
- Value: a separate Anthropic API key scoped to the drift-check use case (create one in Anthropic Console; tag it `mythrun-pricing-drift`).

This is a one-time manual setup; subsequent pushes don't require it.

- [ ] **Step 8: Manually trigger the drift workflow once to confirm it works**

```
gh workflow run llm-pricing-drift.yml
gh run watch $(gh run list --workflow=llm-pricing-drift.yml --limit=1 --json databaseId -q '.[0].databaseId') --exit-status
```

Expected: `pricing-drift: OK — all rates match`. If drift is reported, the rates need updating in `backend/src/billing/model-pricing.ts`.

- [ ] **Step 9: Flip Linear MYT-43 to Done**

Use `mcp__linear-server__save_issue` with `id: 'MYT-43'`, `state: 'Done'`. The PostToolUse hook will fire a wiki-update reminder; if Step 3 already ran, the subagent detects no drift and exits cleanly.

---

## Self-Review Notes

**Spec coverage:** Every section of the design doc has at least one task implementing it.
- §2 contract decisions → covered across Tasks 1-10
- §3 file layout → matches the plan's File Structure section
- §4 schema migration → Task 1
- §5 model pricing → Tasks 5, 11, 12, 13
- §6 cache strategy → Task 5 (rejection of 1-hour cache tokens)
- §7 trial mutual exclusion → Tasks 6, 7, 8
- §8 recordUsage / budgetSummary → Task 9
- §9 demo world → Tasks 1 (seed), 4 (type), 10 (helper)
- §10 source-spec updates → Task 15
- §11 tests → integrated per task (TDD)
- §12 out of scope → no task; documented in design

**Placeholder scan:** No "TBD" / "implement later" / "similar to Task N" / "add error handling" appear. Every code block is complete.

**Type consistency:** `recordUsage` returns `Promise<SessionUsage>` (Task 9) matching the type defined in Task 4. `tryDebitForSession` returns `Promise<TryDebitResult>` (Task 8) matching the type from Task 4. `atomicDebit` returns `Promise<AtomicDebitResult>` (Task 6) matching Task 4's interface.
