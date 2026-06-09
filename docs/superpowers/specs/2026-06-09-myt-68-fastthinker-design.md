# MYT-68 — FastThinker, Tool-Calling Framework & Skill Checks

> **Status:** Design — approved in brainstorm 2026-06-09; hardened by blind review round 1 (Ocean, 4 lenses, 0 showstoppers — see §13); two scope decisions resolved at the user gate (FT consumes `session_preps.ft_context`; DM output persists to the transcript — see §3.7 / §7 / §13).
> **Issue:** MYT-68 (Session Runtime + Combat L1 milestone, 4th issue).
> **Builds on:** MYT-66 (the SessionController conductor + the *stubbed* FastThinker seam `render(ctx, emit)`; the `FtTurnContext` public-by-construction type at `tiers/types.ts`; the turn-publisher; the recovery invariant) and MYT-67 (the DM trigger that fires turns + plumbs `trigger.classification` onto the payload, with `triggerMessages[]` attributed by `{userId, characterName, text}`).
> **Spec refs:** Multiplayer Session Runtime §7 (FastThinker multiplayer), §10 (skill checks), §12 (sequence numbers — *unbuilt*, see §3.7), §17.2 (tool-calling contract); Backend Core §10 (prototype ports). Architecture overview (FT = Sonnet).
> **Tiers stubbed:** ST (`evaluate`) and Scribe (`extract`) remain MYT-66 stubs; real ST direction is MYT-69. This issue makes the **FastThinker** real.

---

## 1. Goal

Replace the stubbed FastThinker with the real player-facing prose tier: a **Sonnet** model driving an **interleaved agentic tool loop** (text → tool call → resolve → feed the result back as a constraint → continue), under **enforced ignorance**, streaming prose to clients and resolving mechanical truth through tools. Ship the loop framework + an extensible tool registry + the two prototype-validated tools (`roll_dice`, `roll_skill_check`).

**Done when:** a triggered turn streams FT prose; the FT can call `roll_skill_check` (a pre-generated DC table → deterministic roll → matched outcome injected as a constraint that the FT narrates around) and `roll_dice`; the per-turn tool-iteration cap holds; the FT never sees plot secrets and never generates a random number.

## 2. The core model: SDK-driven interleaved tool loop

A DM turn's FastThinker pass is a **multi-step generation** conducted by the Vercel AI SDK's tool loop (`ai@6`), on **Sonnet**:

```ts
streamText({
  model: SONNET,                              // wrapped with logAndNormalizeMiddleware
  system,                                     // multiplayer ft-system.txt (public-tier)
  messages,                                   // ftHistory (multi-part) + character-attributed trigger batch + ST direction
  tools,                                      // the registry: roll_dice, roll_skill_check (extensible)
  stopWhen: stepCountIs(FT_MAX_TOOL_STEPS),   // hard per-turn cap (§3.6)
  prepareStep,                                // final step → { toolChoice: 'none' } (clean prose close)
  abortSignal,                                // per-turn timeout (§6)
  providerOptions,                            // anthropic.cacheControl + mythrun log bindings
})
```

The SDK feeds each tool result back to the model and continues until it stops (no more tool calls) or the cap fires. **Constraint-injection (§17.2):** each tool returns the authoritative mechanical/factual truth; the FT writes prose *informed by* it but never *decides* the outcome — a failed check → the FT narrates *how* it fails. That discipline lives in the FT system prompt + the tool-result shape, not in code.

