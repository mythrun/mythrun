# MYT-69 — SlowThinker: the post-hoc narrative director

> **Status:** Design — approved in brainstorm 2026-06-10. Pending blind review + user gate.
> **Issue:** MYT-69 (Session Runtime + Combat L1, 5th issue). Runs in parallel with MYT-70.
> **Builds on:** MYT-68's shipped seams — the `[DM direction: …]` fusion (in-memory, never persisted), `StEvaluation`, the trigger classification on `TurnJobPayload`, usage accumulation, `session_preps.sd_playbook` (the secret-bearing prep doc, loaded nowhere yet), the post-turn phase of the turn worker (re-mature precedent).
> **Spec refs:** Multiplayer Session Runtime §8, §17.4. **This spec DEFINES the direction-channel bound that the runtime spec's dangling "§8.2" reference points at** (flagged in MYT-68's blind review; the runtime spec should gain a pointer here).
> **Prototype:** `st-evaluation.txt` + `slow-thinker.ts` in mythrun-v5 are the validated single-player baseline (the four session-level monitors, "most turns: no", 1–2-sentence what-not-how directions). Ported as a multiplayer rewrite.

---

## 1. Goal

Replace the `StubSlowThinker` with the real narrative director (Opus): it watches completed turns from **off the hot path**, decides when the scene needs direction, and injects leak-safe stage directions the FastThinker consumes on its next turn. It owns the running summary and issues the session wind-down signal.

**The product thesis this issue makes real (added at brainstorm):** every other AI DM plays NPCs as walking plot dispensers — no small talk, no strangers treated like strangers, every conversation a quest hook. The FT/ST split is the *mechanism* for authentic NPCs: **the FT cannot plot-dump what it does not know.** From the FT's seat, the merchant genuinely has nothing to offer a stranger but weather and prices — so it plays small talk in full, and trust builds the way it does at a real table. The ST holds the secrets *and the social clock*: it watches rapport build and decides when a conversation has **earned** a reveal, portioning out exactly what the NPC entrusts. Enforced ignorance is not just the safety boundary; it is the authenticity engine.

**Done when:** a turn whose state matches an `sd_playbook` trigger (or trips a craft monitor) produces a pending direction that the NEXT DM turn fuses and the FT's prose visibly follows — with zero added latency on any player-visible turn, and no secret content ever crossing into the FT.

## 2. Architecture — post-hoc, gated, asynchronous (a deliberate amendment to runtime §6/§8)

The runtime spec ran the ST **before** the FT on evaluated turns, blocking the player-visible stream behind an Opus call. This design moves the ST **after** the turn, into a background pipeline:

```
DM turn N completes (turn worker post-turn phase)
  └─ enqueue st-evaluation job  (per-campaign debounce dedup {id, replace} — NO ttl)
       st-evaluation worker:
         1. DETERMINISTIC POLICY (code, not AI):
              turns-since-last-ST ≥ ST_EVAL_FLOOR_TURNS → evaluate (skip the gate)
              usage ≥ WIND_DOWN_FRACTION × SESSION_TOKEN_BUDGET → evaluate, wind-down mode
         2. else HAIKU GATE: "does the director need to step in?" → no → exit
         3. OPUS ST EVALUATION (sd_playbook + summary + recent slice incl. the FT's response)
         4. write outputs: pending direction slot (one-shot and/or standing) + summary + usage
DM turn N+1 (controller):
  take-and-clear the one-shot → fuse onto the last user message (the EXISTING MYT-68 seam)
  read the standing directive → append as an ephemeral tail message (see §6)
```

**Why post-hoc beats the spec'd pre-FT flow** (decided at brainstorm):
- The ST's monitors are **retrospective by nature** — tonal monotony, pacing stalls, NPC-only revelations, missing agency all judge what has been happening. Post-hoc, the ST also sees what the FT *actually wrote*, which the pre-FT ST never could.
- Player-visible latency goes to zero permanently: time-to-first-token is purely FT, every turn.
- The accepted trade: **interventions land one turn late.** Fine for narrative nudges (they are session-level and age well). The two cases that need in-turn ST judgment are out of this path by construction: the §17.4 lookup relay runs *inside* the `world_fact_lookup` resolver (MYT-72), and the secret tripwire is the Scribe's (MYT-73).

