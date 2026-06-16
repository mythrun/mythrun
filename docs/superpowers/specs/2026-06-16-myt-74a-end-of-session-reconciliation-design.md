# MYT-74a — End-of-Session Reconciliation (working set → durable canon)

> **Status:** approved at brainstorm 2026-06-16 (6 scope/design decisions taken with the user). The **first of four** decomposed pieces of Linear issue MYT-74 (which bundles five subsystems). Direct continuation of **MYT-73** (the Scribe reconciler), which hands this piece a fully-populated, tier+provenance-annotated **session working set** and explicitly deferred the heavy reconcile-to-canon, all non-secret contradiction handling, the wiki refresh, and transcript search here.

**Goal:** commit a finished session's improvised facts to durable canon — turning the ephemeral working set into entities, append-only facts, and relationship edges — without breaking secrets or losing history, and build the session-end lifecycle that triggers it.

---

## Decomposition of MYT-74

MYT-74 as filed is an epic. It decomposes into four independently-shippable pieces, each its own spec → plan → implement cycle (timing follows dependency):

| Piece | Scope | Depends on |
|---|---|---|
| **74a (this spec)** | The session-end **lifecycle** + the **reconcile pass** (working set → canon) | MYT-73 |
| 74b | Post-session **Opus analysis** + the **handoff** to next prep | 74a |
| 74c | **Wiki-data refresh** (known facts per entity; UI is a Frontend ticket) | 74a |
| 74d | **Transcript-search API** over the player-facing transcript | — (independent) |

74b/74c plug into the lifecycle 74a builds. 74d is independent (it reads `session_messages`, public by construction).

---

## In / out of scope (74a)

**In scope.** (1) The session-end **lifecycle**: the `end_session` WS trigger + the token-budget-100% auto-end, the status transition, the off-hot-path reconcile worker, Redis flush + WS close + a structural `session_end` broadcast. (2) The **reconcile pass**: deterministic candidate retrieval → one holistic Opus reconciliation plan → structural validation → a transactional multi-substrate commit (entity rows + append-only facts + `superseded_by` pointers + relationship edges + pgvector embeddings) → working-set `clear()`. (3) The **append-only fact-log migration** + the read-path filter ripple.

