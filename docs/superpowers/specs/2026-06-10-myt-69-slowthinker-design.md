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

**Queue discipline (the MYT-68 smoke lessons applied):** the producer is the turn worker's post-turn phase (after release, alongside the re-mature; own try/catch — an enqueue hiccup never masks the turn outcome). Dedup `{ id: 'st-eval:<campaignId>', replace: true }`, **no ttl** (a ttl'd key outlives the job and swallows re-adds — `reference_bullmq_dedup_ttl_swallows_readds`). The job evaluates *current* state, so collapsing rapid turns onto one evaluation is correct, not lossy. The job payload is `{campaignId, sessionId}` only.

## 3. The Haiku gate

One cheap classified judgment per completed turn: **should we spend the Opus call?**

- **Input (the gate may hold secrets freely — it is ST-side infrastructure whose output is consumed by code only):** the `sd_playbook` trigger conditions, the running summary, the last `ST_GATE_EXCHANGE_WINDOW` exchanges (including the FT's latest response), and the evaluated turn's `trigger.classification` (intent/complexity/confidence) as a signal.
- **Output:** `{ needed: boolean, confidence: number, reason: string }` via `generateObject` on `HAIKU` (repair `'haiku-then-sonnet'`). `needed && confidence ≥ ST_GATE_CONFIDENCE_FLOOR` → evaluate. Low-confidence `needed` also evaluates (fail-toward-oversight); low-confidence `not needed` evaluates too — only a confident "no" skips.
- **GATE INDEPENDENCE (hard rule, decided at brainstorm):** the gate's verdict/reason is **never fed to the ST**. The gate decides only whether the Opus call happens; the ST independently decides whether to intervene, and its prompt states that the decision is its own ("most turns: no" stays). A wrong gate must not bias the judge.
- Gate failure → skip this cycle, log; the floor guarantees eventual oversight. Never retries into the hot path (there is no hot path here).

The deterministic policy arms (floor, wind-down threshold) are **code around the gate**, not prompt content — mechanical policy, ZFC-exempt.

## 4. The ST evaluation (Opus)

**Context (the spec'd slice — decided over full-transcript at brainstorm; the summary is the ST's own compression, so its Opus cost stays bounded regardless of session length):**
- `sd_playbook` (secret-inclusive prep doc — `repo.sessionPreps.getBy`, cached in the job like the FT's `ft_context` pattern),
- the running summary (its own artifact),
- the last `ST_EVAL_EXCHANGE_WINDOW` exchanges from the transcript (player + DM, via `listFtContextRows` + the codec — including the FT's response to the evaluated turn),
- the PC roster with class/background (multi-character awareness, runtime §8: directions may reference specific characters),
- wind-down mode flag when the policy arm fired.

The context assembly is an **extensible world-state block** — roster + summary + slice today; the in-world clock + event schedule slot in here when MYT-77 lands (a seam, not speculative code).

**The summary's content mandate** (the prompt instructs what `summaryUpdate` tracks): character arcs and positions, **NPC rapport/trust levels** ("the party has been drinking with Hobb; he's gone from curt to chatty" — what lets the ST judge an earned reveal across evaluations), **in-progress reveal-ladder state** ("Insight passed, Hobb ladder open"), and **coarse time progression** ("evening falls over Saltgate" — the interim time carrier until MYT-77's structured clock).

**Output schema (the STRUCTURAL SPLIT — this is the §8.2 leak bound):**

```ts
StDirectorResultSchema = z.object({
  // PRIVATE: the ST's secret-aware reasoning. Logged server-side only;
  // NEVER crosses into any FT-facing artifact. Forcing the reasoning into
  // its own field is what keeps ride-along leaks out of the direction text.
  reasoning: z.string().min(1),
  intervene: z.boolean(),
  // PUBLIC-FACING: the one-shot stage direction (behavior, not information;
  // 1-2 sentences; what-not-how). Crosses into the FT via the fusion seam.
  direction: z.string().min(1).nullable(),
  // PUBLIC-FACING: set/replace ('...text...'), clear (''), or leave (null)
  // the standing directive (§5 class G / long-arc beats).
  standingDirective: z.string().nullable(),
  // Always required, even on pass-through evaluations (prototype rule).
  summaryUpdate: z.string().min(1),
})
```

**The direction-channel bound (defining the dangling runtime-§8.2):** the channel is gated **structurally + by prompt contract, with NO independent checker** (decided at brainstorm). The split `reasoning`/`direction` fields kill the dominant leak mode (secret rationale riding along in the direction text). The contract, stated precisely (sharpened during the reveal-ladder discussion): **directions carry behavior plus ST-SANCTIONED reveal content — bounded to exactly what the ST decided the NPC may surface — never unsanctioned secret rationale.** An earned reveal ("on a successful Persuasion he shares that he saw the bargehand try the lock — nothing more") IS information crossing the channel, and that is sanctioned by design: the ST is the single gate, and the reveal text is the gate's output. The *why* stays in the private `reasoning` field. The seam for an independent leak-check (a classifier over `direction` against the prep's core secrets) is documented here deliberately and NOT built; MYT-72's vetted-information-relay mode — the same sanctioning pattern applied to lookups — is the natural point to revisit. Rationale: interventions are rare, subtle inferential leaks evade any checker, and the structural split removes the blatant mode at zero cost.

**The prompt (`st-evaluation.txt`, multiplayer rewrite of the validated prototype):** keeps the four session-level monitors (tonal monotony, pacing stalls, NPC-only revelations, missing agency), "most turns do NOT warrant intervention", 1–2-sentence what-not-how directions; adds the multiplayer batch framing + PC roster, the seven direction classes (§5) with one example each, the trust-pacing frame (playbook secrets are entrusted, not dispensed; healthy small talk is a reason to stay OUT), the check-gating craft rule (never gate critical-path progression behind a check), the standing-directive semantics, the wind-down mode instruction, the summary content mandate, and the channel rule: *directions carry behavior and sanctioned reveal content only — your reasoning field is where secret-aware thinking lives; never put a secret in a direction you have not deliberately decided the NPC surfaces.* Plain direction text (the controller adds the `[DM direction: …]` wrapper at fusion; no prototype `[STAGE]` tags).

## 5. Direction classes (the prompt's taxonomy — enumerated at brainstorm)

| Class | Trigger | Form |
|---|---|---|
| **A. Earned reveals (trust pacing)** | a conversation with a secret-adjacent NPC has warmed to where a reveal is earned (rapport tracked in the summary) | a GRADED sanctioned reveal: "Hobb's warmed to them — he can mention he saw the bargehand poking around the east walkway. Nothing about the ledger." Playbook secrets are **entrusted, not dispensed**; the ST decides the moment and the portion. |
| **B. Check-gated reveal ladders** | useful-but-optional information a standard D&D check flow should gate | a STAGED sequence across evaluations: direct the tell ("Hobb seems to hold something back — if a player reads him, allow Insight"); the check rides MYT-68's `roll_skill_check`; the pass lands in the transcript; the NEXT evaluation directs the rung ("he can be pressed; a successful Persuasion gets the lock story — nothing more"). The summary carries ladder state ("Insight passed, Hobb ladder in progress"). **Craft rule (both ST + prep prompts): never gate critical-path progression behind a check** — if failure would stall the planned beats, give it freely or route it another way; gate optional/corroborating clues, and let failure mean the information arrives by another road. Prompting only — no workflow machinery. |
| **C. Playbook beats** | table state matches an `sd_playbook` trigger condition (later incl. clock/schedule triggers — MYT-77) | behavioral event, secret-free: "Have the bargehand cross their path again — visibly. Don't explain him." |
| **D. Craft interventions** | the four monitors | a craft nudge (how, not what): "Three exchanges of dread — inject something mundane and warm." The inverse holds too: **healthy small talk is a reason to stay out** — organic conversation going well is not a pacing stall. |
| **E. Secret-integrity steering** | conversation drifting toward territory where the blind FT would confabulate against a secret | boundary + redirect: "Hobb knows nothing of the ledger's contents; he deflects to Vane." Prevention; MYT-73's retcon is the cure. |
| **F. Grounding step-ins** | ungrounded RP / the proactive yank-back (the dm-trigger decides *that*; the pending direction supplies *what*) | event injection: "Ring the fog bell — the harbor reacts." |
| **G. Wind-down** | the ≥`WIND_DOWN_FRACTION` budget policy arm | a STANDING directive: "Steer toward a natural close: resolve the current scene, open no new threads or NPCs." |

Out of scope: spotlight/time balancing (MYT-76); the world clock + scheduled events (MYT-77 — class C's trigger set and the §4 world-state block are the ready seams). Future classes riding this channel: the vetted-information relay (MYT-72) and retcon delivery (MYT-73) — the two-shape slot accommodates both.

## 6. The pending-direction slot + consumption mechanics

Trigger-state (Redis, campaign-scoped) gains a two-field slot:

- **`oneShot`** — written by the ST (latest wins: a newer evaluation overwrites an unconsumed direction); **taken-and-cleared atomically (GETDEL)** by the next DM turn's worker, passed into the controller, fused onto the last user message via the **unchanged MYT-68 fusion seam**. Known accepted cost: one prompt-cache prefix re-write per consumed intervention (the persisted row lacks the fused text — the MYT-68 §3.9 caveat).
- **`standing`** — written/replaced/cleared by the ST; **read (not cleared)** every DM turn and appended as an **ephemeral tail message** after the history (`role: 'user'`, `[DM direction: …]`-wrapped, never persisted). Tail placement is load-bearing: fusing a standing directive into a persisted-position message would diverge the reconstruction from the live render on EVERY turn and destroy the cache prefix for the rest of the session; the tail rides in the always-uncached zone past the last breakpoint.
- Both carry the session-state TTL. A dead-air (empty-batch) turn consuming a one-shot fuses onto the last already-answered user message — semantically "apply this nudge now" (the MYT-68 fusion-skip warn arm stays for the truly-no-user-message edge).

The controller's `processDmTurn` no longer calls `st.evaluate` — the `SlowThinker` tier seam leaves the turn path; `StubSlowThinker` retires from production wiring (kept for tests if useful). The directions arrive as worker-resolved deps (`pendingDirection?`, `standingDirective?`), mirroring `ftContext`.

## 7. Summary ownership moves to the ST job

The running summary is the ST's artifact: the st-evaluation job writes the `:summary` key directly after each evaluation (plain SET; the job is the only writer). `flushTurnState` shrinks to **usage-only**; the controller's `applyEvaluation`/summary code is deleted. This removes the background-write-vs-turn-flush clobber race outright. The summary remains: the ST's own context compression, the Scribe's session-end input (MYT-73), and nothing the FT ever reads.

Usage accounting: the job accumulates its own gate + evaluation usage onto the `:usage` turn state via an atomic increment-style update (read-modify-write under no lock is the same clobber hazard — the job updates usage with a small Lua/WATCH or a dedicated `:usage:st` key summed at read time; plan-time pick, correctness requirement pinned: **the ST job must not clobber concurrent turn-flush usage writes**).

## 8. Wind-down (the MYT-68 §3.11 leftover, in scope)

The policy arm: `usage.input + usage.output ≥ WIND_DOWN_FRACTION × SESSION_TOKEN_BUDGET` → force evaluation with the wind-down flag. The ST sets the **standing** wind-down directive (class G) and keeps directing toward closure on subsequent evaluations. The actual `session_end` orchestration (and the FT-context hard cap enforcement) stays with the session-end issue; this is the ST-side signal only. `SESSION_TOKEN_BUDGET` + `WIND_DOWN_FRACTION` (0.9) land in ft-config/st-config.

## 9. Enforced ignorance check

- The gate and the ST hold `sd_playbook` freely — server-side infrastructure; their outputs that cross into the FT are exactly: `direction` and `standingDirective` text (behavior-bound by §4's structural split + prompt contract). `reasoning` and the gate verdict are logs only. The summary stays FT-invisible (MYT-68 removed `runningSummary` from `FtTurnContext`).
- The ST's context assembly happens inside the st-evaluation worker — no secret-bearing field is added to any FT-facing type. The MYT-66 `TurnContext = FtTurnContext & StSecrets` widening is **not needed** under the post-hoc model (the ST no longer consumes the FT's context object at all); note this supersession in tiers/types.ts comments.

## 10. Error handling

Everything is off the hot path; nothing here may ever delay or fail a player-visible turn.
- Producer enqueue failure → own try/catch in the post-turn phase, error-logged (the next turn re-enqueues).
- Gate failure → skip cycle, log; the floor guarantees an evaluation within `ST_EVAL_FLOOR_TURNS`.
- ST evaluation failure → BullMQ retry (transient) / no direction this cycle (terminal), structured log. The repair chain (`generateObject`, `'haiku-then-sonnet'`) handles malformed output.
- Slot write failures → log; the world keeps turning (directions are enhancement, not correctness).
- A consumed direction is gone even if the FT turn then fails terminally — accepted (directions are nudges; the ST will re-evaluate).

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
| `ST_EVAL_TIMEOUT_MS` / `ST_GATE_TIMEOUT_MS` | 120s / 30s | background-tolerant budgets |

## 12. File-level change map

**New:** `src/session/st-evaluation-worker.ts` (the pipeline: policy → gate → evaluate → write); `src/llm/st-gate.ts` + `src/llm/schemas/st-gate.ts` + `prompts/session/st-gate.txt`; `src/llm/st-director.ts` + `src/llm/schemas/st-director.ts` + `prompts/session/st-evaluation.txt` (multiplayer rewrite); `src/session/st-config.ts` (or fold into ft-config).
**Modified (prompt amendments — the FT half of the authenticity dynamic):** `prompts/session/ft-system.txt` gains the NPC-authenticity section (NPCs are normal people; strangers get stranger treatment; small talk is the texture of the world, play it in full; people don't volunteer their troubles to strangers; trust is earned, and what an NPC has to share, the world will tell you when it's time — plus: when a direction indicates a tell, surface it naturally and let the check ride the normal tool flow). `prompts/prep/session-prep.txt` gains two nudges for the sd_playbook: encode what each NPC would entrust and roughly when (trust conditions), and mark which clues are corroborating/optional vs critical-path (the check-gating craft rule's ground truth).
**Modified:** `trigger-state.ts` (the two-field direction slot + turns-since-ST counter); `turn-worker.ts` (post-turn enqueue + slot take/read + controller deps `pendingDirection`/`standingDirective`; ST_QUEUE producer); `session-controller.ts` (drop `st`/`applyEvaluation`/summary; fuse the injected one-shot; append the standing tail); `tiers/types.ts` (`StEvaluation`/`SlowThinker` retire or shrink to the new shapes; supersession notes); `redis/session-state.ts` (`flushTurnState` → usage-only; the ST job's summary/usage write surface); `worker.ts` (6th worker); `repo` reads reused (sessionPreps `sdPlaybook`, the codec window read).

## 13. Testing

- **Unit (mock `'ai'`):** gate schema + the only-confident-no-skips routing; ST schema incl. the structural split + standingDirective set/replace/clear arms; the deterministic policy arms (floor, wind-down threshold) as pure code; prompt template var contracts (both prompts).
- **Pipeline (fakes + ioredis-mock):** policy-before-gate ordering; gate verdict never reaches the ST prompt input (assert the evaluate call's prompt lacks it); slot write semantics (latest-wins overwrite, GETDEL take, standing persistence); summary written by the job; usage non-clobber.
- **Turn-path (controller/worker):** one-shot consumed exactly once + fused via the existing seam; standing appended as the ephemeral tail (and NOT persisted — assert via `appendDmTurn` capture); dead-air consumption edge; post-turn enqueue failure isolation.
- **Real-Anthropic E2E smoke (wire level):** drive turns until the gate fires (a playbook-trigger scenario seeded in `sd_playbook`); assert the direction lands on turn N+1's prose (visible influence, zero verbatim leak — grep the streamed text against the playbook's secret strings); the floor fires after 5 quiet evaluations; wind-down: seed usage near the budget → the standing directive appears in every subsequent turn's behavior; latency: time-to-first-token on evaluated turns unchanged vs un-evaluated. **The authenticity scenario:** seed an sd_playbook with a trust-gated secret + small-talk with the holder NPC → assert the early turns stay plot-free (no hook-dispensing), rapport appears in the summary, and the reveal arrives only after warmth (or a passed check rung) — the signature small-talk dynamic, observed live.

## 14. Resolved decisions (brainstorm 2026-06-10)

Post-hoc async ST (zero hot-path latency; one-turn intervention delay accepted; runtime §6/§8 amended). Haiku gate every turn + the every-5 floor; **gate verdict never fed to the ST** (bias independence). ST context = sd_playbook + summary + recent slice (NOT full transcript — the summary is the ST's compression). Direction channel bound = **structural reasoning/direction split + prompt contract, no independent checker** (defines the dangling runtime-§8.2; checker seam documented; MYT-72 revisits). Two direction shapes: one-shot (take-and-clear, fusion seam) + standing (persist, ephemeral tail message — cache-safe). Summary ownership → the ST job; `flushTurnState` → usage-only. Wind-down in scope as the ST-side standing directive. Seven direction classes (A–G) in the prompt taxonomy — with **earned reveals (trust pacing) and check-gated reveal ladders first-class** (added at brainstorm: the small-talk/NPC-authenticity product thesis; ladders staged across evaluations via summary state, prompting-only; the channel contract sharpened to behavior + SANCTIONED reveal content). The ft-system prompt gains the NPC-authenticity section; the session-prep prompt gains the entrusted-secrets/critical-path-marking nudges. The world clock + scheduled events split to MYT-77 (seams left: the extensible world-state block, class C's trigger set, coarse time in the summary). Spotlight balancing stays MYT-76.
