# MYT-68 — FastThinker, Tool-Calling Framework & Skill Checks: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stubbed FastThinker with the real Sonnet-backed player-facing prose tier: SDK tool loop, `roll_dice` + `roll_skill_check`, PG-direct transcript storage, streaming frames, and the hardened turn lifecycle.

**Architecture:** The Vercel AI SDK (`ai@6`) conducts a multi-step tool loop via a new `streamTextWithTools` wrapper; tools are pure resolvers and ALL frames emit from the consume loop in stream-part order. `session_messages` becomes the ONLY transcript store (Redis `ft_history` retired): the controller reconstructs the FT's multi-part context per turn via one predicate read, and appends the DM turn's rows atomically at turn end with seqs from `:seq`. Skill checks follow Principle #5 (Haiku DC table → deterministic roll → constraint).

**Tech Stack:** Node 24 + TypeScript strict, Fastify, `ai@6.0.176` + `@ai-sdk/anthropic`, Postgres (`pg`), Redis (`ioredis`), BullMQ, Vitest (tests target `mythrun_test`; LLM tests mock the `'ai'` boundary via `vi.mock('ai')`, NEVER the `ai.ts` wrapper; Redis tests use `ioredis-mock`).

**Spec:** `docs/superpowers/specs/2026-06-09-myt-68-fastthinker-design.md` (§ references below point there).

---

## Context primer (read first)

- **Tier boundary:** the FastThinker sees ONLY `FtTurnContext` (public-by-construction). Never add a secret-capable field. `runningSummary` is REMOVED from it in T7.
- **Principle #4:** the LLM never generates random numbers — all rolls in `session/dice/engine.ts` via `crypto.randomInt`.
- **Principle #5:** skill checks pre-generate a DC outcome table (Haiku), roll deterministically, inject the matched tier as a constraint.
- **PG-direct (§3.7):** the FT context is reconstructed from `session_messages` every turn by ONE predicate: `(message_type='player_message' AND seq <= maxConsumedSeq) OR message_type IN ('dm_text','skill_check','dice_roll')`, ORDER BY seq. Player rows above the watermark are the NEXT turn's batch; DM rows are always included (their seqs can exceed an early-arriving next-batch message). The controller no longer appends a separate trigger batch — the rows ARE the context. Payload `triggerMessages` serve only the MYT-67 classifier.
- **SDK truths (verified in dist — do NOT "fix" these):** `streamText`'s `for await (fullStream)` does NOT throw on failure — errors and timeouts surface as in-band `{type:'error'}` / `{type:'abort'}` parts followed by a graceful close. The consume loop must throw on them. `toolChoice:'none'` strips the `tools` param on the Anthropic provider → 400 when history holds tool blocks — the cap close uses an injected instruction instead. Tool `execute` runs at SDK pipeline pace, ahead of the consumer — tools must NOT emit frames; the consume loop emits everything in part order. Anthropic `cache_control` is read from per-MESSAGE `providerOptions`, never the call-level `providerOptions`.
- **Worker rules:** there is a separate dev server on :3001 — never kill it. Implementer subagents run ONLY their own test file (`pnpm --filter @mythrun/backend vitest run <path>`); the controller runs lint + scoped coverage after each wave. Implementers do NOT `git add`/`commit`/`push`.
- **Run tests:** `cd backend && pnpm vitest run src/<path>` (DATABASE_URL_TEST → `mythrun_test`; `pnpm db:migrate:test` applies migrations to it — run it after T1 lands).

## File map / task ownership (non-overlapping per wave)

| Task | Files (Create/Modify) |
|---|---|
| T1 | C: `backend/migrations/024_session_messages_dm_rows.sql` |
| T2 | C: `backend/src/session/dice/engine.ts` + test |
| T3 | C: `backend/src/llm/schemas/skill-check.ts`, `backend/src/llm/prompts/session/skill-check.txt` + test |
| T4 | C: `backend/src/llm/prompts/session/ft-system.txt` + test |
| T5 | M: `backend/src/contract/session-events.ts` + test |
| T6 | M: `backend/src/llm/ai.ts` + test |
| T7 | M: `backend/src/session/tiers/types.ts`, `tiers/stubs.ts`, `session-controller.ts` (mechanical), `redis/session-state.ts`, `turn-publisher.ts` (mechanical), C: `backend/src/session/ft-config.ts` |
| T8 | C: `backend/src/session/transcript-codec.ts` + test; M: `backend/src/repo/session-messages.ts` + test, `repo/types.ts` |
| T9 | M: `backend/src/repo/characters.ts` + test (participant resolution) |
| T10 | C: `backend/src/session/skill-check.ts` + test |
| T11 | C: `backend/src/session/tiers/ft-tools.ts` + test |
| T12 | M: `backend/src/session/trigger-state.ts` + test (emitted latch) |
| T13 | C: `backend/src/session/tiers/fast-thinker.ts` + test |
| T14 | M: `backend/src/session/session-controller.ts` + test |
| T15 | M: `backend/src/session/turn-worker.ts`, `backend/src/worker.ts` + tests |
| T16 | M: `backend/src/routes/sessions.ts`, `routes/ws-session.ts`, `redis/session-state.ts` (blob fields) + tests |
| T17 | M: `backend/src/routes/dev-fire-turn.ts` + fixtures sweep (compile green) |
| T18 | Controller: full lint + scoped-coverage sweep (budgeted, NOT optional) |
| T19 | Controller: real-Anthropic E2E smoke → wiki subagent → single push → Linear Done |

**Waves:** A = T1–T6 (parallel). B = T7 (solo — it ripples). C = T8–T13 (parallel; T10 needs T9-interface but builds against the signature pinned here). D = T14–T17 (T14→T15 sequential; T16, T17 parallel with each other after T15). E = T18–T19 controller-run.

---

### Task 1: Migration — DM transcript rows

**Files:**
- Create: `backend/migrations/024_session_messages_dm_rows.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 024_session_messages_dm_rows.sql — MYT-68 §3.7 PG-direct transcript.
-- DM turns persist as rows: message_type IN ('dm_text','skill_check','dice_roll')
-- (message_type is free TEXT; no CHECK — the repo layer owns the kind set).
-- turn_id groups one DM turn's rows; turn_ordinal (0..n-1) is the in-turn
-- emission order AND the idempotency key: a BullMQ re-run's re-append hits
-- ON CONFLICT (turn_id, turn_ordinal) DO NOTHING, so the first commit wins.
ALTER TABLE session_messages ADD COLUMN turn_id UUID;
ALTER TABLE session_messages ADD COLUMN turn_ordinal SMALLINT;

CREATE UNIQUE INDEX idx_session_messages_turn_ordinal_unique
  ON session_messages (turn_id, turn_ordinal) WHERE turn_id IS NOT NULL;

-- The per-turn reconstruction read (§3.7) filters on session + message_type;
-- the existing (session_id, seq) unique index covers the ORDER BY seq scan.
```

- [ ] **Step 2: Apply to the test DB and verify**

Run: `cd backend && pnpm db:migrate:test && psql "$DATABASE_URL_TEST" -c "\d session_messages" | grep turn_`
Expected: `turn_id | uuid`, `turn_ordinal | smallint`, the partial unique index listed.

(No unit test — migrations are verified by the T8 repo tests against `mythrun_test`.)

---

### Task 2: The dice engine (Principle #4)

**Files:**
- Create: `backend/src/session/dice/engine.ts`
- Test: `backend/src/session/dice/__tests__/engine.test.ts`

