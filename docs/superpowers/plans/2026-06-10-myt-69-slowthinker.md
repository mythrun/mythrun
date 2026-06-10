# MYT-69 — SlowThinker: the post-hoc narrative director — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `StubSlowThinker` with the real Opus narrative director, running OFF the hot path in a new `st-evaluation` BullMQ worker. It watches completed turns, decides (deterministic policy → Haiku gate → Opus evaluation) when the scene needs direction, writes a leak-safe one-shot + standing directive the FastThinker consumes next turn, owns the running summary, and issues the session wind-down signal.

**Architecture:** Post-hoc, gated, asynchronous (a deliberate amendment to runtime §6/§8 — the ST no longer blocks the player-visible stream). The turn worker's post-turn `finally` phase enqueues an `st-evaluation` job (per-campaign dedup `{id}`, no ttl, job-side self-re-arm — mirroring `dm-trigger-worker`). The job runs `DETERMINISTIC POLICY → HAIKU GATE → OPUS ST EVALUATION → write outputs`, where outputs are: a one-shot direction slot (GETDEL-consumed by the next fresh turn, fused via the unchanged MYT-68 seam), a standing directive (read every turn, appended as a raw `ModelMessage` tail AFTER the FT cache breakpoints), the running summary (`:summary` SET — rewrite semantics), and ST usage (`:usage:st` INCRBY). Summary ownership moves entirely to the ST job; `flushTurnState` shrinks to usage-only.

**Tech Stack:** Node 24 + TypeScript strict, Fastify, `ai@6.0.176` + `@ai-sdk/anthropic`, Postgres (`pg`), Redis (`ioredis`), BullMQ, Vitest (tests target `mythrun_test`; LLM tests mock the `'ai'` boundary via `vi.mock('ai')`, NEVER the `ai.ts` wrapper; Redis tests use `ioredis-mock`).

**Spec:** `docs/superpowers/specs/2026-06-10-myt-69-slowthinker-design.md` (§ references below point there). The §12 file-level change map is the decomposition backbone; the §15 review revisions are binding.

---

## Context primer (read first)