**Queue discipline (BOTH MYT-68 dedup lessons applied — the first draft applied only one; round-1 review caught the sibling):** the producer is the turn worker's post-turn phase, **gated on the flushed-success path only** (a failed/lock-lost/converge run has no fresh FT response to evaluate), own try/catch — an enqueue hiccup never masks the turn outcome. Dedup `{ id: 'st-eval:<campaignId>' }`, **no ttl** (a ttl'd key outlives the job and swallows re-adds — `reference_bullmq_dedup_ttl_swallows_readds`); note `replace` is inert here (the job carries no delay, so it never sits in the delayed state). Adds while the job is WAITING collapse losslessly (the job reads current state at run time). Adds while the job is ACTIVE (gate + Opus, up to ~2.5 min) are SWALLOWED — so the job ends with a **self-re-arm**: snapshot the responded watermark at job start; at job end, if newer turns landed, `removeDeduplicationKey(ownId)` + re-add (the exact `dm-trigger-worker` self-re-arm pattern). The producer side must NEVER remove the key (removing it under a waiting job would double-run) — **single-flight-per-campaign is an explicit invariant**, not a dedup accident. Residual honesty: the evaluation can lag the table by up to one job duration; "latest wins" on the slot covers the quality side. The job payload is `{campaignId, sessionId}` only.

## 3. The Haiku gate

One cheap classified judgment per completed turn: **should we spend the Opus call?**

- **Input (the gate may hold secrets freely — it is ST-side infrastructure whose output is consumed by code only):** the **full `sd_playbook`** (no code-side trigger extraction — that would be ZFC-violating string intelligence), the running summary, and the last `ST_GATE_EXCHANGE_WINDOW` exchanges including the FT's latest response. (The dm-trigger `classification` was dropped from this list at review: it rides only the turn-job payload, is persisted nowhere the st-eval job can read, and is ill-defined under job collapse.)
- **Output:** `{ needed: boolean, confidence: number, reason: string }` via `generateObject` on `HAIKU` (repair `'haiku-then-sonnet'`). **The rule, stated in the skip direction (the only direction that matters): skip IFF `!needed && confidence ≥ ST_GATE_CONFIDENCE_FLOOR`.** Everything else evaluates (fail-toward-oversight).
- **The gate's fire conditions include the bookkeeping case:** "small talk with a playbook-relevant NPC is in progress" is evaluate-WORTHY even though the ST will likely stay out — gate-fires ≠ intervene. A pass-through evaluation still rewrites the summary, which is how rapport built during small talk enters the ST's memory at all (review finding: without this, the social clock is starved by its own cost gate, since skipped turns never reach the summary and the recent-exchange window slides past them).
- `ST_GATE_CONFIDENCE_FLOOR` is an **empirical knob**, not a settled default — Haiku confidence calibration is poor; the §13 smoke measures the skip rate and intervention rate over a real session.
- **GATE INDEPENDENCE (hard rule, decided at brainstorm):** the gate's verdict/reason is **never fed to the ST**. The gate decides only whether the Opus call happens; the ST independently decides whether to intervene, and its prompt states that the decision is its own ("most turns: no" stays). A wrong gate must not bias the judge.
- Gate failure → skip this cycle, log; the floor guarantees eventual oversight. Never retries into the hot path (there is no hot path here).

The deterministic policy arms (floor, wind-down threshold) are **code around the gate**, not prompt content — mechanical policy, ZFC-exempt.

## 4. The ST evaluation (Opus)

