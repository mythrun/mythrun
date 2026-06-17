# MYT-74b — Post-Session Analysis + Handoff

> **Status:** approved at brainstorm 2026-06-17 (7 decisions taken with the user). The **second of four** decomposed pieces of Linear issue MYT-74. Continuation of **MYT-74a** (the end-of-session reconciliation + the session-end lifecycle), into whose `endSession` orchestration this plugs.

**Goal:** turn "the session is over" into "here's what happened, and here's the warm starting state for next time" — a live narrative send-off plus a durable, compact record that lets the next session's prep open exactly where this one left off, **with NPC characterization preserved across the gap**.

---

## Where this sits

MYT-74 decomposes into four pieces (see the 74a spec). This is **74b**: the **FT farewell**, the **post-session analysis** (an Opus pass producing the summary + emerging threads + the handoff), and **wiring the next prep to consume** the handoff. 74a built the lifecycle (`endSession`) + the canon reconcile; 74c (wiki refresh) and 74d (transcript search) are later.

**74b vs. session prep (the boundary that drove the design):** session prep (built — MYT-63/64) is the *generative* pass that authors the next session's material (`ft_context` + `sd_playbook`) *before* a session. 74b's analysis runs *at the end* of a session and writes a compact record of what just happened. The relationship is **producer → consumer**: 74b writes the "save file"; the next prep loads it. They are not redundant — the handoff is the small, session-fresh interface (the full transcript is too large for the prep to re-read; the ST running summary is ephemeral and gone after the session; the record must persist whether or not the next session ever happens).

---

## In / out of scope

**In scope.** (1) The **FT farewell** — a final streamed FT call at session end (live narrative closure). (2) The **post-session-analysis worker** — a dedicated off-hot-path Opus job producing `summary` + `emerging_threads` + `handoff`, persisted to the session row. (3) **Wiring the prep to consume** the handoff — populating `priorSessionContext` from prior sessions' summaries + the latest handoff, with the **verbatim NPC-voice excerpts injected into the next `ft_context` deterministically** (no summarizing step).

**Out of scope.** `faction_updates` (produced by nothing yet — faction situation-changes are arguably 74a canon territory; add when a consumer exists); any **player-readable recap surface** (a recap UI is a Frontend ticket — 74b persists the secret-free summary so a future recap is *safe*, but builds no read path); the owner-only **`regenerate-handoff`** re-run route; **promoting voice excerpts into durable entity canon** (a future enhancement so an NPC absent from the latest session still carries their voice — the rolling handoff covers the common case for now); the **prompt-cache reuse** optimization (see D4). 74c/74d. No migration (reuses `sessions.summary` + `sessions.handoff`).

---

## Decisions

- **D1 — Separate analysis worker.** A dedicated `session-analysis` BullMQ worker (modeled on the reconcile/scribe workers), enqueued by `endSession` alongside reconcile. Reconcile owns fact-canon; analysis owns the narrative record — distinct Opus concerns, independent failure + retry. Not folded into reconcile (would couple two unrelated concerns + complicate reconcile's idempotency); not inline in `endSession` (a ~10s+ Opus call must not block session teardown).
- **D2 — Include the FT farewell.** A live streamed FT wrap-up threaded into `endSession`'s close sequence (after the lock-quiesce, before flip/close) so players get narrative closure. The async analysis can't feed the live `session_end` (clients have disconnected by the time Opus finishes), so the farewell *is* the live send-off; the summary/handoff are durable, read later (by the prep).
- **D3 — One clean secret-side Opus call.** The analysis is a single Opus call over the transcript + `sd_playbook` + running summary. Spec default (Opus); the absolute cost is modest (once per session, not per turn).
- **D4 — Prompt-cache reuse deferred.** The FT's warm Sonnet transcript cache *could* cheapen the secret-free summary, but the load-bearing `handoff` is secret-aware (needs the playbook, which is never in the FT's enforced-ignorance cache), and reconstructing the FT's exact cacheable prefix (incl. tools) from a separate call is brittle. Documented as a future summary-only optimization; v1 is one robust secret-side call.
- **D5 — NPC voice = a couple of verbatim, relational, late-session excerpts.** The most jarring cross-session drift is an NPC reverting to a stranger's default — losing the *relationship* they built with the PCs. So each major NPC carries a small set (≈2) of **verbatim** transcript excerpts chosen for **how the NPC interacts with / feels about the PCs**, drawn from **late in the session** (post-acquaintance, so the captured affect is the *evolved* one). Generic first-impression / stereotype lines are explicitly **forbidden** (they flatten the character + reset development). Key locations get a verbatim atmosphere snippet (lower priority — world-feel consistency).
- **D6 — Verbatim end-to-end; no summarizing step.** Extract verbatim (the analysis quotes, never paraphrases) → store verbatim (handoff JSON) → **inject verbatim into the next `ft_context` by deterministic concatenation** (a dedicated section, NOT digestible input to the prep LLM — which would paraphrase it back into a stereotype) → the FT reads `ft_context` unchanged each turn (it is never FT-side summarized; only the ST running summary is a digest, a separate artifact). No summarizing LLM may sit between the transcript excerpt and the next session's FT context.
- **D7 — Persist-only, prep-consumed.** Every 74b output is consumed by the **prep pipeline**; no player/owner read path in 74b. Outputs: `summary` (→ the prep's `previousSummaries`) + `emerging_threads` (→ prep input: the next session develops what players cared about) + `handoff` (→ the prep's where-we-left-off + the verbatim voices). The secret-free classification on `summary`/`emerging_threads` holds regardless (so a future recap is safe).