**Why the SDK loop (not a hand-rolled one):** verified against `ai@6.0.176` — `streamText` + `tool()` + `stopWhen: stepCountIs` + `prepareStep` (per-step `toolChoice`/`activeTools`) + the typed `fullStream` (text-delta / tool-call / tool-result / **error** parts) + `providerOptions.anthropic.cacheControl` + `abortSignal` cover **every** requirement, including the cap's graceful final-prose pass. The SDK calls the model's `doStream` once per step; our `logAndNormalizeMiddleware` wraps each call independently (own `terminated` flag, each step terminating with a `finish` part of `finishReason` `tool-calls`/`stop`), so per-step cost logging + the `mythrun` context bindings flow on every step (verified in `middleware.ts`; re-asserted in the smoke, §10). Re-implementing the loop is strictly more bug surface for no capability gain.

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
  readonly timeoutMs?: number                 // per-TURN budget; abortSignal (§6)
  readonly providerOptions?: unknown          // house style (cast internally); carries anthropic.cacheControl + mythrun bindings
  readonly maxOutputTokens?: number
}
export interface StreamTextWithToolsResult {
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>
  readonly response: Promise<{ messages: ModelMessage[] }>   // the multi-part turn
  readonly usage: Promise<LanguageModelUsage>
}
export function streamTextWithTools(opts: StreamTextWithToolsOpts): StreamTextWithToolsResult
```

- **NO output-repair chain** (it's prose, not structured output — repair is `generateObject`'s concern). **Malformed tool-call inputs** are a distinct concern: a strict Zod `inputSchema` rejection surfaces as a `tool-error` part the model recovers from on its next step (the SDK default). We do **not** wire `experimental_repairToolCall` in MYT-68 — the model's own re-call is sufficient for two simple tools; revisit if the smoke shows repeated malformed calls.
- Timeout via `createTimeoutSignal` (the myth-4omh per-call guard) → SDK `abortSignal`; abort → `LlmTimeoutError`. The abort posture interacts with the loop + the recovery model — see §5 (an abort *after* any frame has been broadcast is terminal, not silently retried).
- Errors mapped via `mapToMythrunError`; the wrapped model carries `logAndNormalizeMiddleware`.
- Lives in `ai.ts` alongside the other call wrappers. The wrapper exposes the stream + the resolved multi-part `response.messages` + `usage`; the FT does the gating/persistence.

### 3.2 The FastThinker implementation — `src/session/tiers/fast-thinker.ts`

Implements the (widened) `FastThinker` interface. Constructor deps (injected — testable): the skill-check resolver (which itself holds the dice engine + the `repo`), the model config, the prompt loader.

`render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage>`:
1. **Build the system prompt** — `loadPrompt('session', 'ft-system', vars)` with the var contract in §7 (multiplayer-attributed; public-tier). The `{{ft_context}}` var is the curated, enforced-ignorance-safe prep document from `session_preps.ft_context` (§3.10) — the FT's stable world/party/situation grounding.
2. **Build the messages — the FULL session transcript, never windowed.** `ctx.ftHistory` is the entire session's FT message history (multi-part, §3.7) — runtime spec sizes it 50–200KB and `session-state.ts` round-trips the whole array (no slice/cap). The FT holds the **complete verbatim transcript in context every turn**, like any chat app; it does **not** narrate from a compressed summary (that would invite the hallucination the full transcript prevents). Append the current trigger batch attributed by **character name** (§7) + the ST `direction` fused onto the batch (the controller already does the fusion; format reconciled in §7; ST is stubbed in MYT-68 → no direction injected). The `runningSummary` is **not** the FT's grounding and the FT never reads it — it's the ST's tool (§7). The transcript never compacts; the context cap *is* the session-length bound (§3.11); recovery rebuilds the transcript from durable storage or crashes loud (§3.7), never degrades onto a summary.
3. **Build the tool set** — the registry (§3.3); each tool's `execute` closes over `emit` + `ctx` (so it can emit the roll frame + resolve the roller against the participant roster).
4. **Run the loop** — `streamTextWithTools({ model: SONNET, system, messages, tools, stopWhen: stepCountIs(FT_MAX_TOOL_STEPS), prepareStep })`.
5. **Consume `fullStream` — with explicit error handling and serial emit ordering:**
   - `text-delta` → `await emit.emitText(delta)`.
   - **`error` parts MUST be handled** — an in-band `error` part (or a mapped error thrown by the middleware) is rethrown as a Mythrun-typed error; the loop does not silently end and mark the turn complete (refutes the naïve `for await` that ignores error parts — see §5). The wrapped model's middleware already converts a stream `error` into `controller.error(mapped)`, so the `for await` *will* throw; the FT must let it propagate (not swallow it).
   - **Serial ordering invariant (load-bearing):** the consume loop `await`s each `emit.*` call **before advancing the iterator**. Tool `execute` emits its frame (and awaits the publish) before returning the tool result. This guarantees the worker publishes `skill_check`/`dice_roll` *before* the dependent narration `text_delta`. The implementation MUST NOT fire-and-forget the publishes (see §3.8 / §13).
6. **Return** the multi-part `AssistantMessage` (built from `response.messages`) for the conductor to persist into `ftHistory`.

### 3.3 The tool registry — `src/session/tiers/ft-tools.ts`

Extensible. MYT-68 wires two tools as `tool({ description, inputSchema, execute })`; the other five (§17.2) register here when their resolvers land (MYT-70/72/75).

- **`roll_dice`** — `inputSchema: { count: z.int().min(1).max(100), sides: z enum of the standard die set {2,4,6,8,10,12,20,100} }`. `execute`: `rollDice(count, sides)` (deterministic, §3.4) → awaits emit of a `dice_roll` frame → returns `{ results, total }`. Bounds are enforced **in code** (Zod + a defensive clamp in the engine) — an unbounded `count` would stall the worker (it holds the session lock); out-of-range rejects to a `tool-error` the model narrates around. For non-skill rolls (damage, wild magic).
- **`roll_skill_check`** — `inputSchema: { character_name, skill, context, advantage?, disadvantage? }`. The resolver (§3.5). `character_name` is matched against the **session participant roster** (a closed known set), not used as a free-text DB key — see §3.5 step 1.

### 3.4 The dice engine — `src/session/dice/engine.ts` (ported, Principle #4)

Pure functions over `crypto.randomInt` (the LLM never generates a random number): `rollD20WithType(type)` returning the **kept** roll for advantage/disadvantage (roll twice, keep higher/lower), `rollDice(count, sides)` (with a defensive bound), `calculateModifier(score) = floor((score-10)/2)`, `proficiencyBonusByLevel(level)` (used for character *generation/validation*, **not** the live skill-check path — see §3.5 step 2). Deterministic + unit-testable (injectable RNG for tests).

### 3.5 `roll_skill_check` resolver (Principle #5) — `src/session/skill-check.ts`

The full pre-gen-DC-table flow:
1. **Resolve the roller from the participant roster (not a free-text DB key).** `character_name` is normalized (trim + case-fold) and matched **exactly** against `ctx.participants` (the session's known character names — a closed set). The matched participant maps to a character record via the `campaign_characters` join (note: `characters.campaign_id` was dropped in migration 009; resolution goes through `campaign_characters` for `ctx.campaignId`). Matching against a closed known set is structural validation (ZFC-exempt) — **no fuzzy matching** (that would be the local string-intelligence ZFC forbids). **No match or ambiguous match** (two participants share a name — no schema uniqueness prevents it) → fail-soft error-constraint (§5), never a throw.
2. **Compute the modifier — read the per-skill proficiency level (DIVERGES FROM THE PROTOTYPE).** `SKILL_ABILITIES[skill]` (ported map; normalize the skill key) → ability modifier from the character's ability score. Then read `character_skills.proficiency_level` for the requested skill: `none → +0`, `proficient → +proficiency_bonus`, `expertise → +2×proficiency_bonus`. **The prototype flattens this to a boolean (`proficient ? +PB : 0`) and has no expertise path — do NOT port that math.** Use the stored `characters.proficiency_bonus` column (authoritative); `proficiencyBonusByLevel` is for generation only. A dedicated **expertise unit test** is required (the prototype has none). Mechanical computation (ZFC-exempt). An **unknown/unmapped skill** (the FT is free-text; it will eventually emit a string outside the 18-skill map) → fail-soft error-constraint (§5), never a throw.
3. **Pre-generate the DC table** — one Haiku call: `generateObject({ model: HAIKU, schema: SkillCheckResultSchema, system: loadPrompt('session','skill-check', {…}), timeoutMs, abortSignal: <threaded from the FT turn> })` → `{ dc, outcomes: { fail, success, great_success } }` (ported template + schema). The outcomes are *narrative constraints*, not dialogue. The FT turn's abortSignal is **threaded into this nested call** so a turn abort cancels the in-flight DC call (no orphaned spend). DC-table failure (or abort) → fail-soft (§5).
4. **Roll** — `rollD20WithType(type)` where `type` resolves per 5e: `advantage && disadvantage → normal` (they cancel), else `advantage → advantage`, `disadvantage → disadvantage`, else `normal`. (The prototype lets advantage silently win when both are true — that is not RAW; fix it.) Add the modifier → `total` (deterministic). **No nat-1/nat-20 auto-fail/crit on ability checks** (RAW: crits apply only to attack rolls); the tier is purely `total` vs `dc`.
5. **Match the tier** — `total ≥ dc+5 → great_success`; `≥ dc → success`; else `fail`. The matched `outcomes[tier]` string is the **constraint**.
6. **Emit + return** — await emit of a `skill_check` frame (roll, kept-roll detail, modifier, total, dc, tier, constraint); return `{ outcome_tier, constraint, roll, total, dc }` as the tool result. The FT narrates informed by `constraint`.

### 3.6 The cap

`FT_MAX_TOOL_STEPS = 5` (config). `stopWhen: stepCountIs(FT_MAX_TOOL_STEPS)` stops *after* N steps. `prepareStep` returns `{ toolChoice: 'none' }` on the final step so the model must close with prose, never a dangling tool call. **Precise semantics:** the model gets up to `FT_MAX_TOOL_STEPS − 1` tool-calling steps + 1 guaranteed prose-close step (the forced step counts as the Nth). The smoke (§10) asserts the **boundary** — that the second-to-last step may call a tool and the last step is gated to prose — rather than just "stops at 5."

### 3.7 Seam widening (the MYT-66 H5 / H12.f points)

- **`TurnEmit` → `TurnEmitter`** — widen the frame-agnostic emit from `(text) => Promise<void>` to a small object: `{ emitText(text), emitSkillCheck(frame), emitDiceRoll(frame) }`, each returning `Promise<void>`. The conductor binds it via the turn-publisher (§3.8).
- **`ConversationMessage.content` → multi-part, with a Mythrun-owned versioned shape.** Widen from `string` to a multi-part content (text + tool-call + tool-result blocks). **Do NOT persist the raw SDK `ModelMessage` shape** into `ftHistory`: that durable Redis blob (and the MYT-65 suspend/checkpoint envelope that folds in `loadTurnState`) would then couple to the `ai` package's serialization, and an `ai` minor bump could make live-session `ftHistory` / checkpoints unparseable on reconnect/cold-start. Define a small Mythrun-owned multi-part type with a schema version; map to/from SDK messages at the FT boundary. Bump the checkpoint envelope's contract version (or `kind`) so the (still-unbuilt) cold-start reader fails loud, not silent, on an old shape.
- **`ConversationMessage` / `FtTurnContext` field add** — `FtTurnContext` gains `readonly ftContext: string` (the FT-safe prep doc, §3.10). Public-by-construction is *preserved*: `ft_context` is the FT-safe slice by construction; `sd_playbook` (secrets) is **not** added here (it goes to the ST via constructor deps in MYT-69).
- **`FastThinker.render`** — `emit` becomes the `TurnEmitter`; the skill-check resolver is a constructor dep.
- **Persistence — `ftHistory` (FT context) + the player transcript (PULLED INTO MYT-68).** `flushTurnState` persists the multi-part assistant turn into `ftHistory` (the FT's internal context, for multi-turn continuity). **Separately, MYT-68 now persists DM output to the player-facing transcript** (`session_messages`): verified, that table currently holds only `player_message` rows and reconnect replay (`buildReconnectFrame`) replays only those — DM prose + roll events were never persisted, so full transcripts didn't exist. Per the user decision (holistic eval needs full transcripts *before* the frontend exists), on turn **success** MYT-68 appends the completed DM turn's player-facing prose + its roll events (`skill_check`/`dice_roll`) to `session_messages` as new transcript row kinds, **idempotent on `turnId`**. The append is a Postgres write done at turn completion (outside the Redis recovery flush; the §5 terminal-after-first-frame posture means an emitted turn won't retry, and the turnId-idempotent insert covers the pre-frame retry case). `buildReconnectFrame` extends to replay these too, so reconnect now shows prior DM turns. **Scope kept tight:** this is durable + queryable transcripts (ordered by `created_at` + a per-turn ordinal), NOT the full §12 server-assigned global-sequence model — that, plus the §17.7 lookback search surface, stays a dedicated follow-up.
- **Recovery contract: rebuild from the durable transcript, or crash loud — never degrade onto a summary.** With the transcript durably persisted per turn (above), `session_messages` is the **source of truth** and Redis `ft_history` is a **rebuildable hot cache**. If `ft_history` is evicted/missing (e.g. `volatile-lru` under memory pressure), recovery **reconstitutes the FT's multi-part history from `session_messages`** — the complete, current transcript at any turn boundary (the recovery invariant means no turn is half-persisted). If the durable transcript is **absent or incoherent when it should exist**, that is a persistence-layer invariant violation — a fundamentally broken system — and the right response is to **fail loud** (surface a fatal error, refuse the turn), NOT to limp on a stale summary. This **supersedes runtime §524** (summary-as-continuity) and revisits the architecture's "eviction loses 0–5 min" framing: with a per-turn-durable transcript, an `ft_history` eviction loses *nothing* — it rebuilds from Postgres. **Plan/scope note:** for `ft_history` to be rebuildable, `session_messages` rows must carry enough structure to reconstruct the FT's multi-part turns (the tool-call/result detail of `skill_check`/`dice_roll`, not just rendered prose) — a transcript-row-shape requirement (plan-time). The full cold-start rebuild *reader* (Orca-noted as currently unbuilt) is a recovery/session-lifecycle issue; MYT-68's obligations are (a) make the transcript durable, (b) carry rebuild-sufficient row structure, (c) state this crash-loud contract and introduce no summary escape hatch.

### 3.8 Contract frames + client-side gating

Add to `contract/session-events.ts`:
- **Server frames** `skill_check` + `dice_roll` (mirror the prototype's `SkillCheckMessageSchema` / `DiceRollSchema` shapes) → `SERVER_FRAME_TYPES` + `ServerFrame`. The SessionHub fan-out is frame-type-agnostic (confirm), so these flow to clients.
- **`roll_complete` is NOT added to the live client allowlist in MYT-68.** The existing gate is `classifyClientFrame` (a boolean allowlist tripwire), not `parseClientFrame` (the draft misnamed it). Adding `roll_complete` to `CLIENT_FRAME_TYPES` with no server handler would make the transport *accept* a frame nothing consumes — exactly what the contract file's header warns against. It is documented as a **deferred** frame (owned by the frontend roll-animation issue) and added to the allowlist only when a handler exists.

**Gating is client-side** (decided). The worker emits the `skill_check`/`dice_roll` frame **then** the dependent narration `text_delta`, in order (the §3.2 serial-emit invariant + the publisher's single-connection awaited PUBLISH guarantee cross-process order; frames carry no seq today, so arrival order is the only ordering — hence the invariant is load-bearing). The frontend (later milestone) plays the dice animation and reveals the buffered narration locally.

**This is an explicit amendment to runtime §10's server-side synchronized-reveal model** (`waitingForRoll` buffers continuation deltas server-side; the first client's `roll_complete` unblocks *everyone*). Rationale: a cross-process session lock cannot be held pending a human animation ack (it would stall the worker + the queue). The accepted tradeoff: roll-animation reveal becomes **per-client**, not globally synchronized — different clients may see the outcome beat at slightly different times. The roll *result* is identical for all clients (deterministic, resolved once); only the animation timing desyncs. Consequence to document for the (deferred) frontend: `turn_end` now fires at model speed, *before* a client finishes animating — the client treats `turn_end` as "stream complete," not "turn visually done," and continues local reveal after the animation. (MYT-68 builds **no** server-side buffer + **no** cross-process ack.)

### 3.9 Prompt caching (the §17.2 cost lever)

`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` with a **sliding breakpoint**, matching the prototype's validated approach (not static-prefix-only): place ephemeral breakpoints on (a) the system prompt + the **immutable `ft_context`** (the prep doc never changes within a session — an ideal cache anchor), and (b) the **last settled message** (end of the prior turn / second-to-last message), so each of the up-to-5 steps re-uses the cached prefix-through-the-last-stable-turn rather than re-paying full input cost on the accumulating tool-result tail. This is what makes the full-transcript-always design (§3.2) affordable at scale: the growing transcript is re-sent each turn but mostly as **cached** input (heavily discounted). Anthropic allows up to 4 breakpoints; the growing in-turn tail past the last breakpoint is uncached.

### 3.10 `ft_context` — the FT's curated world grounding (`session_preps.ft_context`)

The session-prep pipeline (MYT-59/61) already produces a first-class, **enforced-ignorance-safe-by-construction** prep artifact per `(campaignId, sessionNumber)`: `session_preps.ft_context` — a prose-markdown document (`## The World`, `## The Party`, `## Where You Are`, `## The Situation`, `## People You Know`, `## People You Don't Know (Yet)`, `## Factions`, `## Places of Interest`, `## Encounters & Set Pieces`, `## DM Guidance`) explicitly authored as *the* Fast-Thinker context, with secrets quarantined into the sibling `sd_playbook` field (ST-only). MYT-66's `FtTurnContext` never loaded it; MYT-68 wires it in:

