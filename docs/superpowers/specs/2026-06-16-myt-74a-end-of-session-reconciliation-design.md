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
- **Budget auto-end** — the token budget reaches 100% (after the existing ~90% ST wind-down) forces the same flow. The 100% crossing is observed in the **turn worker's post-flush phase** (the same place the ST-eval floor is bumped), which enqueues the end like an explicit one.

The flow (modeled on `session/session-suspend.ts` — BullMQ job + the existing lock/presence machinery), **ordered to fence the reconcile against still-draining in-flight work** (the round-1 lifecycle findings):

1. **Quiesce.** Set a Redis `session:{cId}:ending` flag and **cancel any pending suspend** (`cancelSuspend(sessionId)` — an uncancelled suspend would later re-checkpoint + refresh TTLs on an ended session, a lost-update on the very checkpoint the reconcile reads). Gate inbound: the WS handler drops/ignores `player_message` frames once `ending` is set, and the post-turn re-mature does **not** re-arm the DM-trigger — so no new turn is enqueued after end.
2. **Drain the final turn.** Acquire the per-session lock (waits out an in-flight turn), then wait for the final turn's trailing post-turn jobs (its `finally`-enqueued Scribe + ST-eval) to complete, so the working set is *complete* before reconcile reads it. (The final turn's Scribe job appends that turn's facts; reading before it drains would orphan them.)
3. **Flip + enqueue.** Transition `sessions.status → 'ended'`, set `ended_at = now()` (`reconciled_at` stays NULL — set only by a successful commit, §4). Enqueue ONE **reconcile job** on a new BullMQ queue (`session-reconcile`) with `jobId = reconcile-{sessionId}` (so a double-trigger from the two end paths collapses to one broker job). `lockDuration` is sized **above the worst-case Opus + Voyage wall-clock** (mirrors the ST-eval worker's explicit arithmetic) so BullMQ never stalled-reclaims a live reconcile into a concurrent second run.
4. **Close.** Broadcast a structural `session_end`, flush remaining Redis turn-state, close WS connections.
5. The reconcile worker (§2) runs async, **acquiring the per-session lock** itself; on a **successful** commit it `clear()`s the working set.

**Cross-session interlock (the load-bearing fix).** The working set is **campaign-keyed** (`session:{cId}:workingset`, "one live session per campaign"), but `idx_sessions_one_active` frees the active slot the instant status flips to `'ended'` — so without a guard a new session could start on the same campaign, append onto the *same* Redis list, and have the prior session's still-pending reconcile load the polluted list and `clear()` it (destroying the new session's working set). `POST /api/sessions/:campaignId/start` therefore **blocks while the campaign's most-recent session is `ended_at IS NOT NULL AND reconciled_at IS NULL`** (returns `409 reconcile_pending`): no new session until the prior session's canon is committed and its working set cleared. Reconcile is fast (async, seconds–tens of seconds); a *terminal* reconcile failure thus surfaces as a stuck campaign + an alarm (§4) rather than silent canon loss — the correct failure mode.

**Reader contract (the tri-state).** `ended_at` set + `reconciled_at` NULL means "ended, reconcile pending **or** failed" — consumers (74b/74c, ops) must **not** treat such a session's canon as complete. `reconciled_at` set = canon committed.

The reconcile reads the working set from its **durable source** — MYT-73 rides it on the 5-min `:state` PG checkpoint — so a Redis eviction or crash can't lose uncommitted canon.

*The rich FT farewell + the post-session summary/analysis are 74b; 74a ends a session structurally + commits canon.*

---

## 2. The reconcile pass (the worker body)

ZFC-shaped: deterministic retrieve → LLM judgment → deterministic commit. The `worldId` is resolved once (session → campaign → world, one read).