---

## 1. The end flow (extending 74a's `endSession`)

**Architectural constraint (drove the farewell wiring):** `endSession` is called from two contexts — the **WS route in the API server** (explicit `end_session`) and the **turn worker** (budget auto-end). The FastThinker is constructed only in the **turn-worker** process; the API server has no FT. So the farewell **cannot** be a synchronous FT render inside `endSession`. Instead it is a **player-less turn** rendered by the turn worker — the exact MYT-73 **correction-turn** pattern (a new `trigger.kind: 'farewell'`), which already enqueues a player-less turn that the turn worker renders through the real FT + publisher.

The flow becomes:
1. The end trigger (the `end_session` frame, or the budget auto-end) → `endSession` claims the `ending` flag, `cancelSuspend`, and **enqueues a `farewell` turn** onto the turn queue (instead of flipping/closing immediately). It does *not* finalize yet.
2. The **turn worker** renders the farewell turn — *"the session is winding down; narrate where each character ends up and give the table a moment of closure"* — streamed through the publisher like normal turn prose (enforced-ignorance-safe — it is an FT call, no playbook). A farewell turn is player-less (no watermark advance) and is the last FT activity.
3. In the farewell turn's post-turn phase, the turn worker **finalizes the end**: flip `status='ended'`, `enqueueReconcile` + **`enqueuePostSessionAnalysis({ campaignId, sessionId })`**, broadcast `session_end`, release the lock. (The per-session lock the turn worker already holds for the farewell turn is the quiesce fence — no separate lock dance.)

This keeps 74a's `endSession` *idempotent-claim + enqueue* shape and moves the finalize-on-completion into the turn worker, where the FT lives. (Alternative considered: build FT machinery in the API server — rejected; duplicates the turn worker's tier construction.) If rendering the farewell fails terminally, the finalize still runs (a session must always be able to end) — the farewell is best-effort closure, the finalize is load-bearing.

---

## 2. The analysis worker

A new `session-analysis` BullMQ worker (a `QUEUE_SESSION_ANALYSIS` + payload `{ campaignId, sessionId }` + `enqueuePostSessionAnalysis` with `jobId = analysis-{sessionId}` dedup + a `buildPostSessionAnalysisWorker`, mirroring the reconcile/scribe workers). It runs off the hot path and reads **only durable inputs** (so it is safe to run after WS close):