**Context (the spec'd slice — decided over full-transcript at brainstorm; the summary is the ST's own compression, so its Opus cost stays bounded regardless of session length):**
- `sd_playbook` (secret-inclusive prep doc — a **per-evaluation PG read** via the st-worker's OWN narrow repo interface; deliberately NOT parked on the `:state` blob, which the FT-side hot path reads, and NOT a widening of `TurnWorkerRepo`, whose `sessionPreps` surface is intentionally `{ftContext}`-only),
- the running summary (its own artifact),
- **the current standing directive and any unconsumed one-shot** (review finding: without these the ST manages its own slots blind — it would `keep` a standing text it can no longer remember and clobber pending reveals unknowingly),
- the last `ST_EVAL_EXCHANGE_WINDOW` exchanges from the transcript (player + DM, via `listFtContextRows(sessionId, respondedSeq)` — the watermark read is pinned; the millisecond persist→watermark window can yield a one-turn-early DM row, accepted as quality-neutral),
- the PC roster with class/background (a NEW repo read — `listSessionParticipantCharacters` returns `{userId, name}` only today; extend or add a sibling),
- wind-down mode flag when the policy arm fired.

The context assembly is an **extensible world-state block** — roster + summary + slice today; the in-world clock + event schedule slot in here when MYT-77 lands (a seam, not speculative code).

**The summary is a REWRITE, not an append (review finding — the load-bearing fix of this round):** the prototype's append rule corrupts under the new mandate. Rapport, ladder state, and time are *mutable state*; appended deltas accumulate contradictions ("Hobb is curt" + "Hobb is warm") with no current-value semantics, and an ever-growing summary rides every gate call, unbounding the cost §4 claims is bounded. The ST returns the **full replacement summary** each evaluation (the prompt instructs a target length, ~150–300 words; the old summary is in context to rewrite from).

**The summary's content mandate** (what the rewrite tracks): character arcs and positions, **NPC rapport/trust levels** ("the party has been drinking with Hobb; he's gone from curt to chatty" — what lets the ST judge an earned reveal across evaluations), **in-progress reveal-ladder state** ("Insight passed, Hobb ladder open" — and the rule: **confirm a directed reveal actually appears in the transcript before advancing a ladder**; an overwritten or lost direction must not leave the summary believing a rung landed), and **coarse time progression** ("evening falls over Saltgate" — the interim time carrier until MYT-77's structured clock).

**Output schema (the STRUCTURAL SPLIT — this is the §8.2 leak bound):**

```ts
StDirectorResultSchema = z.object({
  // PRIVATE: the ST's secret-aware reasoning. Logged server-side only;
  // NEVER crosses into any FT-facing artifact. Forcing the reasoning into
  // its own field is what keeps ride-along leaks out of the direction text.
  reasoning: z.string().min(1),
  intervene: z.boolean(),
  // PUBLIC-FACING: the one-shot stage direction (1-2 sentences; what-not-how).
  // Crosses into the FT via the fusion seam.
  direction: z.string().min(1).nullable(),
  // PUBLIC-FACING: the standing-directive op. A discriminated shape, NOT an
  // ''/null trichotomy (review finding: models confuse empty-vs-null, and an
  // accidental '' would silently clear an active wind-down directive).
  standingDirective: z.object({
    action: z.enum(['set', 'clear', 'keep']),
    text: z.string().nullable(), // required for 'set'; null otherwise (validated in code)
  }),
  // The FULL replacement summary (rewrite semantics — see the mandate above).
  summaryUpdate: z.string().min(1),
})
```

**The direction-channel bound (defining the dangling runtime-§8.2):** the channel is gated **structurally + by prompt contract, with NO independent checker** (decided at brainstorm). The split `reasoning`/`direction` fields kill the dominant leak mode (secret rationale riding along in the direction text). The contract, stated precisely (sharpened during the reveal-ladder discussion): **directions carry behavior plus ST-SANCTIONED reveal content — bounded to exactly what the ST decided the NPC may surface — never unsanctioned secret rationale.** An earned reveal ("on a successful Persuasion he shares that he saw the bargehand try the lock — nothing more") IS information crossing the channel, and that is sanctioned by design: the ST is the single gate, and the reveal text is the gate's output. The *why* stays in the private `reasoning` field. The seam for an independent leak-check (a classifier over `direction` against the prep's core secrets) is documented here deliberately and NOT built; MYT-72's vetted-information-relay mode — the same sanctioning pattern applied to lookups — is the natural point to revisit. Rationale: interventions are rare, subtle inferential leaks evade any checker, and the structural split removes the blatant mode at zero cost.

**Repair posture (review finding — the repair chain punctures the single-gate argument):** `generateObject`'s repair path hands the malformed tree, secret-bearing `reasoning` included, to Haiku/Sonnet with license to fix it — a repaired `direction` is text the ST did not author crossing the boundary. Pin: **if `repairAttempted === true`, discard the entire result** (no direction, no standing change, no summary write — skip the cycle; §10 already tolerates a skipped cycle). No `.refine` cross-field constraints on this schema for the same reason. Set `maxOutputTokens` explicitly (reasoning + direction + a full summary rewrite is long; the SDK default truncates).