1. **Retrieve (deterministic).** Load the working set. For each distinct subject, `findSimilarEntities(worldId, …)` → top-K canon entity candidates; load those candidates' **live** facts (`superseded_by IS NULL` — §3) so the reconciler sees current canon, never a fact a prior session already superseded. `findSimilarEntities` already **throws on failure** (never silently mints a duplicate — MYT-71); the per-subject query embeddings are **batched** (`embedDocuments`) and the reads parallelized — this fan-out, not the single Opus call, is the dominant latency.
2. **Reconcile (one holistic Opus call — the judgment).** Input: the full working set (each item's `subjectName`, `content`, `kind`, `tier`, `provenance` objective/attributed, `source`, optional `parentName`) + the retrieved candidates + their live facts. Output: a structured **plan** (§6). The call pins `maxOutputTokens` + `timeoutMs` (an unpinned cap risks mid-JSON truncation → terminal fail; the budget-auto-end fires on the *largest* sessions, so size for the cap, not the median); `repairStrategy: 'sonnet'` is acceptable **only because** the §2.3 validator re-checks every id post-repair (repair fixes JSON shape, never the match/mint judgment). Contradiction handling runs here with full context, **no retcons** (no live turn at session end): the model chooses **absorb** (canonize the improvised version) or **supersede** (append the canonical version + point `superseded_by` at the contradicted fact), per the §17.7 ladder; it **omits** restatements that already match live canon (so a stable entity does not accrete a duplicate fact every session).
3. **Validate (deterministic — structural + policy).** The validator builds the load-bearing **`subjectName → entityId` map** (matched `canonEntityId`s + minted ids) and resolves every fact/relationship op through it. Arms: every `match` id exists; minted types are legal (`npc|location|faction|item`); every `fact.subjectName` and every relationship endpoint resolves to an entity op or live canon (else **dangling → reject**); supersede targets are live facts on the resolved entity; the **tier floor** (§5) and the **attribution arm** (§5) hold. ZFC-safe — structural/policy only, no semantic re-judgment. An invalid plan **fail-softs + alerts with a structural-only payload** (§5; never a partial commit).
4. **Commit (deterministic, transactional — §4).** One repo transaction: mint entities (`created_in='session:<sessionId>'`, `encountered=true`, `modified_by_play=true`; matched entities get the flags too), append facts (with `topic`, `source='session'`, `narrative_status` — §3), set `superseded_by`/`superseded_at` pointers **and NULL the superseded fact's `embedding`** (so it leaves the HNSW index rather than burning recall budget on every search), insert relationship edges (via the integration-edge path — `synth_key` NULL, mirroring character-integration), write `entity_hierarchy` edges for any `parentName` (the sub-faction substrate MYT-73 populated working-set data for — not dropped), write the new facts' embeddings, and set `sessions.reconciled_at` **conditionally** (§4). The Voyage re-embed **call** runs before `BEGIN` over **this attempt's** validated plan-fact contents; the resulting vectors are written **inside** the tx (slow I/O never inside a tx — MYT-55), so embeddings are atomic with the facts and never desync from content across retries. A re-embed failure is classified (config → `*_misconfigured` fail-loud; transient → retry) per MYT-71.
5. **Finalize.** On success → working-set `clear()`. On failure → don't clear (BullMQ retry). Terminal failure → a `*_failed` alarm event + the stuck campaign surfaces via the §1 interlock; the working set persists on the durable checkpoint, recoverable.

---

## 3. The append-only fact log

**Migration** (one file, grounded on the *cumulative* schema — `facts.access_level` is `known|discoverable|secret` since 014, not 001's enum): add to `facts` — `superseded_by UUID REFERENCES facts(id) ON DELETE SET NULL` (nullable) + `superseded_at TIMESTAMPTZ` (nullable); add to `sessions` — `reconciled_at TIMESTAMPTZ` (nullable). The FK's `ON DELETE SET NULL` is a **deliberate** choice (not the bare `NO ACTION` default): `entities → facts` is `ON DELETE CASCADE`, and a world-regen wipe (`entities.deleteByWorldAndCreatedIn`) deleting an entity whose *superseded* fact is pointed-to by a *live* fact would otherwise FK-abort the cascade. A partial index `facts(entity_id, access_level) WHERE superseded_by IS NULL` matches the live-canon snapshot predicate.

**Fact write columns (the live `facts` contract).** Appended facts carry: `topic` — the reconciler **emits** it per fact (`facts.topic` is `NOT NULL`, and it drives later grouping/retrieval, so a constant stamp would degrade it); `source = 'session'` — the fact-provenance marker (the analogue of `entities.created_in`, distinguishing session-improvised canon from prep canon, preserving the D4 audit trail); `narrative_status = 'delivered'` — these facts *were* shown to players this session (code-stamped, not model-chosen). A 74a-committed `secret` fact is indistinguishable from a prep `secret` fact at read time and inherits the same ST-vet over-pull gate (§5).

**Semantics.** Live canon = `superseded_by IS NULL`; full history = the chain. The reconcile path appends + sets pointers + NULLs the superseded row's embedding (content immutable). `updateContentById`/`deleteById` are no longer used for canon corrections.

**Read-path ripple (in scope here, as a binder *flag*).** Every canon **fact** read defaults to live-only (`superseded_by IS NULL`) via a binder flag (so a future history/audit reader can opt into the full chain — the durable shape, not a hardcoded `WHERE` per call site). The complete reader set (the spec's earlier sketch was half of it):
- `world-retrieval.searchFacts` (the `search_lore` semantic arm) — live-only.
- `world-snapshot-view` → `facts.listByEntities` (the live member-facing `GET /sessions/:campaignId/active` + world-snapshot) — live-only, else players see a corrected-away fact beside its correction.
- `world-inventory.load` (the prep/coherence composite read) — live-only, else a superseded fact re-canonizes into the next prep.
- `world-retrieval.listFactsToEmbed` (the `embed-write` backfill) — skip superseded rows (don't re-embed dead canon).
- **The reconciler's own §2.1 candidate-fact read** — live-only, else a superseded *secret* re-enters a later reconcile and could un-retcon a secret.

---

## 4. Idempotency & failure

The reconcile job is BullMQ-retried and can be double-triggered (§1) or stalled-reclaimed, so it must be idempotent against both *retried* and *concurrent* executions.

- **`reconciled_at` is a conditional-update mutex, not just an atomic write.** The commit's last statement is `UPDATE sessions SET reconciled_at = now() WHERE id = $1 AND reconciled_at IS NULL`; **0 rows updated → another execution already reconciled → roll the tx back, `clear()`, exit.** A plain `SET reconciled_at = now()` is *not* a guard — two executions that both read NULL on entry (candidate-retrieval + the seconds-long Opus call sit between the entry check and `BEGIN`) would both commit a full duplicate of the working set. The conditional `WHERE` serializes them; the on-entry check is just a cheap early-out. (`jobId` dedup + the `lockDuration` sizing in §1 make concurrent executions rare; this guard makes a slip *correct*, not merely unlikely.)
- **Atomicity.** Entity rows + appended facts + supersede pointers + nulled superseded embeddings + relationship edges + hierarchy edges + new fact embeddings + the conditional `reconciled_at` are ONE transaction — all-or-nothing. A failed commit rolls back fully; a retry therefore always starts from **zero persisted rows**, so a differing retry plan can't compound on partial state.
- **Empty working set.** A session that canonized nothing → no-op, but still goes through the conditional `reconciled_at` update (never an unguarded write), then `clear()`, done.
- **Terminal failure.** The session is `'ended'` with `reconciled_at` NULL; exhausting retries emits a `reconcile_failed` alarm event (with a structural payload — §5), and the §1 interlock leaves the campaign unable to start a new session until ops intervenes (the working set survives on the durable checkpoint). This is observable-stuck, not silent-loss. (The abandonment/requeue sweep is the deferred later cleanup pass; this piece ships the alarm + the interlock that make the stuck state visible.)

---

## 5. Enforced ignorance

The Opus reconciler reasons over `secret`-tier working-set items **and** secret-cleared candidate facts (§2.1), so the validated plan legitimately *contains* secret prose (a `secret` fact's content **is** the secret — unlike the MYT-73 tripwire, this call is *allowed* to write secrets into canon). The boundary therefore is **not** "no player-facing surface" — that framing is the blind spot. The two real surfaces:

**(1) The log/alert surface (the actual leak vector).** `redactRawText: true` (§6) covers only the raw/repair channel, **not** the validated plan and **not** the application's own log lines — exactly the MYT-73 lesson (the `secretRef`/no-`why` fix; the `supersededContent` leak). So: the validated plan object is **never logged or broadcast** (the §1 `session_end` is structural; the plan is not in it), and every **alert payload** — validator-reject (§2.3), terminal-failure (§4) — carries **structural facts only** (op counts, the rejected op's `kind`+index, dangling ids, `sessionId`), never `content`/`description` prose or the working-set/candidate snapshot. §9 proves it (break-it: a secret-bearing plan down the reject arm → secret absent from the alert + every `logger` arg).

**(2) Tier preservation on commit.** A `secret`-tier working-set item canonizes as `access_level='secret'`, never downgraded; an `attributed` item never elevates to objective truth (D6). The reconciler is trusted (secret-cleared, like the ST), so a slip is a *bug* — but tier/attribution preservation is **policy enforcement** (the ZFC exception), so it gets a *mechanical* guard, not just a prompt:

- **Tier floor (per-fact, reject-not-edit).** Each plan `fact` carries the originating working-set item's `subjectName` (`facts[].subjectName`, §6) — a key MYT-73 *stamped* and the model carries through, **not** the model-rephrasable entity `name`. The validator joins each plan fact to its working-set item by `subjectName` and **rejects the plan** if a fact's `accessLevel` is weaker than its item's `tier`. Per-fact (not entity-granularity — entity-granularity would wrongly bury a secret entity's legitimately-`known` facts) and reject-not-silently-edit (a downgrade is a model bug worth surfacing, not papering over).
- **Attribution arm (structural, not prose-trust).** Each plan `fact` carries `claimedBy: string | null` (§6). The validator **rejects** a fact whose working-set item is `provenance: attributed` but whose `claimedBy` is null (the model dropped the attribution → would canonize a claim as objective truth). This restores MYT-73's structural-and-tested posture (D6's "attribution in the content prose" alone is a regression — the prompt still bakes it into `content`, but `claimedBy` is the structural signal the validator checks and §9 tests deterministically with a mocked model, matching the MYT-73 bar).

Downstream gating stays intact (74c's wiki reads only `known` facts; 74d searches the public transcript). The §9 leak/tier matrix proves all of the above break-it-to-prove-it (a downgraded plan is *rejected*; an attribution-dropped plan is *rejected*; a secret never reaches an alert/log).

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
    subjectName: z.string().min(1),          // the owning entity, BY working-set subjectName
                                             // (the carried-through key the §5 floor joins on)
    topic: z.string().min(1),                // facts.topic is NOT NULL; the model emits it
                                             // (drives grouping/retrieval — not a constant stamp)
    content: z.string().min(1),              // attribution baked in for attributed items (D6).
                                             // NO .max() — free prose; a secret fact's content IS
                                             // the secret (this call is allowed to write secrets)
    accessLevel: z.enum(['known', 'discoverable', 'secret']),
    claimedBy: z.string().nullable(),        // the NPC name for an attributed claim, else null —
                                             // the STRUCTURAL attribution signal the §5 arm checks
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

Flat root, no `.refine` (the cross-field tier/attribution/referential checks are the §2.3 *validator's* job, not Zod's — the validator has the loaded candidates + live facts that a `.refine` cannot reach; it runs **after** `generateObject` returns, post-repair, in the worker). The prompt receives: the working-set items (tier + provenance + source + parentName), the retrieved candidates (id, name, type) + their live facts, and the world tone. It is instructed to (a) decide match vs mint per subject; (b) attach facts — emit `topic`, set `claimedBy` + bake the source into `content` for attributed items, never weaken a tier; (c) resolve contradictions by absorb or supersede (no retcons); (d) **omit** any restatement that already matches a live candidate fact (no duplicate-fact growth); (e) emit only the structured plan. `narrative_status`/`source`/`created_in` are code-stamped at commit (§2.4, §3), not model fields. The model owns all judgment; the validator owns structural + policy enforcement.

---

## 7. Edge cases

- **Subject resolves to multiple working-set items** (an entity mentioned across turns) → the holistic call dedupes naturally (one entity op, multiple fact ops).
- **A mint whose name matches a candidate the model chose not to match** → allowed; the model's judgment governs (it may have good reason). Structural validation doesn't second-guess it.
- **Supersede target already superseded** (a retry, or two corrections) → validation rejects a supersede whose target is not live; the model re-plans, or the op is dropped with a warn (planning decides the exact arm).
- **Relationship/parent endpoint resolves to no entity** → the `subjectName` matches neither an entity op nor live canon → the validator **rejects the plan** (a relationship/hierarchy edge with an unresolvable endpoint would FK-violate or orphan; it is a dangling ref, §2.3).
- **`parentName` on an `entity` item** (a sub-faction) → the commit writes the `entity_hierarchy` edge (parent resolved through the same name→id map). This substrate is committed, not dropped — MYT-73 populated working-set `parentName` specifically so `factionTree` sees session-minted sub-factions.
- **Embed failure at commit** → the whole commit fails (embeddings are in the tx); BullMQ retries (transient) or fail-loud (`*_misconfigured`, a bad key). No half-embedded canon.
- **Working set holds a `retcon` supersede item** (from MYT-73's in-session correction) → it canonizes like any fact, carrying the secret-free `Z`; the secret was never in the working set (MYT-73 §8c).

---

## 8. Interface contracts / what changes

- **New:** `session/session-reconcile.ts` (queue + worker, modeled on `session-suspend.ts`); `llm/session-reconciler.ts` + `llm/schemas/session-reconcile.ts` + `prompts/session/session-reconciler.txt`; a migration (facts `superseded_by`/`superseded_at` + `sessions.reconciled_at`); the `end_session` WS handler + the `ending` quiesce flag; the budget-100% auto-end wiring (turn-worker post-flush).
- **Changed:** `repo/facts.ts` (append with `topic`/`source`/`narrative_status` + `setSuperseded` that also NULLs the embedding + a `liveOnly` read flag); `repo/world-retrieval.ts` (`searchFacts`, `listByEntities`, `listFactsToEmbed` + `world-inventory.load` thread the live-only flag); `repo/sessions.ts` (`reconciled_at` + the conditional-update guard); `repo/relationships.ts`/`entity-hierarchy` (the session-edge write path); `routes/sessions.ts` (the `reconcile_pending` start interlock); `routes/ws-session.ts` (drop inbound on `ending`, close-then-flip); the end flow `cancelSuspend`; `worker.ts` (run the reconcile worker); the WS message-type contract (`end_session`, `session_end`).
- **Reused:** `findSimilarEntities` (match-vs-mint candidates), the Voyage embedder (boot-probed), `embed-write.ts` (vector writes), the working-set repo (`load`/`clear`), the suspend worker's BullMQ/lock pattern + `cancelSuspend`, the per-session lock, `withTransaction`.

---

## 9. Testing

- **Unit:** the plan validator (every arm — dangling ref via the name→id map, unresolvable relationship/parent endpoint, illegal type, non-live supersede target, **tier-downgrade rejection**, **attribution-dropped rejection**); the commit applier against real PG (mint / match / append with topic+source+narrative_status / supersede chain + nulled embedding / relationship edge / `entity_hierarchy` edge / conditional `reconciled_at`); the migration (append-only, `ON DELETE SET NULL`, the live-only read flag hides superseded facts across **all** §3 reader sites); the `end_session` handler + budget-100% auto-end (both enqueue one job + quiesce + flip status); the **start interlock** (`reconcile_pending` 409 while ended-but-unreconciled); **idempotency** (run reconcile twice → no double-write via the conditional gate; a concurrent second execution that reads NULL still commits-once). Opus mocked at the `'ai'` boundary; Redis via ioredis-mock.
- **Leak/tier matrix (break-it-to-prove-it):** a `secret`-tier working-set item commits as `access_level='secret'`; a plan that **downgrades** a secret fact to `known` is **rejected** (not silently committed); a plan that **drops** an attributed item's `claimedBy` is **rejected**; a **secret-bearing plan down the validator-reject + terminal-failure arms** leaves the secret absent from the alert payload and every `logger` arg (the §5(1) log-surface proof — the case the player-stream framing missed); superseded facts are filtered from every §3 reader (snapshot, prep, search, the reconciler's own candidate read).
- **Gated real-LLM smoke (driven before handback):** seed a world + a working set (FT deltas + an attributed NPC-claim + a contradiction against live canon + a sub-faction with `parentName`) → end a real session → run reconcile against **real Opus + real Voyage** → assert: a new entity minted, the attributed claim canonized with `claimedBy` + "*NPC claims X*" content, the contradiction superseded (chain intact, old embedding nulled), the hierarchy edge written, tiers preserved, and **read-after-commit** (the new fact is `searchLore`-findable; the superseded one is not, on every reader site).

---

## 10. Out of scope (→ siblings), restated

The post-session Opus analysis + handoff (74b), the wiki-data refresh (74c), transcript search (74d), combat "coordinates", and abandonment-timeout reconcile. 74a ends a session and commits its working set to durable, tier-preserving, append-only canon.

---

## 11. Blind-review record

**Round 1 (Bridges)** — 4 reviewers (Rialto = LLM-orchestration, Charles = data-model, Khaju = concurrency/lifecycle, Brooklyn = enforced-ignorance). **1 showstopper, resolved:**

- **Showstopper (Khaju C2) — cross-session working-set contamination.** The working set is campaign-keyed and `idx_sessions_one_active` frees the slot the instant status flips to `'ended'`, so a new session on the same campaign could append onto the same Redis list and have the prior session's pending reconcile load + `clear()` the polluted list — silent canon loss on a normal flow (budget-auto-end → start session 2). **Fix:** the §1 **start interlock** (`POST /start` 409s while the prior session is `ended_at` set + `reconciled_at` NULL) + the §4 conditional-update gate.

NITs folded in (the substantive ones — the reviewers found real depth): the §1 lifecycle ordering (quiesce + drain the final turn's trailing post-turn jobs, `cancelSuspend`, close-then-flip, `jobId` dedup, `lockDuration` sizing, the tri-state reader contract); the §4 `reconciled_at` **conditional-update mutex** (a plain atomic write isn't a guard under stalled-reclaim); the §3 **complete read-path site list** as a binder live-only flag (the sketch was half — missed snapshot/prep/backfill/the reconciler's own candidate read) + `ON DELETE SET NULL` + the `topic`/`source`/`narrative_status` fact-write contract + null-embedding-on-supersede; the §2 worldId source + the load-bearing `subjectName→entityId` map + pinned `maxOutputTokens`/`timeoutMs` + the `entity_hierarchy` substrate (was silently dropped); the §5 rewrite — the real leak surface is **logs/alerts** not the player stream (structural-only alert payloads + a break-it test), the **per-fact tier floor** keyed on the carried-through `subjectName` (the prior entity-granularity/`name`-keyed floor was both too coarse and model-rephrasable), and **structural `claimedBy` attribution** with a validator arm (D6's prose-only attribution had regressed MYT-73's structural-and-tested posture). Stopping rule: 0–2 showstopper → ship; no round 2.
