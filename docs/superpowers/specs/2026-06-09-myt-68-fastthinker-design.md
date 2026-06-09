# MYT-68 — FastThinker, Tool-Calling Framework & Skill Checks

> **Status:** Design — approved in brainstorm 2026-06-09, pending blind review.
> **Issue:** MYT-68 (Session Runtime + Combat L1 milestone, 4th issue).
> **Builds on:** MYT-66 (the SessionController conductor + the *stubbed* FastThinker seam `render(ctx, emit)`; the `FtTurnContext` public-by-construction type; the turn-publisher) and MYT-67 (the DM trigger that fires turns + plumbs `trigger.classification` onto the payload).
> **Spec refs:** Multiplayer Session Runtime §7 (FastThinker multiplayer), §10 (skill checks), §17.2 (tool-calling contract); Backend Core §10 (prototype ports). Architecture overview (FT = Sonnet).
> **Tiers stubbed:** ST (`evaluate`) and Scribe (`extract`) remain MYT-66 stubs; real ST direction is MYT-69. This issue makes the **FastThinker** real.

---

## 1. Goal

Replace the stubbed FastThinker with the real player-facing prose tier: a **Sonnet** model driving an **interleaved agentic tool loop** (text → tool call → resolve → feed the result back as a constraint → continue), under **enforced ignorance**, streaming prose to clients and resolving mechanical truth through tools. Ship the loop framework + an extensible tool registry + the two prototype-validated tools (`roll_dice`, `roll_skill_check`).

**Done when:** a triggered turn streams FT prose; the FT can call `roll_skill_check` (a pre-generated DC table → deterministic roll → matched outcome injected as a constraint that the FT narrates around) and `roll_dice`; the per-turn tool-iteration cap holds; the FT never sees plot secrets and never generates a random number.

## 2. The core model: SDK-driven interleaved tool loop

A DM turn's FastThinker pass is a **multi-step generation** conducted by the Vercel AI SDK's tool loop (`ai@6`), on **Sonnet**:

```ts
streamText({
  model: SONNET,
  system,                       // ported ft-system.txt (public-tier)
  messages,                     // ftHistory (multi-part) + character-attributed trigger batch + ST direction
  tools,                        // the registry: roll_dice, roll_skill_check (extensible)
  stopWhen: stepCountIs(FT_MAX_TOOL_STEPS),   // hard per-turn cap (§17.2)
  prepareStep,                  // final step → { toolChoice: 'none' } (clean prose close)
  abortSignal,                  // per-call timeout
  providerOptions,              // anthropic.cacheControl + mythrun log bindings
})
```

The SDK feeds each tool result back to the model and continues until it stops (no more tool calls) or the cap fires. **Constraint-injection (§17.2):** each tool returns the authoritative mechanical/factual truth; the FT writes prose *informed by* it but never *decides* the outcome — a failed check → the FT narrates *how* it fails. That discipline lives in the FT system prompt + the tool-result shape, not in code.

**Why the SDK loop (not a hand-rolled one):** verified against `ai@6` — `streamText` + `tool()` + `stopWhen: stepCountIs` + `prepareStep` (per-step `toolChoice`/`activeTools`) + the typed `fullStream` (text-delta / tool-call / tool-result parts) + `providerOptions.anthropic.cacheControl` + `abortSignal` cover **every** requirement, including the cap's graceful final-prose pass. Re-implementing the loop is strictly more bug surface for no capability gain. (The prototype hand-rolled it only because it predated the SDK's tool loop.)

## 3. Components

### 3.1 `streamTextWithTools` — new `ai.ts` wrapper

The wrapper the FT calls. `ai.ts` has `generateObject`/`streamObject`/`generateText` but **no streaming-with-tools** surface — this is the net-new primitive.

```ts
// src/llm/ai.ts (new export)
export interface StreamTextWithToolsOpts {
  readonly model: LanguageModel
  readonly system: string
  readonly messages: ModelMessage[]
  readonly tools: ToolSet
  readonly stopWhen: StopCondition            // stepCountIs(N)
  readonly prepareStep?: PrepareStepFunction
  readonly callSite: string
  readonly timeoutMs?: number                 // default per-FT-turn budget; abortSignal
  readonly providerOptions?: unknown
  readonly maxOutputTokens?: number
}
export interface StreamTextWithToolsResult {
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>
  readonly response: Promise<{ messages: ModelMessage[] }>   // the multi-part turn
  readonly usage: Promise<LanguageModelUsage>
}
export function streamTextWithTools(opts: StreamTextWithToolsOpts): StreamTextWithToolsResult
```