- **Enforced ignorance (CLAUDE.md #1):** the gate and the ST hold `sd_playbook` FREELY — they are ST-side infrastructure. Their outputs that cross into the FT are EXACTLY `direction` (one-shot) and the standing text — both behavior-bound by the §4 structural split + prompt contract. `reasoning` and the gate verdict are **logs only**, never fed to any FT-facing artifact. The summary is FT-invisible (MYT-68 removed `runningSummary` from `FtTurnContext`). **If you add a secret-bearing field to any FT-facing type, that is the bug the type system exists to prevent.**
- **The structural split IS the §8.2 leak bound (§4):** `StDirectorResultSchema` forces the secret-aware reasoning into its own `reasoning` field so it cannot ride along in `direction`. There is **NO independent checker** (decided at brainstorm; the seam is documented, MYT-72 revisits). Directions carry behavior PLUS ST-sanctioned reveal content — bounded to exactly what the ST decided the NPC surfaces — never unsanctioned secret rationale. Bounds are phrased **behaviorally without naming the protected content** ("he's said all he'll say; he deflects to Vane" — never "nothing about the ledger").
- **Repair-discard (§4):** `generateObject`'s repair chain hands the malformed tree (incl. secret `reasoning`) to Haiku/Sonnet — a repaired `direction` is text the ST did not author. PIN: **if `result.repairAttempted === true`, discard the ENTIRE evaluation result** — no direction, no standing change, no summary write, no usage of the eval; skip the cycle (§10 tolerates a skipped cycle). No `.refine` cross-field constraints on the schema for the same reason.
- **Summary is a REWRITE, not an append (§4):** the ST returns the FULL replacement summary each evaluation (target ~150–300 words; the old summary is in context). Append corrupts the rapport/ladder state machine and unbounds cost.
- **Single-flight-per-campaign is an INVARIANT (§2):** dedup `{ id: 'st-eval:<campaignId>' }`, NO ttl (a ttl'd key swallows re-adds — `reference_bullmq_dedup_ttl_swallows_readds`). The PRODUCER (turn worker) must NEVER remove the key. The JOB self-re-arms at its end: snapshot the responded watermark at start; if newer turns landed, `removeDeduplicationKey(ownId)` + re-add (the exact `dm-trigger-worker` pattern via `DmTriggerQueueWithDedup` — but a NEW `st-eval` queue surface).
- **`:usage:st` is a DEDICATED key, summed at read (§7):** the turn worker reads `:usage` at turn start, accumulates in memory across a minutes-long render, and blind-SETs at flush — an ST increment into `:usage` would be erased. The ST job INCRBYs `:usage:st`; the wind-down policy arm (and any session-spend consumer) reads `usage + usage:st`.
- **Slot consumption (§6):** `oneShot` is taken-and-cleared (GETDEL) ONLY on the turn worker's **fresh-run arm** — AFTER lock acquisition and AFTER the converge/latch early exits. `standing` is **read (not cleared)** every DM turn and appended as a raw `ModelMessage` AFTER `buildModelMessages` placed the breakpoints (never persisted, never pushed into `ftHistory`). **Fusion (one-shot) runs BEFORE the standing tail is appended** (the fuser targets the last user message).
- **Worker rules:** there is a separate dev server — never kill it. Implementer subagents run ONLY their own test file (`pnpm --filter @mythrun/backend vitest run <path>`); the controller runs lint + scoped coverage after each wave. Implementers do NOT `git add`/`commit`/`push` (feedback_parallel_agent_commits).
- **Lint gotchas (error-level):** `@typescript-eslint/no-non-null-assertion` (use a guard, not `!`), `@typescript-eslint/no-deprecated`. 100% coverage gate — budget scoped coverage per task (feedback_scoped_coverage_for_iteration).
- **dev-tool typecheck is separate** (reference_dev_tool_typecheck_separate) — this issue touches no dev-tool sources, so the dev-tool verifier is not in scope; but `routes/sessions.ts` IS in the pre-push `dev-tool:verify` trigger list only if it's a contract-route source — it is NOT, so the pre-push backend gate is the usual one.
- **Run tests:** `cd backend && pnpm vitest run src/<path>` (DATABASE_URL_TEST → `mythrun_test`).
- **SDK / codebase deviation rule:** where the installed `ai@6.0.176` types or `exactOptionalPropertyTypes` force a deviation from the sketches below, **`pnpm typecheck` is the authority** — adjust property reads / generic shapes, keep the structure, never loosen to `any`.

## File map / task ownership (non-overlapping per wave)

| Task | Files (Create/Modify) |
|---|---|
| T1 | C: `backend/src/session/st-config.ts` + test |
| T2 | C: `backend/src/llm/schemas/st-gate.ts`, `backend/src/llm/prompts/session/st-gate.txt`, `backend/src/llm/st-gate.ts` + tests |
| T3 | C: `backend/src/llm/schemas/st-director.ts`, `backend/src/llm/prompts/session/st-evaluation.txt`, `backend/src/llm/st-director.ts` + tests |
| T4 | M: `backend/src/session/trigger-state.ts` + test (direction slots + turns-since-ST counter) |
| T5 | M: `backend/src/llm/prompts/session/ft-system.txt` + extend `backend/src/llm/prompts/__tests__/ft-system.test.ts` |
| T6 | M: `backend/src/llm/prompts/prep/session-prep.txt` + (test if one exists; else a new var-contract test) |
| T7 | M: `backend/src/routes/sessions.ts` + extend `backend/src/routes/__tests__/sessions.test.ts` (active-route allowlist + session-start key resets) |
| T8 | M: `docs/specs/2026-04-13-multiplayer-session-runtime.md` §17.4 (docs edit) |
| T9 | C: `backend/src/session/st-eval-queue.ts` + test |
| T10 | C: `backend/src/session/st-evaluation-worker.ts` + test; M: `backend/src/repo/characters.ts` + test (roster read gains class/background) |
| T11 | M: `backend/src/session/dm-trigger-worker.ts` (summary-input contract-comment amendment) + its test if a comment-asserting test exists (else none) |
| T12 | M: `backend/src/redis/session-state.ts` + test (`flushTurnState` usage-only, `:usage:st`, ST summary write, checkpoint kind bump, summed-usage read) |
| T13 | M: `backend/src/session/tiers/types.ts` (`StEvaluation`/`SlowThinker` retire + supersession notes); M: `backend/src/session/session-controller.ts` + test (drop st/applyEvaluation/summary; fuse-then-append; standing dep) |
| T14 | M: `backend/src/session/tiers/fast-thinker.ts` + test (raw standing tail after breakpoints) |
| T15 | M: `backend/src/session/turn-worker.ts` + test (success-path enqueue, fresh-run-arm one-shot take, turns-since-ST INCR, controller deps); M: `backend/src/worker.ts` (6th worker) |
| T16 | M: fixture sweep / full-suite green (any stragglers from the type retirements) |
| T17 | Controller: full lint + scoped-coverage sweep (budgeted, NOT optional) |
| T18 | Controller: real-Anthropic E2E smoke → wiki subagent → single push → Linear Done |

**Waves:**
- **Wave A (parallel):** T1, T2, T3, T4, T5, T6, T7, T8. Fully non-overlapping file sets. (T2/T3 build against the T1 config constants — pin them by importing; if T1 hasn't landed yet, the implementer reads this plan's T1 values, which are the contract.)
- **Wave B (parallel):** T9, T10, T11. T10 imports the T2/T3 LLM calls + T1 config + T4 trigger-state + T12 session-state surface (build against the signatures pinned in this plan; **typecheck is the authority** once siblings land). T11 is an isolated comment edit.
- **Wave C:** T12 (solo-ish — session-state ripples), then T13 → T14 → T15 in sequence (T15 wires the controller + worker against T13/T14/T9/T10). T13/T14 can run in parallel with each other (distinct files) before T15.
- **Wave D (controller-run):** T16 fixture sweep → T17 lint+coverage → T18 smoke+wiki+push+close.

---

### Task 1: `st-config.ts` — the ST tuning constants

**Files:**
- Create: `backend/src/session/st-config.ts`
- Test: `backend/src/session/__tests__/st-config.test.ts`

Mirror `ft-config.ts`'s shape. NEVER hardcode model names at call sites (`OPUS`/`HAIKU` come from `../llm/models.js`).

- [ ] **Step 1: Failing test**

```ts
// backend/src/session/__tests__/st-config.test.ts
import { describe, expect, it } from 'vitest'
import {
  ST_MODEL, ST_GATE_MODEL, ST_EVAL_FLOOR_TURNS, ST_GATE_CONFIDENCE_FLOOR,
  ST_GATE_EXCHANGE_WINDOW, ST_EVAL_EXCHANGE_WINDOW, SESSION_TOKEN_BUDGET,
  WIND_DOWN_FRACTION, ST_EVAL_TIMEOUT_MS, ST_GATE_TIMEOUT_MS,
  ST_EVAL_MAX_OUTPUT_TOKENS, ST_SUMMARY_TARGET_WORDS,
} from '../st-config.js'
import { OPUS, HAIKU } from '../../llm/models.js'

describe('st-config', () => {
  it('pins the §11 tier assignment + knobs', () => {
    expect(ST_MODEL).toBe(OPUS)
    expect(ST_GATE_MODEL).toBe(HAIKU)
    expect(ST_EVAL_FLOOR_TURNS).toBe(5)
    expect(ST_GATE_CONFIDENCE_FLOOR).toBe(0.8)
    expect(WIND_DOWN_FRACTION).toBe(0.9)
  })
  it('background-tolerant timeouts exceed the worker close grace (deploy re-run accepted)', () => {
    expect(ST_EVAL_TIMEOUT_MS).toBe(120_000)
    expect(ST_GATE_TIMEOUT_MS).toBe(30_000)
  })
  it('exposes the slice windows, budget, output ceiling, summary target', () => {
    expect(ST_GATE_EXCHANGE_WINDOW).toBeGreaterThan(0)
    expect(ST_EVAL_EXCHANGE_WINDOW).toBeGreaterThanOrEqual(ST_GATE_EXCHANGE_WINDOW)
    expect(SESSION_TOKEN_BUDGET).toBeGreaterThan(0)
    expect(ST_EVAL_MAX_OUTPUT_TOKENS).toBeGreaterThan(0)
    expect(ST_SUMMARY_TARGET_WORDS).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run — FAIL** (`Cannot find module '../st-config.js'`).

- [ ] **Step 3: Implement**

```ts
// backend/src/session/st-config.ts
//
// MYT-69 §11 — SlowThinker + Haiku-gate tuning constants. The deterministic
// policy arms (floor turns, wind-down fraction) are CODE around the gate, not
// prompt content — mechanical policy, ZFC-exempt. Never hardcode model names
// or budgets at call sites.

import { HAIKU, OPUS } from '../llm/models.js'

/** The architecture's tier assignment: Opus narrates direction, Haiku gates. */
export const ST_MODEL = OPUS
export const ST_GATE_MODEL = HAIKU

/** runtime §8's every-5-turns oversight floor: turns-since-the-last-ST-RAN ≥
 *  this forces an evaluation, skipping the gate. "Evaluated" == an Opus ST ran
 *  (NOT a skipped gate). */
export const ST_EVAL_FLOOR_TURNS = 5

/** Skip the Opus call IFF `!needed && confidence ≥ this`. An EMPIRICAL knob —
 *  Haiku confidence calibration is poor; the §13 smoke measures the skip rate
 *  and tunes this. Only a confident "no" skips; everything else evaluates
 *  (fail-toward-oversight). */
export const ST_GATE_CONFIDENCE_FLOOR = 0.8

/** Recent-slice sizes (player+DM exchanges). The gate sees a tighter window;
 *  the evaluation sees more. Plan-time tune; the smoke validates. */
export const ST_GATE_EXCHANGE_WINDOW = 6
export const ST_EVAL_EXCHANGE_WINDOW = 10

/** The §3.11 session bound proxy — the total token budget that, at
 *  WIND_DOWN_FRACTION, trips the wind-down policy arm. Plan-time; tuned in the
 *  smoke. The FT-context hard cap (session-end issue) is the real bound; this
 *  is the ST-side signal. */
export const SESSION_TOKEN_BUDGET = 400_000
export const WIND_DOWN_FRACTION = 0.9

/** Background-tolerant budgets (nothing player-visible waits on these). NOTE:
 *  ST_EVAL_TIMEOUT_MS > worker.ts WORKER_CLOSE_GRACE_MS slack only at the
 *  margin — a deploy mid-eval force-closes the worker and the job re-runs after
 *  reboot (double Opus spend per deploy-during-eval, accepted — §11). */
export const ST_EVAL_TIMEOUT_MS = 120_000
export const ST_GATE_TIMEOUT_MS = 30_000

/** reasoning + direction + a FULL summary rewrite is long; the SDK default
 *  truncates (§4). */
export const ST_EVAL_MAX_OUTPUT_TOKENS = 4_000

/** The rewrite-semantics target (the prompt instructs this; not enforced in
 *  code — a hard max on prose is forbidden, feedback_no_max_on_llm_prose_fields). */
export const ST_SUMMARY_TARGET_WORDS = 250
```

- [ ] **Step 4: Run — PASS.** Report DONE. (Verify `OPUS` is actually exported from `../llm/models.js` — if it isn't, that is a real gap: stop and flag it, do NOT invent a model id.)

---

### Task 2: The Haiku gate — schema + prompt + call (§3)

**Files:**
- Create: `backend/src/llm/schemas/st-gate.ts`, `backend/src/llm/prompts/session/st-gate.txt`, `backend/src/llm/st-gate.ts`
- Tests: `backend/src/llm/schemas/__tests__/st-gate.test.ts`, `backend/src/llm/__tests__/st-gate.test.ts`

The gate is ONE cheap classified judgment per completed turn: **should we spend the Opus call?** Its input may hold secrets freely (ST-side infrastructure). Output `{ needed, confidence, reason }`. The SKIP RULE lives in the CALLER (the worker), not here: skip IFF `!needed && confidence ≥ ST_GATE_CONFIDENCE_FLOOR`. **GATE INDEPENDENCE:** the gate's verdict/reason is never fed to the ST.

- [ ] **Step 1: Failing schema test**

```ts
// backend/src/llm/schemas/__tests__/st-gate.test.ts
import { describe, expect, it } from 'vitest'
import { StGateResultSchema } from '../st-gate.js'

const valid = { needed: true, confidence: 0.7, reason: 'small talk warming with a playbook NPC' }

describe('StGateResultSchema', () => {
  it('accepts a valid verdict', () => {
    expect(StGateResultSchema.safeParse(valid).success).toBe(true)
  })
  it('bounds confidence to [0,1] (structural, ZFC-exempt)', () => {
    expect(StGateResultSchema.safeParse({ ...valid, confidence: 1.2 }).success).toBe(false)
    expect(StGateResultSchema.safeParse({ ...valid, confidence: -0.1 }).success).toBe(false)
  })
  it('rejects an empty reason (.min(1) floor; NO .max on prose)', () => {
    expect(StGateResultSchema.safeParse({ ...valid, reason: '' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Implement the schema**

```ts
// backend/src/llm/schemas/st-gate.ts
//
// MYT-69 §3 — the Haiku gate verdict. The gate decides ONLY whether the Opus
// ST call happens; the skip rule (`!needed && confidence ≥ floor`) is policy in
// the worker, not the schema. The verdict is NEVER fed to the ST (gate
// independence). `reason` is logged server-side only.

import { z } from 'zod'

export const StGateResultSchema = z.object({
  needed: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
})

export type StGateResult = z.infer<typeof StGateResultSchema>
```

- [ ] **Step 3: Write the prompt** — `backend/src/llm/prompts/session/st-gate.txt`. Vars: `{{sd_playbook}}`, `{{running_summary}}`, `{{recent_exchanges}}`. (The full `sd_playbook` — NO code-side trigger extraction, that would be ZFC-violating string intelligence.)

```text
You are the gate for a D&D session's narrative director. The director (an expensive call) reviews completed turns and decides whether to step in. Your only job: decide whether this moment is WORTH the director's attention right now. You do NOT decide whether the director intervenes — only whether it should look.

Fire (needed: true) when ANY of these is plausibly in play:
- A turn matches or approaches a trigger condition in the playbook below.
- A conversation with a playbook-relevant NPC is in progress — INCLUDING ordinary small talk. Small talk with a secret-adjacent NPC is worth the director's attention even though it will usually stay out: this is how rapport built during small talk enters the director's memory at all.
- The scene shows a craft problem: tonal monotony (several exchanges in one register), a pacing stall, information arriving only from NPCs talking, or players following instructions without agency.
- The table is drifting toward territory the blind narrator might confabulate against a secret.

Stay out (needed: false) only when the recent exchanges are clearly routine and touch nothing the playbook cares about — pure logistics, banter among players with no NPC present, mechanical resolution already settled.

Firing is cheap insurance; a fire does NOT mean the director will act. When unsure, fire.

## Playbook (director's eyes only — never surfaced to players)

{{sd_playbook}}

## Running summary

{{running_summary}}

## Recent exchanges

{{recent_exchanges}}

Respond as JSON:
{
  "needed": true or false,
  "confidence": <number 0-1, your confidence in this verdict>,
  "reason": "<one phrase: why>"
}
```

- [ ] **Step 4: Failing call test** (mock `'ai'` — copy the mock scaffold from `src/llm/__tests__/dm-trigger-classifier.test.ts`, which scripts `generateText` for the wrapper's `generateObject`; NEVER mock `ai.ts`):

```ts
// backend/src/llm/__tests__/st-gate.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateTextMock = vi.fn()
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: (...a: unknown[]) => generateTextMock(...a) }
})

const { runStGate } = await import('../st-gate.js')

beforeEach(() => { generateTextMock.mockReset() })

describe('runStGate', () => {
  it('returns the structured verdict and threads sd_playbook + summary + slice into the prompt', async () => {
    generateTextMock.mockResolvedValue({
      output: { needed: true, confidence: 0.6, reason: 'r' },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    })
    const r = await runStGate({
      sdPlaybook: 'SECRET-PLAYBOOK', runningSummary: 'SUMMARY', recentExchanges: 'EXCHANGES',
    })
    expect(r.result).toEqual({ needed: true, confidence: 0.6, reason: 'r' })
    const call = generateTextMock.mock.calls[0]?.[0] as { prompt: string }
    expect(call.prompt).toContain('SECRET-PLAYBOOK')
    expect(call.prompt).toContain('SUMMARY')
    expect(call.prompt).toContain('EXCHANGES')
  })
  it('surfaces usage for :usage:st accounting', async () => {
    generateTextMock.mockResolvedValue({
      output: { needed: false, confidence: 0.95, reason: 'routine' },
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
    })
    const r = await runStGate({ sdPlaybook: 'p', runningSummary: '', recentExchanges: 'e' })
    expect(r.usage.inputTokens).toBe(9)
  })
})
```

- [ ] **Step 5: Implement the call**

```ts
// backend/src/llm/st-gate.ts
//
// MYT-69 §3 — the Haiku gate. One cheap generateObject through the canonical
// ai.ts wrapper. The gate may hold secrets freely (ST-side infrastructure whose
// output is consumed by code only). Repair 'haiku-then-sonnet'. The SKIP rule
// (`!needed && confidence ≥ floor`) is the WORKER's policy, not this call's.
// Errors propagate — the worker's fail-posture (skip this cycle, the floor
// guarantees eventual oversight) is the caller's job.

import { generateObject, type LanguageModelUsage } from './ai.js'
import { loadPrompt } from './prompts.js'
import { StGateResultSchema, type StGateResult } from './schemas/st-gate.js'
import { ST_GATE_MODEL, ST_GATE_TIMEOUT_MS } from '../session/st-config.js'

export interface StGateInput {
  readonly sdPlaybook: string
  readonly runningSummary: string
  readonly recentExchanges: string
}

export interface StGateOutput {
  readonly result: StGateResult
  readonly usage: LanguageModelUsage
}

export async function runStGate(input: StGateInput): Promise<StGateOutput> {
  const r = await generateObject({
    model: ST_GATE_MODEL,
    schema: StGateResultSchema,
    schemaName: 'StGateResultSchema',
    prompt: loadPrompt('session', 'st-gate', {
      sd_playbook: input.sdPlaybook,
      running_summary: input.runningSummary,
      recent_exchanges: input.recentExchanges,
    }),
    callSite: 'st-gate',
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_GATE_TIMEOUT_MS,
  })
  return { result: r.output, usage: r.usage }
}
```

**Implementer note:** confirm `LanguageModelUsage` is re-exported from `ai.ts` (it is — see the re-export block). Confirm `loadPrompt(group, name, vars)` ergonomics against `src/llm/prompts.ts`.

- [ ] **Step 6: Run both test files — PASS.** Report DONE.

---

### Task 3: The ST evaluation — schema + prompt (multiplayer rewrite) + call (§4, §5)

**Files:**
- Create: `backend/src/llm/schemas/st-director.ts`, `backend/src/llm/prompts/session/st-evaluation.txt`, `backend/src/llm/st-director.ts`
- Tests: `backend/src/llm/schemas/__tests__/st-director.test.ts`, `backend/src/llm/__tests__/st-director.test.ts`

This is the heart of the issue. The output schema is the STRUCTURAL SPLIT (the §8.2 leak bound). The standing op is DISCRIMINATED (not an ''/null trichotomy). The prompt is the multiplayer rewrite of the validated prototype (`st-evaluation.txt`) with ALL §4/§5 rules — written in full below.

- [ ] **Step 1: Failing schema test**

```ts
// backend/src/llm/schemas/__tests__/st-director.test.ts
import { describe, expect, it } from 'vitest'
import { StDirectorResultSchema } from '../st-director.js'

const base = {
  reasoning: 'Hobb has warmed; an earned reveal is appropriate.',
  intervene: true,
  direction: "Hobb can mention he saw the bargehand poking the east walkway; beyond that he's said all he'll say.",
  standingDirective: { action: 'keep', text: null },
  summaryUpdate: 'The party has been drinking with Hobb; he has gone from curt to chatty. Evening over Saltgate.',
}

describe('StDirectorResultSchema', () => {
  it('accepts a full intervene-with-reveal result', () => {
    expect(StDirectorResultSchema.safeParse(base).success).toBe(true)
  })
  it('accepts a no-intervene pass-through (null direction, keep standing)', () => {
    expect(
      StDirectorResultSchema.safeParse({ ...base, intervene: false, direction: null }).success,
    ).toBe(true)
  })
  it('accepts standingDirective set/clear/keep', () => {
    expect(StDirectorResultSchema.safeParse({ ...base, standingDirective: { action: 'set', text: 'Steer toward a close.' } }).success).toBe(true)
    expect(StDirectorResultSchema.safeParse({ ...base, standingDirective: { action: 'clear', text: null } }).success).toBe(true)
  })
  it('rejects an unknown standing action and an empty summary', () => {
    expect(StDirectorResultSchema.safeParse({ ...base, standingDirective: { action: 'wat', text: null } }).success).toBe(false)
    expect(StDirectorResultSchema.safeParse({ ...base, summaryUpdate: '' }).success).toBe(false)
    expect(StDirectorResultSchema.safeParse({ ...base, reasoning: '' }).success).toBe(false)
  })
  // NOTE: the set-requires-text / non-set-requires-null constraint is validated
  // in CODE (st-director.ts), NOT via .refine — the schema stays refine-free so
  // the repair chain can't author a "valid" tree (§4 repair posture).
})
```

- [ ] **Step 2: Implement the schema**

```ts
// backend/src/llm/schemas/st-director.ts
//
// MYT-69 §4 — the ST director's output: the STRUCTURAL SPLIT that IS the §8.2
// leak bound. Forcing the secret-aware reasoning into its own `reasoning`
// field is what keeps ride-along leaks out of the direction text. NO `.refine`
// cross-field constraints — the repair chain must not be able to author a
// "valid" tree; the set/text coupling is checked in code (st-director.ts),
// and a repairAttempted result is DISCARDED whole by the worker (§4).

import { z } from 'zod'

export const StDirectorResultSchema = z.object({
  // PRIVATE: secret-aware reasoning. Logged server-side only; NEVER crosses
  // into any FT-facing artifact.
  reasoning: z.string().min(1),
  intervene: z.boolean(),
  // PUBLIC-FACING: the one-shot stage direction (1-2 sentences; what-not-how;
  // may carry SANCTIONED reveal content). Crosses into the FT via fusion.
  direction: z.string().min(1).nullable(),
  // PUBLIC-FACING: the standing-directive op. A DISCRIMINATED shape, NOT an
  // ''/null trichotomy — models confuse empty-vs-null, and an accidental ''
  // would silently clear an active wind-down directive.
  standingDirective: z.object({
    action: z.enum(['set', 'clear', 'keep']),
    text: z.string().nullable(), // required for 'set'; null otherwise (code-validated)
  }),
  // The FULL replacement summary (rewrite semantics — §4).
  summaryUpdate: z.string().min(1),
})

export type StDirectorResult = z.infer<typeof StDirectorResultSchema>
```

- [ ] **Step 3: Write the prompt** — `backend/src/llm/prompts/session/st-evaluation.txt`. Vars: `{{party_roster}}`, `{{sd_playbook}}`, `{{running_summary}}`, `{{current_standing_directive}}`, `{{pending_one_shot}}`, `{{recent_exchanges}}`, `{{wind_down}}`, `{{summary_target_words}}`. **Write it in full** (the multiplayer rewrite of the prototype baseline; emit PLAIN prose and NEVER copy `[STAGE]` markup from the playbook — the controller adds the `[DM direction: …]` wrapper at fusion):

```text
You are the narrative director for a MULTIPLAYER D&D 5e session. You review COMPLETED turns from off the critical path — the players have already seen the narrator's last response. Your job: decide whether the NEXT turn needs a stage direction, manage a standing directive, and rewrite the running summary. Most turns do NOT warrant a one-shot intervention. The decision to intervene is YOURS — a separate gate decided only that this moment was worth your attention; it carries no opinion you should weigh.

You hold the playbook's secrets AND the social clock. The blind narrator cannot plot-dump what it does not know — from its seat, a merchant has nothing to offer a stranger but weather and prices, so it plays small talk in full. You watch rapport build and decide when a conversation has EARNED a reveal, portioning out exactly what the NPC entrusts. Enforced ignorance is the authenticity engine: NPCs are normal people until the story says otherwise.

## The party

{{party_roster}}

## What you monitor (craft)

- **Tonal monotony.** Several exchanges in one register (all dread, all warmth, all tension) → inject contrast. The inverse holds: healthy small talk going well is NOT a pacing stall — it is the texture of the world. Leave it alone.
- **Pacing stalls.** Exploration with no direction, or 3+ exchanges with no new development → a compression, an environmental event, the world intruding.
- **NPC-only revelations.** Every new fact arriving from an NPC talking → create a discovery the players stumble into (examine, overhear, find) instead of being told.
- **Missing agency.** Players following instructions for several turns with no independent choice → an open, unstructured moment.

## Direction classes

You may issue ONE one-shot direction per turn. When several fire at once, reveals OUTRANK craft nudges. Prefer a direction any PRESENT character can carry (a reveal aimed at an absent player stalls).

- **A. Earned reveal (trust pacing).** A conversation with a secret-adjacent NPC has warmed enough that a reveal is earned. Give a GRADED, behaviorally-bounded reveal: "Hobb's warmed to them — he can mention he saw the bargehand poking the east walkway; beyond that he's said all he'll say." Secrets are ENTRUSTED, not dispensed; you decide the moment and the portion.
- **B. Check-gated reveal ladder.** Useful-but-optional information a standard check should gate. Stage it ACROSS turns: first direct the tell ("Hobb seems to hold something back — if a player reads him, allow Insight"); the check rides the narrator's normal roll_skill_check; the pass lands in the transcript; on a LATER evaluation, having CONFIRMED the pass appears in the transcript, direct the rung ("a successful Persuasion gets the lock story — nothing more"). Track ladder state in the summary. NEVER gate critical-path progression behind a check — if a failure would stall the planned beats, give the information freely or route it another way; gate optional/corroborating clues, and let a failure mean the information arrives by another road.
- **C. Playbook beat.** Table state matches a playbook trigger. A behavioral, secret-free event: "Have the bargehand cross their path again — visibly. Don't explain him."
- **D. Craft intervention.** A how-not-what nudge: "Three exchanges of dread — inject something mundane and warm."
- **E. Secret-integrity steering.** The conversation is drifting where the blind narrator might confabulate against a secret. A boundary + redirect, phrased WITHOUT naming the protected content: "Hobb has nothing more to offer on warehouse business; he deflects anything further to Vane." A boundary that must HOLD across a scene is STANDING-shaped — fold it into the composed standing text, not a one-shot that evaporates next turn.
- **F. Grounding step-in.** Ungrounded RP or a needed yank-back: "Ring the fog bell — the harbor reacts." (Player-only chat produces no turns and no evaluations; when the system's own proactive step-in fires, your slot is usually empty and the narrator improvises — you refine on the following beat.)
- **G. Wind-down.** When wind-down mode is active (below): a STANDING directive — "Steer toward a natural close: resolve the current scene, open no new threads or NPCs."

## The channel rules (load-bearing — enforced ignorance)

- Directions carry BEHAVIOR and SANCTIONED reveal content only. Your `reasoning` field is where secret-aware thinking lives — it is NEVER shown to the narrator. Never put a secret in a direction you have not deliberately decided the NPC surfaces.
- Phrase scope bounds BEHAVIORALLY, never naming the protected content. Write "he's said all he'll say; he deflects further pressing to Vane" — NEVER "nothing about the ledger" (which itself tells the narrator a ledger exists).
- A direction is an OPPORTUNITY, not an order — it is written one turn ago. If the scene has moved against it, the narrator should let it go.
- Emit PLAIN prose. Do NOT copy `[STAGE]` markup from the playbook — the wrapper is added downstream.

## Standing directive (one composed text, rewritten WHOLE each evaluation)

There is ONE standing slot. Fold wind-down and any live knowledge boundary together into a single composed text. To change it, return `standingDirective.action = "set"` with the full new `text`. To remove it, `"clear"`. To leave it exactly as-is, `"keep"`.

Current standing directive: {{current_standing_directive}}
Pending (unconsumed) one-shot: {{pending_one_shot}}

(You see your own active slots so you do not clobber a pending reveal or `keep` a standing text you can no longer remember.)

## The running summary — a REWRITE, not an append

Return the FULL replacement summary each time (target ~{{summary_target_words}} words; the old summary is below, rewrite from it). Track, with CURRENT values (not accumulated deltas):
- character arcs and positions;
- NPC rapport/trust levels ("the party has been drinking with Hobb; he's gone from curt to chatty") — what lets you judge an earned reveal across evaluations;
- in-progress reveal-ladder state ("Insight passed, Hobb ladder open") — and only advance a rung once you have CONFIRMED the directed reveal actually appears in the transcript (an overwritten or lost direction must not leave the summary believing a rung landed);
- coarse time progression ("evening falls over Saltgate").

## Playbook (your eyes only — never surfaced to players)

{{sd_playbook}}

## Running summary (to rewrite)

{{running_summary}}

## Recent exchanges (player + narrator)

{{recent_exchanges}}

{{wind_down}}

Respond as JSON:
{
  "reasoning": "<your secret-aware thinking — NEVER shown to the narrator>",
  "intervene": true or false,
  "direction": "<a 1-2 sentence what-not-how stage direction, or null>",
  "standingDirective": { "action": "set" | "clear" | "keep", "text": "<full text for set, else null>" },
  "summaryUpdate": "<the FULL rewritten summary>"
}
```

The `{{wind_down}}` var is `''` when not in wind-down mode, else a sentence the call injects (e.g. "WIND-DOWN MODE IS ACTIVE: the session is near its token budget. Set a STANDING directive that steers toward a natural close, and keep directing toward closure on subsequent evaluations.").

- [ ] **Step 4: Failing call test** (mock `'ai'`):

```ts
// backend/src/llm/__tests__/st-director.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateTextMock = vi.fn()
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: (...a: unknown[]) => generateTextMock(...a) }
})

const { runStDirector } = await import('../st-director.js')

const okOutput = {
  reasoning: 'r', intervene: true, direction: 'd',
  standingDirective: { action: 'keep', text: null },
  summaryUpdate: 's',
}

beforeEach(() => { generateTextMock.mockReset() })

describe('runStDirector', () => {
  it('returns the result, usage, and repairAttempted flag; threads context vars', async () => {
    generateTextMock.mockResolvedValue({
      output: okOutput, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    })
    const r = await runStDirector({
      partyRoster: 'Arin (Rogue), Bryn (Cleric)',
      sdPlaybook: 'SECRET', runningSummary: 'SUM', currentStandingDirective: 'NONE',
      pendingOneShot: 'NONE', recentExchanges: 'EX', windDown: false,
    })
    expect(r.result).toEqual(okOutput)
    expect(r.repairAttempted).toBe(false)
    expect(r.usage.inputTokens).toBe(100)
    const call = generateTextMock.mock.calls[0]?.[0] as { prompt: string }
    expect(call.prompt).toContain('SECRET')
    expect(call.prompt).toContain('Arin (Rogue)')
  })
  it('surfaces repairAttempted=true (the worker discards on this)', async () => {
    // Force the wrapper's repair arm: first generateText throws a structured
    // error, then the repair tier returns a valid tree. Easiest reliable form:
    // assert the flag passes through when the mock resolves with it. Implementer:
    // follow the existing ai.test.ts repair-path scaffold to drive repairAttempted
    // true; the assertion is that runStDirector forwards r.repairAttempted.
  })
  it('injects the wind-down instruction only when windDown is true', async () => {
    generateTextMock.mockResolvedValue({ output: okOutput, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
    await runStDirector({
      partyRoster: 'P', sdPlaybook: 'p', runningSummary: '', currentStandingDirective: 'NONE',
      pendingOneShot: 'NONE', recentExchanges: 'e', windDown: true,
    })
    const call = generateTextMock.mock.calls[0]?.[0] as { prompt: string }
    expect(call.prompt).toMatch(/WIND-DOWN MODE IS ACTIVE/i)
  })
})
```

- [ ] **Step 5: Implement the call**

```ts
// backend/src/llm/st-director.ts
//
// MYT-69 §4 — the Opus ST evaluation. generateObject through the canonical
// ai.ts wrapper, repair 'haiku-then-sonnet'. CRITICAL: the wrapper's
// repairAttempted flag is surfaced UNCHANGED — the worker discards the entire
// result when it is true (a repaired `direction` is text the ST did not
// author; the single-gate argument requires it). maxOutputTokens is set
// explicitly (reasoning + direction + a full summary rewrite is long).

import { generateObject, type LanguageModelUsage } from './ai.js'
import { loadPrompt } from './prompts.js'
import { StDirectorResultSchema, type StDirectorResult } from './schemas/st-director.js'
import { ST_EVAL_MAX_OUTPUT_TOKENS, ST_EVAL_TIMEOUT_MS, ST_MODEL, ST_SUMMARY_TARGET_WORDS } from '../session/st-config.js'

const WIND_DOWN_INSTRUCTION =
  'WIND-DOWN MODE IS ACTIVE: the session is near its token budget. Set a STANDING directive that steers toward a natural close (resolve the current scene, open no new threads or NPCs), and keep directing toward closure on subsequent evaluations.'

export interface StDirectorInput {
  readonly partyRoster: string
  readonly sdPlaybook: string
  readonly runningSummary: string
  readonly currentStandingDirective: string
  readonly pendingOneShot: string
  readonly recentExchanges: string
  readonly windDown: boolean
}

export interface StDirectorOutput {
  readonly result: StDirectorResult
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export async function runStDirector(input: StDirectorInput): Promise<StDirectorOutput> {
  const r = await generateObject({
    model: ST_MODEL,
    schema: StDirectorResultSchema,
    schemaName: 'StDirectorResultSchema',
    prompt: loadPrompt('session', 'st-evaluation', {
      party_roster: input.partyRoster,
      sd_playbook: input.sdPlaybook,
      running_summary: input.runningSummary,
      current_standing_directive: input.currentStandingDirective,
      pending_one_shot: input.pendingOneShot,
      recent_exchanges: input.recentExchanges,
      wind_down: input.windDown ? WIND_DOWN_INSTRUCTION : '',
      summary_target_words: String(ST_SUMMARY_TARGET_WORDS),
    }),
    callSite: 'st-director',
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_EVAL_TIMEOUT_MS,
    maxOutputTokens: ST_EVAL_MAX_OUTPUT_TOKENS,
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
```

- [ ] **Step 6: Run both test files — PASS.** Report DONE.

---

### Task 4: trigger-state — the direction slots + turns-since-ST counter (§6, §8)

**Files:**
- Modify: `backend/src/session/trigger-state.ts` + extend `backend/src/session/__tests__/trigger-state.test.ts`

Add the two-field direction slot + the turns-since-ST counter + the §8 session-start reset, all campaign-scoped, mirroring the existing key conventions. The standing op is stored DISCRIMINATED (the worker passes a `{ action, text }` resolution; trigger-state stores/clears the text only — but the take/read semantics live here).

New keys (under the same `${keyPrefix}session:${campaignId}:` convention):
```
session:{cId}:direction:oneshot     latest-wins one-shot text; GETDEL-consumed
session:{cId}:direction:standing    composed standing text; read (not cleared)
session:{cId}:turns-since-st        int counter; INCR per flushed turn, reset when ST ran
```

- [ ] **Step 1: Failing test** (ioredis-mock):

```ts
describe('MYT-69 direction slots', () => {
  it('one-shot: set latest-wins, GETDEL take returns then clears', async () => {
    await ts.setOneShotDirection('c', 'first')
    await ts.setOneShotDirection('c', 'second') // latest wins
    expect(await ts.takeOneShotDirection('c')).toBe('second')
    expect(await ts.takeOneShotDirection('c')).toBeNull() // cleared
  })
  it('one-shot: peek reads WITHOUT consuming (the ST-side read)', async () => {
    await ts.setOneShotDirection('c', 'pending')
    expect(await ts.peekOneShotDirection('c')).toBe('pending')
    expect(await ts.peekOneShotDirection('c')).toBe('pending') // peek does not clear
    expect(await ts.takeOneShotDirection('c')).toBe('pending') // take still consumes
  })
  it('standing: set / read (NOT cleared by read) / clear', async () => {
    expect(await ts.readStandingDirection('c')).toBeNull()
    await ts.setStandingDirection('c', 'wind down')
    expect(await ts.readStandingDirection('c')).toBe('wind down')
    expect(await ts.readStandingDirection('c')).toBe('wind down') // read does not clear
    await ts.clearStandingDirection('c')
    expect(await ts.readStandingDirection('c')).toBeNull()
  })
  it('turns-since-ST: INCR returns the new value, reset zeroes it', async () => {
    expect(await ts.incrTurnsSinceSt('c')).toBe(1)
    expect(await ts.incrTurnsSinceSt('c')).toBe(2)
    expect(await ts.turnsSinceSt('c')).toBe(2)
    await ts.resetTurnsSinceSt('c')
    expect(await ts.turnsSinceSt('c')).toBe(0)
  })
  it('resetSessionKeys clears all five ST keys (+ leaves transport keys)', async () => {
    await ts.setOneShotDirection('c', 'x'); await ts.setStandingDirection('c', 'y')
    await ts.incrTurnsSinceSt('c')
    await ts.resetSessionKeys('c')
    expect(await ts.takeOneShotDirection('c')).toBeNull()
    expect(await ts.readStandingDirection('c')).toBeNull()
    expect(await ts.turnsSinceSt('c')).toBe(0)
  })
})
```

(`resetSessionKeys` here clears the trigger-state-owned ST keys: oneshot, standing, turns-since-st. The `:usage`, `:usage:st`, `:summary` resets live on `session-state.ts` and are called from the route in T7 — keep ownership clean.)

- [ ] **Step 2: Implement** — add to `TriggerState` interface + factory, and the key fns:

```ts
  // §6 one-shot direction slot. Latest-wins SET (a newer evaluation overwrites
  // an unconsumed direction — the ST sees the pending value in its context, so
  // the overwrite is informed). Taken-and-cleared atomically (GETDEL) ONLY on
  // the turn worker's fresh-run arm. Carries the session-state TTL.
  setOneShotDirection(campaignId: string, text: string): Promise<void>
  takeOneShotDirection(campaignId: string): Promise<string | null>
  /** §4 read-only peek for the ST's own context (its unconsumed pending
   *  one-shot) — a plain GET. The turn worker's fresh-run arm is the ONLY
   *  consumer (takeOneShotDirection); the ST NEVER consumes. */
  peekOneShotDirection(campaignId: string): Promise<string | null>
  // §6 standing directive. SET/clear by the ST job; READ (not cleared) every
  // DM turn. Carries the session-state TTL.
  setStandingDirection(campaignId: string, text: string): Promise<void>
  readStandingDirection(campaignId: string): Promise<string | null>
  clearStandingDirection(campaignId: string): Promise<void>
  // §8 turns-since-the-last-ST-RAN. INCR on the flushed-success path; reset only
  // when an Opus evaluation actually ran (the reset-vs-INCR race is accepted at
  // ±1 — the floor still fires within a turn or two).
  incrTurnsSinceSt(campaignId: string): Promise<number>
  turnsSinceSt(campaignId: string): Promise<number>
  resetTurnsSinceSt(campaignId: string): Promise<void>
  /** §8 session-boundary hygiene: clear the ST-owned slots + counter at session
   *  start. (The :usage / :usage:st / :summary resets are session-state's, called
   *  alongside this from the route.) */
  resetSessionKeys(campaignId: string): Promise<void>
```

```ts
  const oneShotKey = (campaignId: string): string => `${base(campaignId)}:direction:oneshot`
  const standingKey = (campaignId: string): string => `${base(campaignId)}:direction:standing`
  const turnsSinceStKey = (campaignId: string): string => `${base(campaignId)}:turns-since-st`
  // STATE_TTL is private to session-state.ts; mirror its 2h value here for the
  // direction slots so a gate-quiet stretch doesn't let a pending reveal lapse
  // mid-session. (Hardcode 7200 with a comment, OR export STATE_TTL_S from
  // session-state and import — implementer's call; typecheck/lint is the gate.)
  const DIRECTION_TTL_S = 2 * 60 * 60
```
```ts
    setOneShotDirection: async (campaignId, text) => {
      await redis.set(oneShotKey(campaignId), text, 'EX', DIRECTION_TTL_S)
    },
    takeOneShotDirection: async (campaignId) => redis.getdel(oneShotKey(campaignId)),
    peekOneShotDirection: async (campaignId) => redis.get(oneShotKey(campaignId)),
    setStandingDirection: async (campaignId, text) => {
      await redis.set(standingKey(campaignId), text, 'EX', DIRECTION_TTL_S)
    },
    readStandingDirection: async (campaignId) => redis.get(standingKey(campaignId)),
    clearStandingDirection: async (campaignId) => {
      await redis.del(standingKey(campaignId))
    },
    incrTurnsSinceSt: async (campaignId) => redis.incr(turnsSinceStKey(campaignId)),
    turnsSinceSt: async (campaignId) => {
      const raw = await redis.get(turnsSinceStKey(campaignId))
      if (raw === null) return 0
      const n = Number(raw)
      return Number.isFinite(n) ? n : 0
    },
    resetTurnsSinceSt: async (campaignId) => {
      await redis.del(turnsSinceStKey(campaignId))
    },
    resetSessionKeys: async (campaignId) => {
      await redis.del(oneShotKey(campaignId), standingKey(campaignId), turnsSinceStKey(campaignId))
    },
```

Also update the module header key-list comment to add the three new keys.

- [ ] **Step 3: Run — PASS.** Report DONE.

---

### Task 5: `ft-system.txt` — the FT half of the authenticity dynamic (§4, §9, §12 amendments)

**Files:**
- Modify: `backend/src/llm/prompts/session/ft-system.txt`
- Test: extend `backend/src/llm/prompts/__tests__/ft-system.test.ts`

Add four amendments to the SHIPPED prompt (do not rewrite the existing sections): the NPC-authenticity section, a reconciliation of the check-frequency rule (no-stakes conversation is NOT uncertainty), the social-check depth rule, the direction-conditionality rule, and the standalone standing-direction message form in the DM Direction Protocol.

- [ ] **Step 1: Failing test** (append to the existing file):

```ts
describe('ft-system MYT-69 amendments', () => {
  const render = (): string =>
    loadPrompt('session', 'ft-system', { ft_context: 'FTCTX', party_roster: 'Arin, Bryn' })
  it('adds the NPC-authenticity section', () => {
    const p = render()
    expect(p).toMatch(/strangers/i)
    expect(p).toMatch(/small talk/i)
    expect(p).toMatch(/trust is earned/i)
  })
  it('carves out no-stakes conversation from the frequency rule', () => {
    expect(render()).toMatch(/genuine .*conversation is not.*uncertainty|chatting/i)
  })
  it('states the social-check depth rule + direction-conditionality', () => {
    const p = render()
    expect(p).toMatch(/demeanor|disposition/i)
    expect(p).toMatch(/let it go|opportunity, not an order/i)
  })
  it('describes the standalone standing-direction message form', () => {
    expect(render()).toMatch(/standing/i)
  })
})
```

- [ ] **Step 2: Implement** — the edits. After the existing `## DM Direction Protocol` paragraph, append:

```text
A direction may also arrive as a standalone bracketed line at the very end of the conversation (not attached to a player message). Treat it identically: a director's note, consumed silently, used as inspiration. A direction is an OPPORTUNITY, not an order — it was written about a moment that may have already passed. If the scene has moved against it, let it go rather than forcing it.
```

Replace the existing **Frequency rule** paragraph (Dice Tools section) with:

```text
**Frequency rule:** If a conversation has gone 2+ exchanges without a skill check, the next player action involving genuine uncertainty MUST trigger one. Social uncertainty counts — but a genuine no-stakes conversation is NOT uncertainty. Checks gate attempts to CHANGE someone's mind, deceive them, or read what they are hiding — never ordinary chatting. Do not roll dice into small talk.
```

After the Dice Tools section, add a new section:

```text
## NPCs Are Normal People

NPCs are not quest dispensers. A stranger treats the party as strangers — they get weather, prices, and wary politeness, not the NPC's troubles or secrets. People do not volunteer what matters to someone they just met. Small talk is the texture of the world; play it in full, and let it be ordinary. Trust is earned across a conversation, and what an NPC has to share, the story will tell you when it is time (a direction will indicate a tell — when it does, surface it naturally and let the check ride the normal tool flow).

When a player succeeds on a social check against an NPC whose depths you do not know, the result is the NPC's DEMEANOR, disposition, or plausible PUBLIC content — never invented hidden plot. A passed Insight tells the player the NPC is nervous or sincere; it does not hand them a secret you were never told.
```

- [ ] **Step 3: Run — PASS.** Report DONE.

---

### Task 6: `session-prep.txt` — entrusted secrets, critical-path marking, stale-instruction fix (§12)

**Files:**
- Modify: `backend/src/llm/prompts/prep/session-prep.txt`
- Test: if `backend/src/llm/prompts/__tests__/session-prep.test.ts` exists, extend it; else add a small var-contract + content test (read the existing prep prompt tests for the pattern first — do NOT change the var contract, only content).

Three edits:
1. **Add** an entrusted-secrets trust-conditions nudge to the playbook authoring guidance: secrets are ENTRUSTED, not dispensed — for each secret-bearing NPC, note what builds the trust that earns a reveal (drinking together, a shared enemy, a passed check) so the director can pace it.
2. **Add** critical-path vs corroborating-clue marking: mark each clue/reveal as either critical-path (a planned beat depends on it — give it freely, never gate it behind a check that could stall the story) or corroborating/optional (safe to gate behind a check; a failure means it arrives by another road).
3. **FIX** the now-stale lines that presume the pre-FT ST this spec removes. The lines (verbatim in the file):
   - L93: `"NPCs only know what they could plausibly know from their own perspective. When uncertain, default to ignorance, and wait for stage directions."`
   - L94: `"Do not invent NPC backstories or reveal anything marked with a depth marker. Stage directions will guide deeper moments when the time comes."`
   - L95: `"Do not guess what a clue marker contains. If the party investigates a marked place, narrate the investigation but wait for a stage direction before revealing specifics."`

   These instruct the FT to STALL waiting for a direction. Under the post-hoc model the FT must narrate what `ft_context` supports NOW; deeper specifics arrive by direction on SUBSEQUENT beats (one turn late). Rewrite the FT-instruction lines the prep doc emits to:
   - `"NPCs only know what they could plausibly know from their own perspective. When uncertain, default to ignorance and play the moment as it stands — do not stall for a cue."`
   - `"Do not invent NPC backstories or reveal anything beyond what this context supports. Deeper moments develop over subsequent turns; narrate honestly now."`
   - `"If the party investigates a marked place, narrate the investigation with what this context supports — do not fabricate hidden specifics; if there is more, it surfaces on a later beat."`

**Implementer note:** read the exact surrounding text before editing — the lines may be inside a quoted block or example. Preserve the depth-marker / `[STAGE]`-tag authoring guidance for the PLAYBOOK (that markup is correct in the sd_playbook); only the FT-FACING instruction lines (what the prep tells the narrator) change. Do NOT touch the playbook's own `[STAGE]` examples — the ST prompt (T3) handles stripping that markup at the point of emission.

- [ ] **Step 1:** make the three edits (content test if applicable).
- [ ] **Step 2:** Run any prep-prompt test — PASS. Report DONE.

---

### Task 7: `routes/sessions.ts` — the active-route ALLOWLIST (§9 showstopper) + session-start key resets (§8)

**Files:**
- Modify: `backend/src/routes/sessions.ts` + extend `backend/src/routes/__tests__/sessions.test.ts`

**The showstopper:** `GET /api/sessions/:campaignId/active` returns the FULL mapped `Session` row — `stRunningSummary` included — to any campaign member. Inert today (empty stub summary); the moment the ST writes rapport/ladder/secret-adjacent state, players read it with one REST call after any suspend. Fix: an explicit response allowlist (id/status/sessionNumber/timestamps — NEVER `stRunningSummary` or any checkpoint material). **Plus** the session-start key resets so a same-campaign session started within the 2h TTL is not born inheriting prior usage + a standing wind-down directive.

- [ ] **Step 1: Failing tests** (extend the existing route suite — read its harness/fixtures first):
  1. `GET .../active` with an active session returns ONLY `{ id, status, sessionNumber, startedAt, endedAt }` (assert the response `session` object has EXACTLY that key set — and explicitly assert `stRunningSummary`, `summary`, `handoff` are ABSENT).
  2. `GET .../active` with no session returns `{ session: null }`.
  3. session start resets `:usage`, `:usage:st`, `:summary`, both direction slots, and the turns-since-ST counter (assert via the injected sessionState/triggerState fakes, or by seeding the keys then asserting they're cleared post-start).

- [ ] **Step 2: Implement.**
  - The active route — map to the allowlist:

```ts
  app.get<{ Params: { campaignId: string } }>(
    '/api/sessions/:campaignId/active',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const session = await repo.sessions.getActiveByCampaign(request.params.campaignId)
      // §9 LEAK FIX: an explicit response allowlist. The full Session row carries
      // `stRunningSummary` (ST-authored, secret-adjacent) + checkpoint material;
      // returning the whole row to any member is the round-1 showstopper. Strip
      // to exactly the player-safe fields. (The deeper "member-guarded route
      // returns whole repo rows" landmine is noted for the API-hygiene sweep;
      // the strip ships here because MYT-69 is what arms it.)
      return reply.code(200).send({
        session:
          session === null
            ? null
            : {
                id: session.id,
                status: session.status,
                sessionNumber: session.sessionNumber,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
              },
      })
    },
  )
```

  - The session-start handler — after the `setState(...)` in `handleSessionStart`, reset the ST keys. The handler has `sessionState` in `deps`; it needs `triggerState` too. Construct a `makeTriggerState(opts.redisRealtime, opts.redisKeyPrefix)` in the plugin shell and pass it into `SessionStartDeps`. Add to `session-state.ts` (T12) a `resetSessionSpend(campaignId)` that DELs `:usage`, `:usage:st`, `:summary` in one MULTI; call both:

```ts
  // §8 session-boundary hygiene: a same-campaign session started within the 2h
  // state TTL must NOT inherit the prior session's usage, summary, or a standing
  // wind-down directive (it would be born dying). Reset both spend keys + the
  // ST-owned direction slots + counter at start.
  await deps.sessionState.resetSessionSpend(campaignId)
  await deps.triggerState.resetSessionKeys(campaignId)
```

  Wire `triggerState` into the plugin: `const triggerState = makeTriggerState(opts.redisRealtime, opts.redisKeyPrefix)`, add `readonly triggerState: TriggerState` to `SessionStartDeps`, pass it in the `handleSessionStart(...)` call. Import `makeTriggerState, type TriggerState` from `'../session/trigger-state.js'`.

- [ ] **Step 3: Run the route suite — PASS** + typecheck. Report DONE.

**Implementer note:** `resetSessionSpend` is defined in T12. If T7 lands before T12, stub the method on the injected fake for the test and pin its signature here; T12 implements it on the real `SessionState`. (typecheck is the authority once both land.)

---

### Task 8: runtime spec §17.4 correction (docs edit)

**Files:**
- Modify: `docs/specs/2026-04-13-multiplayer-session-runtime.md`

§17.4's "Channel-semantics widening (amends §8.2)" paragraph (line ~670) ends: *"The Haiku leak-check (§8.2) still bounds it: the ST cannot relay more than it decided to surface."* This is now FALSE under MYT-69's no-checker decision. Amend it to cite this spec's structural-split bound and the MYT-72 revisit.

- [ ] **Step 1:** Replace the stale sentence. New text:

```text
**Channel-semantics widening (amends §8.2):** §8.2 frames the ST `direction` as *behavior, not information*. The lookup flow adds a second, sanctioned mode — when a player has asked a direct question and **earned the answer via a passed check**, the ST may relay **vetted information** ("yes, a fishing town two days north"), not just behavior. The bound is the STRUCTURAL reasoning/direction split defined in `docs/superpowers/specs/2026-06-10-myt-69-slowthinker-design.md` §4 (the §8.2 direction-channel bound) — there is **no independent Haiku leak-check**; the ST is the single gate and the relay text is its sanctioned output. The MYT-72 vetted-information-relay mode is the natural point to revisit an optional form-checker. This widening is a deliberate decision, not drift.
```

- [ ] **Step 2:** Also fix the §17.4 step-4/§17.6 references to "Haiku leak-check (§8.2)" if any others exist (grep `leak-check` in the file). Report DONE with the lines changed. (Docs-only; no test. The wiki sync in T18 picks up any drift.)

**Implementer note:** this is documentation coherence, not a technical blocker — do not dispatch review rounds over prose. Make the surgical edit and move on.

---

### Task 9: `st-eval-queue.ts` — the producer + the self-re-arm dedup surface (§2)

**Files:**
- Create: `backend/src/session/st-eval-queue.ts`
- Test: `backend/src/session/__tests__/st-eval-queue.test.ts`

Mirror `dm-trigger-queue.ts` + `DmTriggerQueueWithDedup`. The producer adds with dedup `{ id: 'st-eval:<campaignId>' }`, NO ttl, NO delay (so `replace` is inert — note that). The worker-side surface adds `removeDeduplicationKey` for the job's end-of-run self-re-arm.

- [ ] **Step 1: Failing test**

```ts
// backend/src/session/__tests__/st-eval-queue.test.ts
import { describe, expect, it, vi } from 'vitest'
import { enqueueStEval, stEvalDedupId, QUEUE_ST_EVAL, type StEvalPayload } from '../st-eval-queue.js'

describe('st-eval-queue', () => {
  it('dedup id is stable per campaign', () => {
    expect(stEvalDedupId('c1')).toBe('st-eval:c1')
  })
  it('enqueueStEval adds with the dedup id and NO ttl/delay', async () => {
    const add = vi.fn().mockResolvedValue(undefined)
    await enqueueStEval({ add }, { campaignId: 'c1', sessionId: 's1' })
    const [name, data, opts] = add.mock.calls[0] as [string, StEvalPayload, Record<string, unknown>]
    expect(name).toBe(QUEUE_ST_EVAL)
    expect(data).toEqual({ campaignId: 'c1', sessionId: 's1' })
    expect(opts.deduplication).toEqual({ id: 'st-eval:c1' })
    expect(opts.delay).toBeUndefined()
    expect((opts.deduplication as { ttl?: number }).ttl).toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement**

```ts
// backend/src/session/st-eval-queue.ts
//
// MYT-69 §2 — the st-evaluation debounce/dedup producer. Single-flight per
// campaign by an explicit invariant (NOT a dedup accident): dedup
// `{ id: 'st-eval:<campaignId>' }` with NO ttl (a ttl'd key outlives the job
// and swallows re-adds — reference_bullmq_dedup_ttl_swallows_readds). NO delay,
// so `replace` is inert here (the job never sits in the delayed state). Adds
// while the job is WAITING collapse losslessly (the job reads current state at
// run time). Adds while the job is ACTIVE are SWALLOWED — closed by the JOB's
// own end-of-run self-re-arm (see the worker), which clears its own dedup key
// via `removeDeduplicationKey` then re-adds (the dm-trigger-worker pattern).
// The PRODUCER must NEVER remove the key (removing it under a waiting job would
// double-run).

import type { Queue } from 'bullmq'

export const QUEUE_ST_EVAL = 'st-evaluation'
export const ST_EVAL_JOB_NAME = 'st-evaluation'

export interface StEvalPayload {
  readonly campaignId: string
  readonly sessionId: string
}

/** Narrow producer surface (the turn worker's post-turn phase): just `add`. */
export interface StEvalQueueLike {
  add: Queue<StEvalPayload>['add']
}

/** Worker-side surface: the job's self-re-arm clears its OWN dedup key before
 *  re-adding (a running/active job cannot be replaced; a plain dedup'd add from
 *  inside the job is swallowed by its own key). Mirrors DmTriggerQueueWithDedup. */
export interface StEvalQueueWithDedup extends StEvalQueueLike {
  removeDeduplicationKey: Queue<StEvalPayload>['removeDeduplicationKey']
}

export function stEvalDedupId(campaignId: string): string {
  return `st-eval:${campaignId}`
}

export function enqueueStEval(queue: StEvalQueueLike, payload: StEvalPayload): Promise<unknown> {
  return queue.add(ST_EVAL_JOB_NAME, payload, {
    deduplication: { id: stEvalDedupId(payload.campaignId) },
  })
}
```

**Implementer note:** `QUEUE_ST_EVAL` and `ST_EVAL_JOB_NAME` are the same string here (mirrors how other queues name their default job). If the BullMQ `add` typing wants a distinct job name, keep them equal — it's harmless. Confirm the `add` overload signature against `dm-trigger-queue.ts`'s `rescheduleDebounce` for the options object shape.

- [ ] **Step 3: Run — PASS.** Report DONE.

---

### Task 10: `st-evaluation-worker.ts` — the pipeline (policy → gate → evaluate → write) + the roster repo read (§3, §4, §7, §8, §10)

**Files:**
- Create: `backend/src/session/st-evaluation-worker.ts` + `backend/src/session/__tests__/st-evaluation-worker.test.ts`
- Modify: `backend/src/repo/characters.ts` + extend `backend/src/repo/__tests__/characters.test.ts` (the roster read gains class/background)

The worker defines its OWN narrow repo interface (sdPlaybook read + the codec window + the roster read) — it does NOT widen `TurnWorkerRepo` (the FT-side worker's surface never gains a secret-bearing read). `processStEvalJob(deps, job)` takes all collaborators as injected struct params (unit-testable with fakes). `buildStEvaluationWorker(...)` is the boot wiring. The pipeline:

1. **Active-session check** — `repo.sessions.getActiveByCampaign(campaignId)`; if none, or its id ≠ the payload sessionId, no-op (a queued/in-flight job for an ended session no-ops). Snapshot the responded watermark at start (for the self-re-arm).
2. **DETERMINISTIC POLICY** (code, not AI): read `turnsSinceSt` + `usage + usage:st`. If `turnsSinceSt ≥ ST_EVAL_FLOOR_TURNS` → evaluate (skip the gate). If `(usage + usage:st) ≥ WIND_DOWN_FRACTION × SESSION_TOKEN_BUDGET` → evaluate in wind-down mode. Else → the gate.
3. **HAIKU GATE** — `runStGate`. Skip IFF `!needed && confidence ≥ ST_GATE_CONFIDENCE_FLOOR`. A gate FAILURE → skip this cycle, log (the floor guarantees eventual oversight). On skip → go to step 6 (self-re-arm) WITHOUT writing direction/summary, but DO write the gate's usage to `:usage:st` (so the spend is accounted) — actually: write gate usage in step 5 regardless (gate ran either way unless policy skipped it). Keep it simple: accumulate a `usageToWrite` and INCRBY once at the end.
4. **OPUS ST EVALUATION** — assemble context (roster + sd_playbook + summary + current standing + pending one-shot + recent slice + wind-down flag), `runStDirector`. **If `repairAttempted === true` → DISCARD the entire result**: no direction, no standing change, no summary write, but DO still count the eval usage (the tokens were spent) and treat the ST as "ran" (reset turns-since-ST). On success, validate the discriminated standing op in code (set ⇒ text non-null; clear/keep ⇒ ignore text).
5. **WRITE outputs** (each guarded — a slot-write failure logs; the world keeps turning):
   - one-shot: if `result.intervene && result.direction !== null` → `setOneShotDirection` (latest-wins).
   - standing: `set` → `setStandingDirection(text)`; `clear` → `clearStandingDirection`; `keep` → no-op.
   - summary: `setRunningSummary(summaryUpdate)` (the ST job is the only writer; SET with TTL — T12).
   - usage: `incrUsageSt(gateUsage + evalUsage tokens)` (T12).
   - reset `turnsSinceSt` (an Opus evaluation ran).
6. **SELF-RE-ARM** — if the responded watermark advanced since the snapshot (newer turns landed mid-evaluation): `removeDeduplicationKey(stEvalDedupId(campaignId))` then `enqueueStEval(...)`.

- [ ] **Step 1: Roster repo read — failing test + impl.** Extend `characters.listSessionParticipantCharacters` to ALSO carry `class` + `background` (or add a sibling `listSessionParticipantCharactersDetailed`). The FT-side worker reads the `{userId, name}` shape; do NOT break it. **Add a sibling** to avoid touching the FT path's call site:

```ts
    /** MYT-69 §4 — the PC roster with class/background for the ST's world-state
     *  block. A NEW read (the existing listSessionParticipantCharacters returns
     *  {userId, name} only and is read on the FT hot path — leave it). */
    listSessionParticipantRoster: async (
      sessionId: string,
    ): Promise<readonly { name: string; characterClass: string; background: string }[]> => {
      const result = await c.query<{ name: string; class: string; background: string }>(
        `SELECT ch.name, ch.class, ch.background FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1
          ORDER BY sp.joined_at ASC, sp.id ASC`,
        [sessionId],
      )
      return result.rows.map((r) => ({ name: r.name, characterClass: r.class, background: r.background }))
    },
```

  Test (real PG, existing fixtures): seed two joined participants with class/background → returns both in join order with the fields. **Implementer:** verify `characters.class` and `characters.background` are the actual column names (grep `CharacterDbRow` / the `characters` table migration; `class` is likely a column — if `background` is absent or differently named, adapt; typecheck + the real-PG test are the authority).

- [ ] **Step 2: Failing worker test** (fakes + ioredis-mock for any redis; or pure injected fakes). Write these cases:
  1. **Active-session no-op:** `getActiveByCampaign` returns null → no gate, no eval, no writes.
  2. **Wrong-session no-op:** active session id ≠ payload sessionId → no-op.
  3. **Policy floor:** `turnsSinceSt = 5` → the gate is NOT called; the evaluation IS called; `resetTurnsSinceSt` called after.
  4. **Policy wind-down:** `usage + usage:st ≥ 0.9 × budget` → evaluation called with `windDown: true`.
  5. **Gate skip:** policy not tripped, gate returns `{ needed: false, confidence: 0.9 }` → evaluation NOT called; no direction/summary write; gate usage still INCRBY'd to `:usage:st`.
  6. **Gate fire → evaluate:** gate `{ needed: true, confidence: 0.5 }` → evaluation called.
  7. **Gate-low-confidence-no → evaluate:** `{ needed: false, confidence: 0.5 }` (below floor) → evaluate (fail-toward-oversight).
  8. **GATE INDEPENDENCE:** assert the evaluate call's input does NOT contain the gate's reason/verdict (the StDirectorInput has no gate field — assert by capturing the `runStDirector` arg and checking it has no `needed`/gate keys; structurally enforced by the input type, but pin it).
  9. **Intervene write:** evaluation returns `intervene:true, direction:'D', standing set 'S'` → `setOneShotDirection('D')`, `setStandingDirection('S')`, `setRunningSummary`, `incrUsageSt`, `resetTurnsSinceSt`.
  10. **Standing clear/keep:** `clear` → `clearStandingDirection`; `keep` → neither set nor clear called.
  11. **Repair-discard:** `repairAttempted:true` → NO direction/standing/summary write, BUT usage still INCRBY'd (eval tokens spent) AND turns-since-ST reset (the ST ran).
  12. **Gate failure isolation:** `runStGate` throws → caught, logged, cycle skipped (no eval, no throw out of the job).
  13. **Self-re-arm:** responded watermark at end > snapshot → `removeDeduplicationKey` then `enqueueStEval`; equal → neither.
  14. **No self-re-arm on no-op:** the active-session no-op path does not re-arm.

- [ ] **Step 3: Implement.** Sketch (define the narrow repo + the deps; the body follows the pipeline above). **Full code for the novel structure:**

```ts
// backend/src/session/st-evaluation-worker.ts
//
// MYT-69 — the SlowThinker pipeline, OFF the hot path. policy → gate → evaluate
// → write, all background. NOTHING here may delay or fail a player-visible turn
// (the producer is the turn worker's post-turn finally phase, own try/catch).
//
// Defines its OWN narrow repo interface (sd_playbook read + the codec window +
// the roster read) — NOT a widening of TurnWorkerRepo, whose sessionPreps
// surface is {ftContext}-only. The FT-side worker's dependency surface never
// gains a secret-bearing read (§9).

import { Worker as BullmqWorker, Queue, type Job } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { createRepo } from '../repo/index.js'
import { makeSessionState, type SessionState } from '../redis/session-state.js'
import { makeTriggerState, type TriggerState } from './trigger-state.js'
import { runStGate } from '../llm/st-gate.js'
import { runStDirector } from '../llm/st-director.js'
import { rowsToConversation } from './transcript-codec.js'
import {
  ST_EVAL_FLOOR_TURNS, ST_GATE_CONFIDENCE_FLOOR, ST_EVAL_EXCHANGE_WINDOW,
  ST_GATE_EXCHANGE_WINDOW, SESSION_TOKEN_BUDGET, WIND_DOWN_FRACTION,
} from './st-config.js'
import {
  enqueueStEval, stEvalDedupId, QUEUE_ST_EVAL,
  type StEvalPayload, type StEvalQueueWithDedup,
} from './st-eval-queue.js'
import type { ConversationMessage } from './tiers/types.js'
import type { SessionMessage } from '../repo/types.js'

interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

/** The ST worker's OWN narrow repo surface (secret-bearing reads live here, NOT
 *  on TurnWorkerRepo). */
export interface StEvalRepo {
  readonly sessions: {
    getActiveByCampaign(campaignId: string): Promise<{ id: string; sessionNumber: number } | null>
  }
  readonly sessionPreps: {
    getBy(campaignId: string, sessionNumber: number): Promise<{ sdPlaybook: string } | null>
  }
  readonly sessionMessages: {
    listFtContextRows(sessionId: string, maxPlayerSeq: number): Promise<SessionMessage[]>
  }
  readonly characters: {
    listSessionParticipantRoster(
      sessionId: string,
    ): Promise<readonly { name: string; characterClass: string; background: string }[]>
    listSessionParticipantCharacters(
      sessionId: string,
    ): Promise<readonly { userId: string; name: string }[]>
  }
}

/** The ST-side session-state reads/writes (summary + summed usage). */
export interface StEvalSessionState {
  loadTurnState(campaignId: string): Promise<{ summary: string }>
  setRunningSummary(campaignId: string, summary: string): Promise<void>
  totalUsageTokens(campaignId: string): Promise<number>
  incrUsageSt(campaignId: string, tokens: number): Promise<void>
}

/** The ST-side trigger-state surface (slots + counter + watermark). */
export interface StEvalTriggerState {
  setOneShotDirection(campaignId: string, text: string): Promise<void>
  setStandingDirection(campaignId: string, text: string): Promise<void>
  clearStandingDirection(campaignId: string): Promise<void>
  readStandingDirection(campaignId: string): Promise<string | null>
  peekOneShotDirection(campaignId: string): Promise<string | null> // read-only — the ST NEVER consumes (T4)
  turnsSinceSt(campaignId: string): Promise<number>
  resetTurnsSinceSt(campaignId: string): Promise<void>
  respondedSeq(campaignId: string): Promise<number>
}

export interface StEvalProcessorDeps {
  readonly repo: StEvalRepo
  readonly sessionState: StEvalSessionState
  readonly triggerState: StEvalTriggerState
  runGate: typeof runStGate
  runDirector: typeof runStDirector
  reArm(campaignId: string, sessionId: string): Promise<void>
  readonly logger: MinimalLogger
}

const usageTokens = (u: { totalTokens?: number; inputTokens?: number; outputTokens?: number }): number =>
  u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)

function formatExchanges(history: readonly ConversationMessage[], window: number): string {
  const slice = history.slice(-window)
  return slice
    .map((m) => {
      const who = m.role === 'user' ? (m.characterName ?? 'Player') : 'DM'
      const text = m.parts.map((p) => (p.kind === 'text' ? p.text : `[${p.kind}]`)).join(' ')
      return `${who}: ${text}`
    })
    .join('\n')
}

export async function processStEvalJob(
  deps: StEvalProcessorDeps,
  job: { data: StEvalPayload },
): Promise<void> {
  const { campaignId, sessionId } = job.data

  // 1. Active-session check (a queued job for an ended session no-ops).
  const session = await deps.repo.sessions.getActiveByCampaign(campaignId)
  if (session === null || session.id !== sessionId) {
    deps.logger.info({ campaignId, sessionId }, 'st-eval: no matching active session; no-op')
    return
  }
  const watermarkAtStart = await deps.triggerState.respondedSeq(campaignId)

  // Context reads (shared by gate + evaluate).
  const prep = await deps.repo.sessionPreps.getBy(campaignId, session.sessionNumber)
  const sdPlaybook = prep?.sdPlaybook ?? ''
  const { summary } = await deps.sessionState.loadTurnState(campaignId)
  const rows = await deps.repo.sessionMessages.listFtContextRows(sessionId, watermarkAtStart)
  const names = new Map(
    (await deps.repo.characters.listSessionParticipantCharacters(sessionId)).map((p) => [p.userId, p.name]),
  )
  const history = rowsToConversation(rows, names)

  // 2. DETERMINISTIC POLICY (mechanical, ZFC-exempt).
  const turnsSinceSt = await deps.triggerState.turnsSinceSt(campaignId)
  const totalUsed = await deps.sessionState.totalUsageTokens(campaignId)
  const windDown = totalUsed >= WIND_DOWN_FRACTION * SESSION_TOKEN_BUDGET
  const floorForces = turnsSinceSt >= ST_EVAL_FLOOR_TURNS

  let usageToWrite = 0
  let shouldEvaluate = floorForces || windDown

  // 3. HAIKU GATE (only when policy didn't already force the evaluation).
  if (!shouldEvaluate) {
    try {
      const gate = await deps.runGate({
        sdPlaybook,
        runningSummary: summary,
        recentExchanges: formatExchanges(history, ST_GATE_EXCHANGE_WINDOW),
      })
      usageToWrite += usageTokens(gate.usage)
      const skip = !gate.result.needed && gate.result.confidence >= ST_GATE_CONFIDENCE_FLOOR
      shouldEvaluate = !skip
      deps.logger.info(
        { campaignId, needed: gate.result.needed, confidence: gate.result.confidence, skip },
        'st-eval gate',
      )
    } catch (err) {
      // Gate failure → skip this cycle; the floor guarantees eventual oversight.
      deps.logger.warn({ err, campaignId }, 'st-eval: gate failed; skipping cycle')
      await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
      return
    }
  }

  if (!shouldEvaluate) {
    await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
    return
  }

  // 4. OPUS ST EVALUATION. GATE INDEPENDENCE: no gate verdict in the input.
  const roster = await deps.repo.characters.listSessionParticipantRoster(sessionId)
  const partyRoster = roster.map((r) => `${r.name} (${r.characterClass}, ${r.background})`).join('; ')
  const currentStanding = (await deps.triggerState.readStandingDirection(campaignId)) ?? 'NONE'
  // Peek the pending one-shot WITHOUT consuming it (the turn worker's fresh-run
  // arm is the only consumer). A read-only get; see the trigger-state note.
  const pending = (await deps.triggerState.peekOneShotDirection(campaignId)) ?? 'NONE'

  let evalOut: Awaited<ReturnType<typeof runStDirector>>
  try {
    evalOut = await deps.runDirector({
      partyRoster,
      sdPlaybook,
      runningSummary: summary,
      currentStandingDirective: currentStanding,
      pendingOneShot: pending,
      recentExchanges: formatExchanges(history, ST_EVAL_EXCHANGE_WINDOW),
      windDown,
    })
  } catch (err) {
    // Terminal eval failure → no direction this cycle (BullMQ retry handles
    // transient). Still account nothing extra (the wrapper didn't return usage).
    deps.logger.warn({ err, campaignId }, 'st-eval: director failed; no direction this cycle')
    await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
    return
  }

  usageToWrite += usageTokens(evalOut.usage)
  // The ST RAN — reset the floor counter regardless of repair-discard.
  await deps.triggerState.resetTurnsSinceSt(campaignId)

  if (evalOut.repairAttempted) {
    // §4 repair posture: a repaired tree's direction/standing/summary were not
    // authored by the ST — discard ALL of them. Usage is still counted (tokens
    // spent); the counter is reset (the ST ran).
    deps.logger.warn({ campaignId }, 'st-eval: repairAttempted — discarding result (no channel write)')
    await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
    return
  }

  // 5. WRITE outputs (each guarded — enhancement, not correctness).
  const r = evalOut.result
  try {
    if (r.intervene && r.direction !== null) await deps.triggerState.setOneShotDirection(campaignId, r.direction)
  } catch (err) { deps.logger.warn({ err, campaignId }, 'st-eval: one-shot write failed') }
  try {
    if (r.standingDirective.action === 'set' && r.standingDirective.text !== null) {
      await deps.triggerState.setStandingDirection(campaignId, r.standingDirective.text)
    } else if (r.standingDirective.action === 'clear') {
      await deps.triggerState.clearStandingDirection(campaignId)
    }
    // 'keep' (or 'set' with null text — a model error) → no-op.
  } catch (err) { deps.logger.warn({ err, campaignId }, 'st-eval: standing write failed') }
  try {
    await deps.sessionState.setRunningSummary(campaignId, r.summaryUpdate)
  } catch (err) { deps.logger.warn({ err, campaignId }, 'st-eval: summary write failed') }

  await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
}

async function writeUsageAndReArm(
  deps: StEvalProcessorDeps,
  campaignId: string,
  sessionId: string,
  tokens: number,
  watermarkAtStart: number,
): Promise<void> {
  if (tokens > 0) {
    try { await deps.sessionState.incrUsageSt(campaignId, tokens) }
    catch (err) { deps.logger.warn({ err, campaignId }, 'st-eval: usage:st incr failed') }
  }
  // §2 self-re-arm: newer turns landed mid-evaluation → re-run.
  try {
    const now = await deps.triggerState.respondedSeq(campaignId)
    if (now > watermarkAtStart) await deps.reArm(campaignId, sessionId)
  } catch (err) { deps.logger.warn({ err, campaignId }, 'st-eval: re-arm check failed') }
}

export function buildStEvaluationWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  pool: Pool,
  logger: MinimalLogger,
): BullmqWorker<StEvalPayload> {
  const repo = createRepo(pool)
  const sessionState = makeSessionState(redisRealtime, redisKeyPrefix)
  const triggerState = makeTriggerState(redisRealtime, redisKeyPrefix)
  const queue: StEvalQueueWithDedup = new Queue<StEvalPayload>(QUEUE_ST_EVAL, { connection: redisBatch })

  const deps: StEvalProcessorDeps = {
    repo,
    sessionState: {
      loadTurnState: (c) => sessionState.loadTurnState(c),
      setRunningSummary: (c, s) => sessionState.setRunningSummary(c, s),
      totalUsageTokens: (c) => sessionState.totalUsageTokens(c),
      incrUsageSt: (c, t) => sessionState.incrUsageSt(c, t),
    },
    triggerState,
    runGate: runStGate,
    runDirector: runStDirector,
    reArm: async (campaignId, sessionId) => {
      // Self-re-arm: clear our OWN dedup key (a running job can't be replaced),
      // then re-add. Mirrors dm-trigger-worker's removeDeduplicationKey + add.
      await queue.removeDeduplicationKey(stEvalDedupId(campaignId))
      await enqueueStEval(queue, { campaignId, sessionId })
    },
    logger,
  }

  return new BullmqWorker<StEvalPayload>(
    QUEUE_ST_EVAL,
    (job: Job<StEvalPayload>) => processStEvalJob(deps, job),
    { connection: redisBatch, concurrency: 2 },
  )
}
```

**Implementer notes (load-bearing):**
- **PEEK vs TAKE (resolved in self-review):** the ST PEEKS the pending one-shot (`peekOneShotDirection`, a plain GET, defined + tested in T4); the turn worker's fresh-run arm is the ONLY consumer (`takeOneShotDirection`, GETDEL). The interface and worker code above already use the peek — do not "simplify" it to the take.
- `setRunningSummary`, `totalUsageTokens`, `incrUsageSt` are NEW `SessionState` methods (T12). Pin their signatures here; T12 implements them. typecheck is the authority once both land.
- `sessionPreps.getBy` returns the full `SessionPrepRow` (carries `sdPlaybook`) — the narrow `{ sdPlaybook }` interface is structurally satisfied. `getActiveByCampaign` returns the full `Session` (carries `sessionNumber`) — `{ id, sessionNumber }` is satisfied.
- BullMQ lock/stalled config: this job runs up to ~2.5 min (Opus). Set `lockDuration` comfortably above `ST_EVAL_TIMEOUT_MS` (e.g. 150_000) so a live job isn't reclaimed mid-Opus. Mirror the turn-worker's explicit `lockDuration`/`stalledInterval`/`maxStalledCount` shape; concurrency ~2. (typecheck + the §13 smoke validate.)

- [ ] **Step 4: Run the worker test + the characters repo test + typecheck — PASS.** Report DONE.

---

### Task 11: `dm-trigger-worker.ts` — summary-input contract-comment amendment (§9)

**Files:**
- Modify: `backend/src/session/dm-trigger-worker.ts`

Post-MYT-69 the `:summary` deliberately carries secret-adjacent state, so the classifier's "public table material only" contract comments drift. The classifier is ST-side-adjacent infrastructure — its output (`shouldRespond`/intent/complexity) is consumed by code only and never reaches a player or the FT, exactly like the gate. Amend the comments to say so. NO behavior change.

- [ ] **Step 1:** Edit the three comment sites:
  - The module header (lines ~30-32): replace *"Enforced ignorance: the classifier sees ONLY public table material — … No plot/secret slot exists on its input (§4.4)."* with: *"The classifier is ST-side-adjacent infrastructure: its output (shouldRespond/intent/complexity) is consumed by CODE only and never reaches a player or the Fast Thinker — exactly like the MYT-69 Haiku gate. As of MYT-69 the running summary it reads as scene grounding deliberately carries secret-adjacent state (rapport/ladder); that is acceptable because there is no output path from this call to a player-facing surface (the §4.4 'public-only' framing is superseded by 'no output path to a player-facing surface')."*
  - The `SessionStateReads` interface comment (line ~91): replace *"only the public running summary is read here"* with *"the running summary is read here as scene grounding; post-MYT-69 it carries secret-adjacent state, acceptable because this call's output never reaches a player-facing surface (ST-side-adjacent infra)."*
  - The `loadSummary` doc-comment (line ~256): replace *"the only public scene material available"* with *"the scene material the classifier grounds on (secret-adjacent post-MYT-69; ST-side-adjacent infra — output is code-only)."*

- [ ] **Step 2:** typecheck (comment-only; no test unless a test asserts a comment string — none does). Report DONE.

---

### Task 12: `session-state.ts` — usage-only flush, `:usage:st`, ST summary write, summed-usage read, checkpoint kind bump (§7, §8)

**Files:**
- Modify: `backend/src/redis/session-state.ts` + extend `backend/src/redis/__tests__/session-state.test.ts`

Changes:
1. `flushTurnState` shrinks to **usage-only** (drop the `:summary` write — the ST job owns it now). `TurnState` for FLUSH purposes carries only `{ usage }`; `loadTurnState` STILL reads `:summary` (the controller/worker/classifier read it; the ST job reads it as its own artifact). Keep `loadTurnState`'s return `{ summary, usage }`.
2. Add `setRunningSummary(campaignId, summary)` — plain `SET` with the state TTL (the ST job is the only writer; the turn flush no longer refreshes the summary's TTL, so a gate-quiet stretch must not let it lapse).
3. Add `:usage:st` key + `incrUsageSt(campaignId, tokens)` (atomic `INCRBY`) + `totalUsageTokens(campaignId)` (read `:usage` blob's input+output AND `:usage:st`, summed).
4. Add `resetSessionSpend(campaignId)` — DEL `:usage`, `:usage:st`, `:summary` in one MULTI (the §8 session-start reset, called from the route in T7).
5. Checkpoint envelope `kind` bump: `myt68-checkpoint` → `myt69-checkpoint` (the turn-state shape shed the summary from `flushTurnState`; the reader must fail loud on the old shape). The checkpoint still folds `{ state, maxSeq, turnState }` — but `turnState` now is `{ summary, usage }` read via `loadTurnState` (summary from `:summary`, usage from `:usage`). **Note:** the checkpoint persists the summary into `sessions.st_running_summary` — the §9 fix is the ROUTE allowlist (T7), not removing the checkpoint persist; the summary still needs cold-start recovery.

- [ ] **Step 1: Failing tests** (ioredis-mock; extend the existing suite):
  1. `flushTurnState` writes `:usage` only (assert `:summary` is NOT written/overwritten by it — seed `:summary='X'`, flush, assert `:summary` still `'X'`).
  2. `setRunningSummary` SETs `:summary` with a TTL (assert value + `pttl > 0`).
  3. `incrUsageSt` INCRBYs `:usage:st`; `totalUsageTokens` returns `:usage`(input+output) + `:usage:st`.
  4. `resetSessionSpend` DELs all three keys.
  5. `checkpoint` envelope `kind === 'myt69-checkpoint'` and carries `turnState.summary`.

- [ ] **Step 2: Implement.** Key additions:

```ts
  const usageStKey = (campaignId: string): string => `${base(campaignId)}:usage:st`
```
```ts
    flushTurnState: async (campaignId, ts) => {
      // §7: usage-only as of MYT-69 — the :summary key is the ST job's artifact
      // (setRunningSummary is its only writer). A blind summary SET here would
      // clobber the ST's background write (the turn worker reads :usage at turn
      // start, accumulates across a minutes-long render, and SETs at flush — an
      // ST summary write in that window would be erased).
      const ttlMs = STATE_TTL * 1000
      await redis
        .multi()
        .set(usageKey(campaignId), JSON.stringify(ts.usage))
        .pexpire(usageKey(campaignId), ttlMs)
        .exec()
    },

    setRunningSummary: async (campaignId, summary) => {
      // The ST job is the ONLY writer. SET with the state TTL — the turn flush
      // no longer refreshes the summary's TTL, so a gate-quiet stretch must not
      // let the ST's memory lapse mid-session (§7).
      await redis.set(summaryKey(campaignId), summary, 'EX', STATE_TTL)
    },

    incrUsageSt: async (campaignId, tokens) => {
      // §7: a DEDICATED key, atomic INCRBY. The shared-:usage alternative
      // (Lua/WATCH) provably can't survive the turn worker's stale-read-then-SET.
      await redis.incrby(usageStKey(campaignId), tokens)
    },

    totalUsageTokens: async (campaignId) => {
      const [rawUsage, rawSt] = await redis.mget(usageKey(campaignId), usageStKey(campaignId))
      const turnUsage = parseJson<TokenUsage>(rawUsage, { input: 0, output: 0 })
      const stTokens = rawSt === null ? 0 : Number(rawSt)
      return turnUsage.input + turnUsage.output + (Number.isFinite(stTokens) ? stTokens : 0)
    },

    resetSessionSpend: async (campaignId) => {
      // §8 session-boundary hygiene (called from the /start route).
      await redis.del(usageKey(campaignId), usageStKey(campaignId), summaryKey(campaignId))
    },
```

`flushTurnState`'s param: keep the `TurnState` shape `{ summary, usage }` for `loadTurnState`/checkpoint, but `flushTurnState` now ignores `ts.summary`. **Cleaner:** change `flushTurnState(campaignId, ts: { usage: TokenUsage })` and update the controller's call (T13). Pin: `flushTurnState` takes `{ usage }`. Add the new methods to the `SessionState` interface + their doc-comments. Bump the checkpoint envelope `kind` to `'myt69-checkpoint'`.

- [ ] **Step 3: Run — PASS** + typecheck. Report DONE.

---

### Task 13: `tiers/types.ts` retirement + `session-controller.ts` — drop ST/applyEvaluation/summary, fuse-then-append (§6, §7, §9)

**Files:**
- Modify: `backend/src/session/tiers/types.ts` (retire `StEvaluation`/`SlowThinker`; supersession notes)
- Modify: `backend/src/session/session-controller.ts` + rewrite the affected parts of `backend/src/session/__tests__/session-controller.test.ts`

`tiers/types.ts`: the `SlowThinker` tier seam leaves the turn path. Retire `StEvaluation` + `SlowThinker` (delete the interfaces; or keep `StubSlowThinker` for tests but remove it from the controller's deps). Update the `TurnContext = FtTurnContext` comment: the MYT-66 `TurnContext = FtTurnContext & StSecrets` widening is **not needed** under the post-hoc model (the ST no longer consumes the FT's context object at all) — note this supersession.

`session-controller.ts`: drop `st`, `applyEvaluation`, `fuseDirection`-via-evaluation, and ALL summary handling. The directions arrive as worker-resolved deps (`pendingDirection?: string`, `standingDirective?: string`), mirroring `ftContext`. `processDmTurn`:
1. load rows → `rowsToConversation` → `this.history`.
2. **fuse the one-shot** onto the last user message (the EXISTING `fuseDirectionIntoLastUserMessage`), IF `pendingDirection` is set. This happens BEFORE the FT render.
3. `ft.render(this.buildContext(), emitter)` — the standing tail is appended INSIDE `buildModelMessages` at the FT boundary (T14), so it is NOT the controller's job to append it. **But** the controller must pass `standingDirective` THROUGH to the FT — add it to `FtTurnContext`? NO (it's a direction, not context). Pass it via the FT deps OR via the context. **Decision:** add `standingDirective?: string` to `FtTurnContext` is WRONG (it's not enforced-ignorance context). Instead the FT reads it from a render-arg. See the implementer note below — the cleanest is to pass it on the `FtTurnContext` as an explicitly-non-secret ephemeral field OR thread it as a third `render` arg. **Pin: thread it via `FtTurnContext.standingDirective?: string`** — it IS public-by-construction (the ST authored it under the §4 channel contract; it is behavior-bound, never secret rationale), so it belongs on the FT-facing context exactly like a fused one-shot does. Document it as such.
4. NO `st.evaluate`, NO `applyEvaluation`, NO summary. `flushToRedis` writes `{ usage }` only.

- [ ] **Step 1: Failing tests** (in-memory fakes):
  1. `processDmTurn` with `pendingDirection` set → the last user message's text part gains `\n\n[DM direction: …]` (fuse-before-render; assert the FT saw the fused history).
  2. `processDmTurn` with NO `pendingDirection` → no fusion, history is the raw codec output.
  3. `processDmTurn` does NOT call any `st.evaluate` (the dep is gone — assert the controller has no `st` field / the FT is the only tier called besides scribe).
  4. `buildContext()` carries `standingDirective` when the dep is set, omits it when not (exactOptionalPropertyTypes).
  5. `flushToRedis` writes `{ usage }` only (no summary).
  6. Scribe still fire-and-forget + swallowed (unchanged).

- [ ] **Step 2: Implement.** Deps shape:

```ts
export interface SessionControllerDeps {
  readonly sessionState: SessionState
  readonly ft: FastThinker
  readonly scribe: Scribe
  readonly emitter: TurnEmitter
  readonly transcript: TranscriptStore
  readonly attributionNames: ReadonlyMap<string, string>
  readonly participants: readonly string[]
  readonly ftContext: string
  /** §6 one-shot direction (worker-resolved; GETDEL'd by the worker's fresh-run
   *  arm, passed in here). Fused onto the last user message BEFORE the FT render
   *  via the unchanged MYT-68 fusion seam. */
  readonly pendingDirection?: string
  /** §6 standing directive (worker-resolved; READ not consumed). Threaded onto
   *  the FT context — it is public-by-construction (ST-authored under the §4
   *  behavior-bound channel contract; never secret rationale), so it rides the
   *  FT-facing context exactly like a fused one-shot. The FT appends it as a raw
   *  tail message AFTER the cache breakpoints (T14). */
  readonly standingDirective?: string
  readonly allocSeq: () => Promise<number>
  readonly logger?: MinimalLogger
}
```

Drop `st`, `summary`, `applyEvaluation`, the evaluation-based `fuseDirection`. `processDmTurn`:

```ts
  async processDmTurn(maxConsumedSeq: number): Promise<void> {
    const rows = await this.deps.transcript.listFtContextRows(this.sessionId, maxConsumedSeq)
    this.history = rowsToConversation(rows, this.deps.attributionNames)

    // §6: fuse the one-shot onto the last user message BEFORE the render (the
    // fuser targets the last user message; the standing tail is appended later,
    // at the FT boundary, so it must not be present yet).
    if (this.deps.pendingDirection !== undefined) {
      if (!fuseDirectionIntoLastUserMessage(this.history, this.deps.pendingDirection)) {
        this.deps.logger?.warn(
          { campaignId: this.campaignId, turnId: this.turnId },
          'one-shot direction with no user message to fuse onto; skipping fusion',
        )
      }
    }

    this.assistant = await this.deps.ft.render(this.buildContext(), this.deps.emitter)
    this.usage = addUsage(this.usage, this.assistant.usage)

    const scribeCtx = this.buildContext()
    void Promise.resolve()
      .then(() => this.deps.scribe.extract(scribeCtx))
      .catch((err: unknown) => this.deps.logger?.warn({ err }, 'scribe.extract failed'))
  }
```

`buildContext`:
```ts
  private buildContext(): FtTurnContext {
    return {
      campaignId: this.campaignId,
      ftContext: this.deps.ftContext,
      ftHistory: this.history,
      participants: this.deps.participants,
      usage: this.usage,
      workingSet: [],
      ...(this.deps.standingDirective !== undefined ? { standingDirective: this.deps.standingDirective } : {}),
    }
  }
```

`loadFromRedis` keeps reading `:usage` (drop the `this.summary` assignment — summary is no longer the controller's). `flushToRedis`:
```ts
  async flushToRedis(): Promise<void> {
    await this.deps.sessionState.flushTurnState(this.campaignId, { usage: this.usage })
  }
```

`FtTurnContext` (in `tiers/types.ts`) gains:
```ts
  /** §6 standing directive: a behavior-bound stage direction the ST authored
   *  under the §4 channel contract — public-by-construction (never secret
   *  rationale). The FT appends it as a raw `[DM direction: …]` tail message
   *  AFTER buildModelMessages places the cache breakpoints (T14). Optional;
   *  absent when no standing directive is live. */
  readonly standingDirective?: string
```

- [ ] **Step 3: Run — PASS** + typecheck. Report DONE.

**Implementer note:** the `StubSlowThinker` import disappears from `turn-worker.ts` (T15). If `tiers/stubs.ts` exports `StubSlowThinker` and no test uses it after this, delete it; else keep it. typecheck + lint (no-unused) is the gate.

---

### Task 14: `fast-thinker.ts` — the raw standing tail after the breakpoints (§6)

**Files:**
- Modify: `backend/src/session/tiers/fast-thinker.ts` + extend `backend/src/session/tiers/__tests__/fast-thinker.test.ts`

`buildModelMessages` currently builds `[system(breakpoint), ...history(with a breakpoint on the second-to-last)]`. Add: if `ctx.standingDirective` is set, append ONE raw `ModelMessage` at the END (a user message wrapped `[DM direction: …]`), AFTER the breakpoint placement — so it rides the always-uncached zone past the last breakpoint. It is NEVER persisted (it's render-only), NEVER pushed into `ftHistory`.

- [ ] **Step 1: Failing tests** (extend the suite):
  1. `buildModelMessages` with `standingDirective: 'Steer toward a close'` → the LAST message is `{ role: 'user', content: '[DM direction: Steer toward a close]' }` and carries NO `providerOptions` (uncached tail).
  2. The breakpoint is STILL on the second-to-last HISTORY message (the standing tail does NOT shift the breakpoint index — assert the breakpoint message is the same as without the standing directive).
  3. No `standingDirective` → no extra message (unchanged shape).
  4. A render with a standing directive: the standing tail appears in the `streamText` call's `messages`, and it is NOT in the returned `AssistantMessage.parts` (the FT never echoes it into the transcript).

- [ ] **Step 2: Implement.** In `buildModelMessages`, after the breakpoint placement and before the return:

```ts
  const messages: ModelMessage[] = [
    { role: 'system', content: system, providerOptions: ANTHROPIC_CACHE_BREAKPOINT },
    ...historyMessages,
  ]
  // §6 standing directive: a raw, uncached tail message AFTER the breakpoints.
  // NEVER persisted, NEVER pushed into ftHistory (that would shift the
  // sliding-breakpoint index and render through the codec's attribution as a
  // phantom "Player"). The controller resolved it from the standing slot (read,
  // not consumed). The wrapper form mirrors the fused one-shot's `[DM direction:
  // …]` delimiter; the ft-system DM Direction Protocol amendment (T5) covers the
  // standalone form.
  if (ctx.standingDirective !== undefined && ctx.standingDirective !== '') {
    messages.push({ role: 'user', content: `[DM direction: ${ctx.standingDirective}]` })
  }
  return messages
```

- [ ] **Step 3: Run — PASS** + typecheck. Report DONE.

---

### Task 15: `turn-worker.ts` — success-path enqueue, fresh-run one-shot take, turns-since-ST INCR, controller deps (§2, §6, §8)

**Files:**
- Modify: `backend/src/session/turn-worker.ts` + extend `backend/src/session/__tests__/turn-worker.test.ts`
- Modify: `backend/src/worker.ts` (6th worker)

Changes to `processTurnJob`:
1. **Fresh-run one-shot take:** on the fresh-run arm ONLY (after the converge + latch early exits, after `dmThinking`), `const pendingDirection = await deps.triggerState.takeOneShotDirection(campaignId)` and `const standingDirective = await deps.triggerState.readStandingDirection(campaignId)`. Pass both into the controller deps (`pendingDirection ?? undefined`, `standingDirective ?? undefined`). A take by a converge/latch/contention path would burn a sanctioned reveal on a turn that never renders — so it MUST be after those exits.
2. **turns-since-ST INCR + the producer enqueue** on the flushed-success path (alongside `setRespondedSeq`): `await deps.triggerState.incrTurnsSinceSt(campaignId)`. Then, in its OWN try/catch (an enqueue hiccup must never mask the turn outcome), `await enqueueStEval(deps.stEvalQueue, { campaignId, sessionId })`. **Gated on the flushed-success path only** — a failed/lock-lost/converge run has no fresh FT response to evaluate. (The converge path advances the watermark but does NOT enqueue an st-eval — there's no new render; if newer turns exist the self-re-arm or the next real turn covers it.)
3. **New dep:** `readonly stEvalQueue: StEvalQueueLike`. Construct it in `buildSessionTurnWorker` (one `Queue` per process on `redisBatch`, like `turnQueue`).

- [ ] **Step 1: Failing tests** (extend the suite, in-memory deps):
  1. **Fresh run takes the one-shot + reads standing:** `takeOneShotDirection` returns `'D'`, `readStandingDirection` returns `'S'` → the controller is constructed with `pendingDirection: 'D'`, `standingDirective: 'S'` (assert via a recording controller-deps capture or the makeTiers/controller seam).
  2. **One-shot taken ONLY on the fresh-run arm:** the CONVERGE path (`turnRowsExist` true) does NOT call `takeOneShotDirection` (assert not called); the LATCH-terminal path does not either; a contention loser (no lock) does not.
  3. **Success-path enqueue:** a flushed success calls `incrTurnsSinceSt` then `enqueueStEval({campaignId, sessionId})`; assert order relative to `setRespondedSeq`.
  4. **Converge path does NOT enqueue st-eval** (no new render).
  5. **Enqueue failure isolation:** `enqueueStEval` throws → caught, logged, the turn still returns `{ran:true}` (the turn outcome is not masked).
  6. **Lock-lost abort does NOT enqueue / does not take the one-shot after render** (the take is before render; lock-lost after render still leaves the slot consumed — that's the accepted "a consumed direction is gone even if the FT then fails" cost, §10; assert the lock-lost path returns `{ran:true}` without enqueue).

- [ ] **Step 2: Implement.** Add the import + dep + the fresh-run reads + the post-flush enqueue. In the fresh-run body, after `await deps.publisher.dmThinking(...)` and the per-turn context resolution, before constructing the controller:

```ts
    // §6 — take the one-shot (GETDEL, latest-wins) and READ the standing
    // directive. ONLY on the fresh-run arm: a take before the converge/latch
    // exits (above) would burn a sanctioned reveal on a turn that never renders,
    // and a take by a contention loser would starve the lock holder.
    const pendingDirection = await deps.triggerState.takeOneShotDirection(campaignId)
    const standingDirective = await deps.triggerState.readStandingDirection(campaignId)
```

Pass into the controller deps:
```ts
        ...(pendingDirection !== null ? { pendingDirection } : {}),
        ...(standingDirective !== null ? { standingDirective } : {}),
```
(Drop the `st` from the tiers spread — the controller no longer takes it. `makeTiers` returns `{ ft, scribe }` now; update its type to drop `st`.)

After `await deps.triggerState.setRespondedSeq(...)` on the flushed-success path, before `turnEnd`:
```ts
    // §8 — a flushed turn happened; bump the ST floor counter.
    await deps.triggerState.incrTurnsSinceSt(campaignId)
    // §2 — enqueue the st-evaluation (post-hoc, off the hot path). Gated on the
    // flushed-success path ONLY (a failed/lock-lost/converge run has no fresh FT
    // response to evaluate). Own try/catch — an enqueue hiccup never masks the
    // turn outcome.
    try {
      await enqueueStEval(deps.stEvalQueue, { campaignId, sessionId })
    } catch (enqErr) {
      deps.logger.error({ err: enqErr, campaignId, turnId }, 'failed to enqueue st-evaluation')
    }
```

`makeTiers` type: `(turn: TierTurnArgs) => { ft: FastThinker; scribe: Scribe }` (drop `st: SlowThinker`). In `buildSessionTurnWorker`, drop `StubSlowThinker` from the import + the `makeTiers` body (`return { scribe: new StubScribe(), ft: new SonnetFastThinker({...}) }`). Construct the st-eval queue:
```ts
  const stEvalBullQueue = new Queue<StEvalPayload>(QUEUE_ST_EVAL, { connection: redisBatch })
  const stEvalQueue: StEvalQueueLike = { add: (n, d, o) => stEvalBullQueue.add(n, d, o) }
```
Add `stEvalQueue` to `deps`. Import `enqueueStEval, QUEUE_ST_EVAL, type StEvalPayload, type StEvalQueueLike` from `'./st-eval-queue.js'`.

- [ ] **Step 3:** `worker.ts` — the 6th worker. After `dmTriggerWorker`:
```ts
  // ST-evaluation (MYT-69) — the post-hoc narrative director, OFF the hot path.
  // Wired HERE in the dedicated worker process. Takes the pg Pool (builds its
  // own repo) + both Redis connections; its Queue producer rides redisBatch.
  const stEvaluationWorker = buildStEvaluationWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    pg,
    logger,
  )
```
Add `stEvaluationWorker` to: the health-server `workers: [...]` array, the `Promise.all([...closeWithDeadline...])` shutdown list, and the `queues: [...]` log array (add `QUEUE_ST_EVAL`). Import `buildStEvaluationWorker` from `'./session/st-evaluation-worker.js'` and `QUEUE_ST_EVAL` from `'./session/st-eval-queue.js'`.

- [ ] **Step 4: Run the worker tests + `worker.test.ts` + typecheck — PASS.** Report DONE.

**Implementer note:** the `makeTiers` `c8 ignore` block in `buildSessionTurnWorker` (real-FT construction) stays; just drop the `StubSlowThinker` line. The converge path's watermark advance is unchanged; do NOT add an st-eval enqueue there.

---

### Task 16: Fixture sweep / full-suite green

**Files:**
- Modify: any remaining fixture/test files the T13 type retirements (`StEvaluation`/`SlowThinker`) broke.

- [ ] **Step 1:** `pnpm --filter @mythrun/backend typecheck` — fix every remaining error mechanically (the dropped `st` dep, `StEvaluation` references, `flushTurnState({usage})` shape). Grep `StEvaluation|SlowThinker|st\.evaluate|applyEvaluation` across `src/` for stragglers.
- [ ] **Step 2:** `pnpm vitest run src/` full suite — fix stragglers. Report DONE with the full-suite count.

---

### Task 17 (controller): lint + scoped-coverage sweep — BUDGETED, not optional

Implementers run only their own test files; the debt is known (feedback_implementers_skip_lint_and_coverage).

- [ ] `pnpm --filter @mythrun/backend lint` — full list (no head-truncation); dispatch ONE lint-fix subagent for the batch (watch no-non-null-assertion + no-deprecated).
- [ ] Scoped coverage per new/modified source (feedback_scoped_coverage_for_iteration — never full `test:coverage` during iteration): `pnpm vitest run <tests> --coverage --coverage.include='<source>'` for: `st-config.ts`, `st-gate.ts` + schema, `st-director.ts` + schema, `st-eval-queue.ts`, `st-evaluation-worker.ts`, `trigger-state.ts`, `session-state.ts`, `session-controller.ts`, `fast-thinker.ts`, `turn-worker.ts`, `characters.ts` (new read), `routes/sessions.ts`, the two prompt test files. Dispatch a coverage-fill subagent for genuine gaps (real tests > c8-ignore; c8-ignore only the v8 finally-boundary + the real-LLM construction blocks).
- [ ] Full `pnpm typecheck && pnpm lint && pnpm test` green before T18.

### Task 18 (controller): real-Anthropic E2E smoke → wiki → single push → close

Wire-level, per spec §13 + feedback_dev_tool_e2e_smoke_required (curl/SSE/psql/redis-cli; no browser automation). Smoke = plumbing, NOT eval (feedback_smoke_vs_eval) — but §13 explicitly calls for the authenticity scenario observed live; that is acceptable as a smoke of the WIRING (does a reveal land after rapport at all), not a quality eval.

- [ ] Seed a real campaign/session in `mythrun_dev` (dev seed + a `session_preps` row whose `sd_playbook` carries a TRUST-GATED secret + a clean playbook trigger; characters with skills incl. one with Persuasion proficiency). Start `pnpm dev` + the worker (the 6th worker boots). The ST job is on `redisBatch` — confirm it boots (the `worker started` log lists `st-evaluation`).
- [ ] **Trigger scenario:** drive turns (dev fire-turn poke) until the gate fires (a playbook-trigger batch). Assert over WS/log/psql/redis-cli:
  - the st-eval job ran (structured `st-eval gate` log; `st-director` `llm.call` log);
  - a one-shot direction landed in `session:{cId}:direction:oneshot` (redis-cli GET);
  - the NEXT DM turn's prose VISIBLY follows the direction (read the streamed text), with ZERO verbatim leak — grep the streamed text against the playbook's secret strings (the leak grep);
  - the `:summary` key carries rapport/ladder state (the ST wrote it; the controller no longer does).
- [ ] **Floor:** drive 5 quiet evaluations → the floor fires an evaluation on the 5th (the gate is skipped; the `st-director` log appears even with a confident-no gate would-be skip).
- [ ] **Wind-down:** seed `:usage:st` (redis-cli INCRBY) near `0.9 × SESSION_TOKEN_BUDGET` → the next evaluation sets a STANDING directive (`direction:standing` GET), and subsequent turns' prose shows the close-steering behavior (standing tail rides every turn).
- [ ] **Authenticity scenario:** sd_playbook with a trust-gated secret + small-talk with the holder NPC → assert the early turns stay plot-free (no hook-dispensing — read the prose), rapport appears in `:summary` (via a pass-through evaluation), and the reveal arrives only AFTER warmth (or a passed Persuasion rung). The signature small-talk dynamic, observed live.
- [ ] **Class-B depth, live:** a player-initiated early Persuasion against the secret-holder → the FT yields demeanor/redirect, NOT invented plot (the §5 class-B / ft-system depth rule).
- [ ] **Allowlist pin (live):** `GET /api/sessions/:campaignId/active` after a suspend that persisted a summary → the response `session` object does NOT contain `stRunningSummary` (curl + jq).
- [ ] **Measured (not just asserted):** the gate's SKIP rate and the ST's INTERVENTION rate over the session (the floor + confidence knob are empirical — record them; if the skip rate is pathological, note `ST_GATE_CONFIDENCE_FLOOR` needs a tune, but do NOT block the ship on a knob unless plumbing is broken).
- [ ] Fix what the smoke finds (it will find something — prompt-template var drift, a schema mismatch, an enqueue wiring gap), re-run.
- [ ] Wiki subagent (AUTHORING.md prompt, parameterized MYT-69) → wiki committed locally. **Sync the wiki LAST** (feedback_wiki_sync_comes_after_dev_tool_and_test_fixes): after any pre-push flaky-test fixes (runtime/index.html watches all of backend/src/). `wiki:build/check` need `DATABASE_URL` sourced.
- [ ] Close all beads; single `git push` (the pre-push gate runs full coverage/lint/typecheck/test ~5+ min — batch all commits, push once: feedback_pushes_are_expensive). `routes/sessions.ts` is NOT a dev-tool/contract-route trigger, so `dev-tool:verify` does not require a live backend for this push.
- [ ] Flip MYT-69 → Done in Linear (feedback_push_and_close — standing auth).

---

## Self-review notes (run before handing to beads)

- **Spec coverage:** §1→T2+T3+T10 (the thesis is realized by the gate+director+pipeline); §2 queue discipline→T9+T15(producer)+T10(self-re-arm); §3 Haiku gate→T2+T10(policy+skip rule+independence); §4 ST evaluation→T3(schema split, discriminated standing, repair-discard, prompt)+T10(repair-discard enforcement, slot-peek, summary rewrite); §5 direction classes→T3(prompt taxonomy)+T5(ft depth/conditionality); §6 slot mechanics→T4(slots)+T13(fuse-before-render)+T14(standing tail)+T15(fresh-run take); §7 summary ownership + :usage:st→T12+T10(writes)+T13(controller drops summary); §8 wind-down + session resets→T1(config)+T4(reset)+T7(route reset)+T10(policy arm)+T12(resetSessionSpend); §9 enforced-ignorance→T2/T3(gate/ST hold secrets, reasoning logged only)+T7(allowlist showstopper)+T10(narrow repo)+T11(classifier contract)+T13(no StSecrets widening); §10 error handling→T10(guarded writes, gate/eval failure skip)+T15(enqueue isolation); §11 config→T1; §12 file map→all; §13 testing→T18; §14/§15 resolved decisions + review revisions→folded throughout (rewrite-semantics T3/T10, self-re-arm T9/T10, session resets T4/T7/T12, :usage:st T12, discriminated standing T3, slots-in-context T10, repair-discard T3/T10, allowlist T7, prompt rules T3/T5, runtime §17.4 T8).
- **Type consistency:** `StGateResult`/`StDirectorResult` (T2/T3) consumed by T10; `FtTurnContext.standingDirective?` (T13) consumed by T14's `buildModelMessages`; `pendingDirection`/`standingDirective` controller deps (T13) supplied by T15; `SessionState.{setRunningSummary,incrUsageSt,totalUsageTokens,resetSessionSpend}` + `flushTurnState({usage})` (T12) consumed by T10 + T13 + T7; trigger-state slots + `peekOneShotDirection` (T4) consumed by T10 + T15; `StEvalQueueLike`/`WithDedup` (T9) consumed by T15 (producer) + T10 (self-re-arm); the roster read (T10) consumed by T10's director-input assembly.
- **Known judgment points for implementers (typecheck is the authority):** the BullMQ `add`/`removeDeduplicationKey`/`prepareStep` generic shapes; `OPUS` export from `models.js` (flag if missing — do NOT invent); `characters.class`/`background` column names (T10); the `flushTurnState` param shape change rippling to T13; the slot-PEEK vs slot-TAKE distinction (T4 must add `peekOneShotDirection` — the ST peeks, the turn worker takes).
- **Wave non-overlap verified:** Wave A files {st-config, st-gate*, st-director*, trigger-state, ft-system.txt, session-prep.txt, routes/sessions.ts, runtime-spec.md} are pairwise disjoint. Wave B {st-eval-queue, st-evaluation-worker + characters.ts, dm-trigger-worker} disjoint. Wave C is sequenced (session-state → types/controller → fast-thinker → turn-worker/worker).

## Spec ambiguities / contradictions found while drafting (NOT silently resolved — listed per the dispatch instruction)

1. **Slot PEEK vs TAKE for the ST's "sees its own pending one-shot" (§4 / §6).** §4 says the ST sees "any unconsumed one-shot" in its context; §6 says the one-shot is GETDEL-consumed ONLY on the turn worker's fresh-run arm. These are consistent ONLY if the ST READS the slot without consuming it. The spec never names a read-only peek primitive (it only documents GETDEL). I added a `peekOneShotDirection` (plain GET) to T4 and pinned it loudly. **Flagging because** the worker sketch in my own T10 initially copy-pasted `takeOneShotDirection` into the peek slot — a real consumption-vs-peek hazard. If the intent was actually "the ST may consume+rewrite," that changes the latest-wins semantics; I assumed peek (consistent with "the overwrite is informed, not blind"). Worth a one-line confirmation.

2. **Standing directive on `FtTurnContext` vs a separate render arg (§6, §9).** §6 says the standing tail is "appended as a raw ModelMessage at the FT boundary" and the controller passes directions "as worker-resolved deps … mirroring `ftContext`." §9 insists "no secret-bearing field is added to any FT-facing type." A standing directive is NOT secret (it's ST-authored under the behavior-bound channel contract), so putting it on `FtTurnContext` does not violate §9 — but it IS adding a field to the FT-facing type, which the spec's strong language ("If you ever feel the urge to add a … field here") could be read to discourage. I chose `FtTurnContext.standingDirective?: string` (documented as public-by-construction) over a third `render` arg, because the controller→FT seam already flows everything through the context object. **Flagging** in case the reviewer prefers the standing text threaded outside the context type (a `render(ctx, emit, standing?)` arg) to keep `FtTurnContext` strictly enforced-ignorance-CONTEXT (vs ephemeral directions). Both satisfy the leak boundary; it's a taste/architecture call.

3. **`flushTurnState` param shape (§7).** §7 says `flushTurnState` shrinks to usage-only. The existing signature is `flushTurnState(campaignId, ts: TurnState)` where `TurnState = { summary, usage }`. I changed the param to `{ usage }` (cleaner, forces the controller update). The alternative — keep the `{ summary, usage }` param and just ignore `summary` — leaves a misleading signature. Chose the explicit narrowing. **Flagging** only because it ripples to the controller's flush call (T13) and the checkpoint's `loadTurnState` (which still reads `:summary` separately, so it's unaffected). Low-risk, but a deliberate shape change worth noting.

4. **Converge-path st-eval enqueue (§2 vs §8).** §2 gates the enqueue on "the flushed-success path only." The converge path (durable rows exist, re-run) advances the watermark + publishes turn_end but does NOT render — so I did NOT enqueue an st-eval there. But a converge means a turn's rows DID land (on a prior attempt that crashed after persist), and that prior attempt's success-path enqueue may or may not have fired (it crashed). So a converged turn could go un-evaluated. The self-re-arm covers the "newer turns landed" case, but a converged FINAL turn with no successor could be the last word with no ST evaluation. **Flagging** as a thin edge: the spec's "flushed-success path only" is explicit, and §10's idempotency notes accept a missed evaluation as harmless (directions are nudges), so I followed the spec literally. If the reviewer wants the converge path to also enqueue (idempotent-safe, since the job reads current state), that's a one-line add — but it contradicts the literal §2 wording, so I did not silently make it.