- **`FtTurnContext` gains `readonly ftContext: string`** (the FT-safe doc). Public-by-construction is *preserved* — `ft_context` is the public slice by construction; `sd_playbook` is **not** loaded here (MYT-69 gives the ST its secrets via constructor deps).
- **Load once per session, cache in Redis `:state`.** `ft_context` is immutable per session (`ON CONFLICT DO NOTHING`). The cheapest correct path for 200–500 concurrent sessions: load `repo.sessionPreps.getBy(campaignId, sessionNumber)` once at session start and store `ftContext` in the `:state` blob (next to `participants`), so the per-turn hot path reads it from the already-loaded blob with no extra DB round-trip; the SessionController threads it through `buildContext()`. (Exact load hook — session-start vs. lazy-on-first-turn — is plan-time; both are acceptable.)
- **Fail-soft if absent.** If prep hasn't run / `ft_context` is missing, the FT falls back to transcript-only grounding (the running summary as continuity) rather than crashing — logged. The normal path is that prep ran before play.
- **It's the cache anchor (§3.9)** and the FT's stable grounding — combined with the full transcript (§3.2), the FT narrates from curated canon + verbatim history, not a lossy summary.

### 3.11 Session length is bounded by the FT context — graceful wind-down, never compaction

The FT holds the **literal full transcript** every turn (§3.2). There is **no compaction, no in-session summarization, no windowing — ever.** The FT's true context window is therefore a **hard cap on session length**, and that is by design: a Mythrun "session" is the fundamental unit of play precisely because it is what fits in one context window.