Port from the prototype (`mythrun-v5/backend/src/dice/engine.ts`) with three deliberate changes: injectable RNG (testability), a defensive bound on `rollDice`, and NO `rollAbilityCheck` (the resolver owns modifier math; the prototype's boolean-proficiency helper must NOT port — §3.5 step 2).

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/session/dice/__tests__/engine.test.ts
import { describe, expect, it } from 'vitest'
import {
  calculateModifier,
  resolveRollType,
  rollD20WithType,
  rollDice,
  proficiencyBonusByLevel,
} from '../engine.js'

/** Deterministic RNG: pops values off a script. */
const scripted = (...vals: number[]) => {
  let i = 0
  return (_min: number, _max: number): number => {
    const v = vals[i]
    i += 1
    if (v === undefined) throw new Error('scripted RNG exhausted')
    return v
  }
}

describe('calculateModifier', () => {
  it.each([
    [1, -5], [8, -1], [10, 0], [11, 0], [15, 2], [20, 5],
  ])('score %i → %i', (score, mod) => {
    expect(calculateModifier(score)).toBe(mod)
  })
})

describe('resolveRollType (5e RAW: any adv + any dis cancel)', () => {
  it('cancels to normal when both flags set', () => {
    expect(resolveRollType(true, true)).toBe('normal')
  })
  it('advantage alone', () => { expect(resolveRollType(true, false)).toBe('advantage') })
  it('disadvantage alone', () => { expect(resolveRollType(false, true)).toBe('disadvantage') })
  it('neither → normal', () => { expect(resolveRollType(false, false)).toBe('normal') })
})

describe('rollD20WithType', () => {
  it('normal: one die, kept as-is', () => {
    expect(rollD20WithType('normal', scripted(14))).toEqual({
      roll: 14, roll2: null, keptRoll: 14, rollType: 'normal',
    })
  })
  it('advantage keeps the higher', () => {
    expect(rollD20WithType('advantage', scripted(6, 17)).keptRoll).toBe(17)
  })
  it('disadvantage keeps the lower', () => {
    expect(rollD20WithType('disadvantage', scripted(6, 17)).keptRoll).toBe(6)
  })
  it('real RNG stays in 1..20', () => {
    const r = rollD20WithType('normal')
    expect(r.roll).toBeGreaterThanOrEqual(1)
    expect(r.roll).toBeLessThanOrEqual(20)
  })
})

describe('rollDice', () => {
  it('returns count results + total', () => {
    expect(rollDice(3, 6, scripted(2, 4, 6))).toEqual({ results: [2, 4, 6], total: 12 })
  })
  it('throws on out-of-bound count (worker-stall guard)', () => {
    expect(() => rollDice(0, 6)).toThrow()
    expect(() => rollDice(101, 6)).toThrow()
  })
  it('throws on a non-standard die', () => {
    expect(() => rollDice(1, 7)).toThrow()
  })
})

describe('proficiencyBonusByLevel', () => {
  it.each([[1, 2], [4, 2], [5, 3], [9, 4], [13, 5], [17, 6], [20, 6]])(
    'level %i → +%i', (level, pb) => { expect(proficiencyBonusByLevel(level)).toBe(pb) },
  )
  it('throws outside 1-20', () => {
    expect(() => proficiencyBonusByLevel(0)).toThrow()
    expect(() => proficiencyBonusByLevel(21)).toThrow()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../engine.js'`)

Run: `cd backend && pnpm vitest run src/session/dice/__tests__/engine.test.ts`

- [ ] **Step 3: Implement**

```ts
// backend/src/session/dice/engine.ts
//
// MYT-68 §3.4 — the deterministic dice engine (Principle #4: the LLM never
// generates a random number). Ported from the validated mythrun-v5 prototype
// with an injectable RNG for tests, a defensive bound on rollDice (an
// unbounded count would stall the worker, which holds the session lock), and
// 5e-RAW advantage/disadvantage cancellation (the prototype let advantage
// silently win — not RAW).

import crypto from 'node:crypto'

export type RollType = 'normal' | 'advantage' | 'disadvantage'

/** `rng(min, maxExclusive)` — crypto.randomInt-compatible; injectable. */
export type Rng = (min: number, maxExclusive: number) => number

const defaultRng: Rng = (min, maxExclusive) => crypto.randomInt(min, maxExclusive)

export interface D20Result {
  readonly roll: number
  readonly roll2: number | null
  readonly keptRoll: number
  readonly rollType: RollType
}

export const STANDARD_DICE = [2, 4, 6, 8, 10, 12, 20, 100] as const
export const MAX_DICE_COUNT = 100

/** 5e RAW: any source of advantage + any source of disadvantage cancel to a
 *  straight roll, regardless of how many of each. */
export function resolveRollType(advantage: boolean, disadvantage: boolean): RollType {
  if (advantage && disadvantage) return 'normal'
  if (advantage) return 'advantage'
  if (disadvantage) return 'disadvantage'
  return 'normal'
}

export function rollD20WithType(rollType: RollType, rng: Rng = defaultRng): D20Result {
  const roll = rng(1, 21)
  if (rollType === 'normal') return { roll, roll2: null, keptRoll: roll, rollType }
  const roll2 = rng(1, 21)
  const keptRoll = rollType === 'advantage' ? Math.max(roll, roll2) : Math.min(roll, roll2)
  return { roll, roll2, keptRoll, rollType }
}

export function rollDice(
  count: number,
  sides: number,
  rng: Rng = defaultRng,
): { results: number[]; total: number } {
  if (!Number.isInteger(count) || count < 1 || count > MAX_DICE_COUNT) {
    throw new Error(`rollDice: count out of bounds (1..${String(MAX_DICE_COUNT)}): ${String(count)}`)
  }
  if (!(STANDARD_DICE as readonly number[]).includes(sides)) {
    throw new Error(`rollDice: non-standard die d${String(sides)}`)
  }
  const results: number[] = []
  for (let i = 0; i < count; i += 1) results.push(rng(1, sides + 1))
  return { results, total: results.reduce((a, b) => a + b, 0) }
}

export function calculateModifier(abilityScore: number): number {
  return Math.floor((abilityScore - 10) / 2)
}

const PROFICIENCY_TABLE: ReadonlyArray<readonly [number, number, number]> = [
  [1, 4, 2], [5, 8, 3], [9, 12, 4], [13, 16, 5], [17, 20, 6],
]

/** Generation/validation use ONLY — the live skill-check path reads the
 *  stored characters.proficiency_bonus column (§3.5 step 2). */
export function proficiencyBonusByLevel(level: number): number {
  const entry = PROFICIENCY_TABLE.find(([min, max]) => level >= min && level <= max)
  if (entry === undefined) throw new Error(`Invalid level: ${String(level)}. Must be 1-20.`)
  return entry[2]
}
```

- [ ] **Step 4: Run the test — expect PASS.** Report DONE (controller commits).

---

### Task 3: Skill-check schema + DC-table prompt

**Files:**
- Create: `backend/src/llm/schemas/skill-check.ts`, `backend/src/llm/prompts/session/skill-check.txt`
- Test: `backend/src/llm/schemas/__tests__/skill-check.test.ts`

- [ ] **Step 1: Failing test**

```ts
// backend/src/llm/schemas/__tests__/skill-check.test.ts
import { describe, expect, it } from 'vitest'
import { SkillCheckResultSchema } from '../skill-check.js'
import { loadPrompt } from '../../prompts.js'

const valid = {
  dc: 13,
  outcomes: { fail: 'You slip.', success: 'You hold on.', great_success: 'You vault it.' },
}

describe('SkillCheckResultSchema', () => {
  it('accepts a valid table', () => {
    expect(SkillCheckResultSchema.safeParse(valid).success).toBe(true)
  })
  it('rejects an out-of-band DC (structural bound, ZFC-exempt)', () => {
    expect(SkillCheckResultSchema.safeParse({ ...valid, dc: 200 }).success).toBe(false)
    expect(SkillCheckResultSchema.safeParse({ ...valid, dc: -3 }).success).toBe(false)
    expect(SkillCheckResultSchema.safeParse({ ...valid, dc: 12.5 }).success).toBe(false)
  })
  it('rejects an empty outcome (min floor; NO max on prose — feedback_no_max_on_llm_prose_fields)', () => {
    expect(
      SkillCheckResultSchema.safeParse({ ...valid, outcomes: { ...valid.outcomes, fail: '' } }).success,
    ).toBe(false)
  })
})

describe('skill-check prompt template', () => {
  it('carries exactly the FT-tier var contract (§8: tool input + mechanical character data ONLY)', () => {
    const raw = loadPrompt('session', 'skill-check', {
      character_summary: 'CS', world_tone: 'WT', skill: 'SK', context: 'CX',
    })
    expect(raw).toContain('CS')
    expect(raw).toContain('WT')
    expect(raw).toContain('SK')
    expect(raw).toContain('CX')
    // Forbidden vars: the template must NOT reference summary/world-store slots.
    expect(raw).not.toContain('{{')
  })
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement schema**

```ts
// backend/src/llm/schemas/skill-check.ts
//
// MYT-68 §3.5 step 3 — the Haiku DC-outcome-table shape (Principle #5).
// Ported from the prototype's inline dcResponseSchema with structural DC
// bounds added (5-25 is what the prompt requests; int + 1..30 is the hard
// structural envelope — a DC of 200 or -3 makes the tier match degenerate).
// Outcome strings: .min(1) floors only, NO .max() — never reject valid
// generated prose for length (feedback_no_max_on_llm_prose_fields).

import { z } from 'zod'

export const SkillCheckResultSchema = z.object({
  dc: z.number().int().min(1).max(30),
  outcomes: z.object({
    fail: z.string().min(1),
    success: z.string().min(1),
    great_success: z.string().min(1),
  }),
})

export type SkillCheckResult = z.infer<typeof SkillCheckResultSchema>
```

- [ ] **Step 4: Write the prompt template** (port of the prototype's `skill-check.txt`, vars unchanged — the var contract is pinned by §8):

```text
You are setting the difficulty and outcomes for a D&D 5e skill check.

Character: {{character_summary}}
World tone: {{world_tone}}

The DM requested a {{skill}} check in this context:
{{context}}

Set an appropriate DC (Difficulty Class) and write three outcome descriptions — one for each tier. Outcomes must be:
- One sentence each
- General narrative constraints, not specific dialogue or prose
- Written so the DM has creative freedom in how they narrate the result

Respond as JSON:
{
  "dc": <number 5-25>,
  "outcomes": {
    "fail": "<what happens on failure>",
    "success": "<what happens on success (meets DC)>",
    "great_success": "<what happens on great success (DC+5 or more)>"
  }
}
```

Save to `backend/src/llm/prompts/session/skill-check.txt`.

- [ ] **Step 5: Run the test — expect PASS.** Report DONE.

---

### Task 4: `ft-system.txt` — the multiplayer FT system prompt (rewrite, not port)

**Files:**
- Create: `backend/src/llm/prompts/session/ft-system.txt`
- Test: `backend/src/llm/prompts/__tests__/ft-system.test.ts`

The prototype prompt (`mythrun-v5/backend/src/llm/prompts/ft-system.txt`) is single-player. Production keeps its validated sections (Dice Tools incl. the social-checks + frequency rules, Pacing, Prose, Entity Reminders, Narrative Camera, Critical Rules) and changes: `[STAGE]` → `[DM direction: …]` (the shipped controller's delimiter), `{{character_name}}` singular → the `{{party_roster}}` multiplayer roster + per-message attribution, drops `{{npc_seeds}}` + the "Strong Start"/Opening section (session-start flow is a later issue), keeps `{{ft_context}}` (now fed from `session_preps.ft_context`, §3.10), and adds the error-constraint rule (§5).

- [ ] **Step 1: Failing test**

```ts
// backend/src/llm/prompts/__tests__/ft-system.test.ts
import { describe, expect, it } from 'vitest'
import { loadPrompt } from '../../prompts.js'

describe('ft-system prompt (multiplayer rewrite)', () => {
  const render = (): string =>
    loadPrompt('session', 'ft-system', { ft_context: 'FTCTX', party_roster: 'Arin, Bryn' })

  it('interpolates the §7 var contract and nothing else', () => {
    const p = render()
    expect(p).toContain('FTCTX')
    expect(p).toContain('Arin, Bryn')
    expect(p).not.toContain('{{') // no unfilled vars (no npc_seeds, no character_name)
  })
  it('uses the shipped DM-direction delimiter, not the prototype STAGE tag', () => {
    const p = render()
    expect(p).toContain('[DM direction:')
    expect(p).not.toContain('[STAGE]')
  })
  it('pins the tool protocol + the error-constraint rule', () => {
    const p = render()
    expect(p).toContain('roll_skill_check')
    expect(p).toContain('roll_dice')
    expect(p).toMatch(/never generate random numbers/i)
    expect(p).toMatch(/could not be resolved/i)
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Write the prompt** — `backend/src/llm/prompts/session/ft-system.txt`:

```text
You are the Dungeon Master for a multiplayer D&D 5e session. You narrate the world, portray NPCs, and respond to the party's actions.

## The Party

The player characters at the table: {{party_roster}}.

Player messages arrive attributed as "CharacterName: message". Address and react to the character who acted. When several characters speak in one batch, weave one scene that answers all of them — do not write separate replies per character.

## DM Direction Protocol

A player message may end with a bracketed note like `[DM direction: ...]`. These are director's notes from the narrative director — guidance on what should happen in the scene. Consume them silently. Never acknowledge them, never quote them, never reference them. Use them as inspiration for your narration.

## Dice Tools

You have two tools: `roll_skill_check` and `roll_dice`.

**Social scenes require checks just like physical ones.** When a character lies, persuades, intimidates, or tries to read someone, call `roll_skill_check` BEFORE writing the NPC's reaction. The outcome determines how the NPC responds — you do not decide whether a social action succeeds.

- Lying or omitting the truth? Deception.
- Trying to convince or negotiate? Persuasion.
- Threatening or pressuring? Intimidation.
- Reading intentions or detecting lies? Insight.
- Physical effort? Athletics or Acrobatics.
- Noticing something? Perception.
- Hiding or sneaking? Stealth.
- Searching or examining? Investigation.
- Always pass `character_name` — the exact name of the character making the attempt, as attributed in their message.
- If the character has a clear edge (helping hand, surprise, perfect conditions), pass `advantage: true`. If conditions work against them (darkness, exhaustion, hostile terrain), pass `disadvantage: true`. Most checks are normal.
- When several characters attempt the same thing ("everyone roll Perception"), call `roll_skill_check` once per character — you may make all the calls together.

**Frequency rule:** If a conversation has gone 2+ exchanges without a skill check, the next player action involving ANY uncertainty MUST trigger one. Social uncertainty counts.

Call the tool first. Write prose based on the result the tool returns. The result is the authoritative truth of what happened — narrate HOW it happens, never whether.

If a tool returns an error saying the check could not be resolved, do NOT narrate a definite success or failure for that attempt — keep the outcome open and move the scene forward.

For any other dice (damage, wild magic, random effects), use `roll_dice`.

Never generate random numbers yourself. Always use the dice tools.

## Pacing Rules

**Mirror the players' energy and length.** If a player wrote a single short action, respond with a single short beat. If they wrote a paragraph, you can write a paragraph back. Never exceed the batch's combined word count by more than 50%.

- One action = one reaction from the world. Stop at the first natural pause. Leave space for the players to fill.
- Write at length only when a player asked for an explanation or a major scene-setting moment demands it.
- End each response where the players have something to do or say. Never narrate a player character's reaction or feelings.

## Prose Rules

Write vivid, sensory prose. Every NPC has a distinct voice — different cadence, vocabulary, mannerisms. Every location feels different: temperature, smell, sound, light. No info-dumps, no exposition monologues. Show, don't tell.

Match the tone the scene calls for. You can be funny, mundane, tense, warm, eerie, or urgent — not every moment needs to be atmospheric and heavy.

## Entity Reminders

Assume the players have terrible memory. Every NPC and location name comes with one clause of context, woven naturally into the prose — "Maren Osk, the Tide Family matriarch", not just "Maren".

## Narrative Camera

Show, never interpret. NPC reactions are behavior only: hands, voice, eyes, pauses. PC actions belong to the players — describe what happens next, not how well they performed. The players draw the conclusions.

## Critical Rules

- Never generate random numbers yourself — always use the dice tools.
- Never reveal information the characters would not yet know.
- Do not invent plot revelations unprompted.

## Session Context

{{ft_context}}
```

- [ ] **Step 4: Run — PASS.** Report DONE.

---

### Task 5: Contract frames — `skill_check`, `dice_roll`, `dm_message`

**Files:**
- Modify: `backend/src/contract/session-events.ts`
- Test: `backend/src/contract/__tests__/session-events.test.ts` (extend the existing file)

- [ ] **Step 1: Failing test** (append to the existing test file):

```ts
describe('MYT-68 DM-turn frames', () => {
  it('server allowlist gains skill_check / dice_roll / dm_message', () => {
    expect(SERVER_FRAME_TYPES).toContain('skill_check')
    expect(SERVER_FRAME_TYPES).toContain('dice_roll')
    expect(SERVER_FRAME_TYPES).toContain('dm_message')
  })
  it('roll_complete stays OFF the live client allowlist (no handler — §3.8)', () => {
    expect(CLIENT_FRAME_TYPES).not.toContain('roll_complete')
    expect(classifyClientFrame('roll_complete')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — in `session-events.ts`, append to `SERVER_FRAME_TYPES`:

```ts
  // MYT-68 DM-turn mechanical frames. Live-streamed during a turn (no seq, like
  // text_delta) AND replayed from session_messages rows on reconnect (then
  // carrying the row's seq). `dm_message` is replay-only: the consolidated DM
  // prose row (live prose streams as text_delta). `roll_complete` is
  // deliberately NOT added to CLIENT_FRAME_TYPES — no server handler exists
  // (§3.8); it lands with the frontend roll-animation issue.
  'skill_check',
  'dice_roll',
  'dm_message',
```

And to the `ServerFrame` union:

```ts
  | {
      type: 'skill_check'
      turnId: string
      seq?: number // present only on reconnect replay (persisted row)
      characterName: string
      skill: string
      context: string
      roll: number
      roll2: number | null
      rollType: 'normal' | 'advantage' | 'disadvantage'
      modifier: number
      total: number
      dc: number
      outcomeTier: 'fail' | 'success' | 'great_success'
      constraint: string
    }
  | {
      type: 'dice_roll'
      turnId: string
      seq?: number
      count: number
      sides: number
      results: number[]
      total: number
    }
  // Replay-only: one consolidated DM prose row (live prose = text_delta stream).
  | { type: 'dm_message'; seq: number; turnId: string; text: string }
```

- [ ] **Step 4: Run the contract test file — PASS.** Report DONE.

---

### Task 6: `streamTextWithTools` in `ai.ts` (+ re-exports, + `GenerateObjectOpts.abortSignal`)

**Files:**
- Modify: `backend/src/llm/ai.ts`
- Test: `backend/src/llm/__tests__/stream-text-with-tools.test.ts`

Tests mock `'ai'` (the SDK boundary). The wrapper: passes through `fullStream`, exposes `stepUsage` (final-step) + `totalUsage` (cumulative) **with pre-attached no-op catch handlers** (§3.1 guarded promises), wires the per-turn timeout, threads `providerOptions` (mythrun log bindings only). NO repair chain.

- [ ] **Step 1: Failing test**

```ts
// backend/src/llm/__tests__/stream-text-with-tools.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const streamTextMock = vi.fn()
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, streamText: (...args: unknown[]) => streamTextMock(...args) }
})

const { streamTextWithTools } = await import('../ai.js')

async function* parts(...items: unknown[]): AsyncGenerator<unknown> {
  for (const p of items) yield p
}

beforeEach(() => { streamTextMock.mockReset() })

describe('streamTextWithTools', () => {
  it('passes fullStream through and exposes stepUsage + totalUsage', async () => {
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const totalUsage = { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
    streamTextMock.mockReturnValue({
      fullStream: parts({ type: 'text-delta', text: 'hi' }),
      usage: Promise.resolve(usage),
      totalUsage: Promise.resolve(totalUsage),
    })
    const r = streamTextWithTools({
      model: {} as never, messages: [], tools: {},
      stopWhen: (() => false) as never, callSite: 't',
    })
    const seen: unknown[] = []
    for await (const p of r.fullStream) seen.push(p)
    expect(seen).toEqual([{ type: 'text-delta', text: 'hi' }])
    await expect(r.stepUsage).resolves.toEqual(usage)
    await expect(r.totalUsage).resolves.toEqual(totalUsage)
  })

  it('guards the usage promises: a zero-step rejection does not unhandled-reject', async () => {
    streamTextMock.mockReturnValue({
      fullStream: parts({ type: 'error', error: new Error('boom') }),
      usage: Promise.reject(new Error('no steps')),
      totalUsage: Promise.reject(new Error('no steps')),
    })
    const r = streamTextWithTools({
      model: {} as never, messages: [], tools: {},
      stopWhen: (() => false) as never, callSite: 't',
    })
    // Drain the stream; never await the usages — the wrapper must have
    // pre-attached handlers so this test process sees no unhandledRejection.
    for await (const p of r.fullStream) void p
    await new Promise((res) => setImmediate(res))
    // Awaiting them STILL rejects for a consumer who asks:
    await expect(r.stepUsage).rejects.toThrow('no steps')
  })

  it('threads timeout + providerOptions + tools into the SDK call', async () => {
    streamTextMock.mockReturnValue({
      fullStream: parts(), usage: Promise.resolve({}), totalUsage: Promise.resolve({}),
    })
    const tools = { roll_dice: {} }
    streamTextWithTools({
      model: {} as never, messages: [{ role: 'system', content: 's' }] as never, tools: tools as never,
      stopWhen: (() => false) as never, callSite: 'ft-turn', timeoutMs: 1234,
      providerOptions: { mythrun: { stage: 'session_prep' } },
    })
    const call = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.tools).toBe(tools)
    expect(call.providerOptions).toEqual({ mythrun: { stage: 'session_prep' } })
    expect(call.abortSignal).toBeInstanceOf(AbortSignal)
  })
})

describe('GenerateObjectOpts.abortSignal threading', () => {
  it('combines an external signal with the internal timeout (AbortSignal.any)', async () => {
    const generateTextMock = vi.fn().mockResolvedValue({ output: { ok: true }, usage: {} })
    streamTextMock.mockReset()
    // generateObject uses sdkGenerateText; assert the signal it receives aborts
    // when the EXTERNAL controller aborts.
    const aiModule = await import('ai')
    const spy = vi.spyOn(aiModule, 'generateText' as never)
    void spy // typed-mock note: the suite's vi.mock above already intercepts;
    // implementers: assert via the existing generate-object test patterns that
    // passing { abortSignal } yields a signal which is aborted after
    // external.abort() fires.
  })
})
```

(The last block is the assertion *intent*; implement it following the existing `__tests__/ai.test.ts` mock pattern for `generateText` — script `generateText` to capture `abortSignal`, call `external.abort()`, expect `captured.aborted === true`.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement in `ai.ts`**

Add imports/re-exports (top of file, extending the existing re-export block):

```ts
import {
  streamText as sdkStreamText,
  tool,
  stepCountIs,
  type ModelMessage,
  type StopCondition,
  type PrepareStepFunction,
  type TextStreamPart,
  type ToolSet,
} from 'ai'
// extend the existing export lines:
export { tool, stepCountIs }
export type { ModelMessage, StopCondition, PrepareStepFunction, TextStreamPart, ToolSet }
```

Add `abortSignal?: AbortSignal` to `GenerateObjectOpts` and combine in `generateObject`:

```ts
  // in GenerateObjectOpts:
  /** Optional EXTERNAL abort (e.g. the FT turn's signal threaded into the
   *  nested skill-check DC call, §3.5 step 3). Combined with the internal
   *  timeout via AbortSignal.any — whichever fires first aborts. */
  readonly abortSignal?: AbortSignal

  // in generateObject, replace `abortSignal: timeout.signal` with:
      abortSignal: opts.abortSignal !== undefined
        ? AbortSignal.any([timeout.signal, opts.abortSignal])
        : timeout.signal,
```

Add the wrapper (after `generateText`):

```ts
export interface StreamTextWithToolsOpts {
  readonly model: LanguageModel
  /** Full message array INCLUDING the system-role message — passed as a
   *  message (not the `system:` param) so it can carry the per-message
   *  anthropic cacheControl breakpoint (§3.9; call-level providerOptions is
   *  silently inert for cache_control). */
  readonly messages: ModelMessage[]
  readonly tools: ToolSet
  readonly stopWhen: StopCondition<ToolSet> | StopCondition<ToolSet>[]
  readonly prepareStep?: PrepareStepFunction<ToolSet>
  readonly callSite: string
  /** Per-TURN budget (whole loop). Surfaces as an in-band `abort` part —
   *  the CONSUMER throws LlmTimeoutError on it; nothing here throws. */
  readonly timeoutMs?: number
  /** mythrun log bindings ONLY — never cacheControl (see messages note). */
  readonly providerOptions?: unknown
  readonly maxOutputTokens?: number
}

export interface StreamTextWithToolsResult {
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>
  /** FINAL step's usage — its inputTokens is the §3.11 context-fill signal. */
  readonly stepUsage: Promise<LanguageModelUsage>
  /** Cumulative usage across ALL steps — the spend-attribution number. A
   *  5-step turn billed off stepUsage would under-count ~4 Sonnet passes. */
  readonly totalUsage: Promise<LanguageModelUsage>
}

/**
 * MYT-68 §3.1 — the FT tool-loop wrapper. Deliberately NO repair chain (prose,
 * not structured output; malformed tool inputs surface as tool-error parts the
 * model recovers from). Error/abort surface as IN-BAND fullStream parts (the
 * for-await never throws — verified against the ai@6 dist); the consumer owns
 * converting them to thrown Mythrun errors. The usage promises are
 * pre-handled: on a zero-step failure both REJECT, and an FT that threw out
 * of its consume loop must not leave an unhandled rejection to kill the
 * worker.
 */
export function streamTextWithTools(opts: StreamTextWithToolsOpts): StreamTextWithToolsResult {
  const timeout = createTimeoutSignal(opts.timeoutMs)
  const result = sdkStreamText({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: opts.stopWhen,
    abortSignal: timeout.signal,
    ...(opts.prepareStep !== undefined ? { prepareStep: opts.prepareStep } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.providerOptions !== undefined
      ? {
          providerOptions: opts.providerOptions as NonNullable<
            Parameters<typeof sdkStreamText>[0]['providerOptions']
          >,
        }
      : {}),
  })
  // Pre-attach handlers (guarded promises, §3.1): the original promises still
  // reject for consumers who await them; these no-op catches only mark them
  // handled. Also cancel the timeout timer once the final step settles.
  void result.usage.then(() => { timeout.cancel() }, () => { timeout.cancel() })
  void result.totalUsage.catch(() => undefined)
  return {
    fullStream: result.fullStream,
    stepUsage: result.usage,
    totalUsage: result.totalUsage,
  }
}
```

- [ ] **Step 4: Run the test — PASS.** Also run `pnpm --filter @mythrun/backend typecheck` (ai.ts type changes ripple). Report DONE.

**Note for the implementer:** if the installed `ai@6.0.176` typing rejects `StopCondition<ToolSet>` generics as written, mirror whatever generic shape `sdkStreamText` expects — the authority is `pnpm typecheck`, not this plan's sketch. Do NOT loosen to `any`.

---

### Task 7: Seam widening — `tiers/types.ts` v2 + mechanical consumer updates (SOLO wave)

**Files:**
- Modify: `backend/src/session/tiers/types.ts`, `tiers/stubs.ts`, `session-controller.ts`, `redis/session-state.ts`, `turn-publisher.ts`
- Create: `backend/src/session/ft-config.ts`
- Tests: update `tiers/__tests__/stubs.test.ts`, `session/__tests__/session-controller.test.ts`, `redis/__tests__/session-state.test.ts`, `session/__tests__/turn-publisher.test.ts` to compile against v2 (behavioral rewrites land in T14; this task keeps everything green at the v2 types with MINIMAL behavior change).

This task is the ripple point — run it alone, no parallel siblings.

- [ ] **Step 1: Rewrite `tiers/types.ts`** (full replacement of the changed types; keep `TriggerMessage`, `TokenUsage`, `StEvaluation`, `ScribeResult`, `SlowThinker`, `Scribe` as-is):

```ts
/** One block of a multi-part conversation message (§3.7). Mythrun-OWNED and
 *  versioned — never persist the raw SDK ModelMessage shape; the FT maps
 *  to/from SDK messages at its boundary. */
export type ContentPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool_call'
      readonly toolCallId: string
      readonly toolName: string
      readonly input: unknown
    }
  | {
      readonly kind: 'tool_result'
      readonly toolCallId: string
      readonly toolName: string
      readonly output: unknown
    }

/** v1 of the Mythrun multi-part message. `v` is the schema version: a future
 *  shape change bumps it and the reader fails loud on an unknown version. */
export interface ConversationMessage {
  readonly v: 1
  readonly role: 'user' | 'assistant'
  readonly parts: readonly ContentPart[]
  readonly characterName?: string
}

/**
 * PUBLIC-BY-CONSTRUCTION (H4) — and as of MYT-68, STRENGTHENED: ftContext is
 * the enforced-ignorance-safe prep doc (session_preps.ft_context; sd_playbook
 * never loads here), and runningSummary is REMOVED (ST-authored — secrets had
 * a place to live; the ST gets its own view in MYT-69 via
 * `TurnContext = FtTurnContext & StSecrets`). ftHistory is the WHOLE turn
 * context reconstructed from session_messages (§3.7 single-piece predicate)
 * including the current batch — there is no separate batch append.
 */
export interface FtTurnContext {
  readonly campaignId: string
  readonly ftContext: string
  readonly ftHistory: readonly ConversationMessage[]
  readonly participants: readonly string[]
  readonly usage: TokenUsage
  /** Reserved (H9); empty in MYT-68. */
  readonly workingSet: readonly unknown[]
}

export type TurnContext = FtTurnContext

/** Payload of a skill_check frame + transcript row (§3.5 step 6 — carries
 *  characterName: multiplayer clients must see WHOSE check fired). */
export interface SkillCheckFramePayload {
  readonly characterName: string
  readonly skill: string
  readonly context: string
  readonly roll: number
  readonly roll2: number | null
  readonly rollType: 'normal' | 'advantage' | 'disadvantage'
  readonly modifier: number
  readonly total: number
  readonly dc: number
  readonly outcomeTier: 'fail' | 'success' | 'great_success'
  readonly constraint: string
}

export interface DiceRollFramePayload {
  readonly count: number
  readonly sides: number
  readonly results: readonly number[]
  readonly total: number
}

/** The widened emit seam (§3.7): one method per player-visible frame kind.
 *  ALL emission happens from the FT's consume loop in stream-part order —
 *  tools never emit (§3.2 step 5). */
export interface TurnEmitter {
  emitText(text: string): Promise<void>
  emitSkillCheck(payload: SkillCheckFramePayload): Promise<void>
  emitDiceRoll(payload: DiceRollFramePayload): Promise<void>
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly parts: readonly ContentPart[]
  /** totalUsage of the whole tool loop (all steps). */
  readonly usage?: TokenUsage
}

export interface FastThinker {
  render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage>
}
```

- [ ] **Step 2: Create `backend/src/session/ft-config.ts`**

```ts
// MYT-68 §6 — FastThinker tuning constants. Never hardcode model names or
// budgets at call sites.
import { HAIKU, SONNET } from '../llm/models.js'

export const FT_MODEL = SONNET
export const SKILL_CHECK_MODEL = HAIKU

/** §3.6: up to FT_MAX_TOOL_STEPS-1 tool-calling steps + 1 instructed prose
 *  close (NOT toolChoice:'none' — Anthropic strips tools → 400). */
export const FT_MAX_TOOL_STEPS = 5

/** Per-TURN budget: up to FT_MAX_TOOL_STEPS Sonnet passes + nested Haiku DC
 *  calls (same-step calls run concurrently). Tuned against the T19 smoke. */
export const FT_TURN_TIMEOUT_MS = 180_000

export const SKILL_CHECK_TIMEOUT_MS = 30_000

/** Injected as a final-step user message by prepareStep (§3.6). */
export const FT_CLOSE_INSTRUCTION =
  '[System: you have reached the tool-call limit for this turn. Wrap up your narration in prose now. Do not call any tools.]'

/** §5 fail-soft: the resolver's fallback DC table when Haiku fails/aborts.
 *  The one place code picks a value Principle #5 normally delegates —
 *  moderate band so the fallback neither rewards nor punishes. */
export const FALLBACK_DC = 11
export const FALLBACK_OUTCOMES = {
  fail: 'The attempt clearly fails.',
  success: 'The attempt clearly succeeds.',
  great_success: 'The attempt succeeds remarkably well.',
} as const
```

- [ ] **Step 3: Mechanical consumer updates** (keep behavior stub-level; T13/T14 bring the real behavior):
  - `tiers/stubs.ts` — `StubFastThinker.render(_ctx, emit: TurnEmitter)`: `await emit.emitText('(the DM considers the scene…)')`; return `{ role: 'assistant', parts: [{ kind: 'text', text: '(the DM responds.)' }] }`.
  - `turn-publisher.ts` — add `skillCheck` / `diceRoll` methods + return the object emitter:

```ts
  skillCheck(campaignId: string, turnId: string, p: SkillCheckFramePayload): Promise<void>
  diceRoll(campaignId: string, turnId: string, p: DiceRollFramePayload): Promise<void>
  emitFor(campaignId: string, turnId: string): TurnEmitter
```

```ts
    async skillCheck(campaignId, turnId, p): Promise<void> {
      await publish(campaignId, { type: 'skill_check', turnId, ...p, results: undefined } as never)
    },
```
  …implementer: build the frame object field-by-field from the payload (the contract frame in T5 mirrors `SkillCheckFramePayload` plus `turnId`; do NOT spread-with-cast — list the fields). `emitFor` returns `{ emitText: (t) => this.textDelta(...), emitSkillCheck: (p) => this.skillCheck(...), emitDiceRoll: (p) => this.diceRoll(...) }`.
  - `redis/session-state.ts` — `TurnState` drops `ftHistory` (becomes `{ summary, usage }`); `loadTurnState`/`flushTurnState`/`readTurnState` drop the history key handling; the checkpoint envelope keeps `{ kind: 'myt68-checkpoint', maxSeq, state, turnState }` (bump the kind string — the reader is unbuilt and must fail loud on shape change). Add `ftContext?: string` + `worldTone?: string` to `SessionStateBlob`; `getState` passes them through when they are strings.
  - `session-controller.ts` — COMPILE-LEVEL only: drop `runningSummary` from `buildContext` (keep `this.summary` for `applyEvaluation`/flush), make `appendTriggers`/`appendAssistant` produce v2 `ConversationMessage`s (`{v:1, role, parts:[{kind:'text',text:…}]}`), `appendAssistant` pushes `{v:1, role:'assistant', parts: assistant.parts}`. T14 rewrites this file properly; this step just keeps the build green.
  - Update the touched test files to the new shapes (mechanical: `content: 'x'` → `parts: [{kind:'text',text:'x'}]`, `TurnEmit` calls → `emitText`, etc.).

- [ ] **Step 4: Verify the whole backend compiles + the touched suites pass**

Run: `pnpm --filter @mythrun/backend typecheck && pnpm vitest run src/session src/redis src/contract`
Expected: green. (Other suites untouched.) Report DONE.

---

### Task 8: Transcript codec + repo — append, predicate load, idempotency

**Files:**
- Create: `backend/src/session/transcript-codec.ts` + `backend/src/session/__tests__/transcript-codec.test.ts`
- Modify: `backend/src/repo/session-messages.ts` + `backend/src/repo/__tests__/session-messages.test.ts` (extend), `backend/src/repo/types.ts`

**The codec is the single formatter (§3.7):** pure functions, no I/O — the byte-stable round-trip lives here.

- [ ] **Step 1: Failing codec test**

```ts
// backend/src/session/__tests__/transcript-codec.test.ts
import { describe, expect, it } from 'vitest'
import {
  assistantToRows,
  rowsToConversation,
  TranscriptCorruptError,
  DM_MESSAGE_TYPES,
} from '../transcript-codec.js'
import type { AssistantMessage } from '../tiers/types.js'
import type { SessionMessage } from '../../repo/types.js'

const row = (o: Partial<SessionMessage>): SessionMessage => ({
  id: 'id', sessionId: 's', seq: 1, userId: null, messageType: 'dm_text',
  content: '', createdAt: new Date(0), turnId: 't1', turnOrdinal: 0, ...o,
})

const names = new Map([['u1', 'Arin']])

describe('assistantToRows', () => {
  it('maps text + tool pair into ordered rows; matches call/result on toolCallId', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'The lock looks old.' },
        { kind: 'tool_call', toolCallId: 'c1', toolName: 'roll_skill_check', input: { skill: 'Stealth' } },
        { kind: 'tool_result', toolCallId: 'c1', toolName: 'roll_skill_check', output: { total: 17 } },
        { kind: 'text', text: 'You slip past.' },
      ],
    }
    expect(assistantToRows(assistant)).toEqual([
      { kind: 'dm_text', content: 'The lock looks old.' },
      {
        kind: 'skill_check',
        content: JSON.stringify({ toolCallId: 'c1', input: { skill: 'Stealth' }, output: { total: 17 } }),
      },
      { kind: 'dm_text', content: 'You slip past.' },
    ])
  })
  it('DROPS a dangling tool_call with no result (cap edge, §3.6)', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'Hmm.' },
        { kind: 'tool_call', toolCallId: 'c9', toolName: 'roll_dice', input: {} },
      ],
    }
    expect(assistantToRows(assistant)).toEqual([{ kind: 'dm_text', content: 'Hmm.' }])
  })
})