**The prompt (`st-evaluation.txt`, multiplayer rewrite of the validated prototype):** keeps the four session-level monitors (tonal monotony, pacing stalls, NPC-only revelations, missing agency), "most turns do NOT warrant intervention", 1–2-sentence what-not-how directions; adds the multiplayer batch framing + PC roster, the seven direction classes (§5) with one example each, the trust-pacing frame (playbook secrets are entrusted, not dispensed; healthy small talk is a reason to stay OUT), the check-gating craft rule (never gate critical-path progression behind a check), the standing-directive semantics, the wind-down mode instruction, the summary content mandate, and the channel rules: *directions carry behavior and sanctioned reveal content only — your reasoning field is where secret-aware thinking lives; never put a secret in a direction you have not deliberately decided the NPC surfaces; **scope bounds are phrased behaviorally without naming the protected content** ("he's said all he'll say; he deflects further pressing to Vane" — never "nothing about the ledger", which itself tells the FT a ledger exists); **a direction is an opportunity, not an order** — written one turn ago; if the scene has moved against it, the FT should let it go (this conditionality also goes in the ft-system amendment); when multiple classes fire at once, ONE one-shot — reveals outrank craft nudges — and the standing slot holds ONE composed text the ST rewrites whole each time (wind-down + any live boundary folded together); prefer directions any present character can carry (a reveal aimed at an absent player stalls).* Plain direction text — **emit plain prose and never copy `[STAGE]` markup from the playbook** (the playbook's examples are saturated with it; the controller adds the `[DM direction: …]` wrapper at fusion).

**A checkability note (stated plainly, per review):** once directions legitimately carry sanctioned reveals, "leak" is no longer detectable from the direction text alone — sanctioned vs unsanctioned is defined by the ST's intent, which lives in the unobservable `reasoning` field. Any future checker (the MYT-72 revisit) can verify *form* (behavioral phrasing, no verbatim secret strings) but not *sanction*. Prompt hygiene + the E2E secret-string grep are the realistic enforcement for this channel, permanently.

## 5. Direction classes (the prompt's taxonomy — enumerated at brainstorm)

| Class | Trigger | Form |
|---|---|---|
| **A. Earned reveals (trust pacing)** | a conversation with a secret-adjacent NPC has warmed to where a reveal is earned (rapport tracked in the summary) | a GRADED sanctioned reveal with BEHAVIORAL bounds: "Hobb's warmed to them — he can mention he saw the bargehand poking around the east walkway; beyond that he's said all he'll say." Playbook secrets are **entrusted, not dispensed**; the ST decides the moment and the portion. (The bound never names withheld content — see §4's channel rules.) |
| **B. Check-gated reveal ladders** | useful-but-optional information a standard D&D check flow should gate | a STAGED sequence across evaluations: direct the tell ("Hobb seems to hold something back — if a player reads him, allow Insight"); the check rides MYT-68's `roll_skill_check`; the pass lands in the transcript; the NEXT evaluation directs the rung ("he can be pressed; a successful Persuasion gets the lock story — nothing more"). The summary carries ladder state ("Insight passed, Hobb ladder in progress"). **Craft rule (both ST + prep prompts): never gate critical-path progression behind a check** — if failure would stall the planned beats, give it freely or route it another way; gate optional/corroborating clues, and let failure mean the information arrives by another road. Prompting only — no workflow machinery. |
| **C. Playbook beats** | table state matches an `sd_playbook` trigger condition (later incl. clock/schedule triggers — MYT-77) | behavioral event, secret-free: "Have the bargehand cross their path again — visibly. Don't explain him." |
| **D. Craft interventions** | the four monitors | a craft nudge (how, not what): "Three exchanges of dread — inject something mundane and warm." The inverse holds too: **healthy small talk is a reason to stay out** — organic conversation going well is not a pacing stall. |
| **E. Secret-integrity steering** | conversation drifting toward territory where the blind FT would confabulate against a secret | a boundary + redirect phrased WITHOUT naming the protected content: "Hobb has nothing more to offer on warehouse business; he deflects anything further to Vane." Knowledge boundaries that must HOLD across a scene are **standing-shaped** — fold them into the composed standing text, not a one-shot whose effect evaporates next turn. Prevention; MYT-73's retcon is the cure. |
| **F. Grounding step-ins** | ungrounded RP / the proactive yank-back | event injection: "Ring the fog bell — the harbor reacts." HONEST COUPLING (review-corrected): player-only chat produces no DM turns, hence no evaluations — when the dm-trigger's proactive step-in fires, the slot is usually EMPTY and the FT improvises the intrusion itself; the ST refines on the following beat. A pending direction enriches a step-in when one happens to exist; the table does not promise one. |
| **G. Wind-down** | the ≥`WIND_DOWN_FRACTION` budget policy arm | a STANDING directive: "Steer toward a natural close: resolve the current scene, open no new threads or NPCs." |

Out of scope: spotlight/time balancing (MYT-76); the world clock + scheduled events (MYT-77 — class C's trigger set and the §4 world-state block are the ready seams). Future classes riding this channel: the vetted-information relay (MYT-72) and retcon delivery (MYT-73) — the two-shape slot accommodates both.

## 6. The pending-direction slot + consumption mechanics

Trigger-state (Redis, campaign-scoped) gains a two-field slot:

- **`oneShot`** — written by the ST (latest wins: a newer evaluation overwrites an unconsumed direction; the ST sees the pending value in its context, so the overwrite is informed, not blind); **taken-and-cleared atomically (GETDEL) ONLY on the fresh-run arm of the turn worker's §5 decision order** — after lock acquisition and after the converge/latch early exits (a take before those would burn a sanctioned reveal on a turn that never renders, and a take by a contention loser would starve the lock holder). Passed into the controller, fused onto the last user message via the **unchanged MYT-68 fusion seam**, and **fusion runs BEFORE the standing tail is appended** (the fuser targets the last user message; appending first would fuse onto the ephemeral tail). Known accepted costs: one prompt-cache prefix re-write per consumed intervention (the MYT-68 §3.9 caveat), and a two-turn-stale consumption when the next turn starts before the job writes (latest-wins helps only if another evaluation runs first — directions are written as opportunities, per §4, precisely so a stale one degrades to a no-op).
- **`standing`** — written/replaced/cleared by the ST (one composed text; the ST rewrites it whole each time, wind-down + live boundaries folded together); **read (not cleared)** every DM turn and appended as a **raw `ModelMessage` at the FT boundary, AFTER `buildModelMessages` places the cache breakpoints** (`[DM direction: …]`-wrapped, never persisted, never pushed into `ftHistory` — that would shift the sliding-breakpoint index and render through the codec's attribution as a phantom "Player"). Tail placement is load-bearing: a persisted-position fusion would diverge reconstruction from the live render on EVERY turn and destroy the cache prefix for the rest of the session; the raw tail rides in the always-uncached zone past the last breakpoint. The ft-system DM Direction Protocol amendment covers the standalone-message form (today it only describes the fused suffix form).
- Both carry the session-state TTL. A dead-air (empty-batch) turn consuming a one-shot fuses onto the last already-answered user message — semantically "apply this nudge now" (the MYT-68 fusion-skip warn arm stays for the truly-no-user-message edge).

The controller's `processDmTurn` no longer calls `st.evaluate` — the `SlowThinker` tier seam leaves the turn path; `StubSlowThinker` retires from production wiring (kept for tests if useful). The directions arrive as worker-resolved deps (`pendingDirection?`, `standingDirective?`), mirroring `ftContext`.

## 7. Summary ownership moves to the ST job

The running summary is the ST's artifact: the st-evaluation job writes the `:summary` key directly after each evaluation (plain SET; the job is the only writer). `flushTurnState` shrinks to **usage-only**; the controller's `applyEvaluation`/summary code is deleted. This removes the background-write-vs-turn-flush clobber race outright. The summary remains: the ST's own context compression, the Scribe's session-end input (MYT-73), and nothing the FT ever reads.

Usage accounting (review-forced — the choice is not open): the ST job writes its gate + evaluation usage to a **dedicated `:usage:st` key** (atomic INCRBY), summed with `:usage` at every read (the wind-down policy arm, and any other session-spend consumer). The Lua/WATCH-on-the-shared-key alternative is STRUCK: the turn worker reads `:usage` at turn start, accumulates in memory across a minutes-long render, and blind-SETs at flush — an ST increment landing in that window is erased no matter how atomically it was written; only the separate-key design satisfies the bidirectional non-clobber requirement. The ST job's `:summary` SET carries the session-state TTL (the turn flush no longer refreshes it; a gate-quiet stretch must not let the ST's memory lapse mid-session), and the `:summary` write also happens only when `repairAttempted === false` (§4's discard rule).

## 8. Wind-down (the MYT-68 §3.11 leftover, in scope)

The policy arm: `(usage + usage:st) ≥ WIND_DOWN_FRACTION × SESSION_TOKEN_BUDGET` → force evaluation with the wind-down flag. **Session-boundary hygiene (review finding — this spec is what makes the stale keys load-bearing):** session start (`routes/sessions.ts`) resets `:usage`, `:usage:st`, `:summary`, both direction slots, and the turns-since-ST counter — without this, a same-campaign session started within the 2h TTL inherits the prior session's usage and standing wind-down directive and is **born dying**. The st-evaluation job additionally checks the session is still active at start (a queued/in-flight job for an ended session no-ops). The ST sets the **standing** wind-down directive (class G) and keeps directing toward closure on subsequent evaluations. The actual `session_end` orchestration (and the FT-context hard cap enforcement) stays with the session-end issue; this is the ST-side signal only. `SESSION_TOKEN_BUDGET` + `WIND_DOWN_FRACTION` (0.9) land in ft-config/st-config.

## 9. Enforced ignorance check

- The gate and the ST hold `sd_playbook` freely — server-side infrastructure; their outputs that cross into the FT are exactly: `direction` and the standing text (behavior-bound by §4's structural split + prompt contract). `reasoning` and the gate verdict are logs only. The summary stays FT-invisible (MYT-68 removed `runningSummary` from `FtTurnContext`).
- **THE PLAYER-FACING SUMMARY LEAK (round-1 showstopper, fixed in scope):** the summary has a second exit the original audit missed — `checkpoint()` folds it into the suspend envelope, the suspend worker persists it to `sessions.st_running_summary`, and `GET /api/sessions/:campaignId/active` returns the FULL mapped Session row — `stRunningSummary` included — to any campaign member. Inert today (the stub summary is empty); the moment the ST writes rapport/ladder/secret-adjacent state, players can read it with one REST call after any suspend. **Fix (this issue): the active-session route returns an explicit response allowlist (id/status/sessionNumber/timestamps — never `stRunningSummary` or any checkpoint material), with a route test pinning the field set.** The deeper landmine — a member-guarded route returning whole repo rows — is noted for the API-hygiene sweep, but the strip itself ships here because this issue arms it.
- **The dm-trigger classifier's summary input is reclassified (review finding):** `dm-trigger-worker` feeds `:summary` to its Haiku classifier under a documented "public table material only" contract. Post-MYT-69 the summary deliberately carries secret-adjacent state, so that contract drifts. Resolution: the classifier is ST-side-adjacent infrastructure — its output (`shouldRespond`/intent/complexity) is consumed by code only and never reaches players or the FT, exactly like the gate — and its contract comments are amended to say so (the §4.4 'public-only' framing becomes 'no output path to a player-facing surface').
- The st-evaluation worker defines its **own narrow repo interface** (sdPlaybook read + the codec window + the roster read) rather than widening `TurnWorkerRepo` — the FT-side worker's dependency surface never gains a secret-bearing read.
- The ST's context assembly happens inside the st-evaluation worker — no secret-bearing field is added to any FT-facing type. The MYT-66 `TurnContext = FtTurnContext & StSecrets` widening is **not needed** under the post-hoc model (the ST no longer consumes the FT's context object at all); note this supersession in tiers/types.ts comments.

## 10. Error handling

Everything is off the hot path; nothing here may ever delay or fail a player-visible turn.
- Producer enqueue failure → own try/catch in the post-turn phase, error-logged (the next turn re-enqueues).
- Gate failure → skip cycle, log; the floor guarantees an evaluation within `ST_EVAL_FLOOR_TURNS`.
- ST evaluation failure → BullMQ retry (transient) / no direction this cycle (terminal), structured log. The repair chain (`generateObject`, `'haiku-then-sonnet'`) handles malformed output.
- Slot write failures → log; the world keeps turning (directions are enhancement, not correctness).
- A consumed direction is gone even if the FT turn then fails terminally — accepted (directions are nudges; the ST will re-evaluate).
- BullMQ-retry idempotency, accepted explicitly: a crash after the slot write → the retry re-evaluates and may re-write (a nudge delivered twice in rare cases); a crash after the usage increment → double-counted ST spend (wind-down fires marginally early). Both harmless; neither needs machinery.

## 11. Config (st-config.ts or ft-config.ts additions)

| Constant | Default | Notes |
|---|---|---|
| `ST_MODEL` | `OPUS` | the architecture's tier assignment |
| `ST_GATE_MODEL` | `HAIKU` | |
| `ST_EVAL_FLOOR_TURNS` | 5 | runtime §8's every-5-turns oversight floor (evaluated = ST ran) |
| `ST_GATE_CONFIDENCE_FLOOR` | 0.8 | only a confident "no" skips |
| `ST_GATE_EXCHANGE_WINDOW` / `ST_EVAL_EXCHANGE_WINDOW` | ~6 / ~10 | recent-slice sizes (plan-time tune) |
| `SESSION_TOKEN_BUDGET` | plan-time | the §3.11 session bound proxy |
| `WIND_DOWN_FRACTION` | 0.9 | |
| `ST_EVAL_TIMEOUT_MS` / `ST_GATE_TIMEOUT_MS` | 120s / 30s | background-tolerant budgets (note: > `WORKER_CLOSE_GRACE_MS` slack — a deploy mid-eval force-closes and the job re-runs after reboot; double Opus spend per deploy-during-eval, accepted) |
| `ST_EVAL_MAX_OUTPUT_TOKENS` | plan-time | reasoning + direction + full summary rewrite — the SDK default truncates |
| `ST_SUMMARY_TARGET_WORDS` | ~150–300 | the rewrite-semantics bound |

## 12. File-level change map

**New:** `src/session/st-evaluation-worker.ts` (the pipeline: policy → gate → evaluate → write); `src/llm/st-gate.ts` + `src/llm/schemas/st-gate.ts` + `prompts/session/st-gate.txt`; `src/llm/st-director.ts` + `src/llm/schemas/st-director.ts` + `prompts/session/st-evaluation.txt` (multiplayer rewrite); `src/session/st-config.ts` (or fold into ft-config).
**Modified (prompt amendments — the FT half of the authenticity dynamic):** `prompts/session/ft-system.txt` gains the NPC-authenticity section (NPCs are normal people; strangers get stranger treatment; small talk is the texture of the world, play it in full; people don't volunteer their troubles to strangers; trust is earned, and what an NPC has to share, the world will tell you when it's time — plus: when a direction indicates a tell, surface it naturally and let the check ride the normal tool flow), **a reconciliation of the check-frequency rule** (genuine no-stakes conversation is NOT "uncertainty" — checks gate attempts to change someone's mind or read what they're hiding, never chatting; without this carve-out the shipped rule forces dice into every third exchange of exactly the small talk the thesis protects), **the social-check depth rule** (§5 class B — success against unknown depths yields demeanor/disposition/plausible public content, never invented hidden plot), **the direction-conditionality rule** (a direction is an opportunity written one turn ago; if the scene moved against it, let it go), and **the standalone standing-direction message form** in the DM Direction Protocol. `prompts/prep/session-prep.txt` gains: the entrusted-secrets trust conditions, critical-path vs corroborating clue marking, and a FIX to the now-stale "wait for a stage direction before revealing specifics" instruction (it presumes the pre-FT ST this spec removes — the post-hoc contract is "narrate what the ft_context supports now; deeper specifics arrive by direction on subsequent beats").
**Modified (runtime spec correction, not just a pointer):** `docs/specs/2026-04-13-multiplayer-session-runtime.md` §17.4's "The Haiku leak-check (§8.2) still bounds it" is now FALSE under the no-checker decision — amend it to cite this spec's structural-split bound and the MYT-72 revisit.
**Modified:** `trigger-state.ts` (the two-field direction slot + the turns-since-ST counter — INCR on the flushed-success path alongside `setRespondedSeq`, reset only when an Opus evaluation actually ran, the reset-vs-INCR race accepted at ±1); `turn-worker.ts` (success-path enqueue; fresh-run-arm-only slot take; controller deps `pendingDirection`/`standingDirective`); `session-controller.ts` (drop `st`/`applyEvaluation`/summary; fuse-then-append ordering); `tiers/fast-thinker.ts` (the raw standing-tail append after breakpoint placement); `tiers/types.ts` (`StEvaluation`/`SlowThinker` retire; supersession notes); `redis/session-state.ts` (`flushTurnState` → usage-only + the checkpoint envelope `kind` bump to fail-loud on the shape change; `:usage:st`; the ST job's summary write); `routes/sessions.ts` (the active-route response ALLOWLIST — the §9 showstopper fix — and the session-start key resets); `dm-trigger-worker.ts` (the summary-input contract comment amendment); `worker.ts` (6th worker: health-server workers array, the shutdown closeWithDeadline list, the queues log, concurrency ~2); repo: the st-worker's own narrow interface (sdPlaybook + codec window + a roster read extended to carry class/background).

## 13. Testing

- **Unit (mock `'ai'`):** gate schema + the only-confident-no-skips routing; ST schema incl. the structural split + standingDirective set/replace/clear arms; the deterministic policy arms (floor, wind-down threshold) as pure code; prompt template var contracts (both prompts).
- **Pipeline (fakes + ioredis-mock):** policy-before-gate ordering; gate verdict never reaches the ST prompt input (assert the evaluate call's prompt lacks it); slot write semantics (latest-wins overwrite, GETDEL take, standing persistence); summary written by the job; usage non-clobber.
- **Turn-path (controller/worker):** one-shot taken ONLY on the fresh-run arm (converge/latch/contention runs leave the slot intact — assert); fuse-before-append ordering (the one-shot lands on the batch tail, never the ephemeral tail); standing appended as a raw boundary message (NOT persisted — assert via `appendDmTurn` capture — and NOT in `ftHistory`); a mismatched-speaker fusion case; dead-air consumption edge; success-path-only enqueue; post-turn enqueue failure isolation; session-start resets all five ST keys; the st-eval job no-ops on an ended session; the job's end-of-run self-re-arm fires when turns landed mid-evaluation; the active-session route returns ONLY the allowlisted fields (the §9 leak pin).
- **Real-Anthropic E2E smoke (wire level):** drive turns until the gate fires (a playbook-trigger scenario seeded in `sd_playbook`); assert the direction lands on turn N+1's prose (visible influence, zero verbatim leak — grep the streamed text against the playbook's secret strings); the floor fires after 5 quiet evaluations; wind-down: seed usage near the budget → the standing directive appears in every subsequent turn's behavior; latency: time-to-first-token on evaluated turns unchanged vs un-evaluated. **The authenticity scenario:** seed an sd_playbook with a trust-gated secret + small-talk with the holder NPC → assert the early turns stay plot-free (no hook-dispensing), rapport appears in the summary (via a pass-through evaluation), and the reveal arrives only after warmth (or a passed check rung) — the signature small-talk dynamic, observed live. **Also measured (not just asserted):** the gate's skip rate and the ST's intervention rate over the session (the floor + confidence knob are empirical), and a player-initiated early Persuasion against the secret-holder → the FT yields demeanor/redirect, not invented plot (the §5 class-B depth rule, live).

## 14. Resolved decisions (brainstorm 2026-06-10)

Post-hoc async ST (zero hot-path latency; one-turn intervention delay accepted; runtime §6/§8 amended). Haiku gate every turn + the every-5 floor; **gate verdict never fed to the ST** (bias independence). ST context = sd_playbook + summary + recent slice (NOT full transcript — the summary is the ST's compression). Direction channel bound = **structural reasoning/direction split + prompt contract, no independent checker** (defines the dangling runtime-§8.2; checker seam documented; MYT-72 revisits). Two direction shapes: one-shot (take-and-clear, fusion seam) + standing (persist, ephemeral tail message — cache-safe). Summary ownership → the ST job; `flushTurnState` → usage-only. Wind-down in scope as the ST-side standing directive. Seven direction classes (A–G) in the prompt taxonomy (examples behaviorally bounded — never naming protected content) — with **earned reveals (trust pacing) and check-gated reveal ladders first-class** (added at brainstorm: the small-talk/NPC-authenticity product thesis; ladders staged across evaluations via summary state, prompting-only; the channel contract sharpened to behavior + SANCTIONED reveal content). The ft-system prompt gains the NPC-authenticity section; the session-prep prompt gains the entrusted-secrets/critical-path-marking nudges. The world clock + scheduled events split to MYT-77 (seams left: the extensible world-state block, class C's trigger set, coarse time in the summary). Spotlight balancing stays MYT-76.


## 15. Blind review round 1 (Tarot, all-Fable, 2026-06-10) — applied revisions

4 lenses (LLM-orchestration / enforced-ignorance+ZFC / concurrency+state / game-design). **1 SHOWSTOPPER** under the strict rubric, fixed in scope: the ST summary's player-facing exit (checkpoint → `sessions.st_running_summary` → the active-session route returning the full row) — the route gains a response allowlist (§9). Substantive NITs folded in: summary REWRITE semantics (append corrupts the rapport/ladder state machine and unbounds cost); the job-side dedup self-re-arm + single-flight invariant (the second MYT-68 BullMQ lesson); session-boundary key resets (a same-day session inherited wind-down state); the `:usage:st` dedicated key forced (the Lua option provably can't survive the turn's stale-read-then-SET); the discriminated standingDirective op; the ST sees its own active directives; repair-attempted results discarded (the repair chain must not author channel text); behaviorally-phrased bounds (the spec's own examples named the secrets they protected); the ft-system frequency-rule carve-out + the social-check depth rule (the player-initiated confabulation collision); direction-conditionality + transcript-confirmed ladder advancement (the one-turn-late trade honestly extended beyond craft nudges); gate-fires ≠ intervene (pass-through evaluations feed the social clock the gate would otherwise starve); the classifier-summary contract reclassification; class F's coupling stated honestly; the prep prompt's stale wait-for-direction instruction; the runtime §17.4 correction; `[STAGE]` markup hygiene; GETDEL/fusion ordering pins; worker lifecycle + checkpoint-kind + TTL + idempotency notes.