- **NO repair chain** (it's prose, not structured output — repair is `generateObject`'s concern).
- Timeout via `createTimeoutSignal` (the myth-4omh per-call guard) → SDK `abortSignal`; abort → `LlmTimeoutError` (terminal=false → BullMQ retry, consistent with the turn worker).
- Errors mapped via `mapToMythrunError`; the wrapped model carries `logAndNormalizeMiddleware` (cost/latency per step + the `providerOptions.mythrun.{campaignId,sessionId,stage}` bindings — the FT threads them).
- Lives in `ai.ts` alongside the other call wrappers (consistent home; the header's "no stream-gating/persistence" scope still holds — the wrapper just exposes the stream, the FT does the gating/persistence).

### 3.2 The FastThinker implementation — `src/session/tiers/fast-thinker.ts`

Implements the (widened) `FastThinker` interface. Constructor deps (injected — testable): the tool resolvers (the dice engine, the skill-check resolver), `repo` (for character lookup), the model config, the prompt loader.

`render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage>`:
1. **Build the system prompt** — `loadPrompt('session', 'ft-system', { …public vars: tone, participants, … })` (ported `ft-system.txt`).
2. **Build the messages** — from `ctx.ftHistory` (now multi-part, §3.5) + the trigger batch attributed by **character name** (§7: `Arin: "…"` lines) + the ST `direction` fused onto the batch (the controller already does the fusion; format reconciled in §8).
3. **Build the tool set** — the registry (§3.3); each tool's `execute` closes over `emit` + `ctx` (so it can emit the roll frame + resolve the roller).
4. **Run the loop** — `streamTextWithTools({ model: SONNET, system, messages, tools, stopWhen: stepCountIs(FT_MAX_TOOL_STEPS), prepareStep })`.
5. **Consume `fullStream`** — `text-delta` → `emit.emitText(delta)`; tool execution emits its frame inside the resolver. Accumulate the assistant turn.
6. **Return** the multi-part `AssistantMessage` (from `response.messages`) for the conductor to persist.

### 3.3 The tool registry — `src/session/tiers/ft-tools.ts`

Extensible. MYT-68 wires two tools as `tool({ description, inputSchema, execute })`; the other five (§17.2) register here when their resolvers land (MYT-70/72/75).

- **`roll_dice`** — `inputSchema: { count, sides }`. `execute`: `rollDice(count, sides)` (deterministic, §3.4) → emits a `dice_roll` frame → returns `{ results, total }`. For non-skill rolls (damage, wild magic).
- **`roll_skill_check`** — `inputSchema: { character_name, skill, context, advantage?, disadvantage? }`. The resolver (§3.5).

### 3.4 The dice engine — `src/session/dice/engine.ts` (ported, Principle #4)

Pure functions over `crypto.randomInt` (the LLM never generates a random number): `rollD20WithType(type)`, `rollDice(count, sides)`, `calculateModifier(score)`, `proficiencyBonusByLevel(level)`. Deterministic + unit-testable (seedable/injectable RNG for tests).

### 3.5 `roll_skill_check` resolver (Principle #5)

The full pre-gen-DC-table flow:
1. **Resolve the roller** — `character_name` → the campaign's character (via `repo.characters`; the production `characters` + `character_skills` tables carry ability scores + `proficiency_bonus` + per-skill `proficiency_level`). A lookup by `(campaignId, character_name)` is needed — add a thin `repo.characters` method if absent.
2. **Compute the modifier** — `SKILL_ABILITIES[skill]` (ported map) → ability mod + (proficient ? proficiency_bonus : 0; expertise → 2×). Mechanical (ZFC-exempt computation).
3. **Pre-generate the DC table** — one Haiku call: `generateObject({ model: HAIKU, schema: SkillCheckResultSchema, system: loadPrompt('session','skill-check', {…}) })` → `{ dc, outcomes: { fail, success, great_success } }` (ported template + schema). The outcomes are *narrative constraints*, not dialogue.
4. **Roll** — `rollD20WithType(advantage|disadvantage|normal)` + modifier → `total` (deterministic).
5. **Match the tier** — `total ≥ dc+5 → great_success`; `≥ dc → success`; else `fail`. The matched `outcomes[tier]` string is the **constraint**.
6. **Emit + return** — emit a `skill_check` frame (roll, modifier, total, dc, tier, constraint); return `{ outcome_tier, constraint, roll, total, dc }` as the tool result. The FT narrates informed by `constraint`.

### 3.6 The cap

`FT_MAX_TOOL_STEPS = 5` (config). `stopWhen: stepCountIs(FT_MAX_TOOL_STEPS)`. `prepareStep`: on the final allowed step (`stepNumber === FT_MAX_TOOL_STEPS - 1`) return `{ toolChoice: 'none' }` → the model must close with prose, never a dangling tool call.

### 3.7 Seam widening (the MYT-66 H5 / H12.f points)

- **`TurnEmit` → `TurnEmitter`** — widen the frame-agnostic emit from `(text) => Promise<void>` to a small object: `{ emitText(text), emitSkillCheck(frame), emitDiceRoll(frame) }`. The conductor binds it via the turn-publisher (§3.8). The seam stays frame-shape-light (the emitter methods take plain data; the publisher maps to wire frames).
- **`ConversationMessage.content` → multi-part** — widen from `string` to support text + tool-use + tool-result blocks (or store the SDK's `ModelMessage` shape), so `ftHistory` holds the real interleaved turns. Needed for coherent multi-turn FT context + correct prompt caching. The MYT-66 H12.f flag explicitly anticipated this.
- **`FastThinker.render`** — `emit` becomes the `TurnEmitter`; resolvers are constructor deps (not render args).
- **`appendAssistant` / `flushTurnState`** (session-controller / session-state) — persist the multi-part assistant turn into `ftHistory`. The **player transcript** (the reconnect-replay corpus: prose + roll events) is a *separate* representation and stays as-is — `ftHistory` is the FT's internal context, not the transcript.

### 3.8 Contract frames + client-side gating

Add to `contract/session-events.ts`:
- **Server frames** `skill_check` + `dice_roll` (mirror the prototype's `SkillCheckMessageSchema` / `DiceRollSchema` shapes) → `SERVER_FRAME_TYPES` + `ServerFrame`.
- **Client frame** `roll_complete` → `CLIENT_FRAME_TYPES` + `ClientFrame` + `parseClientFrame` (contract only — see gating).
- `turn-publisher.ts` gains `skillCheck(campaignId, turnId, frame)` + `diceRoll(...)`; `emitFor` returns the `TurnEmitter`. The SessionHub fan-out is frame-type-agnostic (confirm) so the new frames flow to clients.

**Gating is client-side** (decided): the worker emits the `skill_check`/`dice_roll` frame **then** the dependent narration `text_delta`, in order. The frontend (later milestone) plays the dice animation and reveals the buffered narration locally. MYT-68 builds **no** server-side `waitingForRoll` buffer and **no** cross-process `roll_complete` ack — the lock is never held for an animation, no absent-ack stall. `roll_complete` is added to the contract for the frontend but has no server-side handler in this issue (per-client reveal, not globally synced — a deliberate amendment to §10's server-side model, justified by the cross-process architecture + the deferred frontend).

### 3.9 Prompt caching (the §17.2 cost lever)

`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` on the **static prefix** — the system prompt + the stable `ft_context` head (running summary, participants). The growing tool-result tail is **not** cached. This blunts the cost of the extra inference passes the interleaved loop incurs.

## 4. Data flow

```
trigger fires turn (MYT-67) → conductor.processDmTurn:
  ST.evaluate (stub → {intervene:false})
  ft.render(ctx, emitter):
    build system (ft-system.txt) + messages (ftHistory + attributed batch + direction) + tools
    streamTextWithTools loop (Sonnet):
      text-delta ─emit.emitText→ text_delta frame (worker → Redis → hub → clients)
      [tool-call roll_skill_check] → resolver: resolve character → modifier → Haiku DC table → roll → tier
        → emit.emitSkillCheck(frame)  +  return constraint
      [SDK feeds constraint back] → FT continues narration (text-delta) informed by it
      … up to FT_MAX_TOOL_STEPS; final step toolChoice:'none' → prose close
    return multi-part AssistantMessage
  conductor.appendAssistant (multi-part) → flushToRedis → turnEnd
```

## 5. Error handling

- **Per-call timeout** wraps the FT turn (`abortSignal`); abort → `LlmTimeoutError` → rethrow → BullMQ retry (turn-worker policy). A mid-loop failure after some `text_delta` already emitted → terminal `turn_error` (the recovery invariant: the conductor mutates only in-memory until the final flush, so no partial state persists; the already-broadcast deltas are the client's to discard on `turn_error`).
- **Skill-check Haiku (DC-table) failure** → **fail-soft**: the resolver returns a neutral fallback constraint (a default DC + generic fail/success/great outcomes) so the turn completes with degraded-but-coherent prose, rather than failing the whole turn on one sub-call. Logged.
- **Unknown / unresolvable `character_name`** in `roll_skill_check` → the resolver returns an error-shaped constraint the FT narrates around (no crash).
- **Cap hit mid-intent** → `prepareStep` already forced a prose close; no dangling tool call.

## 6. Config constants

| Constant | Default | Notes |
|---|---|---|
| `FT_MODEL` | `SONNET` | config constant; swappable for an Opus eval (§ brainstorm) |
| `FT_MAX_TOOL_STEPS` | 5 | the §17.2 per-turn cap (`stepCountIs`) |
| `FT_TURN_TIMEOUT_MS` | (per-turn budget) | the abortSignal timeout; tune |
| `SKILL_CHECK_MODEL` | `HAIKU` | the DC-table tier |

## 7. Ports (validated in mythrun-v5; rewritten against production)

| Asset | → production location |
|---|---|
| `ft-system.txt` | `src/llm/prompts/session/ft-system.txt` (loaded via `loadPrompt('session','ft-system',vars)`) |
| `skill-check.txt` | `src/llm/prompts/session/skill-check.txt` |
| `SkillCheckResultSchema` | `src/llm/schemas/skill-check.ts` |
| dice engine | `src/session/dice/engine.ts` |
| `SKILL_ABILITIES` map | with the skill-check resolver |

**Direction-format reconciliation:** the controller fuses `[DM direction: …]`; the prototype `ft-system.txt` expects `[STAGE]…[/STAGE]`. Align the **prompt** to the controller's `[DM direction: …]` format (one source of truth; the controller is shipped). The ported prompt already encodes Principles #1 (don't reveal what the character can't know), #4 (never roll yourself), #5 (call the tool, then narrate the result).

## 8. Non-negotiables check

- **Enforced ignorance (#1):** the FT input is `FtTurnContext` (public-by-construction; secrets have nowhere to live). The system prompt reinforces it. The FT never receives `sd_playbook`/secrets. ✓
- **ZFC (#2):** the loop is *mechanical orchestration* (the SDK's deterministic tool loop is plumbing, like BullMQ — not delegated reasoning); the FT *prose* is the model's job; the dice + skill math are deterministic code; the DC-table judgment is delegated to Haiku. No heuristics/keyword-routing. ✓
- **LLM never rolls (#4):** all rolls in `dice/engine.ts` via `crypto.randomInt`. ✓
- **Skill-check DC tables (#5):** Haiku pre-generates DC + 3 outcomes → roll → matched tier injected as a constraint → the FT writes prose informed by it. ✓
- **Prose quality is the product (#7):** Sonnet FT, the ported voice-validated `ft-system.txt`, sensory/distinct-NPC prompting. ✓

## 9. Scope / deferred

**In:** the SDK tool loop + the `streamTextWithTools` wrapper; the cap; the FastThinker impl; the extensible tool registry + `roll_dice` + `roll_skill_check` (+ the dice engine + the DC-table); the seam widening (`TurnEmitter`, multi-part `ConversationMessage`, multi-part persistence); the `skill_check`/`dice_roll`/`roll_complete` contract frames; prompt caching; the ported prompts/schema.

**Deferred (register into the same framework later):** `cast_spell` / `spend_resource` (Rules Lawyer + character ledger, MYT-70); `initiate_combat` / `resolve_combat_round` (Combat L1, MYT-75); `world_fact_lookup` (ST-gated retrieval, MYT-72). Real ST `direction` (MYT-69). Server-side synchronized roll gating (deferred / client-side per §3.8). The roll-animation *frontend* (Frontend milestone).

## 10. Testing

- **Unit (mock the `'ai'` SDK boundary** — `vi.mock('ai')`, per the repo convention; NOT the `ai.ts` wrapper): the FT loop over scripted `fullStream` parts (text-delta + tool-call + tool-result); the cap (assert the loop stops at `FT_MAX_TOOL_STEPS`); `prepareStep` forces `toolChoice:'none'` on the final step; the multi-part assistant persistence.
- **Dice engine:** deterministic with an injected RNG; the modifier + tier-matching math (great/success/fail boundaries) is exhaustively unit-tested.
- **Skill-check resolver:** mocked Haiku DC table + a fake character (ability score + proficiency) → assert the modifier, the roll, the matched tier, the constraint, the emitted frame; the fail-soft fallback on Haiku error.
- **Contract:** the new frames' shapes; `roll_complete` parses.
- **dev-tool / smoke:** MYT-68 adds no REST route (the FT runs in the worker, fired by the trigger) — the dev `fire-turn` route already drives a turn; the dev-tool gate skips. **Real-Anthropic E2E smoke (required):** drive a turn (via the dev `fire-turn` poke against a real session) and assert the FT streams real prose, calls `roll_skill_check` (the `skill_check` frame appears + the narration reflects the outcome tier), and `roll_dice` works — wire-level (SSE/log + DB), real Sonnet + real Haiku.

## 11. File-level change map (informs the plan)

**New:**
- `src/llm/ai.ts` — add `streamTextWithTools` (modify).
- `src/session/tiers/fast-thinker.ts` — the real FastThinker.
- `src/session/tiers/ft-tools.ts` — the tool registry + `roll_dice` + `roll_skill_check` tool defs.
- `src/session/skill-check.ts` — the `roll_skill_check` resolver (DC table + roll + tier).
- `src/session/dice/engine.ts` — deterministic dice (ported).
- `src/llm/schemas/skill-check.ts` — `SkillCheckResultSchema` (ported).
- `src/llm/prompts/session/ft-system.txt` + `skill-check.txt` (ported, direction-format reconciled).

**Modified:**
- `src/session/tiers/types.ts` — widen `TurnEmit` → `TurnEmitter`; `ConversationMessage.content` → multi-part; `FastThinker.render` signature.
- `src/session/turn-publisher.ts` — `skillCheck`/`diceRoll` + `emitFor` returns the `TurnEmitter`.
- `src/contract/session-events.ts` — `skill_check`/`dice_roll` server frames + `roll_complete` client frame + `parseClientFrame`.
- `src/session/session-controller.ts` — wire the real FT (it already calls `ft.render`); multi-part `appendAssistant`; the emitter.
- `src/session/turn-worker.ts` — `makeTiers` returns the real `FastThinker` (Sonnet) instead of `StubFastThinker` (constructor deps: repo, dice, skill-check resolver, model config).
- `src/redis/session-state.ts` — `flushTurnState` persists multi-part `ftHistory`.
- `src/repo/characters.ts` — a `(campaignId, character_name)` → character lookup if absent.

## 12. Open questions / resolved decisions

- **FT model:** Sonnet (resolved; config-swappable for an Opus eval).
- **Loop mechanism:** SDK auto-loop (resolved; verified the SDK covers every requirement).
- **Tool scope:** loop + `roll_dice` + `roll_skill_check` + extensible registry (resolved).
- **Roll gating:** client-side (resolved; server-side synced gating deferred).
- **Plan-time details:** the exact `ConversationMessage` multi-part shape (align to the SDK `ModelMessage`?); the `FT_TURN_TIMEOUT_MS` value; whether the character-by-name lookup needs a new repo method or composes existing ones.