- the **player-facing transcript** — `session_messages` (FT prose + player messages + skill/dice/combat events), **not** the debug `st_evaluation` / `scribe_result` streams (§17.7);
- the prep's **`sd_playbook`** — read through a narrow secret-side repo surface (mirrors `ScribeRepo` / the analysis is secret-side like the ST);
- the ST **running summary** — `sessions.st_running_summary` (persisted; the ST checkpoints it, and `endSession`'s flush ensures it is on the row before the analysis reads it — a dependency the worker tolerates by treating a null/empty running summary as "transcript-only").

One Opus call (§6) → the structured result → persist to the session row: `summary` (TEXT) + `handoff` (JSON, carrying the `SessionHandoff` + `emerging_threads`). **Idempotent**: a conditional "analysis already written" gate (e.g. `UPDATE … SET summary=…, handoff=… WHERE id=$1 AND handoff IS NULL` → 0 rows ⇒ already done) so a BullMQ retry / double-enqueue commits once. Transient failures throw (BullMQ retries); a terminal failure alarms (the next prep degrades to summaries-only / cold open — named, not silent).

---

## 3. The analysis outputs + the `SessionHandoff` shape

```ts
// The analysis result (persisted: summary → sessions.summary; the rest → sessions.handoff JSON).
interface PostSessionAnalysis {
  summary: string                  // 2–4 sentence recap; SECRET-FREE (player-witnessed events only)
  emergingThreads: string[]        // hooks/interests that surfaced organically; SECRET-FREE
  handoff: SessionHandoff
}

interface SessionHandoff {
  party:             { characterName: string; location: string; condition: string }[] // per-PC end state
  timeOfDay:         string
  unresolvedThreads: string[]      // ranked by urgency
  npcs:              NpcHandoff[]
  keyLocations:      { name: string; atmosphere: string }[]  // verbatim atmosphere snippet per major location
}

interface NpcHandoff {
  name:  string
  state: string                    // current disposition/situation toward the party (structured)
  voice: string[]                  // ≈2 VERBATIM transcript excerpts — relational, late-session (D5).
                                   // NEVER paraphrased; the evidence of `state`.
}
```

Dropped the prototype's `inventory_changes` (inventory is the MYT-70 character ledger — the handoff is purely *narrative* state). `faction_updates` is out of scope (D7).

---

## 4. Wiring the prep to consume the handoff

The prep's `serialize-world-state-for-prep.ts` already exposes `priorSessionContext` (`previousSummaries: string[]`) and is fed nothing today. 74b:

- **Widens** `PriorSessionContext` to `{ previousSummaries: string[]; latestHandoff?: SessionHandoff }`.
- The **session-prep processor**, generating session N+1, reads prior ended sessions' `summary` + the most-recent `handoff` from the `sessions` table and builds `priorSessionContext`.
- The **serialize** renders the prior recaps + the handoff's opening-scene anchor (party positions, time, unresolved threads) into the prep prompt.
- **The verbatim NPC voice excerpts are injected into the next `ft_context` by DETERMINISTIC concatenation** — a fixed "Returning characters — keep these voices consistent" section appended to the prep's generated `ft_context`, **never** fed as digestible input to the prep LLM (D6). The prep authors the scene *around* these voices; it never rewrites them. (Implementation: the excerpts are concatenated into `ft_context` by code after the prep LLM produces the rest — the same "don't trust the LLM to preserve verbatim, copy deterministically" discipline as the MYT-73 delimiter-guard.)

This is the load-bearing chain: extract verbatim (§6) → store verbatim (§3) → inject verbatim (here) → FT reads verbatim (`ft_context` is the static prep doc the FT holds unchanged).

---

## 5. Enforced ignorance

The analysis reads the secret `sd_playbook`, so `redactRawText: true` on the Opus call (a malformed output can't spill a secret into the repair log / diagnostic / SSE). Its outputs split by classification:

- **`summary` + `emerging_threads` → SECRET-FREE.** The prompt constrains them to *player-witnessed* events (the distinction between the ST's private running summary and a public recap). Persisted so a future recap is safe; a leak test proves the summary is secret-free over a secret-bearing playbook.
- **`handoff` → may be SECRET-AWARE** (it feeds the prep, which is Opus/secret-cleared and itself emits the enforced-ignorance-safe `ft_context`). Never returned to a player surface (there is no player read path — D7).
- **The verbatim voice/atmosphere excerpts are SECRET-FREE by construction** — they are copied from the *player-facing transcript* (what everyone witnessed), not the playbook. This is why they are safe to inject into the enforced-ignorance `ft_context` (§4): a transcript excerpt cannot contain a secret the players didn't already see.

---

## 6. The analysis Opus call (prompt + selection rules)

A new LLM call (`llm/post-session-analysis.ts` + a flat Zod schema for `PostSessionAnalysis` + `prompts/session/post-session-analysis.txt`), Opus, through `generateObject` + repair + `redactRawText`. Flat root, no `.refine`, `.min(1)` floors on prose, **no `.max()`** on free-prose fields (the voice excerpts + summary are free prose).

The prompt receives the transcript, the `sd_playbook`, the running summary, and the session's participant roster (to attribute per-PC handoff state). Its hard rules:

- **`summary`/`emergingThreads`**: only what the players witnessed — never reveal or hint at playbook secrets the session didn't surface.
- **NPC `voice` excerpts (D5)**: emit **verbatim** transcript lines (quote exactly — never paraphrase, never invent); choose **≈2 per major NPC** that show **how the NPC treats / feels about / acts around the PCs**; prefer excerpts from **late in the session** (the evolved relationship); **do NOT** pick generic first-impression or stereotype lines — the goal is preserving the *current affect toward these PCs*, not a flat personality tag.
- **`keyLocations.atmosphere`**: a verbatim sensory/atmosphere snippet for each major location (world-feel consistency).
- **`handoff`**: a precise, specific end-state snapshot for the next session (exact per-PC locations, time of day, urgent unresolved threads, NPC dispositions).

---

## 7. Interface contracts / what changes

- **New:** `session/post-session-analysis.ts` (queue + worker, modeled on `session-reconcile.ts`); `llm/post-session-analysis.ts` + `llm/schemas/post-session-analysis.ts` + `prompts/session/post-session-analysis.txt`; the `farewell` prompt addition to `ft-system.txt` (the FT renders a wind-down when handed a farewell direction).
- **Changed:** `session/turn-queue.ts` (a `trigger.kind: 'farewell'` + the player-less farewell payload, mirroring `'correction'`); `session/turn-worker.ts` (render the farewell turn → in its post-turn phase, finalize the end: flip `status='ended'`, `enqueueReconcile` + `enqueuePostSessionAnalysis`, broadcast `session_end`); `session/session-end.ts` (enqueue a `farewell` turn + claim `ending` + `cancelSuspend`, rather than flip/close directly — the finalize moves to the turn worker; gains the analysis-queue producer); `repo/sessions.ts` (a conditional `writeAnalysis(id, {summary, handoff})` gate + the `summary`/`handoff` reads for the prep); `llm/prep/serialize-world-state-for-prep.ts` (widen `PriorSessionContext` + render the handoff); `llm/prep/session-prep-processor.ts` (read prior summaries + latest handoff; deterministically inject the voice excerpts into `ft_context`); `worker.ts` (run the analysis worker).
- **Reused:** the FT render seam (the turn worker's), the publisher (farewell stream), the boot-probed Opus path, `withTransaction`, the suspend/reconcile worker patterns, the existing `sessions.summary`/`handoff` columns (no migration).

---

## 8. Testing

- **Unit:** the analysis Opus call (mock `'ai'`); the analysis worker (injected fakes — durable-input reads, the idempotent gate, persist); the FT farewell threaded into `endSession` (streamed before close; idempotent with the ending flag); the prep-consumption serialize (the handoff renders into the prep prompt) **and the deterministic `ft_context` injection (the verbatim voice excerpts appear byte-identical in the generated `ft_context`, not paraphrased)**.
- **Leak matrix (break-it-to-prove-it):** the analysis over a secret-bearing `sd_playbook` → `summary`/`emerging_threads` are secret-free; the `redactRawText` reject arm carries no secret in the diagnostic / logs.
- **Gated real-LLM smoke (driven before handback):** seed + drive a real session to end → assert the farewell streamed, the Opus analysis persisted `summary` + `handoff` (with ≈2 verbatim relational NPC voice excerpts that actually appear in the seeded transcript), the summary is secret-free, and the next prep's `priorSessionContext` opens "where we left off" **with the NPC voice excerpts present verbatim in the generated `ft_context`** (the end-to-end consistency proof).

---

## 9. Out of scope (restated)

`faction_updates`, any player/owner recap surface or endpoint, `regenerate-handoff`, promoting voice excerpts to durable entity canon, prompt-cache reuse, 74c/74d. 74b ends a session with a live farewell and a durable, prep-consumed record that carries plot **and** NPC characterization into the next session.