- **Graceful wind-down, not a hard cutoff (runtime §14 / §546; overview §7.4).** As the running transcript approaches the FT context/token budget, the session is brought to a natural close: at ~90% of the budget the ST issues a **wind-down instruction**, the narrative reaches a stopping point, and the server broadcasts `session_end` — *"no hard cutoff mid-response."* The system never silently drops or summarizes transcript to keep going.
- **Cross-session continuity is at the seams, not mid-session.** What carries forward is the **Scribe's session-end reconciliation** (§710 — one full-context pass producing durable world state) + the **next session's `ft_context` prep** (§3.10). Continuity is *between* sessions, not via compressing *within* one.
- **MYT-68 scope.** MYT-68 holds the full transcript (no compaction) and accumulates `usage` (the budget signal — already threaded through the controller). The wind-down itself is an **ST behavior** (the ST is stubbed in MYT-68 → real wind-down is MYT-69) plus **session-end orchestration** (its own issue). MYT-68 must not contradict this model — i.e. it introduces no summarization/windowing escape hatch. If a context-budget *observability/guard* is wanted inside MYT-68 (surface the % so a human/dev can see it), that is a small add; the wind-down decision stays with the ST.

## 4. Data flow

```
trigger fires turn (MYT-67) → conductor.processDmTurn:
  ST.evaluate (stub → {intervene:false})       // no direction injected in MYT-68
  ft.render(ctx, emitter):
    build system (ft-system.txt, §7 var contract) + messages (ftHistory + attributed batch) + tools
    streamTextWithTools loop (Sonnet):
      text-delta ─await emit.emitText→ text_delta frame (worker → Redis → hub → clients)
      [tool-call roll_skill_check] → resolver: resolve roller from participants → modifier (per-skill level)
        → Haiku DC table (abort-threaded) → roll (kept-roll) → tier
        → await emit.emitSkillCheck(frame)  +  return constraint
      [SDK feeds constraint back] → FT continues narration (text-delta) informed by it
      error part → throw mapped error (NOT silently complete)
      … up to FT_MAX_TOOL_STEPS; final step toolChoice:'none' → prose close
    return multi-part AssistantMessage
  conductor.appendAssistant (multi-part) → flushToRedis (ftHistory only) → turnEnd
```