describe('rowsToConversation', () => {
  it('round-trips deterministically (the §3.9 byte-stability requirement)', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'A' },
        { kind: 'tool_call', toolCallId: 'c1', toolName: 'roll_dice', input: { count: 1, sides: 6 } },
        { kind: 'tool_result', toolCallId: 'c1', toolName: 'roll_dice', output: { results: [4], total: 4 } },
        { kind: 'text', text: 'B' },
      ],
    }
    const rows = assistantToRows(assistant).map((r, i) =>
      row({ messageType: r.kind, content: r.content, seq: 10 + i, turnOrdinal: i, turnId: 'tX' }),
    )
    const conv = rowsToConversation(rows, names)
    expect(conv).toHaveLength(1)
    expect(conv[0]).toEqual({ v: 1, role: 'assistant', parts: assistant.parts })
    // determinism: same input → byte-identical JSON
    expect(JSON.stringify(rowsToConversation(rows, names))).toBe(JSON.stringify(conv))
  })
  it('maps player rows with attribution and groups DM rows by turnId', () => {
    const rows = [
      row({ messageType: 'player_message', content: 'I sneak in', seq: 1, userId: 'u1', turnId: null, turnOrdinal: null }),
      row({ messageType: 'dm_text', content: 'Roll it.', seq: 2, turnId: 't1', turnOrdinal: 0 }),
      row({ messageType: 'player_message', content: 'ok', seq: 3, userId: 'u1', turnId: null, turnOrdinal: null }),
    ]
    const conv = rowsToConversation(rows, names)
    expect(conv.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(conv[0]).toMatchObject({ characterName: 'Arin', parts: [{ kind: 'text', text: 'I sneak in' }] })
  })
  it('throws TranscriptCorruptError on an unparseable roll row (crash-loud, §3.7)', () => {
    const rows = [row({ messageType: 'skill_check', content: 'not-json', seq: 1 })]
    expect(() => rowsToConversation(rows, names)).toThrow(TranscriptCorruptError)
  })
})

