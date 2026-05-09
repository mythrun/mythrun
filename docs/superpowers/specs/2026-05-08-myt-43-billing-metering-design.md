# MYT-43 — Billing Metering + Trial Mutual Exclusion + Demo World Design

> **Linear:** [MYT-43 — Billing: per-session token metering + budget enforcement + free trial](https://linear.app/mythrun/issue/MYT-43)
> **Source spec:** `docs/specs/2026-04-13-billing-cost-controls.md` §6 + §7 (with revisions in §10 below)
> **Status:** design — implementation pending

## 1. Goal

Ship the **data plane** for per-session cost tracking, the credit-consumption primitive that powers session start, the free-trial mutual-exclusion rule, and demo-world scaffolding. Closes the Platform milestone.

The Session Runtime (next milestone) consumes these primitives. The end-of-session hand-off works as follows: when accumulated session cost approaches the configured cap, the Slow Thinker receives a wrap-up signal and the next narrative beat ramps the session toward a graceful close. The cost-cap is the **primary** session-end mechanism, not an emergency backstop — it is expected to fire on most sessions. (FT context cap and ST narrative-driven wrap are the other two end signals; all three end the session via the same ST-driven graceful-close path.)

**Architecture simplification — Redis dropped from cost tracking.** Earlier drafts followed the source spec's "Redis live counter, Postgres 5-min checkpoint" pattern. Re-evaluation: at Mythrun's call rate (~7 calls/sec at 500 concurrent sessions, ~70 at 10×), Postgres handles per-call UPSERTs with no headroom concern, and Postgres reads at 1-3ms are negligible against 200-2000ms LLM calls. Redis was paying complexity cost (cross-source consistency, checkpoint lossy windows, crash-recovery reconciliation) for benefits we don't need (sub-ms reads, in-flight buffering). Cost tracking is now Postgres-only: `recordUsage` writes per LLM call and returns the updated running totals; the Slow Thinker's wrap-up decision reads from that return value with no extra round-trip. Redis still earns its keep elsewhere in the system (WS session-state cache + pub/sub, WS-ticket store, rate-limit backing); it just doesn't fit the cost-tracking workload.

## 2. Contract decisions (resolved against the source spec + Linear issue)

The Linear issue text and source spec §6/§7 disagree in several places. The contract this design implements:

| Axis | This design | Drift from source-of-record |
|---|---|---|
| Trial / paid coexistence | **Mutually exclusive.** On first paid grant, any unexpired trial credit is auto-burned in the same tx. Trial-FIRST ordering inside `atomicDebit` is no longer needed. | Source spec §7 line 337 referenced a "trial-FIRST consumption invariant" inside the debit recipe. That is replaced by mutual exclusion enforced at grant time. |
| `atomicDebit` return | Returns `{entry, consumedSourceType}`. The Session Runtime reads `consumedSourceType === 'trial'` as the trial-mode signal. | New surface; spec §7 line 337 deferred this redesign to MYT-43. |
| `session_usage` purpose | **The single durable cost record.** Written per LLM call via `recordUsage` UPSERT. Read by `budgetSummary` and returned by `recordUsage`. The Session Runtime's wrap-up trigger reads from `recordUsage`'s return value (no extra round-trip). No Redis layer for cost. | Linear issue described `budgetSummary` as "used by Session Runtime to decide when to halt." Resolved under the new architecture: `recordUsage` returns running totals, and the wrap-up signal is computed inline by the caller. |
| `session_usage.budget_limit_tokens` | **Dropped.** Token-budget enforcement is abandoned; we enforce on dollar cost cap, FT context size, and Slow-Thinker narrative wrap. The token-budget column is dead under that model. | Source spec §6 line 289 defined token-budget thresholds (80% warn / 90% wind-down / 120% hard cap). Superseded; spec gets revised in §10. |
| Cost cap location | Global setting (env var or `settings` table) read by Session Runtime on startup. NOT a per-row column. | Earlier draft considered a per-session `cost_cap_usd` column; identified as wrong design (every session has the same cap; per-row would be redundant noise). |
| `model` parameter in `recordUsage` | Consumed at write-time for cost computation; **not persisted**. Per-model breakdown deferred to a future analytics table if needed. | Linear issue API signature took a model param; clarifies that param is for cost math, not durable storage. |
| Pricing source-of-truth | Hardcoded `MODEL_PRICING` constants (4 rates per model: input, output, cache-write, cache-read). Daily CI cron diffs against Anthropic's pricing docs page (extracted via Haiku); alarms on any drift with floating-point epsilon. | New surface; nothing in source spec covered drift detection. LiteLLM JSON considered and rejected (third-party trust, no SLA, format risk). |
| Cache strategy | **5-minute cache.** TTL refreshes on read at no additional cost; 3-hour session of normal play stays warm with one write. 1-hour cache only wins for sessions with systematic >5min pauses. | Spec didn't pin a strategy. Justification in §6 below. |
| Trial provisioning at registration | Already shipped in `routes/users.ts:124-150` (MYT-38/MYT-42). No work in MYT-43. | Linear issue listed this as scope; it was actually shipped earlier. |
| Demo world | Add `worlds.is_demo BOOLEAN`, partial unique index for at-most-one-demo, seed one placeholder demo world owned by a new `system` users row. Real content authored later as an UPDATE. | Linear issue called for a seed migration; design pins exact schema + system-user pattern. |
| `users.trial_granted_at` column | Not added. Trial grant timestamp is derivable from `credit_ledger.granted_at WHERE source_type='trial'`. The existing `users.free_trial_used` boolean is the canonical "has the trial been issued" signal. | Linear issue suggested a new column; redundant with existing data. |

## 3. File layout

**New files:**

| Path | Responsibility |
|------|---------------|
| `backend/migrations/008_billing_metering.sql` | Schema changes: drop `session_usage.budget_limit_tokens`, add unique index `session_usage_one_per_session ON (session_id)`, add `worlds.is_demo BOOLEAN NOT NULL DEFAULT false`, partial unique index `worlds_one_demo`, seed `system` users row, seed placeholder demo world. |
| `backend/src/billing/model-pricing.ts` | `MODEL_PRICING` constants + `computeCostUsd(model, deltas: UsageDeltas)` helper. Pure, no I/O. Also exports a `displayNameToSlug` map used by the price-check (Anthropic's docs page lists models by display name; we key by slug). |
| `backend/src/repo/uuidv5.ts` | Deterministic-by-input UUIDv5 generator. Used by the trial-burn `source_id` derivation. Wraps `node:crypto`'s SHA-1 with the RFC 4122 byte-twiddling. Tiny (~15 lines); single-purpose. |
| `backend/src/billing/__tests__/model-pricing.test.ts` | Unit tests for `computeCostUsd` across mixed-model + cached/uncached scenarios. |
| `backend/scripts/check-pricing.ts` | Daily price check: fetch Anthropic pricing docs, extract via Haiku with structured output + sanity-bounds validation, diff against `MODEL_PRICING`, exit non-zero with explicit diff if any rate differs. |
| `.github/workflows/llm-price-check.yml` | Daily 14:00 UTC cron (≈9am Eastern) running the price check. CI failure → existing alarm pipeline (Slack/SNS) → 1-line PR. |

**Modified files:**

| Path | Why |
|------|-----|
| `backend/src/repo/sessions.ts` | Add `recordUsage(sessionId, model, inputTokens, outputTokens, cacheWriteTokens?, cacheReadTokens?)` (UPSERT) and `budgetSummary(sessionId)` (SELECT). Existing `create` extended to also INSERT the initial `session_usage` row in the same tx. |
| `backend/src/repo/credits.ts` | Extend `atomicDebit` return type to include `consumedSourceType`. Add trial-burn logic to `grantInTx` (and exported `grantInTx` standalone). Add `tryDebitForSession(userId, sessionId)` wrapper. |
| `backend/src/repo/worlds.ts` | Add `getDemo()` helper. |
| `backend/src/repo/types.ts` | Add `SessionUsage` type, `AtomicDebitResult` type, `TryDebitResult` discriminated union. Update `World` type to include `isDemo: boolean`. |
| `backend/src/repo/mappers.ts` | Add `toSessionUsage` and update `toWorld` to map `is_demo` column. |
| `backend/src/repo/__tests__/sessions.test.ts` | Tests for `recordUsage` / `budgetSummary` / one-row-per-session unique constraint. |
| `backend/src/repo/__tests__/credits.test.ts` | Tests for trial-burn idempotency, `consumedSourceType` returns, `tryDebitForSession` typed result. |
| `backend/src/repo/__tests__/worlds.test.ts` | Tests for `getDemo` / `is_demo` flag. |
| `docs/specs/2026-04-13-billing-cost-controls.md` | Source-spec updates per §10 below. |

## 4. Schema migration

```sql
-- backend/migrations/008_billing_metering.sql

-- 4.1 session_usage: drop the abandoned token-budget column.
-- Token-budget enforcement (§6 of the source spec) is replaced by
-- cost-cap + FT-context-cap + ST narrative wrap. The column is dead
-- under the new model; greenfield repo with no production data
-- means no migration cruft to live with.
ALTER TABLE session_usage DROP COLUMN budget_limit_tokens;

-- 4.1b session_usage: split input-side token classes into separate
-- columns so analytics doesn't lose the breakdown. Per Cardamom I5
-- from round-1 review.
ALTER TABLE session_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_usage ADD COLUMN cache_read_tokens  INTEGER NOT NULL DEFAULT 0;

-- 4.2 session_usage: pin one-row-per-session as the contract.
-- recordUsage uses ON CONFLICT (session_id) DO UPDATE; this index
-- both makes that work and prevents accidental dup rows. The
-- idx_*-prefix matches the convention used by migration 001/002.
CREATE UNIQUE INDEX idx_session_usage_one_per_session
  ON session_usage (session_id);

-- 4.3 worlds: add is_demo flag.
-- Trial-mode sessions fork from the demo world. At-most-one-demo
-- enforced via a partial unique index — multiple historical demo
-- rows with is_demo=false are fine (retired demos).
ALTER TABLE worlds ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX idx_worlds_one_demo ON worlds (is_demo) WHERE is_demo = true;

-- 4.4 Seed: system users row.
-- Owns platform-seeded content (demo world today, future SRD-derived
-- worlds, etc.). Has no Cognito identity; suspended_at is set to a
-- sentinel timestamp so the row can never authenticate even if a
-- future bug routed a JWT to its cognito_sub. The cognito_sub format
-- 'system:mythrun' cannot collide with a real Cognito-issued sub.
--
-- Column list matches the post-migration-005 users shape (email,
-- avatar_url, auth_provider were dropped in migration 005).
INSERT INTO users (
  id, cognito_sub, display_name, username,
  free_trial_used, suspended_at
)
VALUES (
  '019700e0-0000-7000-8000-000000000001'::uuid,
  'system:mythrun',
  'Mythrun System',
  'system',
  true,      -- system can't claim a trial
  '1970-01-01 00:00:00+00'::timestamptz  -- sentinel: permanently suspended
);

-- 4.5 Seed: placeholder demo world.
-- Real narrative content is a separate authoring task; this seed
-- writes the row so the trial flow has something to fork from once
-- Session Runtime ships. The placeholder makes the schema + repo
-- testable without coupling to content authoring.
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
  false,  -- demo is fork-source only; not browsable as public
  true
);
```

The seed UUIDs use the UUIDv7 pattern's high bits (`019700e0`...) to keep them sortable with real production rows but pin them to a known prefix so they're easy to grep for in queries / diagnostics.

## 5. Model pricing

### 5.1 The `MODEL_PRICING` constants

```typescript
// backend/src/billing/model-pricing.ts
//
// USD per million tokens for each model we use, across all four
// rate categories Anthropic publishes:
//   - input:           base prompt tokens
//   - output:          generated tokens
//   - cacheWrite:      prompt-cache write tokens (5-min cache only;
//                      see §6 for why we don't use the 1-hour cache)
//   - cacheRead:       prompt-cache read tokens (TTL refreshes on read)
//
// THIS IS APPROXIMATE COST FOR OBSERVABILITY, NOT BILLING.
// The user pays Stripe a fixed $/session price; these rates power
// internal cost-cap enforcement, dashboards, and CloudWatch alarms.
// Drift up to a few percent is acceptable directionally.
//
// Drift detection: scripts/check-pricing.ts runs daily under
// .github/workflows/llm-price-check.yml — fetches Anthropic's
// pricing docs page, extracts rates via Haiku (Zod-validated +
// sanity-bounded), diffs against this constant, alarms on any
// difference (with floating-point epsilon).

export const MODEL_PRICING = {
  'claude-opus-4-7':              { input: 5.00,  output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-sonnet-4-6':            { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5-20251001':    { input: 1.00,  output:  5.00, cacheWrite: 1.25,  cacheRead: 0.10 },
} as const

/** Display name → slug mapping. Used by the price-check to map
 *  Anthropic's docs-page entries (which list models by display name
 *  only — "Claude Opus 4.7" — not by slug) back to MODEL_PRICING keys. */
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
  /** 1-hour cache write tokens. Mythrun does not use the 1-hour cache
   *  (see §6 for rationale); if this is ever non-zero, it indicates a
   *  caller misconfigured a cache_control breakpoint and computeCostUsd
   *  will throw. We don't silently mis-charge by treating these as
   *  5-min-rate writes. */
  readonly cacheWrite1hTokens?: number
}

export function computeCostUsd(model: Model, deltas: UsageDeltas): number {
  if ((deltas.cacheWrite1hTokens ?? 0) > 0) {
    // Loud failure: we don't charge 1-hour cache writes at the 5-min
    // rate (60% under-charge per write), and we haven't authored a
    // 1-hour rate in MODEL_PRICING. If this fires, either set
    // cache_control.ttl back to '5m' at the call site, or extend
    // MODEL_PRICING with a cacheWrite1h rate and re-evaluate §6's
    // cache-strategy decision.
    throw new Error(
      `computeCostUsd: 1-hour cache_creation tokens (${deltas.cacheWrite1hTokens}) ` +
        `received but not priced. Mythrun uses 5-min cache only; see design §6.`,
    )
  }
  const p = MODEL_PRICING[model]
  const cacheWrite = deltas.cacheWriteTokens ?? 0
  const cacheRead = deltas.cacheReadTokens ?? 0
  return (
    deltas.inputTokens   * p.input +
    deltas.outputTokens  * p.output +
    cacheWrite           * p.cacheWrite +
    cacheRead            * p.cacheRead
  ) / 1_000_000
}
```

The cache-write rate corresponds to Anthropic's 5-minute cache (1.25× input). We don't track the 1-hour cache rate (2× input) because we don't use it; see §6 for the rationale.

The Mythrun-known model IDs above match what `backend/src/llm/models.ts` constants reference (verify at implementation time).

### 5.2 Drift detection

```typescript
// backend/scripts/check-pricing.ts
//
// Daily job. Fetches Anthropic's pricing docs page, sends the
// rendered text to Haiku with a Zod-validated structured-output
// schema, sanity-bounds the result, then diffs against MODEL_PRICING.
// Exits non-zero with a clear per-rate diff if anything differs.

import { generateText, Output } from 'ai'
import { z } from 'zod'
import { HAIKU } from '../src/llm/models.js'
import { MODEL_PRICING, MODEL_DISPLAY_NAMES } from '../src/billing/model-pricing.js'
import { loadPrompt } from '../src/llm/prompts.js'

const PRICING_DOC_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const PAGE_MARKER = 'MTok'  // sanity check that we got the actual pricing page
const USER_AGENT = 'Mythrun-Price-Check/1.0 (ops@mythrun.com)'

// Per-rate sanity bounds. Multiplier-based bounds catch order-of-
// magnitude hallucinations AND wrong-cache-tier confusion (e.g., Haiku
// returning the 1-hour cache write rate, which is 2× input not 1.25×).
const ABSOLUTE_INPUT_RANGE = [0.10, 50] as const   // USD/MTok
const ABSOLUTE_OUTPUT_RANGE = [0.50, 250] as const
const CACHE_WRITE_MULT_RANGE = [1.0, 2.5] as const  // × of input rate
const CACHE_READ_MULT_RANGE = [0.05, 0.20] as const // × of input rate

// Drift epsilon: 1e-6 USD/MTok = 1/1000th of a cent per million tokens.
// Below float roundtrip noise; well above our directional-only accuracy.
const DRIFT_EPSILON = 1e-6

const PricingSchema = z.object({
  models: z.array(z.object({
    displayName: z.string(),                // as-listed on the docs page (e.g., "Claude Opus 4.7")
    inputPerMTok: z.number(),
    outputPerMTok: z.number(),
    cacheWritePerMTok: z.number(),          // 5-minute cache write rate
    cacheReadPerMTok: z.number(),           // cache read rate (any TTL)
  })),
})

async function main(): Promise<void> {
  const pageResponse = await fetch(PRICING_DOC_URL, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'manual',  // detect if Anthropic moves the URL
  })
  if (pageResponse.status >= 300 && pageResponse.status < 400) {
    console.error(`price-check: docs URL redirected (status ${pageResponse.status}); manual review required`)
    process.exit(1)
  }
  if (!pageResponse.ok) {
    console.error(`price-check: docs fetch failed ${pageResponse.status}`)
    process.exit(1)
  }
  const pageText = await pageResponse.text()
  if (!pageText.includes(PAGE_MARKER)) {
    console.error(`price-check: page does not contain '${PAGE_MARKER}' marker; doc structure may have changed`)
    process.exit(1)
  }

  const result = await generateText({
    model: HAIKU,
    output: Output.object({ schema: PricingSchema }),
    system: loadPrompt('billing', 'pricing-extract'),
    prompt: pageText,
  })

  // Sanity bounds, model-aware. Catches both absolute hallucinations
  // and wrong-cache-tier confusion via multiplier ranges.
  for (const m of result.output.models) {
    if (m.inputPerMTok < ABSOLUTE_INPUT_RANGE[0] || m.inputPerMTok > ABSOLUTE_INPUT_RANGE[1]) {
      bailOnSanity(m.displayName, 'input', m.inputPerMTok, ABSOLUTE_INPUT_RANGE)
    }
    if (m.outputPerMTok < ABSOLUTE_OUTPUT_RANGE[0] || m.outputPerMTok > ABSOLUTE_OUTPUT_RANGE[1]) {
      bailOnSanity(m.displayName, 'output', m.outputPerMTok, ABSOLUTE_OUTPUT_RANGE)
    }
    const cacheWriteMult = m.cacheWritePerMTok / m.inputPerMTok
    if (cacheWriteMult < CACHE_WRITE_MULT_RANGE[0] || cacheWriteMult > CACHE_WRITE_MULT_RANGE[1]) {
      bailOnSanity(m.displayName, 'cacheWrite_mult', cacheWriteMult, CACHE_WRITE_MULT_RANGE)
    }
    const cacheReadMult = m.cacheReadPerMTok / m.inputPerMTok
    if (cacheReadMult < CACHE_READ_MULT_RANGE[0] || cacheReadMult > CACHE_READ_MULT_RANGE[1]) {
      bailOnSanity(m.displayName, 'cacheRead_mult', cacheReadMult, CACHE_READ_MULT_RANGE)
    }
  }

  // Diff each tracked model. Match docs entries by display name → slug
  // via MODEL_DISPLAY_NAMES (e.g., "Claude Opus 4.7" → "claude-opus-4-7").
  const drifts: string[] = []
  const newModels: string[] = []  // in docs but not in MODEL_PRICING — informational only
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
      ['input',      ours.input,      m.inputPerMTok],
      ['output',     ours.output,     m.outputPerMTok],
      ['cacheWrite', ours.cacheWrite, m.cacheWritePerMTok],
      ['cacheRead',  ours.cacheRead,  m.cacheReadPerMTok],
    ]
    for (const [name, oursRate, theirsRate] of checks) {
      if (Math.abs(oursRate - theirsRate) > DRIFT_EPSILON) {
        drifts.push(`${slug}.${name}: ours=${oursRate} docs=${theirsRate} delta=${(theirsRate - oursRate).toFixed(4)}`)
      }
    }
  }
  // Also: models we track but docs page no longer lists.
  for (const slug of Object.keys(MODEL_PRICING)) {
    const present = result.output.models.some((m) => MODEL_DISPLAY_NAMES[m.displayName] === slug)
    if (!present) drifts.push(`${slug}: not present in docs (model may have been retired or display-name renamed)`)
  }

  for (const m of newModels) console.log(`price-check: new model on docs page (informational): ${m}`)
  if (drifts.length > 0) {
    console.error('price-check: DRIFT DETECTED')
    for (const d of drifts) console.error(`  ${d}`)
    process.exit(3)
  }
  console.log('price-check: OK — all rates match')
}

function bailOnSanity(displayName: string, field: string, val: number, range: readonly [number, number]): never {
  console.error(`price-check: ${displayName}.${field} = ${val} outside sanity bounds [${range[0]}, ${range[1]}]`)
  process.exit(2)
}

main().catch((err: unknown) => {
  console.error('price-check: unhandled error', err)
  process.exit(1)
})
```

The system prompt lives in `backend/src/llm/prompts/billing/pricing-extract.txt` (per project convention — prompts are template files, not inline strings; matches the `loadPrompt('auth', 'profanity')` pattern). The prompt instructs Haiku to extract by display name, ignore the 1-hour cache write rate, and produce the 4 required rates per model.

```yaml
# .github/workflows/llm-price-check.yml
name: LLM price check
on:
  schedule: [{ cron: '0 14 * * *' }]   # 14:00 UTC daily ≈ 9am US Eastern
  workflow_dispatch:
jobs:
  price-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_PRICE_CHECK }}
        run: pnpm --filter backend exec tsx scripts/check-pricing.ts
```

Cost: ~1 Haiku call/day at ~3K input + ~500 output tokens ≈ $0.005/day = $1.80/year.

A separate Anthropic API key for the price check (`ANTHROPIC_API_KEY_PRICE_CHECK`) keeps it on its own audit trail and can be rate-limited or rotated independently of the production key.

## 6. Cache strategy: 5-minute cache

Anthropic offers two cache TTLs (`ephemeral` 5-min default and 1-hour extended). Both refresh TTL on read at no additional cost. Their write costs differ:

- 5-min cache write: 1.25× input token rate
- 1-hour cache write: 2× input token rate
- Cache read (either TTL): 0.10× input token rate

A typical Mythrun session is 3 hours, ~150 turns at ~1 turn/min. For a 10K-token system prompt:

| Strategy | Writes | Reads | Cost (input baseline-equivalents) |
|---|---|---|---|
| No caching | 0 | 0 (re-sends full prompt every turn) | 150.0 |
| 5-min cache, no pauses | 1 (× 1.25) | 149 (× 0.10) | 16.15 (~89% savings) |
| 5-min cache, one 10-min pause | 2 (× 1.25) | 148 (× 0.10) | 17.30 |
| 1-hour cache | 1 (× 2.00) | 149 (× 0.10) | 16.90 |

The 5-min cache wins on the typical session by ~5% on the write cost, with TTL refreshing on every read keeping the cache warm for the entire session. The 1-hour cache only wins for pathological pause patterns (frequent >5min gaps, no rapid play interleaving). Active D&D play has natural lulls but rarely systematic pauses long enough to benefit.

We track the 5-min cache rate (`cacheWrite: 1.25 × input`) in `MODEL_PRICING`. The 1-hour rate is omitted — we don't use it, and persisting unused rates clutters the constants and adds noise to the price check.

## 7. Trial / paid mutual exclusion

### 7.1 The rule

A user's credit ledger contains EITHER unexpired trial credits OR unexpired paid credits, never both at the same time. The invariant is maintained by **auto-burning the trial credit on first paid grant**.

This replaces the source spec §7's "trial-FIRST consumption" rule from the credit-debit recipe. The motivation is UX: a user who pays for Mythrun should NEVER experience the limited trial mode (45-min cap, demo world, reduced budget) on their first paid session. By burning the trial at purchase time, the next session unambiguously consumes paid credit.

### 7.2 Implementation: trial-burn in `grantInTx`

```typescript
// repo/credits.ts — modified grantInTx

export async function grantInTx(tx: ClientLike, input: GrantInput): Promise<CreditEntry> {
  // ... existing validation (amount > 0, sourceType !== 'debit') ...

  // Lock anchor on users row. Reentrant (Postgres tuple-lock re-entrancy:
  // re-acquiring on same xid is a no-op), so callers that already locked
  // the row can still call grantInTx safely.
  const userCheck = await tx.query<{ id: string }>(
    'SELECT id FROM users WHERE id = $1 FOR UPDATE',
    [input.userId],
  )
  if (userCheck.rowCount === 0) throw new UserNotFoundError(input.userId)

  // NEW: when granting a paid credit, burn any unexpired trial credits
  // first. Maintains the trial-OR-paid mutual-exclusion invariant.
  if (input.sourceType === 'purchase' || input.sourceType === 'subscription') {
    await burnUnexpiredTrialCredits(tx, input.userId, input.creditType)
  }

  // ... existing INSERT for the new grant row ...
}

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
  // (userId, creditType) so the same logical burn always produces the
  // same source_id. ON CONFLICT DO NOTHING handles webhook redelivery:
  // the second call sees the existing burn row and skips. Subsequent
  // paid grants land their own grant rows normally.
  //
  // Why UUIDv5 (not a string like 'trial-burn:{userId}:{creditType}'):
  // credit_ledger.source_id is declared UUID per migration 001. A
  // raw string would fail with `invalid input syntax for type uuid`
  // on the first burn call. UUIDv5 gives us deterministic-by-input
  // values that satisfy the column type.
  const burnSourceId = trialBurnSourceId(userId, creditType)
  await tx.query(
    `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
     VALUES ($1, $2, $3, $4, 'debit', $5)
     ON CONFLICT (user_id, credit_type, source_id) WHERE source_type = 'debit' DO NOTHING`,
    [uuidv7(), userId, creditType, -balance, burnSourceId],
  )
}

// Mythrun-pinned namespace UUID for trial-burn source_ids. Generated
// once and never changes; rotating it would orphan existing burn rows
// from their idempotency check.
const TRIAL_BURN_NAMESPACE = '019700e0-0000-7000-8000-000000000003'

function trialBurnSourceId(userId: string, creditType: string): string {
  // UUIDv5 (RFC 4122) — SHA-1(namespace_bytes || name_bytes), first 16
  // bytes, with version + variant bits set. Implementation lives in
  // backend/src/repo/uuidv5.ts (new in MYT-43); imported here as a
  // shape-stable utility.
  return uuidv5(`${userId}:${creditType}`, TRIAL_BURN_NAMESPACE)
}
```

### 7.3 `atomicDebit` returns `consumedSourceType`

Under mutual exclusion, all unexpired credits at any moment are the same source-type-class. `atomicDebit` reads the source_type of the user's currently-unexpired positive credits ordered by `granted_at ASC` and returns the first row's source_type as `consumedSourceType`. The Session Runtime reads `consumedSourceType === 'trial'` to enter trial-mode.

```typescript
interface AtomicDebitResult {
  readonly entry: CreditEntry
  readonly consumedSourceType: 'trial' | 'purchase' | 'subscription' | 'gift' | 'refund'
}

// Inside atomicDebit's tx, AFTER the balance check passes (so we know
// at least one positive unexpired row exists), BEFORE the debit INSERT:
const sourceTypeResult = await client.query<{ source_type: string }>(
  `SELECT source_type FROM credit_ledger
    WHERE user_id = $1 AND credit_type = $2
      AND amount > 0
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY granted_at ASC, id ASC
    LIMIT 1`,
  [input.userId, input.creditType],
)
// The balance check passed (available >= amount), so by construction
// at least one positive unexpired row exists. If the SELECT returned
// zero rows, something is structurally wrong (clawback-only ledger,
// expires_at race, etc.) — bail loudly rather than fall through to
// 'unknown' and silently break the trial-mode signal.
const sourceTypeRow = sourceTypeResult.rows[0]
if (!sourceTypeRow) {
  throw new Error(
    `atomicDebit: balance check passed but no positive unexpired ` +
      `credit row found for user ${input.userId} (${input.creditType}). ` +
      `Possible ledger inconsistency.`,
  )
}
const consumedSourceType = sourceTypeRow.source_type as AtomicDebitResult['consumedSourceType']
// ... INSERT debit row, COMMIT, return { entry, consumedSourceType } ...
```

### 7.4 `tryDebitForSession` wrapper

```typescript
type TryDebitResult =
  | { readonly ok: true; readonly consumedSourceType: AtomicDebitResult['consumedSourceType'] }
  | { readonly ok: false; readonly code: 'insufficient_credits'; readonly available: number; readonly required: number }

tryDebitForSession: async (userId: string, sessionId: string): Promise<TryDebitResult> => {
  try {
    const result = await atomicDebit({
      userId,
      creditType: 'session',
      amount: 1,
      sourceId: sessionId,  // sessionId is the per-user idempotency key
    })
    return { ok: true, consumedSourceType: result.consumedSourceType }
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, code: 'insufficient_credits', available: err.available, required: err.required }
    }
    throw err  // UserNotFoundError, IdempotencyConflictError, etc. still throw
  }
}
```

The issue text said `tryDebitForSession(sessionId, costMinor)`. Under the new model the cost is always 1 session credit (Stripe charges a fixed $/session at the consumer surface; LLM cost is observability-only). The API takes `(userId, sessionId)` and debits exactly 1 session credit.

**HTTP surface for the `ok: false` path** (when the future Session Runtime route consumes this): **402 Payment Required** + body `{code: 'insufficient_credits', available, required}`. 402 is the literal-meaning HTTP status; frontends match on status to render the gentle out-of-credits UX (purchase prompts) vs. error UX (other 4xx/5xx). Body shape matches the rest of the codebase's `{code: '<snake_case>'}` convention.

**Failure-path discriminant for trial-vs-paid** (Saffron I3): the typed result above doesn't tell the caller whether the user previously had a trial. The Session Runtime can read `users.free_trial_used` separately if it needs to render different UX for "never had trial → here's a trial offer" vs. "trial used → here's the purchase prompt." That's a one-extra-query the SR handler does at insufficient-credits time; we don't pre-bake it into `tryDebitForSession`'s contract.

## 8. `recordUsage` + `budgetSummary`

`recordUsage` writes per LLM call (per §1's Redis-dropped architecture) and **returns the running totals after the UPSERT**. The Session Runtime's wrap-up trigger reads from this return value — no separate read.

`session_usage` keeps `input_tokens`, `cache_write_tokens`, and `cache_read_tokens` as **separate columns** (per Cardamom I5 from round-1 review). Greenfield-cheap and avoids an analytics rewrite later.

### 8.1 Schema (updated columns)

Migration 008's session_usage shape (full DDL in §4):

```sql
ALTER TABLE session_usage
  DROP COLUMN budget_limit_tokens,
  ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_tokens  INTEGER NOT NULL DEFAULT 0;
-- input_tokens, output_tokens, estimated_cost_usd already exist; semantics narrow:
--   input_tokens       = base prompt tokens only (was: aggregate of all input classes)
--   cache_write_tokens = 5-min cache write tokens (NEW)
--   cache_read_tokens  = 5-min cache read tokens (NEW)
--   estimated_cost_usd = USD computed via 4-rate MODEL_PRICING per call, accumulated
```

### 8.2 `recordUsage`

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
  if (result.rowCount === 0) {
    // SELECT-FROM matched zero sessions. The session row is missing or was
    // deleted; surface this loudly rather than silently no-opping the write.
    throw new SessionNotFoundError(sessionId)
  }
  return toSessionUsage(result.rows[0]!)
},
```

The function returns the **post-UPSERT row**, so the caller has the cumulative totals immediately and can compute "did we just cross 80% of the cost cap?" inline.

### 8.3 `budgetSummary`

For consumers other than the Session Runtime hot path (receipts, dashboards, end-of-session reports). Plain SELECT.

```typescript
budgetSummary: async (sessionId: string): Promise<SessionUsage | null> => {
  const result = await pool.query<SessionUsageDbRow>(
    `SELECT * FROM session_usage WHERE session_id = $1`,
    [sessionId],
  )
  return result.rows[0] ? toSessionUsage(result.rows[0]) : null
},
```

Returns `null` when no usage rows exist (session created but no LLM calls yet). Caller handles.

### 8.4 Notes

- **No silent no-op on bad sessionId** (per Saffron I4 / Sumac I6). If `recordUsage` is called with a session id that doesn't exist (or was deleted mid-session), it throws `SessionNotFoundError`. Callers in the hot path should never see this; it's a tripwire for upstream bugs.
- **Idempotency:** `recordUsage` is **non-idempotent under retry** — a retried call double-counts. The Session Runtime is responsible for not retrying after partial failure. If retry-safety is ever needed, add a per-call `reportingId` and pin a `(session_id, reporting_id)` unique constraint; deferred until a real retry path appears.
- **Concurrent writes within a session** serialize on the row lock. Mythrun doesn't issue parallel LLM calls within a session today (FT/ST/Scribe run sequentially per turn), so contention is per-session-sequential = correct + zero-contention in practice.

## 9. Demo world

`worlds.is_demo` is the at-most-one-demo flag (partial unique index pins the invariant). The placeholder seed row is owned by the `system` users row (also seeded in migration 008). Real narrative content is authored separately and lands as an UPDATE to that row's `concept`, `tone`, `themes`, `geography_summary`, `political_summary`, etc.

```typescript
// repo/worlds.ts addition

getDemo: async (): Promise<World | null> => {
  const result = await pool.query<WorldDbRow>(
    `SELECT * FROM worlds WHERE is_demo = true LIMIT 1`,
  )
  return result.rows[0] ? toWorld(result.rows[0]) : null
},
```

The fork-demo-world-per-trial-user logic is Session Runtime territory (when a trial-mode session starts, it forks the demo world via the existing `worlds.fork` pipeline). MYT-43 ships only the schema + seed + helper.

## 10. Source-spec updates

Spec edits in the **same commit** as the implementation, so the source-of-record never lags. Per Sumac C4 from round-1 review, multiple specs reference the dropped column / superseded invariant — all need updating.

### 10.1 `docs/specs/2026-04-13-billing-cost-controls.md`

- **§6 Token Budget table**: mark superseded. The cost-cap + FT-context-cap + Slow-Thinker narrative-wrap model replaces the model-blind 500K-output-tokens cap. Add a new subsection "Why not model-blind token budget" with the rationale (Opus-heavy at 500K = $37.50; Haiku-heavy at 500K = $2; ~19× cost variance; cost is the meaningful enforcement metric).
- **§6 Token Accumulation**: drop the Redis-as-live-counter + Postgres-checkpoint pattern entirely. Replace with Postgres-only architecture: every LLM call writes via `recordUsage` UPSERT and reads back the running totals; the Slow Thinker's wrap-up signal is computed inline by the caller. Cost-cap-approaching is the **primary** session-end trigger (not an emergency backstop) — when accumulated cost hits the warn threshold (e.g. 80% of cap), the ST is signaled to ramp toward a graceful narrative close. FT context cap and ST narrative-driven wrap are the other two end signals; all three end via the same ST-driven path.
- **§6 Cost Estimation**: expand to cover the 4-rate pricing model (input/output/cacheWrite/cacheRead). Reference `backend/src/billing/model-pricing.ts` as the source-of-truth for rates. Note the daily price-check workflow.
- **§7 Free Trial / Implementation**: mark trial-FIRST consumption as **superseded by mutual exclusion**. Replace with: trial credit and paid credit are mutually exclusive; first paid grant burns trial; `atomicDebit.consumedSourceType === 'trial'` is the trial-mode signal. Clarify that `users.free_trial_used` is the canonical "trial issued" signal — remove any reference to a `users.trial_granted_at` column that was speculated in earlier drafts.
- **§8 Per-Session Cost Tracking schema block**: update the displayed schema — drop `budget_limit_tokens`, add `cache_write_tokens` / `cache_read_tokens` columns, add the unique index on `session_id`.
- **§10 Edge Cases** (line 468 area): the "Trial-FIRST invariant" edge case row is **superseded by mutual exclusion**. Either remove the row or replace with "Mutual-exclusion invariant: trial and paid credit never coexist (auto-burn at first paid grant maintains)."

### 10.2 `docs/specs/2026-04-13-backend-core.md`

- **session_usage schema block** (around line 535, the `budget_limit_tokens INTEGER NOT NULL` line): update to match migration 008 — drop `budget_limit_tokens`, add `cache_write_tokens` / `cache_read_tokens`, note the unique index.

### 10.3 `docs/specs/2026-04-06-production-architecture-overview.md`

- **§5 / §7 references to session_usage schema and the 80% / 90% / 120% threshold language** (around lines 392, 566, 740, 744): update threshold language to cost-cap-based wrap signal (warn at 80% of cost cap → ST wrap-up signal); drop the 120% hard cap framing (the cap fires the ST signal, not a hard halt). Update any displayed `session_usage` schema to match migration 008.

### 10.4 Coherence check

After edits, grep for `budget_limit_tokens` across `docs/` — should match zero results outside of historical-rationale prose. Same for `trial-FIRST consumption` and `120%` in cost-cap context.

## 11. Tests

### 11.1 `repo/__tests__/sessions.test.ts`

```
recordUsage / budgetSummary
  - first call inserts row with deltas + computed cost (sonnet → cost contribution correct)
  - second call increments existing row (haiku adds to running totals)
  - mixed-model session: opus + haiku + sonnet → cumulative cost == sum of per-call costs
  - cacheWriteTokens contribute via cacheWrite rate; column written separately
  - cacheReadTokens contribute via cacheRead rate; column written separately
  - input_tokens / cache_write_tokens / cache_read_tokens are split columns (verify via SELECT)
  - recordUsage returns the post-UPSERT SessionUsage row (not void)
  - returned cumulative totals match what budgetSummary would return immediately after
  - budgetSummary returns null for sessions with no usage
  - budgetSummary returns the row for sessions with usage
  - one-row-per-session unique constraint enforced (idx_session_usage_one_per_session)
  - recordUsage on a non-existent session → throws SessionNotFoundError (NOT silent no-op)
  - 1-hour cache token in deltas → computeCostUsd throws (defensive; not silently mis-charged)
  - retry of recordUsage after partial failure → double-counts (documented non-idempotency)
```

### 11.2 `repo/__tests__/credits.test.ts` (additions)

```
grantInTx — trial-burn
  - granting 'purchase' when trial credit exists → debit row written; source_id is a valid UUID
  - granting 'subscription' when trial credit exists → debit row written
  - granting 'gift' when trial credit exists → no burn (gift is not paid)
  - granting 'trial' when trial credit exists → no self-burn
  - granting 'refund' when trial credit exists → no burn
  - second 'purchase' grant after first burn → ON CONFLICT no-ops the burn row (idempotent), new grant row inserted
  - granting 'purchase' with no trial credit → no burn row written
  - balance after burn + paid grant: equals the paid grant amount only
  - trialBurnSourceId is deterministic: same (userId, creditType) → same UUID
  - trialBurnSourceId is unique-by-input: different (userId, creditType) → different UUIDs

atomicDebit — consumedSourceType
  - trial-only user: consumedSourceType === 'trial'
  - purchase-only user: consumedSourceType === 'purchase'
  - subscription-only user: consumedSourceType === 'subscription'
  - existing tests still pass with new return shape (entry, consumedSourceType)
  - synthetic ledger inconsistency (balance check passes but FIFO SELECT empty) → throws explicit "ledger inconsistency" error, no 'unknown' fallback

tryDebitForSession
  - sufficient balance: { ok: true, consumedSourceType: '...' }
  - insufficient balance: { ok: false, code: 'insufficient_credits', available, required }
  - non-existent user: throws UserNotFoundError (not wrapped in typed result)
  - idempotency: same sessionId twice returns same prior debit row consistently
```

### 11.3 `repo/__tests__/worlds.test.ts` (additions)

```
getDemo
  - returns the seeded demo world after migration 008
  - returns null if no demo world exists (sanity)
  - is_demo flag round-trips correctly through toWorld mapper

at-most-one-demo invariant
  - attempting to INSERT a second world with is_demo=true → unique-violation error
```

### 11.4 `billing/__tests__/model-pricing.test.ts`

```
computeCostUsd
  - haiku 1M input + 1M output: input*1 + output*5 = $6.00
  - sonnet 100K cacheWrite + 1M cacheRead: 100K*3.75/1M + 1M*0.30/1M = $0.375 + $0.30 = $0.675
  - opus mixed call: cost = sum of weighted contributions
  - undefined cacheWriteTokens / cacheReadTokens default to 0
  - all rates in MODEL_PRICING are positive and within sanity bounds (defensive)
```

### 11.5 `scripts/__tests__/check-pricing.test.ts`

Mock fetch + Haiku response.

```
- fetch returns 200 with a fake docs page → price-check exits 0 when extracted == MODEL_PRICING
- extracted rate differs by 0.01 → price-check exits 3 with diff in stderr
- Haiku returns rate of 99999.0 (sanity-bound violation) → exits 2
- fetch returns 500 → exits 1 (transient; cron retries on next run)
- model present in MODEL_PRICING but missing from docs → drift detected
```

## 12. Out of scope

- Live cost-cap enforcement (Session Runtime's wrap-up signal logic — reads from `recordUsage`'s return value, but the threshold-comparison + ST-signal-emit logic lives in SR).
- FT context-cap enforcement (Session Runtime's pre-prompt size check).
- Slow-Thinker narrative-driven session-end logic.
- **Real demo-world content.** MYT-43 ships the placeholder seed row + the schema. Real narrative content (concept, tone, themes, NPCs, opening situation) is a separate content-authoring task with **no owner pinned today**. This is a **launch-blocker**: the trial flow is not user-testable end-to-end until both real demo content + Session Runtime fork-on-trial-start ship. To be tracked outside Linear (per `feedback_tooling_not_on_linear.md`-style "real content authoring is its own work, not engineering scope") until ready to author.
- Per-model token breakdown for analytics dashboards (deferred to a future `session_usage_breakdown` table if needed; current schema's separate `input_tokens` / `cache_write_tokens` / `cache_read_tokens` columns are the most useful breakdown that's cheap to ship now).
- 1-hour cache rate tracking. Mythrun uses 5-min cache only (see §6); `computeCostUsd` throws if a 1-hour cache token count is ever passed in, so a regression here fails loud.
- Batch API rate tracking (we don't use it for live sessions).
- Trial-grant flow on `POST /api/users/register` (already shipped in MYT-38/MYT-42).
- Cost dashboards (deferred to Observability sub-spec).
- Cost-cap value tuning. The cap is a config value (env var or `settings` table). Initial value calibration is operational, requires measurement-based tuning during beta. The source spec's current $3/$5 + 20%-margin numbers are pre-launch placeholders pending beta data.
- **`estimated_cost_usd` accuracy target** — pinning a target ("within X% of monthly Anthropic invoice") + a reconciliation cadence is operational and lives outside MYT-43. The price-check workflow keeps the rates accurate; per-session cost-attribution accuracy follows from rate accuracy + correct token counts.
- **Price-check response loop SLA / owner.** The CI alarm fires; the human-in-the-loop response cadence is a Platform-on-call operational concern, not an MYT-43 design decision.
- **`tryDebitForSession`'s HTTP route** itself. MYT-43 ships only the repo function; the route that consumes it (with the 402-response shape pinned in §7.4) lands when Session Runtime ships the session-create endpoint.
