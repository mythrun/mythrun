# MYT-73 — Scribe Reconciler: working set, FT fact-delta, secret tripwire & retcon (design)

> **Status:** approved at brainstorm 2026-06-16. Continuation of MYT-72 (which shipped **relay-only** — the ST-vet's inventions carry forward only in the FT transcript, no durable writes). MYT-73 builds the **in-session** canonization layer. The heavy end-of-session reconcile-to-canon is **MYT-74**.
>
> **Spec basis:** Multiplayer Session Runtime §9 (Scribe), §17.5 (two lookup channels), §17.6 (resolver), §17.7 (the write-authority map — Class 2 = MYT-73), §17.8 (open questions — both resolved here).

## 1. Goal & scope

**Goal:** turn improvisation into durable-*eligible* canon **without breaking secrets** — close the read-after-write gap MYT-72 left open, and catch the one contradiction that can't wait (a core-secret break) with an in-fiction retcon.

**In scope (MYT-73):**
- The ephemeral **session working set** (Redis, session-keyed, rides the 5-min checkpoint).
- **Read side:** the §17.6 resolver reads **working-set ∪ canon**.
- **Two write sources:** the FT's emitted **fact-delta** section; MYT-72's **ST injections** (lookup `invent`/`relay`).
- The per-turn **secret tripwire** (Haiku, secret side).
- The **retcon** flow (dedicated Opus author → proactive DM turn → append-only supersede in the working set).

**Out of scope (→ MYT-74):** the heavy end-of-session **match-vs-mint reconcile-to-canon**, the multi-substrate durable commit (relational row + relationship edges + pgvector embedding + coordinates), **non-secret contradiction handling** (the absorb/reconcile rungs of the Class-3 ladder run at session end with full context), the wiki refresh, transcript search.

### 1.1 Decisions (brainstorm 2026-06-16)

- **D1 — Ephemeral-only.** MYT-73 makes **zero durable Postgres canon writes**. The working set (FT fact-delta + ST injections + retcon supersedes) lives entirely in Redis session state and rides the existing 5-min `:state` checkpoint for crash durability. MYT-74's end-of-session reconcile is the **sole** path that commits anything to durable canon. (Matches §17.7 "proposed in-turn, reconciled at session end.")
- **D2 — Discrete dedicated LLM calls** (not folded into the st-evaluation director; mirrors MYT-72's lookup-gate + ST-vet pattern). The **tripwire** is a new per-turn Haiku call; the **retcon-author** is a new dedicated Opus call fired *only on a tripwire hit*. Each prompt is single-purpose. Retcon **delivery** reuses the existing one-shot-direction channel + the DM-trigger machinery (no new delivery mechanism).
- **D3 — Embed-on-append + semantic merge.** Each working-set fact gets a real Voyage embedding when it lands (reuse the MYT-71 boot-probed embedder). The §17.6 `search_lore` resolver cosine-merges the small in-memory working set with the pgvector canon results; the graph tools merge working-set entities/relationships structurally. A fact invented turn 5 is semantically findable turn 9.
- **D4 — NPC write semantics: attributed by channel** (resolves §17.8). A working-set item carries a **provenance/truth-status**: DM-channel relays + FT fact-deltas are `objective`; NPC-channel answers are `attributed` to the conveying NPC ("NPC X conveyed Y", non-objective). The resolver/ST later surfaces attributed items as such ("you recall the smith *told* you…"), preserving that NPCs can be partial/wrong/lying. Carried into MYT-74.
- **D5 — FT-emitted fact-delta section** (not a post-hoc Haiku extraction; corrects an earlier draft). The FT appends a delimited section at the end of its turn; the FT knows exactly what it introduced, it costs no extra call, and it is **public by construction** (the FT never sees secrets). A **delimiter-guard** in the consume loop keeps the section off the player stream (D5.1).
- **D6 — Retcon delivery: proactive DM turn.** On a tripwire hit + authored retcon, set the one-shot direction **and** fire a proactive DM turn (reuse the MYT-67 DM-trigger) so the correction lands immediately, not whenever the next player message happens to arrive. A false core-secret fact's blast radius grows every turn it sits.
- **D7 — In-turn contradiction handling is core-secret breaks ONLY.** Every other contradiction (non-secret, peripheral) defers to MYT-74's full-context reconcile (the absorb/reconcile rungs). MYT-73 implements only the bottom rung — detect-and-retcon a core-secret break — in-turn.

## 2. The session working set (§17.7 Class 2)

A new ephemeral structure in Redis session state, **session-keyed** (`session:{campaignId}:workingset` — derived from the existing `:state` base key; it is per *live session*, cleared at session end after MYT-74 consumes it). Loaded per-turn into the transient controller, appended to, flushed back on the controller's existing Redis flush + the 5-min checkpoint.

### 2.1 Item shape

Each working-set item is one proposed narrative datum:

```ts
interface WorkingSetItem {
  readonly id: string                 // uuidv7, working-set-local (NOT a canon entity/fact id)
  readonly kind: 'fact' | 'entity' | 'relationship'
  readonly content: string            // the prose datum (the relay text, the FT-introduced fact, the retcon Z)
  readonly subjectName: string        // the named thing this is about (entity-resolution handle for MYT-74)
  readonly tier: AccessLevel          // 'known' | 'discoverable' | 'secret' — from the ST-vet, or 'known' for public FT deltas
  readonly provenance:                // D4
    | { kind: 'objective' }                                  // DM-channel relay / FT fact-delta
    | { kind: 'attributed'; npcEntityId: string; npcName: string }   // NPC-channel — a claim, not ground truth
  readonly source: 'ft_delta' | 'st_injection' | 'retcon'   // who proposed it
  readonly embedding: readonly number[]   // 512-dim Voyage vector (D3) — embed-on-append
  readonly supersedesId: string | null    // set on a retcon item: the working-set item it corrects
  readonly turnId: string                  // provenance for MYT-74 + crash forensics
}
```

> **Tier on a public FT delta.** FT fact-deltas are public by construction → `tier: 'known'`. ST injections carry the ST-vet's `tier`. (A `secret`-tier item can exist in the working set — e.g. the ST sanctioned a reveal — but only because the ST authored it; the FT never minted a secret.)

### 2.2 Embed-on-append (D3)

When an item is appended, the controller embeds `content` via the boot-probed `VoyageEmbedder` (the MYT-72/T9 instance, already threaded into the turn worker) and stores the vector on the item. Embedding failure is **fail-soft**: the item is appended with an empty embedding and a `degraded` log; it is still findable by the graph/lexical paths and by MYT-74 (which re-embeds at commit). The embedder is already config-classified (MYT-71): a *config* error at this point logs `*_misconfigured`, a *transient* one logs `*_degraded` — neither blocks the turn.

### 2.3 Crash durability

The working set rides the existing 5-min `:state` checkpoint (raw items incl. embeddings serialized into the checkpoint blob). A mid-session crash loses at most the last <5 min of proposals; on recovery the FT transcript still carries the player-visible narration, and MYT-74's reconcile re-derives from the transcript + the recovered working set. No new durability machinery.

## 3. The read side — working-set ∪ canon (§17.6)

The MYT-72 resolver closures (`search_lore` / `characters_known_to` / `faction_tree`, built in `lookup-wiring.ts`'s `buildLookupDeps`) gain a working-set merge:

- **`search_lore` (semantic):** after the pgvector canon query returns `LoreHit[]`, cosine-rank the **query embedding** against each working-set item's `embedding` (in-memory; the set is small), and merge the top working-set hits into the result list as `LoreHit`s tagged `source: 'working_set'` with their `accessLevel = tier` and `provenance`. The merged list funnels to the ST-vet exactly as canon hits do — **the over-pull/tier-gate boundary is unchanged** (the ST still vets; a `secret`-tier working-set item is gated the same as a `secret` canon fact).
- **Graph tools (structural):** working-set `entity`/`relationship` items merge by name/edge into the `charactersKnownTo` / `factionTree` results (small, cheap; no embedding needed). Tier-annotated like the T1 graph results so the ST-vet sees them.

**Provenance flows to the relay.** An attributed (NPC-claim) working-set hit reaches the ST-vet tagged as a claim; the ST-vet's prompt already authors the relay — it surfaces it as recollection of *what was said*, not ground truth. (No ST-vet schema change; the `results` block the orchestrator renders gains a `[claim by {npc}]` annotation alongside the existing `[tier=…]`.)

## 4. The FT fact-delta (§17.7 Class-2 source; D5)

### 4.1 Emission

The FT system prompt instructs: after the player-facing prose, emit a section
```
<player prose>
===WORLD_DELTA===
{ "facts": [ { "subject": "...", "content": "...", "kind": "fact" }, ... ] }
```
The post-delimiter body is a **Zod-validated JSON** delta (`WorldDeltaSchema`): a list of incidental named things the FT introduced (new NPCs, places, items, lore the FT minted in prose). Empty/absent section ⇒ no delta that turn (the common case). All items are `objective` provenance, `tier: 'known'`.

### 4.2 The delimiter-guard (D5.1) — load-bearing

The FT consume loop (`fast-thinker.ts` ~`if (part.type === 'text-delta')`) currently does `assembler.pushTextDelta(part.text); await emit.emitText(part.text)`. MYT-73 inserts a **stateful delimiter-guard** between assembly and emit:

- Maintain a small **hold buffer** (≤ delimiter length). On each text delta, scan for `=`. From the first `=` onward, route characters into the hold buffer **instead of** `emit.emitText` — the player sees nothing past a potential delimiter prefix.
- Disambiguate as more text arrives:
  - **Diverges** from `===WORLD_DELTA===` (a char that can't continue the delimiter — e.g. `2 = 2`) → **flush** the hold buffer to `emit.emitText` (it was a false alarm) and resume normal streaming.
  - **Completes** the delimiter → **stop player-emit entirely**; route all subsequent text into a **delta accumulator** (never emitted).
- The guard handles `=` split across token chunks (the buffer spans deltas) and a partial delimiter at stream-end (flush as prose).
- At `assembler.finalize`, split the full assembled text on the delimiter: the **pre-delimiter prose** is the assistant message (→ transcript, the player-facing part); the **post-delimiter body** is Zod-parsed into `WorkingSetItem`s (`source: 'ft_delta'`) → embedded → working set. A malformed/unparseable delta body is **fail-soft**: dropped with a warn (the prose still ships; MYT-74 re-extracts from the transcript).

> **Why the guard, not just a finalize split.** `emit.emitText` streams each delta to the player live; without the guard the player would briefly see `===WORLD_DELTA===` and the JSON before the turn finalized. The guard makes the section invisible *during* streaming, which is the user's hard requirement.

## 5. ST injections (§17.7 Class-2 source)

MYT-72's lookup flow produces `{mode, text, tier}`. MYT-73 wires the orchestrator (`world-fact-lookup.ts`) so that on `mode: 'invent'` **or** `'relay'`, the relayed text is appended to the working set as a `WorkingSetItem` (`source: 'st_injection'`, `tier` from the vet, `provenance` from the channel per D4). `mode: 'none'` writes nothing. This is the read-after-write close: a turn-5 invention is in the working set for a turn-9 lookup. (MYT-72 deliberately emitted the `tier` "for MYT-73 to consume" — this is that consumption.)

## 6. The secret tripwire (§17.7; D2) — secret side

After each FT turn (post-prose, off the hot path), a cheap **Haiku** call checks the turn's assertions against the prep's **core secrets**.

- **Inputs (secret side):** the turn's player-facing prose (public) + the **`sd_playbook`'s core secrets** — read via the dedicated narrow `LookupVetRepo.getSdPlaybookBy` surface MYT-72/T9 built (the same secret-side seam; **never** the secret-free `FtTurnContext`, never widening `TurnWorkerRepo.sessionPreps`).
- **Output (control signal only):** `{ breached: boolean, secretRef: string | null, why: string | null }` — a Zod-flat object. The output is a **control signal**, never content for the FT or the working set. On `breached: false` (the overwhelming common case), the turn is done — cost is one Haiku call.
- **What "core secret" means:** the playbook's secrets that are currently *in play and breakable* per §17.4 (the revelation-condition'd facts, not every backstory line). The prompt scopes the check to those.
- **Raw-output suppression:** like the ST-vet, the tripwire's raw output reasons over secrets — it sets `redactRawText: true` (MYT-72/T4a) so a malformed Haiku response can't spill a secret into logs/diagnostics/SSE.

## 7. The retcon flow (§17.7 Class 3, bottom rung; D2, D6) — secret side

On `breached: true`:

1. **Author (dedicated Opus call, secret side).** A new `runRetconAuthor` (single-purpose, modeled on the ST-vet's shape) sees: the breached assertion, the `sd_playbook` core secret, and recent narration. It writes `Z` — a **secret-preserving correction** that removes the contradiction **without revealing the secret** (the FT still never learns the secret; an early reveal only if the playbook's revelation conditions already allow). Output: `{ retconText: string, supersededContent: string, tier: AccessLevel }`. `redactRawText: true`. Discard-on-repair (a repaired tree's prose was re-authored — fail-soft to no-retcon-this-cycle; the next turn's tripwire re-fires).
2. **Deliver (D6).** `retconText` is set as the **one-shot direction** (`setOneShotDirection`) **and** a **proactive DM turn is enqueued** (`enqueueTurn(sessionTurnQueue, …)`, the MYT-67 explicit-summon machinery). The next FT turn — fired immediately by the proactive trigger — consumes the one-shot direction and delivers the retcon in DM voice ("earlier I said X — correction, it's actually Z; from there…"). The FT receives only the **secret-free `Z`**.
3. **Record (D1, ephemeral).** A `WorkingSetItem` (`source: 'retcon'`, `supersedesId` → the working-set item carrying the false fact, if it originated there; else `supersedesId: null` with the superseded content captured for MYT-74) is appended — an **append-only supersede event** in the working set. History stays intact; MYT-74 commits the supersede to durable canon.

> **Tripwire vs retcon-author split (D2).** The tripwire is the cheap per-turn gate (Haiku); the Opus author runs **only** on a hit. Net per-turn Scribe cost vs the old §9 design goes *down*: no per-turn Sonnet extraction, just a Haiku tripwire + (rarely) the Opus author + the working-set append.

## 8. Enforced-ignorance boundary (the load-bearing invariant)

```
SECRET SIDE (see sd_playbook):  tripwire (Haiku)  ·  retcon-author (Opus)
   their ONLY outputs:          control signal     ·  secret-free Z
                                       │                    │
PUBLIC SIDE (FT / working set / resolver): ◄──────────── secret-free Z
   working set holds ONLY: vetted relays (ST-vet, MYT-72) · public FT deltas · secret-free retcon Z
```

- The tripwire/retcon-author read `sd_playbook` via the dedicated `LookupVetRepo` surface; nothing on `FtToolDeps` / `ft-tools.ts` / `fast-thinker.ts` / the working set ever holds a raw secret.
- The tripwire's output is a control signal (never content). The retcon-author's output `Z` is ST-authored to be secret-free.
- The working set the FT + resolver read is **secret-free by construction**: every item is either a MYT-72 ST-vetted relay (already secret-free), a public FT delta, or a secret-preserving retcon. (A `secret`-*tier* item can exist — the ST sanctioned it — but "secret-tier, ST-authored, gated by the ST-vet on read" ≠ "a raw playbook secret the FT minted.")
- **Leak-test matrix (T-level):** (a) a tripwire over prose that breaches a secret → the secret never appears in the tripwire's logged output/diagnostic; (b) the retcon `Z` never contains the secret token; (c) the working set never contains a raw `sd_playbook` secret string; (d) an attributed NPC-claim working-set item, surfaced by a later lookup, never elevates to objective truth in the relay.

## 9. Edge cases & fail-soft

- **No delta / no breach (common path):** FT emits no `===WORLD_DELTA===`; tripwire returns `breached: false`. Cost: one Haiku. Nothing written.
- **Malformed FT delta JSON:** dropped with a warn; prose ships; MYT-74 re-extracts from transcript. (Never blocks the turn.)
- **Embed failure on append:** item appended with empty embedding + `degraded` log; still graph/lexical-findable; MYT-74 re-embeds.
- **Tripwire LLM failure (transient/config):** fail-soft — log, no retcon this cycle; the next turn's tripwire re-fires (the false fact persists one more turn, the accepted cost of a provider blip). A *config* failure escalates loudly (`*_misconfigured`) per the MYT-71 posture.
- **Retcon-author repair/failure:** discard-on-repair / fail-soft → no retcon this cycle; re-fires next turn.
- **Proactive turn collides with a real player turn:** the MYT-67 lock + the one-shot direction's latest-wins SET handle it (the direction rides whichever turn runs first; no double-retcon — the supersede item's presence gates re-authoring).
- **Working-set unbounded growth:** a hard per-session cap (config) on working-set item count; on overflow, oldest **public** items are evicted (they survive in the transcript for MYT-74); ST injections + retcons are never evicted (they're the read-after-write-critical ones). Logged.

## 10. Interface contracts

- **`Scribe.extract(ctx) → ScribeResult`** becomes real: `ScribeResult.workingSetDeltas: readonly WorkingSetItem[]` (typed; was `readonly unknown[]`). The controller flushes the deltas to the Redis working set (it currently discards the stub's `[]`).
- **`WorkingSetRepo`** (Redis): `load(campaignId) → WorkingSetItem[]`, `append(campaignId, items)`, `evictIfOver(campaignId, cap)`, rides the checkpoint. Session-keyed; cleared at session end (post-MYT-74-consume).
- **`buildLookupDeps`** (MYT-72/T9 `lookup-wiring.ts`) gains the working-set read merge into the search/graph closures.
- **`world-fact-lookup.ts`** orchestrator gains the ST-injection append on `invent`/`relay`.
- **`fast-thinker.ts`** consume loop gains the delimiter-guard + the finalize split; the FT system prompt gains the `===WORLD_DELTA===` instruction; `WorldDeltaSchema` (Zod).
- **`secret-tripwire.ts`** (new, `llm/`): `runSecretTripwire(input) → {breached, secretRef, why}`. **`retcon-author.ts`** (new, `llm/`): `runRetconAuthor(input) → {retconText, supersededContent, tier}`. Both: dedicated prompts, `redactRawText: true`, secret-side `sd_playbook` via `LookupVetRepo`.
- **Job topology (D2 — separate from st-eval).** The **cheap working-set append** (parse the FT delta + the ST injections — both already computed during the turn) is synchronous in the turn: `Scribe.extract` returns the deltas, the controller flushes them to the working set. The **tripwire (Haiku) + on-hit retcon-author (Opus)** run in a **dedicated post-turn Scribe job** — enqueued at turn end and modeled on the `st-evaluation-worker`'s job pattern, but a *separate* job (the user chose discrete calls over folding into st-eval). It runs off the hot path so the Opus retcon never blocks the transient controller's teardown, and it holds the secret-side `sd_playbook` read + the direction/trigger surfaces. On a hit it calls `setOneShotDirection` + `enqueueTurn` (existing trigger-state + turn-queue surfaces). The job runs every turn (the tripwire must); the Opus author fires only on a breach.

## 11. Testing

- **Unit:** the delimiter-guard (the full state machine — false-alarm flush, split-chunk `=`, partial-at-end, clean split); `WorldDeltaSchema`; the working-set read-merge (cosine merge + provenance flow); the tripwire/retcon LLM wrappers (mock `'ai'` `generateText`, like the ST-vet tests); the orchestrator ST-injection append.
- **Leak matrix (real PG + forced LLM):** §8 (a)–(d), the load-bearing enforced-ignorance proof, modeled on MYT-72's `world-lookup-leak.test.ts` (break-it-to-prove-it).
- **Gated real-LLM smoke:** seed a world + a `sd_playbook` core secret; drive a turn whose FT prose breaches the secret → assert the real Haiku tripwire fires, the real Opus retcon-author writes a secret-free `Z`, a proactive turn is enqueued, and the supersede lands in the working set — secret never leaks (wire-level: working-set inspection, logs, the delivered prose). Plus the happy path: an FT delta is readable (semantically) by a next-turn lookup.

## 12. Out of scope (→ MYT-74), restated

The end-of-session **match-vs-mint reconcile** of the working set into durable canon (relational + edges + pgvector + coords), non-secret contradiction absorb/reconcile with full context, the wiki refresh, transcript search. MYT-73 hands MYT-74 a fully-populated, tier+provenance-annotated working set.

## 13. Blind-review record

_(to be appended after the blind-review round)_