it('DM_MESSAGE_TYPES is the closed kind set', () => {
  expect(DM_MESSAGE_TYPES).toEqual(['dm_text', 'skill_check', 'dice_roll'])
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement the codec**

```ts
// backend/src/session/transcript-codec.ts
//
// MYT-68 §3.7 — the ONE formatter between session_messages rows and the FT's
// Mythrun-owned multi-part ConversationMessages. Pure functions, no I/O. Both
// directions live here so the round-trip is deterministic by construction
// (the §3.9 prompt-cache byte-stability requirement). Reconstruction of an
// incoherent row THROWS (crash-loud; the worker maps it to a fatal turn
// error) — it never silently truncates.

import type { SessionMessage } from '../repo/types.js'
import type { AssistantMessage, ContentPart, ConversationMessage } from './tiers/types.js'

export const DM_MESSAGE_TYPES = ['dm_text', 'skill_check', 'dice_roll'] as const
export type DmMessageType = (typeof DM_MESSAGE_TYPES)[number]

export interface DmTurnRow {
  readonly kind: DmMessageType
  readonly content: string
}

export class TranscriptCorruptError extends Error {
  constructor(detail: string) {
    super(`transcript corrupt: ${detail}`)
    this.name = 'TranscriptCorruptError'
  }
}

const KIND_TO_TOOL: Record<Exclude<DmMessageType, 'dm_text'>, string> = {
  skill_check: 'roll_skill_check',
  dice_roll: 'roll_dice',
}

interface RollRowJson {
  readonly toolCallId: string
  readonly input: unknown
  readonly output: unknown
}

/** Assistant parts → ordered DM rows. text → dm_text; a tool_call+tool_result
 *  pair (matched on toolCallId) → ONE roll row whose content is the canonical
 *  JSON {toolCallId, input, output}. A dangling tool_call (cap edge, §3.6) is
 *  DROPPED — the persisted turn must rebuild into a coherent history. */
export function assistantToRows(assistant: AssistantMessage): DmTurnRow[] {
  const rows: DmTurnRow[] = []
  const parts = assistant.parts
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as ContentPart
    if (part.kind === 'text') {
      if (part.text.length > 0) rows.push({ kind: 'dm_text', content: part.text })
      continue
    }
    if (part.kind === 'tool_call') {
      const result = parts.find(
        (p) => p.kind === 'tool_result' && p.toolCallId === part.toolCallId,
      )
      if (result === undefined || result.kind !== 'tool_result') continue // dangling → drop
      const kind: DmMessageType = part.toolName === 'roll_skill_check' ? 'skill_check' : 'dice_roll'
      const json: RollRowJson = { toolCallId: part.toolCallId, input: part.input, output: result.output }
      rows.push({ kind, content: JSON.stringify(json) })
    }
    // tool_result parts are folded by their tool_call; skip standalone.
  }
  return rows
}

/** Rows (seq ASC) → ConversationMessages. Player row → one user message with
 *  attribution; contiguous DM rows sharing a turnId → ONE assistant message.
 *  Deterministic: same rows + names → byte-identical output. */
export function rowsToConversation(
  rows: readonly SessionMessage[],
  displayNames: ReadonlyMap<string, string>,
): ConversationMessage[] {
  const out: ConversationMessage[] = []
  let dmParts: ContentPart[] = []
  let dmTurnId: string | null = null

  const flushDm = (): void => {
    if (dmParts.length > 0) out.push({ v: 1, role: 'assistant', parts: dmParts })
    dmParts = []
    dmTurnId = null
  }

  for (const r of rows) {
    if (r.messageType === 'player_message') {
      flushDm()
      const name = (r.userId !== null ? displayNames.get(r.userId) : undefined) ?? r.userId ?? 'Player'
      out.push({ v: 1, role: 'user', parts: [{ kind: 'text', text: r.content }], characterName: name })
      continue
    }
    if (!(DM_MESSAGE_TYPES as readonly string[]).includes(r.messageType)) continue // foreign kinds ignored
    if (dmTurnId !== null && r.turnId !== dmTurnId) flushDm()
    dmTurnId = r.turnId
    if (r.messageType === 'dm_text') {
      dmParts.push({ kind: 'text', text: r.content })
      continue
    }
    let parsed: RollRowJson
    try {
      parsed = JSON.parse(r.content) as RollRowJson
    } catch {
      throw new TranscriptCorruptError(`unparseable ${r.messageType} row seq=${String(r.seq)}`)
    }
    if (typeof parsed !== 'object' || typeof parsed.toolCallId !== 'string') {
      throw new TranscriptCorruptError(`malformed ${r.messageType} row seq=${String(r.seq)}`)
    }
    const toolName = KIND_TO_TOOL[r.messageType as Exclude<DmMessageType, 'dm_text'>]
    dmParts.push({ kind: 'tool_call', toolCallId: parsed.toolCallId, toolName, input: parsed.input })
    dmParts.push({ kind: 'tool_result', toolCallId: parsed.toolCallId, toolName, output: parsed.output })
  }
  flushDm()
  return out
}
```

- [ ] **Step 4: Repo additions.** `repo/types.ts`: add `turnId: string | null` + `turnOrdinal: number | null` to `SessionMessage` (and thread through `mappers.ts` — `turn_id`/`turn_ordinal` columns). `repo/session-messages.ts` gains:

```ts
    /** §3.7 single-piece context read: player rows up to the consumed
     *  watermark + ALL DM rows (their seqs can exceed an early next-batch
     *  player seq when chat raced the prior turn's end), seq ASC. */
    listFtContextRows: async (sessionId: string, maxPlayerSeq: number): Promise<SessionMessage[]> => {
      const result = await c.query<SessionMessageDbRow>(
        `SELECT * FROM session_messages
          WHERE session_id = $1
            AND ((message_type = 'player_message' AND seq <= $2)
                 OR message_type IN ('dm_text','skill_check','dice_roll'))
          ORDER BY seq ASC`,
        [sessionId, maxPlayerSeq],
      )
      return result.rows.map(toSessionMessage)
    },

    turnRowsExist: async (turnId: string): Promise<boolean> => {
      const result = await c.query(
        `SELECT 1 FROM session_messages WHERE turn_id = $1 LIMIT 1`, [turnId],
      )
      return (result.rowCount ?? 0) > 0
    },

    /** §3.7 atomic per-turn DM append: ONE multi-VALUES INSERT (single
     *  statement = atomic; all rows or none), idempotent via ON CONFLICT
     *  (turn_id, turn_ordinal) DO NOTHING. Seqs are allocated by the caller
     *  (Redis :seq INCR) BEFORE the insert, in row order. */
    appendDmTurn: async (input: {
      sessionId: string
      turnId: string
      userId?: null
      rows: readonly { kind: string; content: string }[]
      seqs: readonly number[]
    }): Promise<void> => {
      if (input.rows.length === 0) return
      if (input.seqs.length !== input.rows.length) {
        throw new Error('appendDmTurn: seqs/rows length mismatch')
      }
      const values: string[] = []
      const params: unknown[] = []
      input.rows.forEach((r, i) => {
        const base = i * 6
        values.push(
          `($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}, $${String(base + 4)}, $${String(base + 5)}, $${String(base + 6)})`,
        )
        params.push(uuidv7(), input.sessionId, input.seqs[i], r.kind, r.content, input.turnId)
      })
      await c.query(
        `INSERT INTO session_messages (id, session_id, seq, message_type, content, turn_id, turn_ordinal)
         SELECT v.id::uuid, v.session_id::uuid, v.seq::int, v.kind, v.content, v.turn_id::uuid,
                (row_number() OVER ()) - 1
           FROM (VALUES ${values.join(', ')}) AS v(id, session_id, seq, kind, content, turn_id)
         ON CONFLICT (turn_id, turn_ordinal) WHERE turn_id IS NOT NULL DO NOTHING`,
        params,
      )
    },
```

**Implementer note:** if the `row_number() OVER ()` ordinal trick fights the VALUES ordering guarantee or the partial-index conflict inference in practice (verify against real PG in the test!), fall back to passing `turn_ordinal` explicitly as a 7th column — correctness over cleverness. The test (next step) is the authority.

- [ ] **Step 5: Repo tests** (extend `repo/__tests__/session-messages.test.ts`, real `mythrun_test` PG via the existing scoped-fixture pattern in that file — read its header before writing):
  - `appendDmTurn` inserts rows with ordinals 0..n-1 + the given seqs; a SECOND identical call inserts nothing (idempotent); `turnRowsExist` flips true.
  - `listFtContextRows` includes: player ≤ watermark, ALL DM rows (including one with seq ABOVE the watermark — the raced-interleave case), excludes player rows above the watermark.
  - mixed-session isolation (rows from another sessionId never appear).

- [ ] **Step 6: Run both test files — PASS.** Report DONE.

---

### Task 9: Participant-roster character resolution (repo)

**Files:**
- Modify: `backend/src/repo/characters.ts` + extend `backend/src/repo/__tests__/characters.test.ts`

- [ ] **Step 1: Failing test** (real PG; use the existing fixtures in that file for users/campaigns/sessions/characters — read its setup helpers first):
  - resolves a joined participant's character by exact name, case-folded + trimmed (`'  aRiN '` → Arin's character + skills);
  - returns `'not_found'` for a campaign member who never joined the session;
  - returns `'ambiguous'` when two participants' characters share a normalized name;
  - returns the `character_skills` rows alongside.