## 5. Error handling

The error model is written against how `ai@6` actually surfaces failures (a `for await` over `fullStream` does **not** throw on an in-band `error` part unless the consumer/middleware makes it):

- **In-stream provider error** — `logAndNormalizeMiddleware` converts a stream `error` part into `controller.error(mapped)` (verified, `middleware.ts:158-162`), so the FT's `for await` throws. The FT must let it propagate. **Never** let an `error` part fall through and end the loop "normally" (which would mark a truncated turn as a successful `turn_end`).
- **Per-turn timeout** (`abortSignal`); abort → `LlmTimeoutError`.
- **Retry vs. divergent re-stream (the turnId hazard).** The turn-worker rethrows non-lock-lost errors → BullMQ retries the job. The recovery invariant keeps Redis at the pre-turn snapshot, so a retry re-runs the FT from scratch — but Sonnet is non-deterministic and `roll_*` re-rolls, so a retry would re-stream **divergent prose + divergent rolls under the same `turnId`**. Decision: **a failure AFTER any frame (text/skill/dice) has been broadcast for a `turnId` is terminal** — publish `turn_error` for that turnId, do **not** silently retry a partially-streamed turn. A failure **before any frame emitted** is safe to retry (nothing was shown). The worker distinguishes the two via an "emitted-anything" latch on the turn (mirrors MYT-67's `claimTurnErrorPublish` latch pattern). The client discards partial content on `turn_error`.
- **Tool-execute throws → resolvers must be TOTAL.** An uncaught throw in a resolver becomes a `tool-error` part the SDK feeds back, and the loop **continues** — which for a skill check would let the model narrate an outcome with **no roll** (a #4/#5 violation). Therefore every resolver is `try/catch`-total and returns a **structured error constraint** ("the check could not be resolved — do not narrate a definite outcome"), and the ft-system prompt instructs the model how to handle an error constraint without inventing a result.
- **Fail-soft enumeration (the skill-check resolver never throws mid-turn):** (a) **DC-table Haiku failure or abort** → a neutral fallback `{ dc: <fixed default>, outcomes: { fail, success, great_success } }` of **tier-neutral** templates ("the attempt clearly fails / clearly succeeds / succeeds remarkably"); the deterministic roll + tier-match **still execute** against the fallback DC, so #5's "roll then match" holds. (b) **Unknown / ambiguous `character_name`** → error constraint. (c) **Unknown / unmapped `skill`** → error constraint. (d) **`roll_dice` out-of-range** → `tool-error` the model narrates around. All logged.
- **Cap hit mid-intent** → `prepareStep` already forced a prose close; no dangling tool call.

## 6. Config constants

| Constant | Default | Notes |
|---|---|---|
| `FT_MODEL` | `SONNET` | config constant; swappable for an Opus eval |
| `FT_MAX_TOOL_STEPS` | 5 | the §3.6 per-turn cap (`stepCountIs`); model gets N−1 tool-calling steps + 1 prose close |
| `FT_TURN_TIMEOUT_MS` | sized for the worst case | **per-turn** budget covering up to `FT_MAX_TOOL_STEPS` Sonnet passes **+** the nested Haiku DC calls, serially: target ≈ `FT_MAX_TOOL_STEPS × p95(Sonnet stream) + (#checks) × p95(Haiku DC)`. One `abortSignal` for the whole loop in MYT-68 (per-step abort would need a fresh signal per iteration — a wrapper change deferred). At `TURN_CONCURRENCY=5`/worker, too-generous a budget pins slots under a Sonnet slowdown — tune against the smoke. |
| `SKILL_CHECK_MODEL` | `HAIKU` | the DC-table tier |

## 7. Ports + the multiplayer prompt rewrite (validated in mythrun-v5; rewritten against production)

| Asset | → production location |
|---|---|
| `ft-system.txt` | `src/llm/prompts/session/ft-system.txt` — a **multiplayer rewrite**, not a verbatim port (see below) |
| `skill-check.txt` | `src/llm/prompts/session/skill-check.txt` |
| `SkillCheckResultSchema` | `src/llm/schemas/skill-check.ts` |
| dice engine | `src/session/dice/engine.ts` |
| `SKILL_ABILITIES` map | with the skill-check resolver |

**`ft-system.txt` is a rewrite, not a port.** The prototype prompt is single-player (`{{character_name}}` singular, `{{ft_context}}` prep slice, `{{npc_seeds}}`, a "Strong Start" opening, `[STAGE]…[/STAGE]`). The production prompt:
- **The FT's grounding = `{{ft_context}}` (curated canon, §3.10) + the full `{{transcript}}`/`ftHistory` (verbatim session history, §3.2).** Not a summary. The prototype's single-player `{{ft_context}}` becomes the production `session_preps.ft_context` doc; the conversation is the complete `ft_history`.
- **Var contract (maps to `FtTurnContext`):** `ftContext` (the curated world/party/situation prep doc — the stable grounding), the participant roster + attribution (character name → speaking player), and the tool protocol ("call `roll_skill_check`/`roll_dice`, then narrate the returned constraint; never decide an outcome yourself; never roll yourself"). It encodes Principle #1 (never reveal what the character can't know) and the error-constraint handling (§5). The conversation transcript rides in the `messages` array, not a template var.
- **`runningSummary` is the ST's tool, NOT the FT's memory — the FT never reads it.** The FT holds the full transcript (§3.2). The 1–5KB running summary is only (a) the **ST's** input (overview §1092 — the ST works from the summary + recent exchanges + `sd_playbook`, not necessarily the whole transcript) and (b) the **Scribe's** session-end input (runtime §538). It plays **no role in FT recovery** — that band-aid (runtime §524, "the summary provides continuity" when `ft_history` is evicted) predates durable transcript persistence and is superseded by §3.7's rebuild-or-crash contract. With curated canon (`ft_context`) + verbatim history in context, there is no compression for the FT to hallucinate around (`project_session_prep_confab_failure_mode`). **No compaction ever** — the context cap bounds the session (§3.11).
- **Direction + attribution format reconciliation:** the shipped controller fuses `[DM direction: …]` (appended to the last trigger). Align the prompt to that delimiter **and** to the controller's actual attribution rendering (`characterName` per message — not the prototype's `Arin (Player 1):` form). One source of truth = the shipped controller. (Latent in MYT-68: ST is stubbed, so the direction channel emits nothing until MYT-69; smoke re-validates the pairing then.)

## 8. Non-negotiables check

- **Enforced ignorance (#1) — scoped precisely:**
  - **Context channel:** the FT input is `FtTurnContext` (public-by-construction; secrets have nowhere to live — verified, `tiers/types.ts`). The one new field, `ftContext` (§3.10), is the **FT-safe slice by construction** — the prep stage authors `ft_context` and `sd_playbook` as two separate fields, secrets confined to `sd_playbook` (which MYT-68 never loads). The transcript persisted to `session_messages` (§3.7) is the player-facing prose + public roll events — public by definition. MYT-68 adds **no** secret-bearing field. ✓
  - **Direction channel:** the fused `[DM direction: …]` carries ST output verbatim. Its safety (the ST must not emit secrets; runtime §17.4's vetted-relay + the "Haiku leak-check" it cites as "§8.2" — **a dangling reference; runtime §8 has no such subsection**) is **MYT-69's responsibility**, not MYT-68's. This issue freezes the FT-side consumption format but does not own the direction's content bound; the §8 ✓ above is scoped to the context channel. (Filed note: fix the dangling §8.2 reference in the runtime spec when MYT-69 defines the leak-check.)
- **ZFC (#2):** the loop is *mechanical orchestration* (the SDK's deterministic tool loop is plumbing, like BullMQ — not delegated reasoning); the FT *prose* is the model's job; the dice + skill math + tier-matching + roster name-match (closed-set exact match) are deterministic code; the DC-table judgment is delegated to Haiku. No heuristics/keyword-routing/fuzzy-matching. ✓
- **LLM never rolls (#4):** all rolls in `dice/engine.ts` via `crypto.randomInt`; the FT calls the tool. ✓
- **Skill-check DC tables (#5):** Haiku pre-generates DC + 3 outcomes → roll → matched tier injected as a constraint → the FT writes prose informed by it (even on the fail-soft fallback). ✓
- **Prose quality is the product (#7):** Sonnet FT, the voice-validated prompt rewritten for multiplayer, sensory/distinct-NPC prompting. ✓

## 9. Scope / deferred

**In:** the SDK tool loop + the `streamTextWithTools` wrapper; the cap; the FastThinker impl (full-transcript grounding, §3.2); the extensible tool registry + `roll_dice` + `roll_skill_check` (+ the dice engine + the DC-table + the participant-roster resolver); **`ft_context` wiring** (§3.10 — load `session_preps.ft_context` into `FtTurnContext`, cache in `:state`); **DM-output transcript persistence** (§3.7 — DM prose + roll events to `session_messages`, idempotent on `turnId`, reconnect-replayed); the seam widening (`TurnEmitter`, Mythrun-owned multi-part `ConversationMessage`, multi-part `ftHistory` persistence + checkpoint version bump); the `skill_check`/`dice_roll` contract frames; the error model (§5); sliding prompt caching (anchored on `ft_context`); the multiplayer prompt rewrite.

**Deferred:** `cast_spell`/`spend_resource` + the live character ledger (MYT-70); `initiate_combat`/`resolve_combat_round` (MYT-75); `world_fact_lookup` (ST-gated, MYT-72). Real ST `direction` + the direction-channel leak-check (MYT-69). The **graceful session-end wind-down** (the ST's 90%-budget wind-down instruction, §3.11 — ST stubbed here → MYT-69) + session-end orchestration + the Scribe's end-of-session reconciliation (a session-end issue). MYT-68 holds the full transcript + accumulates usage but does not own the wind-down decision. The full §12 server-assigned **global-sequence** model + the §17.7 lookback **search** surface (a dedicated transcript/seq issue — MYT-68 ships durable, queryable, `created_at`-ordered transcripts, not the global-seq model). `roll_complete` + server-synchronized roll gating + the roll-animation frontend (Frontend milestone).

## 10. Testing

- **Unit (mock the `'ai'` SDK boundary** — `vi.mock('ai')`, per the repo convention; NOT the `ai.ts` wrapper): the FT loop over scripted `fullStream` parts (text-delta + tool-call + tool-result + **error**); assert an `error` part throws (not a silent `turn_end`); the cap **boundary** (second-to-last step may tool-call, last step gated to prose via `prepareStep`); the serial-emit ordering (skill_check/dice_roll emitted+awaited before the dependent text_delta); the multi-part assistant persistence round-trips through the Mythrun-owned shape.
- **Dice engine:** deterministic with an injected RNG; the modifier math, the kept-roll for advantage/disadvantage, `advantage && disadvantage → normal`, the bound on `count`, and the tier-matching boundaries (great/success/fail).
- **Skill-check resolver:** mocked Haiku DC table + a fake participant character → assert the modifier **including a dedicated expertise case** (`expertise → 2×PB`), the roll, the matched tier, the constraint, the emitted frame; the fail-soft fallback (DC-table failure/abort, unknown character, ambiguous character, unknown skill) each returns an error/neutral constraint and **never throws**; the abort threads into the Haiku call.
- **Contract:** the new server frames' shapes; `roll_complete` is *not* in the live client allowlist.
- **Real-Anthropic E2E smoke (required, wire-level):** drive a turn (via the dev `fire-turn` poke against a real session) and assert the FT streams real Sonnet prose, calls `roll_skill_check` (the `skill_check` frame appears **before** the outcome narration, and the narration reflects the outcome tier), `roll_dice` works, and — explicitly — that the multi-step loop composes with `logAndNormalizeMiddleware` (per-step `llm.call` logs, no spurious truncation error) and the cap boundary holds. Real Sonnet + real Haiku, SSE/log + DB inspection. (No new REST route; the dev-tool gate skips.)

## 11. File-level change map (informs the plan)

**New:**
- `src/llm/ai.ts` — add `streamTextWithTools` (modify).
- `src/session/tiers/fast-thinker.ts` — the real FastThinker.
- `src/session/tiers/ft-tools.ts` — the tool registry + `roll_dice` + `roll_skill_check` tool defs.
- `src/session/skill-check.ts` — the resolver (roster resolution + per-skill modifier + DC table + roll + tier).
- `src/session/dice/engine.ts` — deterministic dice (ported).
- `src/llm/schemas/skill-check.ts` — `SkillCheckResultSchema` (ported).
- `src/llm/prompts/session/ft-system.txt` (multiplayer rewrite) + `skill-check.txt` (ported).

**Modified:**
- `src/session/tiers/types.ts` — widen `TurnEmit` → `TurnEmitter`; `ConversationMessage.content` → Mythrun-owned multi-part (versioned); add `FtTurnContext.ftContext: string` (§3.10); `FastThinker.render` signature.
- `src/session/turn-publisher.ts` — `skillCheck`/`diceRoll` + `emitFor` returns the `TurnEmitter`.
- `src/contract/session-events.ts` — `skill_check`/`dice_roll` server frames.
- `src/session/session-controller.ts` — wire the real FT (it already calls `ft.render`); thread `ftContext` through `buildContext()`; multi-part `appendAssistant`; the emitter; the "emitted-anything" latch (§5); persist the completed DM turn's prose + roll events to `session_messages` on success (§3.7).
- `src/session/turn-worker.ts` — `makeTiers` returns the real `FastThinker` (Sonnet); the terminal-after-first-frame retry posture (§5).
- `src/redis/session-state.ts` — `flushTurnState` persists multi-part `ftHistory`; `:state` blob carries `ftContext` (§3.10); checkpoint envelope version bump.
- the session-start / `:state`-build path (MYT-65) — load `repo.sessionPreps.getBy(campaignId, sessionNumber).ftContext` into the `:state` blob (fail-soft if absent).
- `src/repo/session-messages.ts` (or equivalent) — append DM-prose + roll-event transcript rows (new kinds); `buildReconnectFrame` replays them (§3.7).
- `src/repo/characters.ts` — a participant-scoped `(campaignId, character_name)` resolution via the `campaign_characters` join (+ ability scores + `character_skills.proficiency_level`).
- `src/repo/session-preps.ts` — read path `getBy(campaignId, sessionNumber)` already exists (returns `ftContext`/`sdPlaybook`); no change unless the session-start load needs a narrower projection.

## 12. Open questions / resolved decisions

**Resolved:** FT model = Sonnet (config-swappable). Loop = SDK auto-loop (every requirement verified, incl. middleware multi-step composition). Tool scope = loop + `roll_dice` + `roll_skill_check` + extensible registry. Roll gating = client-side (server-synced deferred). Character resolution = participant-roster exact match (not free-text DB key). Expertise = per-skill `proficiency_level` (diverges from prototype). Retry = terminal-after-first-frame. Multi-part `ConversationMessage` = Mythrun-owned versioned shape. Caching = sliding breakpoint.

**Scope decisions resolved at the user gate (2026-06-09):**
1. **DM-output transcript persistence — PULLED IN** (§3.7). Holistic eval needs full transcripts before the frontend exists, so MYT-68 persists DM prose + roll events to `session_messages` (queryable + reconnect-replayed). The full §12 global-sequence model stays deferred.
2. **FT memory = full transcript + curated `ft_context`, NOT a running summary** (§3.2, §3.10). The FT holds the entire `ft_history` in context every turn (the architecture already intends this — it was a mischaracterization in the gate question, not a design flaw) **and** consumes `session_preps.ft_context` (the purpose-built FT-safe prep doc that MYT-66 left unloaded). The running summary is demoted to a secondary continuity fallback. This removes the lossy-summary confabulation surface at the root.

**Plan-time detail:** the exact Mythrun multi-part `ConversationMessage` schema; the `FT_TURN_TIMEOUT_MS` value (set against the smoke); the `ft_context` load hook (session-start vs. lazy); the `session_messages` transcript-row kinds + ordering column.

## 13. Blind review round 1 (Ocean) — applied revisions

4 reviewers (LLM-orchestration / enforced-ignorance+ZFC / game-mechanics / concurrency+streaming+persistence). **0 showstoppers** under the strict rubric — all four affirmed the core architecture (SDK loop as plumbing, constraint-injection, type-level enforced ignorance, deterministic dice, Haiku DC-table). Every Critical fired on an error/retry path, was a doc/framing error, or was an unverified hypothesis the smoke catches. Substantive findings folded into the spec (they change interfaces, so pinned at design time):

- **Error model rewritten to SDK reality** (§3.2 step 5, §5): `fullStream` error parts must propagate (not silently complete); resolvers must be total (tool-execute throw → `tool-error` continues the loop); terminal-after-first-frame retry posture (no divergent re-stream under one turnId); fail-soft enumeration expanded (DC failure/abort, unknown/ambiguous character, unknown skill, dice OOR).
- **Character resolution** (§3.5 step 1, §3.3): resolve the roller from the participant roster (closed-set exact match, ZFC-clean), not a free-text DB key on a dropped `campaign_id` column; ambiguous/no-match → fail-soft.
- **Expertise math** (§3.5 step 2): read per-skill `proficiency_level` (`expertise → 2×PB`); explicit DIVERGES-FROM-PROTOTYPE warning + a required expertise test.
- **Dice hardening** (§3.3, §3.4, §3.5 step 4): bound `roll_dice` inputs in code; kept-roll for adv/dis; `advantage && disadvantage → normal`; no nat-1/20 auto-crit on ability checks.
- **Middleware multi-step composition** (§2, §10): verified `logAndNormalizeMiddleware` wraps each `doStream`/step independently and each step emits a `finish` part → no spurious truncation; per-step cost + `mythrun` bindings flow; re-asserted in the smoke.
- **Cap precision** (§3.6): N−1 tool-calling steps + 1 forced prose close; smoke asserts the boundary.
- **Caching** (§3.9): sliding ephemeral breakpoint (per prototype), not static-prefix-only.
- **Durable shape** (§3.7): Mythrun-owned versioned multi-part `ConversationMessage`, not raw SDK `ModelMessage`; checkpoint envelope version bump.
- **Contract hygiene** (§3.8): `roll_complete` NOT added to the live allowlist (no handler); `classifyClientFrame` (not `parseClientFrame`); the client-side-gating decision marked as an explicit §10 amendment with the per-client-reveal tradeoff stated.
- **Timeout** (§6): per-turn budget sized for the whole loop + nested Haiku calls; abort threaded into the Haiku resolver call.
- **Enforced-ignorance scoping** (§8): the ✓ scoped to the context channel; the direction-channel bound (+ the dangling runtime §8.2 leak-check ref) is MYT-69's.
- **Prompt** (§7): `ft-system.txt` is a multiplayer rewrite with an explicit var contract, not a verbatim port; attribution-format reconciled.
- **Transcript gap corrected** (§3.7, §12): the draft's "transcript stays as-is (prose + roll events)" was false — it holds neither; corrected + surfaced as a scope decision.

**User-gate resolutions (2026-06-09), folded in:**
- **`ft_context` wired** (§3.10, §3.2, §7): the FT now consumes `session_preps.ft_context` — the purpose-built, enforced-ignorance-safe prep doc MYT-66 left unloaded. It's the FT's curated grounding + the prompt-cache anchor.
- **Full-transcript memory affirmed + no compaction** (§3.2, §3.11, §7): the FT holds the entire `ft_history` in context every turn (no summary, no window, **no compaction ever**). The FT context is a **hard cap that bounds session length** — as the transcript fills, the ST issues a graceful wind-down (runtime §14/§546; "no hard cutoff mid-response") and the session ends; continuity is the Scribe's session-end reconciliation + the next session's `ft_context`, not in-session summarization. The `runningSummary` is the **ST's** tool + Scribe input — **not the FT's memory, not a pressure-relief valve, and not an FT recovery fallback.** (My gate-question phrasing — "running summary + recent history" — and follow-ups "far-out scale ceiling / summary is the eventual pressure relief" and "summary as the FT's crash fallback" were all wrong.)
- **Recovery = rebuild-or-crash, never degrade** (§3.7): `session_messages` is the durable source of truth, `ft_history` a rebuildable cache; an evicted `ft_history` rebuilds from the transcript, and a missing/incoherent durable transcript is a fatal persistence failure (crash loud), not a summary-band-aid. Supersedes runtime §524.
- **DM-output transcript persistence pulled in** (§3.7): DM prose + roll events → `session_messages`, for holistic eval before the frontend exists.
