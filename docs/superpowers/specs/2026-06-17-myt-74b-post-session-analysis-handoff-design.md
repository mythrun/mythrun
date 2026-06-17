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

The flow:
1. The end trigger (`end_session` frame, or budget auto-end) → `endSession` claims the `ending` flag (SET-NX — the farewell enqueue is **strictly inside the true-branch** so the explicit/budget race produces exactly one farewell), `cancelSuspend`, and **enqueues a `farewell` turn** (`enqueueTurn` with a per-session `jobId = farewell-{sessionId}` — a broker-level dedup backstop beyond the flag). It does *not* finalize yet. It also sets the gate that **suppresses the post-turn re-mature + the explicit-drain enqueue** for this campaign (see below) so no fresh real turn can be enqueued behind the farewell.
2. The **turn worker** renders the farewell turn — driven by the existing **silent-consume `[DM direction: …]`** seam (NOT the `[[DM CORRECTION:]]` open-marker; the farewell is consumed silently and rendered in the FT's own voice) — *"the session is winding down; narrate where each character ends up and give the table a moment of closure."* Streamed through the publisher like normal turn prose (enforced-ignorance-safe — an FT call, no playbook). A `farewell` turn is **player-less** and joins `correction` under a shared `isPlayerless` predicate that gates every relevant turn-worker arm: no watermark advance, no budget-auto-end re-trigger, **no Scribe/working-set enqueue** (the farewell is pure closure — keeping its prose out of the working set avoids a Scribe-job-vs-reconcile race), and the terminal-`turn_error` publish is suppressed (a farewell has nothing to retry).
3. **Finalize — runs whether or not the farewell render succeeds** (the load-bearing fix). The finalize (flip `status='ended'` + `endedAt`, `enqueueReconcile` + **`enqueuePostSessionAnalysis`**, broadcast `session_end`) executes in the farewell turn's **`finally`/terminal path**, not only its happy post-turn phase — so a thrown/timed-out FT render still finalizes. For the **`maxStalledCount`-exhaustion** terminal (the documented turn-worker gap where no `'failed'` JS event fires), the finalize is *also* reachable from a backstop: the explicit-drain `QueueEvents('session-turn')` subscriber (or a dedicated check) finalizes any `ending` session whose farewell job terminally failed. **A session always ends; the farewell is best-effort closure, the finalize is unconditional.**

**Interlock window (C3).** Because the status flip now lands at finalize (after the render), the 74a `reconcile_pending` interlock keys on `endedAt` — which is set at finalize — so during the farewell render the campaign is guarded by the `ending` flag (a new `start` precondition: `409 session_ending` while the `ending` flag is set) in addition to the `session_already_active` guard. The `ending`-flag start-guard closes the "status still 'active' during the render" window.

This keeps 74a's `endSession` *idempotent-claim + enqueue* shape and moves the (unconditional) finalize into the turn worker, where the FT lives. (Alternative considered: build FT machinery in the API server — rejected; duplicates the turn worker's tier construction.)

---

## 2. The analysis worker

A new `session-analysis` BullMQ worker (a `QUEUE_SESSION_ANALYSIS` + payload `{ campaignId, sessionId }` + `enqueuePostSessionAnalysis` with `jobId = analysis-{sessionId}` dedup + a `buildPostSessionAnalysisWorker`, mirroring the reconcile/scribe workers). Its queue config (`removeOnComplete`/`removeOnFail`) is pinned alongside the reconcile queue in `server-queues.ts` so a terminally-failed analysis can be re-enqueued (not dedup-blocked by a dead record). It runs off the hot path and reads **only durable inputs** (so it is safe to run after WS close):