- [ ] **Step 2: Implement** in `charactersNs`:

```ts
    /** MYT-68 §3.5 step 1 — resolve a skill-check roller from the SESSION
     *  roster (session_participants carries character_id; a campaign member
     *  who never joined isn't rollable). Exact match on normalized name —
     *  closed-set structural validation, NO fuzzy matching (ZFC). */
    findSessionParticipantCharacterByName: async (
      sessionId: string,
      characterName: string,
    ): Promise<
      | { outcome: 'found'; character: Character; skills: readonly { skill_name: string; proficiency_level: string }[] }
      | { outcome: 'not_found' }
      | { outcome: 'ambiguous' }
    > => {
      const matches = await c.query<CharacterDbRow>(
        `SELECT ch.* FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1
            AND lower(trim(ch.name)) = lower(trim($2))`,
        [sessionId, characterName],
      )
      if (matches.rows.length === 0) return { outcome: 'not_found' }
      if (matches.rows.length > 1) return { outcome: 'ambiguous' }
      const row = matches.rows[0]
      if (!row) return { outcome: 'not_found' }
      const skills = await c.query<{ skill_name: string; proficiency_level: string }>(
        `SELECT skill_name, proficiency_level FROM character_skills WHERE character_id = $1`,
        [row.id],
      )
      return { outcome: 'found', character: toCharacter(row), skills: skills.rows }
    },
```

