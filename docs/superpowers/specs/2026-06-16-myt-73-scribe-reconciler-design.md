# MYT-73 — Scribe Reconciler: working set, FT fact-delta, secret tripwire & retcon (design)

> **Status:** approved at brainstorm 2026-06-16; hardened through blind-review round 1 (Ancient cities) — 2 showstoppers (data-flow path; retcon delivery) resolved with the user, NITs folded in. Continuation of MYT-72 (which shipped **relay-only** — ST-vet inventions carry forward only in the FT transcript, no durable writes). MYT-73 builds the **in-session** canonization layer. The heavy end-of-session reconcile-to-canon is **MYT-74**.
>
> **Spec basis:** Multiplayer Session Runtime §9, §17.5–17.8 (the write-authority map — Class 2 = MYT-73; §17.8 open Qs resolved here).

## 1. Goal & scope

**Goal:** turn improvisation into durable-*eligible* canon **without breaking secrets** — close the read-after-write gap MYT-72 left open, and catch the one contradiction that can't wait (a core-secret break) with an in-fiction correction.

**In scope (MYT-73):** the ephemeral **session working set** (Redis, rides the 5-min checkpoint); the **read side** (resolver reads working-set ∪ canon); the **two write sources** (FT-emitted fact-delta; MYT-72 ST injections); the per-turn **secret tripwire** (Haiku, secret side); the **retcon** flow (dedicated Opus author → a first-class **correction turn** → append-only supersede in the working set).

**Out of scope (→ MYT-74):** the heavy end-of-session **match-vs-mint reconcile-to-canon**, the multi-substrate durable commit, **non-secret contradiction handling** (the absorb/reconcile rungs run at session end with full context — D7), the wiki refresh, transcript search.

### 1.1 Decisions

- **D1 — Ephemeral-only.** Zero durable Postgres canon writes. Working set (FT deltas + ST injections + retcon supersedes) lives in Redis session state, rides the 5-min `:state` checkpoint. MYT-74's reconcile is the sole durable-commit path.
- **D2 — Discrete dedicated LLM calls** (not folded into the st-evaluation director; mirrors MYT-72). Tripwire = a new per-turn Haiku call; retcon-author = a new dedicated Opus call fired *only on a tripwire hit*. Both via `generateObject` with `redactRawText` (secret side). Delivery via a new correction-turn mode (D6).
- **D3 — Embed-on-append + semantic merge** (Voyage, reuse MYT-71 embedder). Working-set facts embedded **as documents** (input-type parity with canon); the `search_lore` resolver cosine-merges them with pgvector canon using the **same query vector** `searchLore` already computes; graph tools merge structurally.
- **D4 — NPC write semantics: attributed by channel.** DM-channel relays + FT deltas → `objective`; NPC-channel answers → `attributed:{npc}` (a claim, not ground truth). Surfaced as recollection-of-a-claim; non-elevation to objective is a first-class tested invariant.
- **D5 — FT-emitted fact-delta section** (not post-hoc extraction). The FT appends a newline-anchored delimited section; the consume loop's **delimiter-guard** keeps it off the player stream **and** off the persisted transcript (D5.1, §4.2).
- **D6 — Retcon delivery: a first-class player-less "correction turn."** The silent one-shot-direction channel cannot deliver an *open* correction (the FT prompt hard-rule is "consume directions silently, never acknowledge"), and the DM-trigger no-monologue guard suppresses player-less turns. So MYT-73 adds (a) a **correction-turn kind** — a player-less turn with a watermark that does **not** advance past unresponded player seqs — and (b) a distinct FT prompt affordance: a `[[DM CORRECTION: Z]]` marker that is the explicit **exception** to the silent-consume rule (deliver Z openly in DM voice — "earlier I said X — correction, it's actually Z" — then hand the floor back).
- **D7 — In-turn contradiction handling is core-secret breaks ONLY.** Non-secret self-contradictions (a renamed NPC, a moved landmark) get **no in-session correction** — they defer to MYT-74's full-context reconcile. **Named accepted v1 limit** (§9): players may see an uncorrected non-secret slip mid-session; MYT-73 deliberately does not add a general in-turn consistency checker (added scope + cost + spurious-correction risk). The tripwire is tuned for the high-stakes break only.
- **D8 — The turn data-flow path** (resolves the blind-review data-flow gap, §2.4). The FT's `render()` surfaces the parsed delta on its return value; mid-turn ST injections accumulate in a **turn-scoped sink** threaded through `FtToolDeps`; a **dedicated post-turn Scribe job** receives the rendered prose + the delta + the injection sink and does the working-set append + tripwire + (on hit) retcon. The MYT-72 vet surfaces are widened to actually carry `{mode, tier}` out of the tool.