- the **player-facing transcript** — `session_messages` (FT prose + player messages + skill/dice/combat events), **not** the debug `st_evaluation` / `scribe_result` streams (§17.7). Each row carries its **originating `trigger.kind`** (a new transcript-row field — §5/§7), so the worker can structurally exclude `correction` + `farewell` rows from voice-excerpt selection.
- the prep's **`sd_playbook`** — read through a narrow secret-side repo surface (mirrors `ScribeRepo` / the analysis is secret-side like the ST);
- the ST **running summary** — read from the live Redis key **`session:{cId}:summary`** (via `makeSessionState`, the only place the running summary lives — `sessions.st_running_summary` is **overloaded by the suspend path** to hold a checkpoint envelope, NOT the summary, so the worker must NOT read that column). The Redis key survives well within its 2h TTL for a seconds-later analysis. A missing key (no ST eval ran) → treat as "transcript-only," tolerated.

**Input-size bound (Pharos I3).** The budget-auto-end fires on the **largest** sessions (up to `SESSION_TOKEN_BUDGET`), so the transcript can approach Opus's context limit. The worker bounds its input: it feeds the **running summary + the recent transcript tail** (the bulk of voice/affect lives late, per D5) rather than an unbounded full transcript — sized so the call never overflows context on the longest sessions. The Opus call pins **`maxOutputTokens`** (sized for the worst-case handoff — many NPCs × voice arrays) and **`timeoutMs`** (an Opus call over a large input is multi-second), mirroring the reconciler's explicit sizing.

One Opus call (§6) → the structured result → persist to the session row: `summary` (TEXT) + `handoff` (JSON; see §3 for the on-disk envelope — `emerging_threads` is stored **with `summary`, NOT inside the secret-aware `handoff` blob**). **Idempotent**: a conditional gate `UPDATE … WHERE id=$1 AND summary IS NULL` → 0 rows ⇒ already done. Transient failures throw (BullMQ retries); a terminal failure alarms with a **structural-only payload** (never the summary/handoff content — the MYT-73 §5 log-surface lesson). **Note:** unlike a failed reconcile (which the `reconcile_pending` interlock surfaces), a never-written analysis is *silent* — the next prep just cold-opens; the alarm is the only signal, so the analysis enqueue is tied to the same unconditional finalize as reconcile (§1.3).

---

## 3. The analysis outputs + the `SessionHandoff` shape

```ts
// The Opus call's structured output (one flat Zod root — §6).
interface PostSessionAnalysis {
  summary: string                  // 2–4 sentence recap; SECRET-FREE (player-witnessed events only)
  emergingThreads: string[]        // hooks/interests that surfaced organically; SECRET-FREE
  handoff: SessionHandoff
}

interface SessionHandoff {
  party:             { characterName: string; location: string; condition: string }[] // per-PC end state
  timeOfDay:         string
  unresolvedThreads: string[]      // ranked by urgency
  npcs:              NpcHandoff[]         // MAJOR NPCs only; soft-capped (array length bounded, ~6) so the
                                          // injected ft_context section can't bloat the FT's static budget
  keyLocations:      { name: string; atmosphere: string }[]  // verbatim atmosphere snippet per major location; soft-capped
}

interface NpcHandoff {
  name:  string
  state: string                    // current disposition/situation toward the party (structured)
  voice: string[]                  // ≈2 VERBATIM transcript excerpts — relational, late-session (D5).
                                   // NEVER paraphrased; from NON-correction/farewell rows only (§5);
                                   // every entry is verified to appear in the transcript (§6 containment check).
}
```