(Match the file's existing mapper name for `toCharacter` / `CharacterDbRow` — read the file; do not invent new mappers.)

- [ ] **Step 3: Run — PASS.** Report DONE.

---

### Task 10: The skill-check resolver (§3.5 — Principle #5, fail-soft total)

**Files:**
- Create: `backend/src/session/skill-check.ts`
- Test: `backend/src/session/__tests__/skill-check.test.ts`

- [ ] **Step 1: Failing test.** Mock the `'ai'` boundary (`vi.mock('ai')` scripting `generateText` for the wrapper's `generateObject` — copy the mock scaffold from `src/llm/dm-trigger-classifier`'s test, which does exactly this). Inject a scripted RNG + a fake `mech` reads object. Key cases (full code per case — write them all):
  1. **Happy path:** Haiku returns `{dc:13, outcomes}` → scripted d20 roll 12 + Stealth (dex 16 → +3) + `proficient` (+2 PB) = 17 ≥ 13 → `success` tier; payload carries characterName/skill/rollType/dc/constraint; `outcome.ok === true`.
  2. **Expertise (REQUIRED — §3.5 step 2):** `proficiency_level='expertise'`, PB 2 → modifier includes `+4`.
  3. **Absent skill row → `none`** (+0).
  4. **Skill-name normalization both sides:** input `'sleight of hand'` vs stored `'Sleight Of Hand'` still matches; ability map resolves via canonical key.
  5. **adv+dis cancel:** both flags → `rollType 'normal'`, one die.
  6. **Unknown skill** (`'Basket Weaving'`) → `{ok:false}` error-constraint, NO Haiku call.
  7. **`not_found` / `ambiguous` roster outcomes** → `{ok:false}` error-constraint.
  8. **Haiku failure → FALLBACK table:** `generateObject` rejects → `dc===FALLBACK_DC`, roll + tier-match still execute (Principle #5 holds), `ok:true` with the tier-neutral constraint.
  9. **Never throws:** every arm above resolves (assert no rejection).
  10. **Abort threading:** the injected `abortSignal` reaches the `generateObject` call (capture via the mock).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```ts
// backend/src/session/skill-check.ts
//
// MYT-68 §3.5 — the roll_skill_check resolver (Principle #5: Haiku pre-
// generates the DC outcome table; code rolls deterministically; the matched
// tier is the FT's constraint). TOTAL: every failure arm returns a structured
// error-constraint — an uncaught throw would surface as a tool-error part the
// loop CONTINUES past, letting the model narrate an outcome with no roll
// (a Principle #4/#5 violation). The injected `mech` dep is a SCOPED
// mechanical projection, not the whole Repo (§8 tool-result channel bound).

import { generateObject } from '../llm/ai.js'
import { loadPrompt } from '../llm/prompts.js'
import { SkillCheckResultSchema, type SkillCheckResult } from '../llm/schemas/skill-check.js'
import {
  FALLBACK_DC, FALLBACK_OUTCOMES, SKILL_CHECK_MODEL, SKILL_CHECK_TIMEOUT_MS,
} from './ft-config.js'
import {
  calculateModifier, resolveRollType, rollD20WithType, type Rng,
} from './dice/engine.js'
import type { Character } from '../repo/types.js'
import type { SkillCheckFramePayload } from './tiers/types.js'

type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'

/** Canonical 5e skill list, keyed by normalized (lower/trimmed) name. */
const SKILL_ABILITIES = new Map<string, { canonical: string; ability: AbilityKey }>(
  (
    [
      ['Athletics', 'str'], ['Acrobatics', 'dex'], ['Sleight of Hand', 'dex'],
      ['Stealth', 'dex'], ['Arcana', 'int'], ['History', 'int'],
      ['Investigation', 'int'], ['Nature', 'int'], ['Religion', 'int'],
      ['Animal Handling', 'wis'], ['Insight', 'wis'], ['Medicine', 'wis'],
      ['Perception', 'wis'], ['Survival', 'wis'], ['Deception', 'cha'],
      ['Intimidation', 'cha'], ['Performance', 'cha'], ['Persuasion', 'cha'],
    ] as const
  ).map(([canonical, ability]) => [canonical.toLowerCase(), { canonical, ability }]),
)

const norm = (s: string): string => s.trim().toLowerCase()

export interface MechanicalReads {
  findSessionParticipantCharacterByName(
    sessionId: string,
    characterName: string,
  ): Promise<
    | { outcome: 'found'; character: Character; skills: readonly { skill_name: string; proficiency_level: string }[] }
    | { outcome: 'not_found' }
    | { outcome: 'ambiguous' }
  >
}

export interface SkillCheckDeps {
  readonly mech: MechanicalReads
  readonly sessionId: string
  readonly worldTone: string
  readonly rng?: Rng
  readonly abortSignal?: AbortSignal
  readonly logger?: { warn: (o: Record<string, unknown>, m: string) => void }
}

export interface SkillCheckInput {
  readonly character_name: string
  readonly skill: string
  readonly context: string
  readonly advantage?: boolean
  readonly disadvantage?: boolean
}

export type SkillCheckResolution =
  | { readonly ok: true; readonly payload: SkillCheckFramePayload }
  | { readonly ok: false; readonly errorConstraint: string }

const UNRESOLVED =
  'This check could not be resolved. Do not narrate a definite success or failure for this attempt.'

export async function resolveSkillCheck(
  deps: SkillCheckDeps,
  input: SkillCheckInput,
): Promise<SkillCheckResolution> {
  const skillEntry = SKILL_ABILITIES.get(norm(input.skill))
  if (skillEntry === undefined) {
    deps.logger?.warn({ skill: input.skill }, 'skill-check: unknown skill')
    return { ok: false, errorConstraint: `Unknown skill "${input.skill}". ${UNRESOLVED}` }
  }

  const resolved = await deps.mech.findSessionParticipantCharacterByName(
    deps.sessionId, input.character_name,
  )
  if (resolved.outcome !== 'found') {
    deps.logger?.warn(
      { characterName: input.character_name, outcome: resolved.outcome },
      'skill-check: roller resolution failed',
    )
    return {
      ok: false,
      errorConstraint: `Could not identify the character "${input.character_name}". ${UNRESOLVED}`,
    }
  }

  const { character, skills } = resolved
  // §3.5 step 2 — normalize BOTH sides of the skill join; absent row → none.
  const skillRow = skills.find((s) => norm(s.skill_name) === norm(input.skill))
  const level = skillRow?.proficiency_level ?? 'none'
  const profBonus =
    level === 'expertise' ? 2 * character.proficiencyBonus
    : level === 'proficient' ? character.proficiencyBonus
    : 0
  const abilityScore = character[skillEntry.ability]
  const modifier = calculateModifier(abilityScore) + profBonus

  const table = await fetchDcTable(deps, input, character, skills)

  const rollType = resolveRollType(input.advantage === true, input.disadvantage === true)
  const d20 = rollD20WithType(rollType, deps.rng)
  const total = d20.keptRoll + modifier
  const outcomeTier: 'fail' | 'success' | 'great_success' =
    total >= table.dc + 5 ? 'great_success' : total >= table.dc ? 'success' : 'fail'

  return {
    ok: true,
    payload: {
      characterName: character.name,
      skill: skillEntry.canonical,
      context: input.context,
      roll: d20.roll,
      roll2: d20.roll2,
      rollType,
      modifier,
      total,
      dc: table.dc,
      outcomeTier,
      constraint: table.outcomes[outcomeTier],
    },
  }
}

/** Haiku DC table with the §5(a) fail-soft fallback: on ANY failure (incl.
 *  abort) return the tier-neutral table — the deterministic roll + tier match
 *  still execute, so Principle #5's "roll then match" holds. */
async function fetchDcTable(
  deps: SkillCheckDeps,
  input: SkillCheckInput,
  character: Character,
  skills: readonly { skill_name: string; proficiency_level: string }[],
): Promise<SkillCheckResult> {
  const characterSummary =
    `${character.name} (Level ${String(character.level)} ${character.class}) — ` +
    `STR ${String(character.str)}, DEX ${String(character.dex)}, CON ${String(character.con)}, ` +
    `INT ${String(character.int)}, WIS ${String(character.wis)}, CHA ${String(character.cha)} — ` +
    `Proficiency Bonus: +${String(character.proficiencyBonus)} — ` +
    `Proficient skills: ${skills.filter((s) => s.proficiency_level !== 'none').map((s) => s.skill_name).join(', ') || 'none'}`
  try {
    const result = await generateObject({
      model: SKILL_CHECK_MODEL,
      schema: SkillCheckResultSchema,
      schemaName: 'SkillCheckResultSchema',
      prompt: loadPrompt('session', 'skill-check', {
        character_summary: characterSummary,
        world_tone: deps.worldTone,
        skill: input.skill,
        context: input.context,
      }),
      callSite: 'ft-skill-check',
      repairStrategy: 'haiku-then-sonnet',
      timeoutMs: SKILL_CHECK_TIMEOUT_MS,
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    })
    return result.output
  } catch (err) {
    deps.logger?.warn({ err, skill: input.skill }, 'skill-check: DC table failed; using fallback')
    return { dc: FALLBACK_DC, outcomes: { ...FALLBACK_OUTCOMES } }
  }
}
```

- [ ] **Step 4: Run — PASS.** Report DONE.

---

### Task 11: The tool registry — `ft-tools.ts` (pure resolvers)

**Files:**
- Create: `backend/src/session/tiers/ft-tools.ts`
- Test: `backend/src/session/tiers/__tests__/ft-tools.test.ts`

- [ ] **Step 1: Failing test:** build the tools with a stubbed resolver + scripted RNG; assert: `roll_dice.execute({count:2,sides:6})` returns `{results,total}` and never emits anything (tools are pure); an out-of-bounds input REJECTS at the Zod layer (assert `inputSchema.safeParse({count:0,sides:6}).success === false` and a non-standard die fails); `roll_skill_check.execute` returns the resolver's `payload`-derived output on `ok:true` and `{error: …}` on `ok:false`; the SDK's second `execute` arg (`{abortSignal}`) is forwarded into the resolver deps.

- [ ] **Step 2: Implement**

```ts
// backend/src/session/tiers/ft-tools.ts
//
// MYT-68 §3.3 — the extensible FT tool registry. Tools are PURE resolvers:
// execute returns data only; ALL frame emission happens in the FT's consume
// loop in stream-part order (§3.2 step 5 — execute runs at SDK pipeline pace,
// ahead of the consumer; an execute-side publish would race earlier prose).
// MYT-70/72/75 register their tools here.

import { z } from 'zod'
import { tool, type ToolSet } from '../../llm/ai.js'
import { MAX_DICE_COUNT, rollDice, STANDARD_DICE, type Rng } from '../dice/engine.js'
import { resolveSkillCheck, type SkillCheckDeps } from '../skill-check.js'

export const ROLL_DICE_INPUT = z.object({
  count: z.number().int().min(1).max(MAX_DICE_COUNT),
  sides: z.union(
    STANDARD_DICE.map((s) => z.literal(s)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
  ),
})

export const ROLL_SKILL_CHECK_INPUT = z.object({
  character_name: z.string().min(1),
  skill: z.string().min(1),
  context: z.string().min(1),
  advantage: z.boolean().optional(),
  disadvantage: z.boolean().optional(),
})

/** The skill-check tool's model-facing output. ok:true carries the §17.2
 *  CONSTRAINT (the authoritative outcome the FT narrates around) + the full
 *  frame payload (the consume loop builds the skill_check frame from it).
 *  ok:false carries the §5 error-constraint. */
export function buildFtTools(deps: Omit<SkillCheckDeps, 'abortSignal'>, rng?: Rng): ToolSet {
  return {
    roll_dice: tool({
      description:
        'Roll dice for anything except skill checks (damage, wild magic, random effects). Returns the authoritative results.',
      inputSchema: ROLL_DICE_INPUT,
      execute: (input) => {
        const { results, total } = rollDice(input.count, input.sides, rng)
        return Promise.resolve({ count: input.count, sides: input.sides, results, total })
      },
    }),
    roll_skill_check: tool({
      description:
        'Resolve a D&D 5e skill check for one character. Call BEFORE narrating any uncertain attempt. The returned constraint is the authoritative outcome — narrate HOW it happens, never whether.',
      inputSchema: ROLL_SKILL_CHECK_INPUT,
      execute: async (input, { abortSignal }) => {
        const resolution = await resolveSkillCheck(
          { ...deps, rng, ...(abortSignal !== undefined ? { abortSignal } : {}) },
          input,
        )
        if (!resolution.ok) return { error: resolution.errorConstraint }
        const p = resolution.payload
        return {
          character_name: p.characterName,
          skill: p.skill,
          outcome_tier: p.outcomeTier,
          constraint: p.constraint,
          roll: p.roll,
          roll2: p.roll2,
          roll_type: p.rollType,
          modifier: p.modifier,
          total: p.total,
          dc: p.dc,
          context: p.context,
        }
      },
    }),
  }
}
```

- [ ] **Step 3: Run — PASS.** Report DONE.

---

### Task 12: Emitted-anything latch (trigger-state)

**Files:**
- Modify: `backend/src/session/trigger-state.ts` + extend its test

- [ ] **Step 1: Failing test** (ioredis-mock): `markTurnEmitted('t1')` then `wasTurnEmitted('t1')` → true; unseen turnId → false; mark is idempotent; key carries a TTL.

- [ ] **Step 2: Implement** — add to the `TriggerState` interface + factory (mirror `claimTurnErrorPublish`'s SET-NX style):

```ts
  /** §5 emitted-anything latch: SET NX keyed by turnId, set by the emitter
   *  BEFORE the first frame publish (set-after leaves a crash window that
   *  re-streams divergent prose), checked at job START (a stalled-reclaimed
   *  job doesn't arrive via a failure path). Cross-container by construction. */
  markTurnEmitted(turnId: string): Promise<void>
  wasTurnEmitted(turnId: string): Promise<boolean>
```

```ts
    markTurnEmitted: async (turnId) => {
      await redis.set(`${keyPrefix}turn:${turnId}:emitted`, '1', 'EX', 3600, 'NX')
    },
    wasTurnEmitted: async (turnId) =>
      (await redis.exists(`${keyPrefix}turn:${turnId}:emitted`)) === 1,
```

- [ ] **Step 3: Run — PASS.** Report DONE.

---

### Task 13: The FastThinker — `fast-thinker.ts`

**Files:**
- Create: `backend/src/session/tiers/fast-thinker.ts`
- Test: `backend/src/session/tiers/__tests__/fast-thinker.test.ts`

The heart of the issue. Tests mock `'ai'` (script `streamText`'s `fullStream` parts); inject a recording `TurnEmitter` + stubbed tools.

- [ ] **Step 1: Failing tests** (write ALL of these; each is a scripted-parts scenario):
  1. **Prose streams:** parts `[text-delta 'A', text-delta 'B']` → `emitText('A')`, `emitText('B')` in order; returns `AssistantMessage` with one text part `'AB'` (deltas coalesce per step).
  2. **Skill-check frame in part order:** parts `[text-delta 'X', tool-call(c1, roll_skill_check, input), tool-result(c1, output{ok payload fields…}), text-delta 'Y']` → emit order is exactly `emitText('X')`, `emitSkillCheck(payload)`, `emitText('Y')`; assistant parts are `[text 'X', tool_call c1, tool_result c1, text 'Y']`.
  3. **Fail-soft result emits NO frame:** tool-result output `{error: '…'}` → no `emitSkillCheck`, loop continues, parts still record the call+result.
  4. **dice_roll frame** built from call input + result output.
  5. **`error` part throws:** parts `[text-delta 'X', error(mappedErr)]` → render REJECTS with that error (no silent return).
  6. **`abort` part throws `LlmTimeoutError`.**
  7. **Cap boundary:** assert the `prepareStep` passed to the SDK, when invoked with `{stepNumber: FT_MAX_TOOL_STEPS - 1}`, returns a step config whose injected messages include `FT_CLOSE_INSTRUCTION` and does NOT set `toolChoice: 'none'`; with earlier stepNumbers returns `undefined`.
  8. **Dangling final tool_call dropped from the RETURNED assistant** (tool-call with no result part → not in parts; a warn logged).
  9. **Message mapping:** given a ctx with ftHistory `[user(Arin,'hi'), assistant(parts…)]` + ftContext `'CTX'`, the `streamText` call's `messages[0]` is a system message containing `'CTX'` + the roster, carrying `providerOptions.anthropic.cacheControl`; the second-to-last message also carries the breakpoint; user content renders as `'Arin: hi'`.
  10. **Usage:** `totalUsage` resolves `{inputTokens:40,outputTokens:20}` → returned `usage === {input:40,output:20}`.

- [ ] **Step 2: Implement**

```ts
// backend/src/session/tiers/fast-thinker.ts
//
// MYT-68 §3.2 — the real FastThinker. Sonnet under the ai@6 tool loop via
// streamTextWithTools. ENFORCED IGNORANCE: input is FtTurnContext only.
// The consume loop is the SINGLE emission point, in stream-part order; it
// also ASSEMBLES the returned multi-part AssistantMessage directly from the
// parts it consumes (no coupling to the SDK's response.messages shape).
// error/abort are IN-BAND parts — the for-await never throws on its own
// (verified against the dist); this loop converts them to thrown Mythrun
// errors so a truncated turn is never persisted as a success (§5).

import {
  stepCountIs, streamTextWithTools,
  type ModelMessage, type PrepareStepFunction, type ToolSet,
} from '../../llm/ai.js'
import { LlmTimeoutError } from '../../llm/errors.js'
import { loadPrompt } from '../../llm/prompts.js'
import {
  FT_CLOSE_INSTRUCTION, FT_MAX_TOOL_STEPS, FT_MODEL, FT_TURN_TIMEOUT_MS,
} from '../ft-config.js'
import type {
  AssistantMessage, ContentPart, ConversationMessage, DiceRollFramePayload,
  FastThinker, FtTurnContext, SkillCheckFramePayload, TurnEmitter,
} from './types.js'

interface MinimalLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void
}

export interface SonnetFastThinkerDeps {
  /** buildFtTools(...) — constructed per turn by the worker (closes over the
   *  scoped mechanical reads + sessionId + worldTone). */
  readonly tools: ToolSet
  readonly logger?: MinimalLogger
  /** Test seam; defaults to the real config/model. */
  readonly model?: typeof FT_MODEL
  readonly timeoutMs?: number
}

const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: 'ephemeral' as const } } }

export class SonnetFastThinker implements FastThinker {
  private readonly deps: SonnetFastThinkerDeps

  constructor(deps: SonnetFastThinkerDeps) {
    this.deps = deps
  }

  async render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage> {
    const messages = buildModelMessages(ctx)
    const result = streamTextWithTools({
      model: this.deps.model ?? FT_MODEL,
      messages,
      tools: this.deps.tools,
      stopWhen: stepCountIs(FT_MAX_TOOL_STEPS),
      prepareStep: makePrepareStep(),
      callSite: 'ft-turn',
      timeoutMs: this.deps.timeoutMs ?? FT_TURN_TIMEOUT_MS,
      providerOptions: { mythrun: { campaignId: ctx.campaignId } },
    })

    const parts: ContentPart[] = []
    const pendingCalls = new Map<string, { toolName: string; input: unknown }>()
    let textBuf = ''

    const flushText = (): void => {
      if (textBuf.length > 0) parts.push({ kind: 'text', text: textBuf })
      textBuf = ''
    }

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        textBuf += part.text
        await emit.emitText(part.text)
        continue
      }
      if (part.type === 'tool-call') {
        flushText()
        pendingCalls.set(part.toolCallId, { toolName: part.toolName, input: part.input })
        parts.push({
          kind: 'tool_call', toolCallId: part.toolCallId,
          toolName: part.toolName, input: part.input,
        })
        continue
      }
      if (part.type === 'tool-result') {
        const call = pendingCalls.get(part.toolCallId)
        pendingCalls.delete(part.toolCallId)
        parts.push({
          kind: 'tool_result', toolCallId: part.toolCallId,
          toolName: part.toolName, output: part.output,
        })
        await emitToolFrame(emit, part.toolName, call?.input, part.output)
        continue
      }
      if (part.type === 'error') {
        // Already Mythrun-mapped by the middleware; streamText re-surfaced it
        // in-band. Throw — never let a failed turn end "normally".
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
      if (part.type === 'abort') {
        throw new LlmTimeoutError('ft turn aborted (per-turn budget)')
      }
      // finish/finish-step/tool-input-* parts: no action.
    }
    flushText()

    // Dangling final-step tool_call (cap edge §3.6): strip call parts with no
    // matching result so the persisted turn rebuilds coherently.
    const settled = parts.filter(
      (p) =>
        p.kind !== 'tool_call' ||
        parts.some((q) => q.kind === 'tool_result' && q.toolCallId === p.toolCallId),
    )
    if (settled.length !== parts.length) {
      this.deps.logger?.warn({}, 'ft: dropped dangling final-step tool call (cap close defied)')
    }

    const total = await result.totalUsage
    return {
      role: 'assistant',
      parts: settled,
      usage: { input: total.inputTokens ?? 0, output: total.outputTokens ?? 0 },
    }
  }
}

/** §3.6 — the injected-instruction cap close. NEVER toolChoice:'none' (the
 *  Anthropic provider strips `tools` for it → 400 when history holds tool
 *  blocks; verified against @ai-sdk/anthropic dist). */
function makePrepareStep(): PrepareStepFunction<ToolSet> {
  return ({ stepNumber, messages }) => {
    if (stepNumber !== FT_MAX_TOOL_STEPS - 1) return undefined
    return { messages: [...messages, { role: 'user', content: FT_CLOSE_INSTRUCTION }] }
  }
}

async function emitToolFrame(
  emit: TurnEmitter,
  toolName: string,
  input: unknown,
  output: unknown,
): Promise<void> {
  if (output === null || typeof output !== 'object') return
  if ('error' in (output as Record<string, unknown>)) return // fail-soft: no roll → no frame
  if (toolName === 'roll_skill_check') {
    const o = output as Record<string, unknown>
    const payload: SkillCheckFramePayload = {
      characterName: String(o.character_name), skill: String(o.skill),
      context: String(o.context), roll: Number(o.roll),
      roll2: o.roll2 === null ? null : Number(o.roll2),
      rollType: o.roll_type as SkillCheckFramePayload['rollType'],
      modifier: Number(o.modifier), total: Number(o.total), dc: Number(o.dc),
      outcomeTier: o.outcome_tier as SkillCheckFramePayload['outcomeTier'],
      constraint: String(o.constraint),
    }
    await emit.emitSkillCheck(payload)
    return
  }
  if (toolName === 'roll_dice') {
    const o = output as Record<string, unknown>
    const i = (input ?? {}) as Record<string, unknown>
    const payload: DiceRollFramePayload = {
      count: Number(o.count ?? i.count), sides: Number(o.sides ?? i.sides),
      results: (o.results as number[] | undefined) ?? [],
      total: Number(o.total),
    }
    await emit.emitDiceRoll(payload)
  }
}

/** ConversationMessage[] + ftContext → SDK ModelMessages with the §3.9
 *  per-message cache breakpoints: (a) the system message (ft_context is the
 *  immutable anchor), (b) the last SETTLED message (second-to-last overall).
 *  Deterministic: same ctx → byte-identical messages (cache hits depend on
 *  it). */
export function buildModelMessages(ctx: FtTurnContext): ModelMessage[] {
  const system: ModelMessage = {
    role: 'system',
    content: loadPrompt('session', 'ft-system', {
      ft_context: ctx.ftContext,
      party_roster: ctx.participants.join(', '),
    }),
    providerOptions: CACHE_BREAKPOINT,
  }
  const history: ModelMessage[] = ctx.ftHistory.map((m) => toModelMessages(m)).flat()
  // Sliding breakpoint on the last settled message (second-to-last overall —
  // the final message is the current batch tail / direction target).
  const breakpointIdx = history.length - 2
  if (breakpointIdx >= 0) {
    const target = history[breakpointIdx]
    if (target !== undefined) history[breakpointIdx] = { ...target, providerOptions: CACHE_BREAKPOINT }
  }
  return [system, ...history]
}

function toModelMessages(m: ConversationMessage): ModelMessage[] {
  if (m.role === 'user') {
    const text = m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    const name = m.characterName ?? 'Player'
    return [{ role: 'user', content: `${name}: ${text}` }]
  }
  // assistant: split at tool_result boundaries — assistant(text+tool-call)
  // then tool(tool-result), per the SDK message shape.
  const out: ModelMessage[] = []
  let assistantContent: Array<
    | { type: 'text'; text: string }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  > = []
  for (const p of m.parts) {
    if (p.kind === 'text') {
      assistantContent.push({ type: 'text', text: p.text })
      continue
    }
    if (p.kind === 'tool_call') {
      assistantContent.push({
        type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: p.input,
      })
      continue
    }
    // tool_result → flush the assistant message, then a tool message.
    if (assistantContent.length > 0) {
      out.push({ role: 'assistant', content: assistantContent } as ModelMessage)
      assistantContent = []
    }
    out.push({
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: p.toolCallId, toolName: p.toolName,
        output: { type: 'json', value: p.output },
      }],
    } as ModelMessage)
  }
  if (assistantContent.length > 0) {
    out.push({ role: 'assistant', content: assistantContent } as ModelMessage)
  }
  return out
}
```

**Implementer notes:** (a) the exact part-type field names (`part.text` vs `part.delta`, `part.input` vs `part.args`, the tool-result `output` shape) MUST be verified against the installed `ai@6.0.176` types — `pnpm typecheck` is the authority; adjust the property reads, keep the structure. (b) If `ModelMessage`'s tool-result `output` union differs, mirror the type — never cast to `any`. (c) `LlmTimeoutError` — confirm the constructor signature in `llm/errors.ts` before use.

- [ ] **Step 3: Run — PASS** + `pnpm typecheck`. Report DONE.

---

### Task 14: SessionController v2 — predicate load, persist, no turn_end

**Files:**
- Modify: `backend/src/session/session-controller.ts` + rewrite `backend/src/session/__tests__/session-controller.test.ts`

- [ ] **Step 1: Failing tests** (in-memory fakes for transcript/sessionState/publisher):
  1. `processDmTurn(maxConsumedSeq)` loads rows via `transcript.listFtContextRows(sessionId, maxConsumedSeq)` and feeds `rowsToConversation(rows, names)` as `ctx.ftHistory` to the FT — NO separate batch append (assert the FT saw exactly the codec output).
  2. ST direction fuses onto the LAST user message's text part as `\n\n[DM direction: …]` (in-memory only).
  3. `ctx.ftContext` is the injected value; `ctx` has NO `runningSummary` key.
  4. `processDmTurn` does NOT publish `turn_end` (the worker owns it now).
  5. `persistTurn()` allocates one seq per row via the injected `allocSeq` and calls `transcript.appendDmTurn` with codec rows in order; empty assistant parts → no append.
  6. `flushToRedis()` writes `{summary, usage}` only.
  7. Scribe still fire-and-forget + swallowed.

- [ ] **Step 2: Rewrite the controller.** Shape (keep the recovery-invariant header comment, updated):

```ts
export interface TranscriptStore {
  listFtContextRows(sessionId: string, maxPlayerSeq: number): Promise<SessionMessage[]>
  appendDmTurn(input: {
    sessionId: string
    turnId: string
    rows: readonly { kind: string; content: string }[]
    seqs: readonly number[]
  }): Promise<void>
}

export interface SessionControllerDeps {
  readonly sessionState: SessionState
  readonly st: SlowThinker
  readonly ft: FastThinker
  readonly scribe: Scribe
  readonly publisher: TurnPublisher
  readonly transcript: TranscriptStore
  readonly displayNames: ReadonlyMap<string, string>
  readonly ftContext: string
  readonly allocSeq: () => Promise<number>
  readonly logger?: MinimalLogger
}

export class SessionController {
  constructor(deps: SessionControllerDeps, campaignId: string, sessionId: string, turnId: string)
  async loadFromRedis(): Promise<void>            // summary/usage (turn state) + participants (:state)
  async processDmTurn(maxConsumedSeq: number): Promise<void>
  async persistTurn(): Promise<void>              // PG append (atomic, idempotent)
  async flushToRedis(): Promise<void>             // {summary, usage}
}
```

`processDmTurn` body: load rows → `this.history = rowsToConversation(rows, deps.displayNames)` → `buildContext()` (with `ftContext`) → `st.evaluate(ctx)` → `applyEvaluation` → fuse direction onto the last user message (rebuild that one message's text part) → `ft.render(ctxAfterFusion, publisher.emitFor(...))` wrapped by the worker's latched emitter (the EMITTER is injected by the worker — see T15; the controller calls `this.deps.publisher.emitFor(...)`? **No:** make the emitter a dep: add `readonly emitter: TurnEmitter` to deps and use it directly — the worker builds the latched emitter) → store `this.assistant` + accumulate usage → fire-and-forget scribe. `persistTurn`: `const rows = assistantToRows(this.assistant)`; allocate `rows.length` seqs sequentially via `allocSeq`; `transcript.appendDmTurn({sessionId, turnId, rows, seqs})`.

(Direction fusion helper: find last index with `role==='user'`; replace its single text part with `text + '\n\n[DM direction: ' + direction + ']'`.)

- [ ] **Step 3: Run — PASS** + typecheck. Report DONE.

---

### Task 15: Turn-worker v2 — converge/latch/lock-gate + real FT wiring

**Files:**
- Modify: `backend/src/session/turn-worker.ts`, `backend/src/worker.ts` + extend `session/__tests__/turn-worker.test.ts`

- [ ] **Step 1: Failing tests** (in-memory deps as the existing suite does):
  1. **Converge:** `turnRowsExist(turnId)` true at job start → NO render, watermark advanced to `maxConsumedSeq`, `turn_end` published, returns `{ran:true}`.
  2. **Latch-terminal:** rows absent + `wasTurnEmitted(turnId)` true → `turn_error` published via the claim, throws `UnrecoverableError`.
  3. **Fresh run order:** dmThinking → load → processDmTurn → **lock check** → persistTurn → flush → `setRespondedSeq(maxConsumedSeq)` → `turn_end` (assert call order via a recorder).
  4. **Lock lost AFTER render, BEFORE persist:** persistTurn never called; quiet abort.
  5. **Latched emitter:** first `emitText` calls `markTurnEmitted(turnId)` BEFORE the publish (order-assert), once only.
  6. **Real-failure rethrow** still routes to the H8 failed-handler path (existing behavior preserved).

- [ ] **Step 2: Implement.** Key shapes:

```ts
// New deps:
export interface TurnProcessorDeps {
  // …existing…
  readonly repo: Repo                 // transcript + names + ftContext reload + mech reads
  readonly makeTiers: (turn: {
    sessionId: string
    worldTone: string
    emitter: TurnEmitter
  }) => { st: SlowThinker; ft: FastThinker; scribe: Scribe }
}
```

`processTurnJob` v2 (after lock acquire + setResponding):

```ts
  // §5 decision order on ANY run (fresh or re-run):
  if (await deps.repo.sessionMessages.turnRowsExist(turnId)) {
    // Converge to completion: the turn IS durable. Finish the bookkeeping;
    // never turn_error (clients would discard prose the transcript keeps,
    // and the stuck watermark would double-answer the batch).
    await deps.triggerState.setRespondedSeq(campaignId, job.data.maxConsumedSeq)
    await deps.publisher.turnEnd(campaignId, turnId)
    deps.logger.warn({ campaignId, turnId }, 'turn converged from durable rows (post-commit re-run)')
    return { ran: true }
  }
  if (await deps.triggerState.wasTurnEmitted(turnId)) {
    // Frames were broadcast but nothing committed: a retry would re-stream
    // DIVERGENT prose + re-rolls under the same turnId (§5). Terminal.
    await publishTerminalTurnErrorNow(...)   // claim + publish, as in the failed-handler
    throw new UnrecoverableError('turn already streamed; terminal (no divergent re-stream)')
  }
```

Latched emitter (worker-local helper):

```ts
function makeLatchedEmitter(
  inner: TurnEmitter,
  markEmitted: () => Promise<void>,
): TurnEmitter {
  let latched = false
  const latch = async (): Promise<void> => {
    if (!latched) { latched = true; await markEmitted() } // SET-NX BEFORE first publish
  }
  return {
    emitText: async (t) => { await latch(); await inner.emitText(t) },
    emitSkillCheck: async (p) => { await latch(); await inner.emitSkillCheck(p) },
    emitDiceRoll: async (p) => { await latch(); await inner.emitDiceRoll(p) },
  }
}
```

Fresh-run body: resolve `state = sessionState.getState(campaignId)`; `ftContext = state?.ftContext ?? (await reloadFtContext(deps.repo, campaignId, sessionId))` (re-load from `session_preps` via the session row's `sessionNumber`; absent prep → `''` + loud warn — §3.10); `worldTone = state?.worldTone ?? ''`; `displayNames` from `repo.campaigns.listMembersBasic(campaignId)`; build the latched emitter; construct the controller with the new deps (`transcript: repo.sessionMessages`, `allocSeq: () => deps.sessionState.nextSeq(campaignId)`); then:

```ts
    await controller.loadFromRedis()
    if (isLockLost()) throw new LockLostError()
    await controller.processDmTurn(job.data.maxConsumedSeq)
    if (isLockLost()) throw new LockLostError()       // §3.7 lock-gate BEFORE the PG commit
    await controller.persistTurn()
    await controller.flushToRedis()
    await deps.triggerState.setRespondedSeq(campaignId, job.data.maxConsumedSeq)
    await deps.publisher.turnEnd(campaignId, turnId)
    return { ran: true }
```

`buildSessionTurnWorker` gains a `pool: Pool` param (build `repo = createRepo(pool)`); `makeTiers` builds the real `SonnetFastThinker` with `buildFtTools({ mech: repo.characters, sessionId, worldTone, logger }, undefined)` + Stub ST/Scribe. Update `worker.ts`'s call site to pass the pool it already holds. Import `UnrecoverableError` from `'bullmq'`.

- [ ] **Step 3: Run worker tests + `worker.test.ts` + typecheck — PASS.** Report DONE.

---

### Task 16: Session-start ftContext/worldTone, join-path roster, reconnect DM replay

**Files:**
- Modify: `backend/src/routes/sessions.ts`, `backend/src/routes/ws-session.ts` + extend their tests

- [ ] **Step 1: Failing tests:**
  1. `sessions.ts` start: after a successful start, `getState(...)` carries `ftContext` (from a seeded `session_preps` row for the session's number) + `worldTone` (from the campaign's world); with NO prep row → state has no `ftContext`, start still 200s (fail-soft, logged).
  2. `ws-session` join: after a join, `getState(...).participants` contains the joiner's character name; a second joiner appends; a duplicate join doesn't duplicate.
  3. `buildReconnectFrame`: seed player + `dm_text` + `skill_check` rows → the replay `messages` array carries `player_message`, `dm_message {seq, turnId, text}`, and `skill_check {seq, …payload}` frames in seq order; a corrupt roll row is SKIPPED with a warn (replay is player-facing — degrade gracefully here; the crash-loud contract is the FT context path, not the replay).
  4. Replay-only `dm_message` frames: live DM prose still arrives as `text_delta` (no change).

- [ ] **Step 2: Implement.**
  - `sessions.ts` (start handler, after the debit + before `setState`): read the created session's `sessionNumber` (it's on the row the handler created — reuse the existing variable or re-read via `repo.sessions.getById(sessionId)`), then `const prep = await repo.sessionPreps.getBy(campaignId, sessionNumber)`; resolve `worldTone` via the existing world read pattern (`repo.campaigns.getWorldId` → `repo.worlds.getById(worldId)` → `.tone ?? ''` — check the worlds repo's actual surface and reuse it). `setState({ participants: [], mode: 'exploration', status: 'active', ...(prep ? { ftContext: prep.ftContext } : {}), worldTone })`; log a warn when prep is absent.
  - `ws-session.ts` join (in the join handler, after `characterName` is resolved): read-modify-write the roster:

```ts
    // MYT-68 §3.5 step 1 — maintain the FT's prompt roster. Read-modify-write
    // (a lost-update race between two simultaneous joins costs one name until
    // the next join; the skill-check RESOLVER reads session_participants, not
    // this list, so correctness never depends on it).
    if (characterName !== '') {
      const state = await sessionState.getState(campaignId)
      if (state !== null && !state.participants.includes(characterName)) {
        await sessionState.setState(campaignId, {
          ...state,
          participants: [...state.participants, characterName],
        })
      }
    }
```

  - `buildReconnectFrame` row mapping: extend the `rows.map` to switch on `messageType`: `player_message` → existing; `dm_text` → `{type:'dm_message', seq, turnId: row.turnId ?? '', text: row.content}`; `skill_check`/`dice_roll` → parse the JSON content `{toolCallId, input, output}` and build the frame from `output` (same field mapping as T13's `emitToolFrame`, plus `seq` + `turnId`); on parse failure, log a warn and skip the row.

- [ ] **Step 3: Run the two route suites — PASS** + typecheck. Report DONE.

---

### Task 17: dev-fire-turn + fixture sweep

**Files:**
- Modify: `backend/src/routes/dev-fire-turn.ts` (verify payload still type-checks; it already sets `maxConsumedSeq` + `trigger`) and ANY remaining fixture/test files the T7–T16 type changes broke.

- [ ] **Step 1:** `pnpm --filter @mythrun/backend typecheck` — fix every remaining error mechanically (v2 shapes). `pnpm vitest run src/` full suite — fix stragglers.
- [ ] **Step 2:** Report DONE with the full-suite count.

---

### Task 18 (controller): lint + scoped-coverage sweep — BUDGETED, not optional

Implementers run only their own test files; the debt is known (feedback_implementers_skip_lint_and_coverage).

- [ ] `pnpm --filter @mythrun/backend lint` — full list (no head-truncation); dispatch ONE lint-fix subagent for the batch.
- [ ] Scoped coverage per new/modified source: `pnpm vitest run <tests> --coverage --coverage.include='<source>'` for: `dice/engine.ts`, `transcript-codec.ts`, `skill-check.ts`, `ft-tools.ts`, `fast-thinker.ts`, `session-controller.ts`, `turn-worker.ts`, `ai.ts` (new export), `session-state.ts`, `trigger-state.ts`, `session-messages.ts`, `characters.ts`, contract, prompts. Dispatch a coverage-fill subagent for genuine gaps (real tests > c8-ignore).
- [ ] Full `pnpm typecheck && pnpm lint && pnpm test` green before T19.

### Task 19 (controller): real-Anthropic E2E smoke → wiki → single push → close

Wire-level, per the spec §10 and feedback_dev_tool_e2e_smoke_required (no browser automation):

- [ ] Seed a real campaign/session in `mythrun_dev` (the dev seed scripts + `session_preps` row + characters with skills incl. one `expertise`), start `pnpm dev` + the worker, drive a turn via the dev fire-turn poke with a batch that invites a skill check.
- [ ] Assert over WS/log/psql: real Sonnet prose streams; a `skill_check` frame precedes its outcome narration and the narration reflects the tier; `roll_dice` works; per-step `llm.call` logs (no spurious truncation); **turn ≥2 has `cacheReadTokens > 0`** (grep the middleware logs); a **group-check turn** (prompt several characters to act) resolves multiple checks with frames in part order; a **cap-pressure turn** closes in prose without a 400; `session_messages` holds the DM rows (turn_id, ordinals, seqs) and a reconnect replays them; the FT's turn-2 context contains turn-1's DM rows (psql + a temporary debug log if needed).
- [ ] Fix what the smoke finds (it will find something), re-run.
- [ ] Wiki subagent (AUTHORING.md prompt, parameterized MYT-68) → wiki committed locally.
- [ ] Close all beads; single `git push` (pre-push gate: dev-tool:verify does NOT trigger — no `backend/dev-tool/**` or contract-route diffs; but `contract/session-events.ts` IS in the trigger list — **start `pnpm dev` on :3030 before pushing**, per reference_pre_push_dev_tool_verify_needs_backend).
- [ ] Flip MYT-68 → Done in Linear.

---

## Self-review notes (run before handing to beads)

- **Spec coverage:** §3.1→T6, §3.2→T13, §3.3→T11, §3.4→T2, §3.5→T9+T10, §3.6→T13(+config T7), §3.7→T1+T8+T14+T15, §3.8→T5(+T16 replay), §3.9→T13, §3.10→T16(+T15 reload), §3.11→no code (usage accumulation already threaded; no compaction introduced anywhere), §5→T6+T10+T13+T15, §7→T3+T4, §8→T10 (scoped mech dep) + T7 (runningSummary removal). ✓
- **Type consistency:** `ConversationMessage{v,role,parts,characterName?}` (T7) is what T8's codec, T13's mapper, and T14's controller consume; `SkillCheckFramePayload` (T7) is built by T10, emitted by T13, framed by T5/T7-publisher; `appendDmTurn(rows,seqs)` (T8) is called by T14 with T8's codec rows. `loadFtHistory` was renamed to the two-piece `listFtContextRows` (repo) + `rowsToConversation` (codec) — the spec's single repo function split into read + pure mapping for testability; semantics identical (§3.7 predicate).
- **Known judgment points for implementers:** exact ai@6 part/property names (typecheck is the authority); the multi-VALUES ordinal SQL (test against real PG; fall back to explicit ordinals); `worlds` repo read surface in T16.