## 2. The session working set (§17.7 Class 2)

Ephemeral Redis state keyed by campaignId (`session:{campaignId}:workingset` — one live session per campaign, the existing `:state` keying; cleared at session end after MYT-74 consumes it).

### 2.1 Item shape

```ts
interface WorkingSetItem {
  readonly id: string                 // uuidv7, working-set-local (NOT a canon id)
  readonly kind: 'fact' | 'entity' | 'relationship'
  readonly content: string            // the prose datum
  readonly subjectName: string        // the named thing (entity-resolution handle for MYT-74)
  // 'relationship' items additionally carry typed endpoints so the graph merge has something to merge on (Nineveh-I1):
  readonly edge?: { readonly fromName: string; readonly toName: string; readonly relType: string }
  readonly parentName?: string        // 'entity' items that are sub-factions: the parent (graph merge)
  readonly tier: AccessLevel          // 'known' for FT deltas (parser-stamped, never FT-supplied — I3); the ST-vet's tier for injections
  readonly provenance:
    | { kind: 'objective' }
    | { kind: 'attributed'; npcEntityId: string; npcName: string }
  readonly source: 'ft_delta' | 'st_injection' | 'retcon'
  readonly embedding: readonly number[]   // 512-dim Voyage DOCUMENT vector (D3); held in the in-memory working set only
  readonly supersedesId: string | null    // retcon items: the item they correct (or null + supersededContent for an injection that wasn't working-set-resident)
  readonly turnId: string
}
```

### 2.2 Embed-on-append

On append, the post-turn Scribe job embeds `content` via the boot-probed `VoyageEmbedder` using the **document** input-type (`embedDocuments` path, dimension/model parity with canon — Nineveh-C2). Embed failure is **fail-soft**: the item is appended with an empty embedding, logged (config error → `*_misconfigured`, transient → `*_degraded`, per MYT-71). **Accepted limit (Nineveh-I4):** an empty-embedding `fact` item is **not** `search_lore`-findable until MYT-74 re-embeds (semantic search has no lexical fallback) — named, not silent; entity/relationship items remain graph-findable by name.

### 2.3 Crash durability — embeddings are NOT checkpointed

The working set rides the existing 5-min `:state` checkpoint, but **only `content` + metadata are serialized — embeddings are stripped** (Nineveh-C3: 512 float64s ≈ 6–7 KB/item JSON × the §9 cap would add ~MB-scale write amplification to the `st_running_summary` TEXT column every 5 min). On crash recovery the working set is re-embedded (the recovery path is rare; MYT-74 re-embeds at commit regardless). This keeps the checkpoint blob bounded and avoids float round-trip concerns.

### 2.4 Turn data-flow (D8) — load-bearing

The blind review established that the parsed FT delta + the mid-turn ST injections + the tripwire's prose input have **no path** to the post-turn work on the current seams (`Scribe.extract(ctx: FtTurnContext)` is fire-and-forget, result-discarded, and `FtTurnContext` carries no rendered prose; the wired MYT-72 orchestrator drops `tier`/`mode`). MYT-73 specifies the path:

1. **ST injections (mid-turn).** `FtToolDeps` gains a **turn-scoped injection sink** — `recordInjection(item: WorkingSetProposal)` — a closure the controller constructs per turn and threads in. Inside `world-fact-lookup.ts`, on the vet returning `mode: 'invent' | 'relay'`, the orchestrator calls `recordInjection({ content: text, tier, provenance: <channel-derived>, source: 'st_injection' })` **synchronously within the tool `execute`**. To do this the MYT-72 surfaces are widened (a real MYT-73 change, not "consume what MYT-72 emitted"): `WorldFactLookupVet` → returns `{ mode, text, tier, repairAttempted }`; `runWorldFactLookup` → surfaces `{ relayText, skillGateFrame, rollHidden, vetMode, vetTier }`; the tool wires `recordInjection`. The sink accumulates into a turn-local array the controller owns.
2. **FT delta (turn end).** `FastThinker.render()` returns the parsed, Zod-validated delta on its result (`AssistantMessage` gains `readonly worldDelta?: WorldDelta`). The delimiter-guard (§4.2) produces it; it never rides the transcript.
3. **The post-turn Scribe job.** After `render()`, the controller enqueues a **dedicated Scribe job** (separate queue, modeled on the st-evaluation-worker; NOT the controller's fire-and-forget — the Opus retcon must not block controller teardown) carrying: `campaignId`, `sessionId`, `turnId`, the rendered **player-facing prose** (post-delimiter-split), the parsed `worldDelta`, and the **injection sink array**. The job: (a) embeds + appends all proposals to the working set (atomic append, §9), (b) runs the secret tripwire over the prose, (c) on a hit, runs the retcon-author + emits the correction turn (§7). `Scribe.extract`'s old fire-and-forget seam is **retired** in favor of this enqueued job; `ScribeResult` is superseded by the job payload.

> **Why a separate queue, not st-eval.** Per D2 (user chose discrete over folding into st-eval). The Scribe job and the st-eval job are independent post-turn consumers of the same turn; both read the secret side via the narrow `LookupVetRepo`, neither blocks the turn.

## 3. The read side — working-set ∪ canon (§17.6)

The merge happens **inside the `search_lore` resolver closure in `ft-tools.ts`, before `renderLoreHits` collapses `LoreHit[]` to a string** (Nineveh-C1 — the ST-vet sees a rendered string, not `LoreHit[]`, so the merge cannot live "after the resolver returns"):

- **`search_lore` (semantic):** `searchLore` is widened to also return the **query embedding** it already computes. The closure cosine-ranks that query vector against each working-set item's document embedding (in-memory; the set is small), maps the top working-set hits to `LoreHit` (`source: 'working_set'`, `accessLevel = tier`, plus a `provenance` field — `LoreHit` gains an optional `provenance`, a MYT-71-surface addition listed in §10), merges into `hits`, re-ranks by `score`, and applies the existing limit policy: **canon `limit` preserved; up to K working-set hits appended** (Nineveh-M3 — working-set hits never crowd out canon under a fixed limit). Then `renderLoreHits` renders `[tier=…][claim by {npc}] …` (provenance baked into the string — Nineveh-I2). The merged list funnels to the ST-vet exactly as canon does; **the over-pull/tier-gate boundary is unchanged** (a `secret`-tier working-set item is gated by the ST-vet the same as a `secret` canon fact).
- **Graph tools (structural):** working-set `entity`/`relationship` items merge into `charactersKnownTo`/`factionTree` by name + the typed `edge`/`parentName` (§2.1); items lacking a structural anchor append as flat nodes with `depth: null` (name-append only). Tier-annotated like the T1 graph results.

## 4. The FT fact-delta (§17.7 Class-2 source; D5)

### 4.1 Emission + schema

The FT system prompt instructs: after the player-facing prose, on its **own line**, emit:
```
<player prose>
[[WORLD_DELTA]]
{ "facts": [ { "subject": "...", "content": "...", "kind": "fact" }, ... ] }
```
`WorldDelta` is a Zod object; the body schema has **no `tier` field** — the parser stamps `tier: 'known'`, `provenance: {kind:'objective'}`, `source: 'ft_delta'` on every item (Ur-I3/Nineveh-M1: the FT never controls a tier label). The delimiter is **newline-anchored** (`\n[[WORLD_DELTA]]\n`) and uses `[[…]]` rather than `===` to slash false-positives (a mid-sentence `=` no longer trips the guard — Carthage-C3). Empty/absent ⇒ no delta. The cap-close instruction (`FT_CLOSE_INSTRUCTION`) is reconciled with the delta instruction so they don't compete (Carthage-C3): the close instruction explicitly permits the trailing `[[WORLD_DELTA]]` line.

### 4.2 The delimiter-guard (D5.1) — load-bearing, guards BOTH emit AND transcript

The FT consume loop (`fast-thinker.ts`, the `text-delta` branch: `assembler.pushTextDelta(part.text); await emit.emitText(part.text)`) gains a stateful guard that suppresses the delta section from **both sinks** (Petra-C1: guarding only `emit` lets the raw delimiter+JSON persist into the `dm_text` transcript row and re-inject into FT history forever — the exact MYT-72 §6 permanent-leak). The guard is a filter on the **text-delta substream** feeding *both* `pushTextDelta` and `emitText`:

- Maintain a hold buffer (≤ delimiter length, ~14 chars). The matcher targets the **exact literal** `\n[[WORLD_DELTA]]`. The guard arms only at a newline; from a `\n` followed by a `[` (a candidate), route chars into the hold buffer instead of to either sink.
- **Diverges** (a char that can't continue the literal): flush the hold buffer to **both** sinks, re-test the diverging char as a potential new candidate (KMP-style re-anchor — Petra-I1), resume.
- **Completes**: stop feeding **both** sinks; route all subsequent text into a delta accumulator (never assembled, never emitted).
- **Tool-call / step boundary while buffer non-empty** (Petra-I2): flush the pending partial to both sinks (a delimiter can't straddle a tool call); the guard state persists across step boundaries + ignored part types.
- **Partial delimiter at stream-end:** flush as prose.
- **Trailing prose after the JSON** (Petra-I3): discarded as malformed-turn output (the spec accepts this; the pre-delimiter prose is unaffected).
- **`finalize`:** `PartsAssembler.finalize` is delimiter-aware — the assembled text part contains **only** the pre-delimiter prose (it was never fed the tail). The delta accumulator's body is Zod-parsed into `worldDelta` on the `AssistantMessage`; unparseable ⇒ fail-soft (drop with a warn; prose still ships; MYT-74 re-extracts from the transcript).

**Tests (§11) MUST include the transcript-level assertion** (Petra-M3): the persisted `dm_text` row + the FT-history round-trip contain no delimiter and no JSON — the proof the permanent-leak is closed, not just an emit-stream check.

## 5. ST injections (§17.7 Class-2 source)

Wired per §2.4 step 1: on `mode: 'invent' | 'relay'` the relay text is recorded to the turn-scoped sink (`source: 'st_injection'`, `tier` from the widened vet output, `provenance` from the channel per D4); `mode: 'none'` records nothing. This is the read-after-write close — a turn-5 invention is in the working set for a turn-9 lookup.

## 6. The secret tripwire (§17.7; D2) — secret side

In the post-turn Scribe job (§2.4 step 3), a `generateObject` **Haiku** call checks the turn's player-facing prose against the prep's core secrets.

- **Inputs (secret side):** the rendered **player-facing prose** (from the job payload — the correct artifact, not the lossy running summary — Carthage-C1) + the `sd_playbook` core secrets, read via `LookupVetRepo.sessionPreps.getBy(campaignId, sessionNumber)` (the real method; resolve `sessionNumber` via `repo.sessions.getActiveByCampaign`, as the st-eval worker does — Ur-I1). An **unresolvable/empty playbook FAILS LOUD** (`*_misconfigured`, alarmable) — a tripwire silently checking against zero secrets is worse than an error (Ur-I1; `feedback_fail_loud_on_external_api_misconfig`).
- **Output (control signal; via `generateObject` so it inherits `redactRawText`):** `{ breached: boolean, confidence: number, secretRef: string | null }`. `secretRef` is an **opaque playbook handle/id, never prose** — and there is **no `why` free-text field**: the tripwire's *valid* output must not carry secret-derived prose, because `redactRawText` covers only the raw/repair channel, not the validated result (Carthage-I2). Nothing in the output is logged as prose; only `{breached, confidence, secretRef}` (handle) is logged.
- **Confidence + escalation (Principle #3 — Carthage-I3):** the tripwire is the highest-stakes classifier in the runtime; it carries a `confidence` and biases toward recall. A `breached:true` at high confidence → retcon-author. A **low-confidence** verdict (ambiguous) escalates to the Opus retcon-author for a second look rather than silently dropping. The recall/precision posture is stated so the implementer doesn't ship a coin-flip boolean.
- `redactRawText: true` (a malformed Haiku response reasoning over secrets can't spill into logs/diagnostics/SSE).

## 7. The retcon flow (§17.7 Class 3, bottom rung; D2, D6) — secret side

On a breach (or low-confidence escalation):

1. **Author** — `runRetconAuthor` (dedicated Opus `generateObject`, `redactRawText: true`, secret side). **Pinned (Carthage-I1):** schema `RetconResultSchema` (flat); `retconText` `.min(1)` **no `.max()`**; `maxOutputTokens` (~1200, ST-vet parity); a timeout; inputs = `{ breachedAssertion, sdPlaybookSecret, playerFacingProse, recentNarrative }`. It writes `Z` — a secret-preserving correction that removes the contradiction **without revealing the secret, paraphrased or implied** (the retcon-author prompt carries the **identical paraphrase-and-implication hard-rule clause** the ST-vet prompt uses — Carthage-I5). It prefers the **minimal honest correction** and folds the fix into narration where the secret allows (Tikal-M1). It fires the open "earlier I said X" framing **only when X was player-visible** prose (not an internal-only datum — Tikal-M2). Output `{ retconText, supersededContent, tier }`; discard-on-repair → fail-soft (no retcon this cycle; re-fires next turn).
2. **Deliver (D6 — correction turn).** A **player-less correction turn** is enqueued (a new turn kind; watermark does NOT advance past unresponded player seqs, so genuine pending messages aren't stranded — Carthage-C2/Tikal-C2). The correction turn injects `Z` as a `[[DM CORRECTION: Z]]` marker — the explicit FT-prompt **exception** to silent-consume — so the FT delivers it openly, then hands the floor back. The FT receives only the secret-free `Z`.
3. **Record (D1, ephemeral).** A `WorkingSetItem` (`source: 'retcon'`, `supersedesId` → the working-set item carrying the false fact, or `null` + `supersededContent` if it wasn't working-set-resident; `tier: 'known'` — it's what the player was told, never gated on read — Ur-M2) is appended. The supersede gates re-authoring (no double-retcon).

**Worst-case bound (Tikal-I3):** the unhappy chain (tripwire blip → repair-discard → collision) can delay a correction a few turns while the false fact compounds. The spec states a ceiling: if a breach `secretRef` persists **N turns** unresolved, force-escalate (and optionally inject a holding **steer** that stops the FT building further on the flagged fact until the correction lands).

## 8. Enforced-ignorance boundary (the load-bearing invariant)

Secret side (see `sd_playbook`): tripwire (Haiku) · retcon-author (Opus). Their ONLY outputs: an opaque control signal (`{breached, confidence, secretRef-handle}`) · the secret-free `Z`. Public side (FT / working set / resolver) holds ONLY: MYT-72-vetted relays · public FT deltas (`tier:'known'`, parser-stamped) · secret-preserving `Z`.

- The FT **never reads the working set as a context field**: `FtTurnContext.workingSet` stays `[]` permanently (it is retired/pinned-empty); the FT sees working-set content **only** through the ST-vet's relay (Ur-C1). The §8 leak matrix proves a secret-tier working-set item never reaches `buildModelMessages`.
- The working set persisted in the checkpoint is **never surfaced by any member-facing route** (the `GET /api/sessions/:campaignId/active` allowlist strips the whole `st_running_summary` column — Ur-C2); on recovery it re-enters only the resolver-side read, never `FtTurnContext.workingSet`.
- **Leak-test matrix (real PG + forced LLM, modeled on MYT-72's break-it-to-prove-it):** (a) tripwire over secret-breaching prose → secret absent from the rethrown `.diagnostic.rawTextSnippet`/`zodIssues` AND every warn-log arg (drive the terminal-failure path, structurally identical to `world-lookup-leak.test.ts` case (c)); (b) the retcon `Z` never reveals the secret — **a semantic check (LLM-judge or curated paraphrase set), not a single-token substring** (Carthage-I5); (c) the working set never contains a raw `sd_playbook` secret string; (d) an `attributed` NPC-claim item, surfaced by a later lookup **beside objective hits, with a different asker**, never elevates to objective truth in the relay (Tikal-I2 — tested across the messy merge, not a single assertion); (e) a secret-tier working-set item never appears in `buildModelMessages` / `FtTurnContext.workingSet`.

## 9. Edge cases & fail-soft

- **No delta / no breach (common):** FT emits no `[[WORLD_DELTA]]`; tripwire `breached:false`. Cost: one Haiku.
- **Malformed FT delta:** dropped + warn; prose ships; MYT-74 re-extracts.
- **Embed failure:** item appended w/ empty embedding (§2.2 accepted limit).
- **Tripwire / retcon-author LLM failure:** fail-soft (transient) → re-fires next turn; **config failure fails loud**.
- **Empty/unresolvable playbook:** fail loud (§6) — never a silent disarmed tripwire.
- **Parallel-player turns (Nineveh-I5):** turns are serialized by the per-session lock (MYT-66) — but `WorkingSetRepo.append` is nonetheless an **atomic server-side append** (Redis list `RPUSH` / append-only, never load-blob-mutate-`SET`) so a delta is never lost to a stale-snapshot flush.
- **Working-set growth / eviction:** a per-session item **cap** (config) set high enough that eviction is a **pathological-overflow safety valve, not a normal-session event**. On overflow, oldest **public** items evict — with the **named caveat** that evicting a public FT delta reopens the read-after-write gap for *that item* in-session (it survives only in the transcript, which the in-session resolver doesn't read — Nineveh-I3/Carthage-M3). ST injections + retcons never evict.
- **Correction turn collides with a real player turn:** the per-session lock + the supersede-item-gates-re-authoring rule prevent a double-retcon; the correction rides whichever turn the lock admits first.

## 10. Interface contracts

- **Retire** `Scribe.extract`'s fire-and-forget seam; the post-turn Scribe job (new queue + worker, modeled on `st-evaluation-worker`) is the consumer. `ScribeResult` → the job payload (prose + `worldDelta` + injection sink + ids).
- **`FtToolDeps`** gains `recordInjection(proposal)` (the turn-scoped sink). **`FastThinker.render` / `AssistantMessage`** gain `worldDelta?`. **`WorldFactLookupVet` / `runWorldFactLookup` / `LookupToolResult`** widen to surface `{mode, tier}` (§2.4 step 1).
- **`SearchResolvers.searchLore`** widens to also return the query embedding; the `search_lore` closure in `ft-tools.ts` does the merge (§3). **`LoreHit`** gains optional `provenance`.
- **`WorkingSetRepo`** (Redis): `load(campaignId) → WorkingSetItem[]` (re-embeds stripped vectors on load if absent), `append(campaignId, items)` (atomic), `evictIfOver(campaignId, cap)`; checkpoint serialization strips embeddings.
- **New `llm/` modules + prompt template files** (CLAUDE.md: prompts are `.txt`, not inline — Carthage-M4): `secret-tripwire.ts` + `prompts/session/secret-tripwire.txt`; `retcon-author.ts` + `prompts/session/retcon-author.txt`. Both `generateObject` + `redactRawText`, secret-side `sd_playbook` via `LookupVetRepo`.
- **Correction turn:** a new turn kind + the `[[DM CORRECTION:]]` FT-prompt affordance (the silent-consume exception) + the watermark-safe enqueue.

## 11. Testing

- **Unit:** the delimiter-guard state machine (re-anchor, tool-boundary flush, cross-step persistence, partial-at-end, clean split) **incl. the transcript-level "no delimiter/JSON persisted" assertion** (Petra-M3); `WorldDeltaSchema` (stray `tier` ignored → `'known'`); the read-merge (document-embed cosine parity, provenance-to-string, limit policy); the tripwire/retcon wrappers (mock the `'ai'` SDK `generateText` that `generateObject` wraps — like the ST-vet/leak tests — NOT a raw `generateText` call); the widened vet surfaces + `recordInjection`; `resolveWorldId`-style narrow-repo + the loud empty-playbook arm.
- **Leak matrix (real PG + forced LLM):** §8 (a)–(e), the load-bearing enforced-ignorance proof, break-it-to-prove-it.
- **Gated real-LLM smoke:** seed a world + `sd_playbook` secret; drive a turn whose FT prose breaches it → assert the real Haiku tripwire fires, the real Opus author writes a secret-free `Z` (semantic check), a **correction turn** is enqueued + the FT delivers `Z` openly, the supersede lands — secret never leaks (wire-level). Plus: an FT delta is semantically readable by a next-turn `search_lore` (read-after-write).

## 12. Out of scope (→ MYT-74), restated

The end-of-session match-vs-mint reconcile of the working set into durable canon, **all** non-secret contradiction handling (D7), wiki refresh, transcript search. MYT-73 hands MYT-74 a fully-populated, tier+provenance-annotated working set.

## 13. Blind-review record (round 1 — Ancient cities, 2026-06-16)

5 reviewers (Ur=enforced-ignorance, Carthage=LLM-orchestration, Petra=streaming-correctness, Nineveh=data-model/retrieval, Tikal=game-design). **2 showstoppers, resolved with the user:**
- **Data-flow gap** (Carthage-C1 / Nineveh-C1 / Petra-C2): the FT prose + parsed delta + mid-turn ST injections had no correct path to the post-turn work; the wired MYT-72 code dropped `tier`/`mode`; the merge insertion point was mis-located. → §2.4 (D8) + §3 + widened §10 surfaces.
- **Retcon delivery** (Carthage-C2 / Tikal-C1 / Tikal-C2): the silent one-shot direction can't deliver an open correction + the no-monologue guard blocks player-less turns. → D6: a first-class player-less **correction turn** + the `[[DM CORRECTION:]]` FT affordance (user-chosen).

**NITs folded in:** assembler-side delimiter-guard + transcript test (Petra-C1/M3); opaque `secretRef`, no `why`, `generateObject`+`redactRawText` (Carthage-I2/Ur-I2); `FtTurnContext.workingSet` pinned empty + checkpoint-route leak cases (Ur-C1/C2); document-embed + query-vector merge (Nineveh-C2/Carthage-I4); embeddings stripped from checkpoint (Nineveh-C3); tripwire confidence/escalation (Carthage-I3); retcon-author schema/budget/paraphrase-clause/minimal-correction/player-visible-X + semantic leak test (Carthage-I1/I5, Tikal-M1/M2); correct `sessionPreps.getBy` + loud empty-playbook (Ur-I1); FT-delta `tier` parser-stamped (Ur-I3/Nineveh-M1); graph-merge edge shape (Nineveh-I1); eviction caveat + atomic append (Nineveh-I3/I5); empty-embed named limit (Nineveh-I4); newline-anchored `[[…]]` delimiter + cap-close reconciliation (Carthage-C3); worst-case retcon bound (Tikal-I3); prompt-template-file deliverables (Carthage-M4). **D7 pushback** (Tikal-I1): user kept secret-only in-turn; the limit is named in D7/§9.

Stopping rule: 2 showstoppers → ship exit (fixed inline, no round 2).