**On-disk envelope (no migration — TEXT columns).** `summary` → `sessions.summary` (TEXT, secret-free). The **secret-free** `emergingThreads` is stored **with the summary** (a small JSON wrapper in the `summary`-adjacent path or a `{summary, emergingThreads}` shape — the point is it is NOT co-located in the secret-aware blob, so a future recap reader can't accidentally pull secret-aware data). The **secret-aware** `handoff` → `sessions.handoff` (TEXT holding `JSON.stringify(SessionHandoff)`). `sessions.handoff` is documented as **prep-only / secret-cleared** — any reader of that column is secret-side (mirrors the `st_running_summary` allowlist-strip precedent). **Read side:** the prep `JSON.parse`s with a Zod `safeParse`; a malformed/legacy value degrades to "no handoff" (never throws mid-prep) — same tolerance as a null running summary.

Dropped the prototype's `inventory_changes` (inventory is the MYT-70 character ledger — the handoff is purely *narrative* state). `faction_updates` is out of scope (D7).

---

## 4. Wiring the prep to consume the handoff

The prep's `serialize-world-state-for-prep.ts` exposes `priorSessionContext` (`previousSummaries: string[]`) and is fed nothing today. 74b closes the producer→consumer chain (the seam details below — Hook C1/C2):

- **Widen** `PriorSessionContext` to `{ previousSummaries: string[]; latestHandoff?: SessionHandoff }`.
- **The fetch + the predicate.** A new repo read `sessions.getPriorContextForPrep(campaignId)` returns prior **ended** sessions' summaries + the **latest** ended session's `handoff` (`status='ended' AND handoff IS NOT NULL`, ordered by `session_number`). The predicate is **handoff-present, NOT reconcile-gated**: the handoff is transcript-derived *narrative* state, independent of canon being committed, so the prep consumes it even if that session's reconcile is still pending (the two end-jobs race; the handoff never references canon ids). `previousSummaries` is **chronological ascending** (oldest→newest, so "the story so far" reads forward) and **bounded** to the last N (a campaign-length cap — long campaigns don't blow the prep-prompt budget). **Cold start (session 1):** no prior ended session → `priorSessionContext` absent → no recaps, no handoff anchor, no injected section — the legitimate empty path (the existing serialize already no-ops on empty), not a failure.
- **The processor wires it.** The `session-prep-processor` (payload `{campaignId, sessionNumber}`) calls `getPriorContextForPrep`, `safeParse`s the latest `handoff`, builds `priorSessionContext`, and threads it both into `generateSessionPrep` (for the serialize) **and** through to the deterministic injection step.
- **The serialize** renders the prior recaps + the handoff's opening-scene anchor — party positions, time, unresolved threads, **and each NPC's `state`** (so the prep authors NPCs aware of their current disposition) — into the prep prompt.
- **The deterministic verbatim injection (the load-bearing seam — Hook C1, I5).** `generateSessionPrep` returns the model's `ft_context` as a sealed field; the **processor** concatenates a fixed **"Returning characters / places — keep these voices and atmospheres consistent"** section onto `result.ft_context` **after** generation + Zod validation, **before** `sessionPreps.insert` — carrying the NPC `voice[]` excerpts **and** the `keyLocations[].atmosphere` snippets (atmosphere is verbatim by the same logic as voice — it must NOT go through the paraphrasing prep prompt). This section is **never** digestible prep-LLM input; the prep authors the scene *around* it. (Same "copy deterministically, never trust the LLM to preserve verbatim" discipline as the MYT-73 delimiter-guard. §7 names the exact functions: `generateSessionPrep` returns `ft_context`; the processor appends + inserts.)

This is the load-bearing chain: extract verbatim (§6) → store verbatim (§3) → inject verbatim **deterministically in the processor** (here) → FT reads verbatim (`ft_context` is the static prep doc the FT holds unchanged each turn — confirmed in `turn-context.ts`). **No summarizing LLM step sits between a transcript excerpt and the next FT context** — for voice *and* atmosphere.

---

## 5. Enforced ignorance

The analysis reads the secret `sd_playbook` **and** the secret-adjacent ST running summary, so `redactRawText: true` on the Opus call. **Carry the MYT-73 log-surface lesson:** `redactRawText` covers only the raw/repair channel — NOT the validated output and NOT the worker's own log lines. So the worker **never logs the `summary`/`handoff`/excerpt content**; every alert/diagnostic payload is **structural-only** (op counts, ids, the failure reason). Outputs split by classification:

- **`summary` + `emerging_threads` → SECRET-FREE — best-effort, residual-risk-named (not a hard guarantee).** They are emitted in the same call that holds the playbook + running summary, so "secret-free" rests on the prompt constraining them to *player-witnessed* events — a *quality* property, not a structural one. The deterministic guarantees that DO hold: (a) the `redactRawText` reject arm (a malformed output is redacted from logs/diagnostic); (b) there is **no player read path** (D7); (c) the leak test is a **semantic curated-paraphrase check with a negative control** (MYT-73 case-(b) shape — not a single clean real-LLM run, which proves nothing per `feedback_smoke_vs_eval`), run against **both** secret inputs (a secret-bearing playbook AND a running summary carrying ST-private rapport/ladder content).
- **`handoff` → may be SECRET-AWARE** (it feeds the prep — Opus/secret-cleared — which emits the enforced-ignorance-safe `ft_context`). Never returned to a player surface (D7); `sessions.handoff` is documented secret-cleared/prep-only (§3).
- **The verbatim voice/atmosphere excerpts — SECRET-FREE, but enforced STRUCTURALLY, not "by construction" (the Fastnet-C1 / Pharos-C1 fix).** A transcript excerpt is *usually* safe (the transcript is player-witnessed), but two holes break "by construction": (1) the model could **fabricate or subtly alter** a "verbatim" quote (then it isn't transcript-sourced at all, and could synthesize playbook phrasing the call holds); (2) the transcript **contains MYT-73 retcon `[[DM CORRECTION:]]` prose** — late-session, relational, NPC-focused (exactly the D5 selection target) — which references the corrected-away secret topic; re-injecting it into `ft_context` hands the FT a *pointer to the secret the retcon spent an Opus call to bury*. Two structural defenses (ZFC: a security boundary is not prompt-only):
  - **Source exclusion:** transcript rows carry their originating `trigger.kind` (§2/§7); voice-excerpt selection (and the deterministic injector) **structurally exclude `correction` + `farewell` rows** — not via the prompt, via a row-kind filter the code applies.
  - **Containment verification:** every emitted `voice[]` / `atmosphere` string is **mechanically verified to appear (normalized) in a non-excluded transcript row** before it is stored/injected; a non-locatable excerpt is dropped + warned (the 74a "deterministic post-`generateObject` validator" pattern). This makes "secret-free by construction" actually true — a stored excerpt is provably a copy of a player-witnessed, non-correction line.
  - **Leak test (§8):** seed a transcript that *includes a retcon turn* → prove no retcon-derived line (and no fabricated line) reaches the generated `ft_context`. This is the novel leak surface this piece introduces; the matrix must test the transcript→`ft_context` path, not just playbook→summary.

---

## 6. The analysis Opus call (prompt + selection rules)

A new LLM call (`llm/post-session-analysis.ts` + a flat Zod schema for `PostSessionAnalysis` + `prompts/session/post-session-analysis.txt`), Opus, through `generateObject` + repair + `redactRawText`. Flat root, no `.refine`, `.min(1)` floors on prose, **no `.max()`** on free-prose fields (the voice excerpts + summary are free prose).

The call pins **`maxOutputTokens`** + **`timeoutMs`** (§2 input-size bound) and a stated `repairStrategy`; **`repairAttempted === true` voids the verbatim guarantee** (a repair model may rewrite the `voice[]`), so on repair the worker re-runs the §5 containment verification (a repaired excerpt that no longer matches the transcript is dropped). The prompt receives the **bounded** transcript tail + running summary, the `sd_playbook`, and the participant roster. Its rules:

- **`summary`/`emergingThreads`**: only what the players witnessed — never reveal or hint at playbook (or running-summary) secrets the session didn't surface.
- **NPC `voice` excerpts (D5)**: emit **verbatim** transcript lines (quote exactly — never paraphrase, never invent); choose **≈2 per major NPC** that show **how the NPC treats / feels about / acts around the PCs**, preferring **late-session** excerpts (the evolved relationship); **never** pick generic first-impression / stereotype lines; **never** quote a `[[DM CORRECTION:]]` or farewell line. (These selection-*quality* rules are prompt-guided; the *correctness* guards — verbatim-containment + correction-row exclusion — are mechanical, §5.)
- **`keyLocations.atmosphere`**: a verbatim sensory snippet per major location.
- **`handoff`**: a precise, specific end-state snapshot (exact per-PC locations, time of day, urgent unresolved threads, NPC dispositions).

**Quality vs. correctness (Pharos I5, `feedback_smoke_vs_eval`).** "Relational / late-session / non-stereotype" excerpt *quality* is an **eval-harness** concern, NOT gated by 74b's tests. 74b's tests gate only the **mechanical** properties: verbatim-in-(non-correction)-transcript, the array bounds, and secret-free. The smoke asserts those; it does not (cannot, with one run) assert affect-quality.

---

## 7. Interface contracts / what changes

- **New:** `session/post-session-analysis.ts` (queue + worker, modeled on `session-reconcile.ts`); `llm/post-session-analysis.ts` + `llm/schemas/post-session-analysis.ts` + `prompts/session/post-session-analysis.txt`.
- **Changed:** `session/turn-queue.ts` (a `trigger.kind: 'farewell'` + the player-less payload, mirroring `'correction'`, with `correctionText`-style farewell-direction text); the **transcript codec / `session_messages` write path** (carry the originating `trigger.kind` onto rows so the analysis can structurally exclude `correction`/`farewell` rows — §5; verify whether a column exists or is added); `session/turn-worker.ts` (render the farewell via the silent-consume direction seam; the shared `isPlayerless` gates; the **unconditional finalize** in the farewell turn's `finally`/terminal path + the `QueueEvents` backstop for the `maxStalledCount` terminal — §1.3); `session/session-end.ts` (claim `ending` → `cancelSuspend` → suppress re-mature/drain → enqueue `farewell` turn with `jobId`; the finalize moves to the turn worker); `prompts/session/ft-system.txt` (only if the farewell needs a prompt cue beyond the existing direction seam — prefer no new branch, M8); `repo/sessions.ts` (`writeAnalysis(id, {summary, emergingThreads, handoff})` conditional gate + `getPriorContextForPrep(campaignId)`); `routes/sessions.ts` (`409 session_ending` start-guard while the `ending` flag is set); `llm/prep/serialize-world-state-for-prep.ts` (widen `PriorSessionContext`; render recaps + handoff anchor incl. NPC `state`); `llm/prep/stages/session-prep.ts` (`generateSessionPrep` returns `ft_context` for the processor to append to); `llm/prep/session-prep-processor.ts` (fetch via `getPriorContextForPrep`, `safeParse` the handoff, build `priorSessionContext`, **deterministically append the verbatim voice+atmosphere section to `ft_context` before `insert`**); `worker.ts` (run the analysis worker); `server-queues.ts` (the `session-analysis` queue + its prune policy).
- **Reused:** the player-less-turn seam (the MYT-73 correction turn), the publisher (farewell stream), the boot-probed Opus path, `makeSessionState` (the Redis running-summary read), `withTransaction`, the suspend/reconcile worker patterns, the existing `sessions.summary`/`handoff` TEXT columns (no migration).

---

## 8. Testing

- **Unit:** the analysis Opus call (mock `'ai'`); the **verbatim-containment verifier** (an emitted excerpt not locatable in a non-correction transcript row is dropped — the §5 mechanical guard); the **correction/farewell row exclusion** (a `voice` excerpt is never sourced from a `correction`/`farewell` row); the analysis worker (injected fakes — the Redis running-summary read, the idempotent gate, persist, structural-only failure log); the **unconditional finalize** (a farewell turn that THROWS still flips status + enqueues reconcile + analysis — the Eddystone-C1 guard); the `isPlayerless` gates (farewell: no watermark advance, no Scribe enqueue, no `turn_error`); the prep `getPriorContextForPrep` + `safeParse` (malformed handoff → no-handoff, not a throw; cold-start session 1 → empty); the **deterministic `ft_context` injection** (the verbatim voice **and** atmosphere appear byte-identical in the generated `ft_context`, not paraphrased).
- **Leak matrix (break-it-to-prove-it):** (a) the analysis over a **secret-bearing `sd_playbook` AND a secret-adjacent running summary** → `summary`/`emerging_threads` carry no secret token (semantic curated-paraphrase check + a negative control that fires); (b) the `redactRawText` reject arm + the worker's failure log carry no secret content; (c) **the transcript→`ft_context` path** — seed a transcript that *includes a MYT-73 `[[DM CORRECTION:]]` retcon turn*, run the analysis + the deterministic injection, and assert **no retcon-derived (or fabricated) line appears in the generated `ft_context`** (the novel leak surface this piece introduces).
- **Gated real-LLM smoke (driven before handback):** seed + drive a real session to end → assert the farewell streamed, the Opus analysis persisted `summary` + `handoff` (with verbatim NPC voice excerpts that the **containment verifier confirms** appear in the seeded transcript), the summary is secret-free, and the next prep's `priorSessionContext` opens "where we left off" **with the NPC voice + location atmosphere present verbatim in the generated `ft_context`** (the end-to-end consistency proof). The affect-*quality* of the excerpts (relational / late-session) is **logged for eval, not asserted** (`feedback_smoke_vs_eval`).

---

## 9. Out of scope (restated)

`faction_updates`, any player/owner recap surface or endpoint, `regenerate-handoff`, promoting voice excerpts to durable entity canon, prompt-cache reuse, 74c/74d. 74b ends a session with a live farewell and a durable, prep-consumed record that carries plot **and** NPC characterization into the next session.

---

## 10. Blind-review record

**Round 1 (Lighthouses)** — 4 reviewers (Pharos = LLM-orchestration, Eddystone = lifecycle/concurrency, Hook = data-flow/prep, Fastnet = enforced-ignorance). **2 showstoppers, resolved + substantial NITs folded in:**

- **Showstopper (Eddystone C1) — the finalize was unreachable on a failed/stalled farewell render**, leaving sessions permanently un-ended (the spec's "a session always ends" guarantee was mechanically false). **Fixed (§1.3):** the finalize runs unconditionally in the farewell turn's `finally`/terminal path + a `QueueEvents` backstop for the `maxStalledCount` terminal — the farewell is best-effort, the finalize is unconditional.
- **Showstopper (Fastnet C1 / Pharos C1) — the verbatim voice excerpts could carry MYT-73 retcon `[[DM CORRECTION:]]` prose (a secret pointer) or a fabricated quote into the next `ft_context`** — an enforced-ignorance breach. **Fixed (§5):** transcript rows carry `trigger.kind`; voice-excerpt selection + the injector **structurally exclude** `correction`/`farewell` rows; a **mechanical verbatim-containment verifier** confirms every excerpt appears in a non-excluded transcript row before storage/injection; the §8 leak matrix adds the transcript→`ft_context` case (seed a retcon → prove no retcon-derived line reaches `ft_context`).

NITs folded in: the running-summary source was wrong (it's the Redis `:summary` key, not the suspend-overloaded `sessions.st_running_summary` column — §2); pinned `maxOutputTokens`/`timeoutMs` + an input-size bound on the largest-session call (§2); the prep-consumption seam fully specified — `getPriorContextForPrep` + the handoff-present-not-reconcile-gated predicate + ordering/bound/cold-start + the processor-level deterministic injection naming `generateSessionPrep` (§4); atmosphere joins the deterministic injection (was routed through the paraphrasing prep prompt — §4); the TEXT-as-JSON serialization contract + `safeParse`-on-read + `emerging_threads` stored with the summary not in the secret-aware handoff blob (§3); the repair-voids-verbatim posture (§6); secret-free reclassified as best-effort/residual-risk with a semantic-paraphrase leak test against both secret inputs + the structural-only log-surface rule (§5); the relational/late-session excerpt *quality* reclassified as eval not smoke (§6/§8); the farewell uses the silent-consume direction seam not the `[[DM CORRECTION:]]` marker + `isPlayerless` gates + a per-session farewell `jobId` + the `session_ending` start-guard + the queue prune policy (§1/§7). Stopping rule: 1–2 showstopper → ship; no round 2.