**Out of scope.** The rich FT **farewell** prose + the post-session **summary/analysis/handoff** (→ 74b); the **wiki refresh** (→ 74c); **transcript search** (→ 74d); combat-map **"coordinates"** (the spec's multi-substrate list includes coordinates, but those are voxel/combat state owned by the Combat milestone — narrative canon here is entities + facts + relationships + embeddings); abandonment-timeout reconcile for suspended-but-never-resumed sessions (a later cleanup pass).

---

## Decisions

- **D1 — Decompose; build 74a first.** This spec is the end-of-session reconciliation + the session-end lifecycle. The other three pieces are separate cycles.
- **D2 — 74a owns the session-end lifecycle.** There is no session-end flow today (MYT-65 built `suspend`, which keeps `status='active'`); the `sessions.summary`/`handoff` columns are unpopulated. 74a builds the end trigger + orchestration shell (modeled on the `suspend` BullMQ worker) so the piece is end-to-end smoke-able. 74b/74c plug into it.
- **D3 — Holistic Opus reconciler emits a plan; deterministic code applies it.** ZFC: `findSimilarEntities` does mechanical candidate retrieval; ONE Opus call makes the match/mint/contradiction **judgment** and emits a structured plan; deterministic code validates (structural) + commits. One call → best cross-subject coherence (two working-set items that name the same new entity can't double-mint). No similarity-threshold auto-match (that hardcodes a judgment ZFC delegates to the model).
- **D4 — Append-only facts via a supersede pointer.** `facts` stays append-only (every assertion is a new row, content never edited); a nullable `superseded_by`/`superseded_at` pointer marks a corrected fact. Live canon = `superseded_by IS NULL`; history = the chain. Preserves the "why is this canon" audit trail MYT-73's retcon already assumes. `updateContentById`/`deleteById` are retired from the canon-correction path.
- **D5 — Triggers: explicit `end_session` + budget-100% auto-end.** Both run the same end→reconcile flow. The ~90% ST wind-down already exists (`st-config.ts`); 74a wires the 100% forced-end. Abandoned/suspended sessions stay `'active'` (later cleanup pass).
- **D6 — Attributed NPC-claims canonize with attribution baked into the fact content.** The working set already tags each item `provenance: objective | attributed{npcName}`. The Opus reconciler writes an attributed item as a fact whose content records the claim + its source ("Marsh the Fishmonger claims the harbor answers to smugglers"); an objective item writes plain ground-truth content. No schema column — the distinction survives in the prose the FT/resolver read later, so an NPC's lie/partial knowledge never silently becomes canon truth.

---

## 1. The session-end lifecycle

Two triggers converge on one flow:

- **Explicit** — a player sends `end_session` (new WS message type).
- **Budget auto-end** — the token budget reaches 100% (after the existing ~90% ST wind-down) forces the same flow.

The flow (modeled on `session/session-suspend.ts` — BullMQ job + the existing presence/lock machinery):

1. Transition `sessions.status → 'ended'`, set `ended_at = now()`. The session is over from the players' view immediately; `reconciled_at` stays NULL (it is set only by a successful commit, §4).
2. Enqueue ONE **reconcile job** on a new BullMQ queue (`session-reconcile`), keyed by `sessionId`. The Opus call + multi-table commit must NOT block the `end_session` response.
3. Flush remaining Redis turn-state, broadcast a structural `session_end`, close WS connections (reuse the suspend/flush machinery).
4. The reconcile worker (§2) runs async; on a **successful** commit it `clear()`s the working set.

The reconcile reads the working set from its **durable source** — MYT-73 rides it on the 5-min `:state` PG checkpoint — so a Redis eviction or crash can't lose uncommitted canon.

*The rich FT farewell + the post-session summary/analysis are 74b; 74a ends a session structurally + commits canon.*

---

## 2. The reconcile pass (the worker body)

ZFC-shaped: deterministic retrieve → LLM judgment → deterministic commit.

1. **Retrieve (deterministic).** Load the working set. For each distinct subject, `findSimilarEntities(worldId, …)` → top-K canon entity candidates; load those candidates' current (live) facts so the reconciler can see contradictions. `findSimilarEntities` already **throws on failure** (never silently mints a duplicate — MYT-71).
2. **Reconcile (one holistic Opus call — the judgment).** Input: the full working set (each item's `subjectName`, `content`, `kind`, `tier`, `provenance`, `source`) + the retrieved candidates + their live facts. Output: a structured **plan** (§6). Contradiction handling runs here with full context, **no retcons** (no live turn at session end): the model chooses **absorb** (canonize the improvised version) or **reconcile** (append the canonical version + supersede the contradicted fact), per the §17.7 ladder.
3. **Validate (deterministic, structural-only).** Referenced canon ids exist; minted entity types are legal (`npc|location|faction|item`); supersede targets are live facts on the right entity; no dangling refs. ZFC-safe — no semantic re-judgment. An invalid plan **fail-softs + alerts** (never a partial commit).
4. **Commit (deterministic, transactional — §4).** One repo transaction: mint entities (`created_in='session:<sessionId>'`, `encountered=true`, `modified_by_play=true`; matched entities get the flags too), append facts, set `superseded_by`/`superseded_at` pointers, insert relationship edges, write fact embeddings, set `sessions.reconciled_at`. The Voyage re-embed **call** runs before `BEGIN`; the resulting vectors are written **inside** the tx (slow I/O never inside a tx — MYT-55), so embeddings are atomic with the facts. Re-embed (rather than reuse working-set vectors) because the checkpoint strips working-set embeddings and the attribution-baked content differs from the raw item.
5. **Finalize.** On success → working-set `clear()`. On failure → don't clear (BullMQ retry). Terminal failure → alert; the working set persists on the durable checkpoint, recoverable.

---

## 3. The append-only fact log

**Migration** (one file): add to `facts` — `superseded_by UUID REFERENCES facts(id)` (nullable) + `superseded_at TIMESTAMPTZ` (nullable); add to `sessions` — `reconciled_at TIMESTAMPTZ` (nullable). A partial index on `facts(entity_id) WHERE superseded_by IS NULL` for the live-canon read path.

**Semantics.** Live canon = `superseded_by IS NULL`; full history = the chain. The reconcile path appends + sets pointers (content immutable). `updateContentById`/`deleteById` are no longer used for canon corrections (they may remain for other callers, verified during planning).

**Read-path ripple (in scope here).** Every canon **fact** reader must filter `superseded_by IS NULL` so a superseded fact never resurfaces to the FT/resolver: the world-retrieval read binder's fact reads (`searchLore` fact hits, the graph/fact reads behind `findSimilarEntities` and the §17.6 resolver). Planning enumerates the exact binder query sites; the filter is added to each.

---

## 4. Idempotency & failure

The reconcile job is BullMQ-retried, so it must be idempotent.

- **`reconciled_at` gate.** The commit tx sets `sessions.reconciled_at` atomically with the canon writes. On entry the worker checks it: if set, the working set was already committed → just `clear()` + exit. This closes the dangerous window (commit succeeded but `clear()` failed → a naive retry would double-write). A retry that finds `reconciled_at` NULL re-runs from the (still-uncleared) working set; the Opus plan may differ across retries, which is fine — the working set is the source of truth and any valid reconciliation is acceptable.
- **Atomicity.** Entity rows + appended facts + supersede pointers + relationship edges + fact embeddings + `reconciled_at` are ONE transaction — all-or-nothing. A failed commit rolls back fully; no partial state.
- **Empty working set.** A session that canonized nothing → no-op: set `reconciled_at`, `clear()`, done.
- **Terminal failure.** The session is already `'ended'`; exhausting retries alerts (a `*_failed` event for the ops alarm). The working set survives on the durable checkpoint for manual recovery.

---

## 5. Enforced ignorance

The reconcile is off-hot-path with **no player-facing surface** (no streaming), and the Opus reconciler is secret-cleared (like the ST) — so a tier-downgrade here is a *bug*, not an adversarial leak (the working-set tiers were set by the same trusted ST/FT sources). The load-bearing invariant: **tiers are preserved on commit.** A `secret`-tier working-set item canonizes as `access_level='secret'`, never downgraded to `known`; an `attributed` item's source is recorded, never elevated to objective truth (D6). Downstream gating stays intact (74c's wiki reads only `known` facts; 74d searches the public transcript).

Enforcement is layered, honest about what's mechanically checkable: (a) the reconciler **prompt** instructs "never weaken a tier"; (b) a **mechanical floor** where it's unambiguous — when the working set contains a `secret`/`discoverable` item whose `subjectName` an entity op matches, the validator floors that entity's facts at the item's tier (a precise per-fact floor isn't reliable because the model may merge/rephrase content, so it isn't claimed); (c) the **leak/tier test** (§9) proves the end-to-end guarantee on representative cases (a secret item → a secret fact). Planning settles the exact validator arm; the test is the backstop.

---

## 6. The Opus reconciler (prompt + plan schema)

A new LLM call (`llm/session-reconciler.ts` + schema + prompt), Opus, through the standard `generateObject` + repair + `redactRawText` boundary (the reconciler reasons over secret-tier items, so a malformed output must not spill into logs/SSE — same posture as the ST-vet / tripwire).

**Plan schema (flat Zod root; no `.refine`; no `.max()` on free-prose content):**

```ts
// Each op references working-set subjects by name and canon entities by id.
ReconcilePlanSchema = z.object({
  entities: z.array(z.object({
    op: z.enum(['match', 'mint']),
    subjectName: z.string().min(1),          // the working-set subject
    canonEntityId: z.string().nullable(),    // set when op='match'
    name: z.string().min(1),                 // canonical name (mint, or normalized match)
    entityType: z.enum(['npc', 'location', 'faction', 'item']),
    accessLevel: z.enum(['known', 'discoverable', 'secret']),
  })),
  facts: z.array(z.object({
    subjectName: z.string().min(1),          // the owning entity (by working-set subject)
    content: z.string().min(1),              // attribution baked in for attributed items (D6)
    accessLevel: z.enum(['known', 'discoverable', 'secret']),
    supersedesFactId: z.string().nullable(), // a live canon fact this corrects, or null
  })),
  relationships: z.array(z.object({
    fromSubjectName: z.string().min(1),
    toSubjectName: z.string().min(1),
    relationshipType: z.string().min(1),
    description: z.string().min(1),
  })),
})
```

The prompt receives: the working-set items (tier + provenance + source), the retrieved candidates (id, name, type) + their live facts, and the world tone. It is instructed to (a) decide match vs mint per subject; (b) attach facts, baking attribution into attributed-item content and never downgrading a tier; (c) resolve contradictions by absorb or supersede (no retcons); (d) emit only the structured plan. Validation (§2.3) is structural; the model owns all judgment.

---

## 7. Edge cases

- **Subject resolves to multiple working-set items** (an entity mentioned across turns) → the holistic call dedupes naturally (one entity op, multiple fact ops).
- **A mint whose name matches a candidate the model chose not to match** → allowed; the model's judgment governs (it may have good reason). Structural validation doesn't second-guess it.
- **Supersede target already superseded** (a retry, or two corrections) → validation rejects a supersede whose target is not live; the model re-plans, or the op is dropped with a warn (planning decides the exact arm).
- **Embed failure at commit** → the whole commit fails (embeddings are in the tx); BullMQ retries. (No half-embedded canon.)
- **Working set holds a `retcon` supersede item** (from MYT-73's in-session correction) → it canonizes like any fact, carrying the secret-free `Z`; the secret was never in the working set (MYT-73 §8c).

---

## 8. Interface contracts / what changes

- **New:** `session/session-reconcile.ts` (queue + worker, modeled on `session-suspend.ts`); `llm/session-reconciler.ts` + `llm/schemas/session-reconcile.ts` + `prompts/session/session-reconciler.txt`; a migration (facts supersede + sessions.reconciled_at); the `end_session` WS handler; the budget-100% auto-end wiring.
- **Changed:** `repo/facts.ts` (append + `setSuperseded` + the live-fact read filter); `repo/sessions.ts` (`reconciled_at`); the world-retrieval read binder (filter `superseded_by IS NULL`); `worker.ts` (run the reconcile worker); the WS message-type contract (`end_session`, `session_end`).
- **Reused:** `findSimilarEntities` (match-vs-mint candidates), the Voyage embedder (boot-probed), `embed-write.ts` (vector writes), the working-set repo (`load`/`clear`), the suspend worker's BullMQ/presence pattern, `withTransaction`.

---

## 9. Testing

- **Unit:** the plan validator (structural — dangling ref, illegal type, non-live supersede target, tier-downgrade rejection); the commit applier against real PG (mint / match / append / supersede chain / relationship edge / `reconciled_at`); the supersede migration (append-only + the read filter hides superseded facts); the `end_session` handler + budget-100% auto-end (both enqueue the job + flip status); **idempotency** (run reconcile twice → no double-write, gated by `reconciled_at`). Opus mocked at the `'ai'` boundary (the plan schema); Redis via ioredis-mock.
- **Leak/tier matrix:** a `secret`-tier working-set item commits as `access_level='secret'` (never downgraded); an attributed item commits with attribution in content (never as bare objective truth); superseded facts are filtered from `searchLore`/`findSimilarEntities`. Break-it-to-prove-it.
- **Gated real-LLM smoke (driven before handback):** seed a world + a working set (FT deltas + an attributed NPC-claim + a contradiction against canon) → end a real session → run reconcile against **real Opus + real Voyage** → assert: a new entity minted, the attributed claim canonized as "*NPC claims X*" content, the contradiction superseded (chain intact), tiers preserved, fact embeddings written, and **read-after-commit** (the new fact is `searchLore`-findable; the superseded one is not).

---

## 10. Out of scope (→ siblings), restated

The post-session Opus analysis + handoff (74b), the wiki-data refresh (74c), transcript search (74d), combat "coordinates", and abandonment-timeout reconcile. 74a ends a session and commits its working set to durable, tier-preserving, append-only canon.
