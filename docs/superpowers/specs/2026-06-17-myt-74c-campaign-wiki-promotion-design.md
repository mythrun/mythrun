# MYT-74c — Campaign Wiki + Reconcile-Time Tier Promotion

> **Status:** approved at brainstorm 2026-06-17; hardened through a blind-review round (Constellations) that surfaced a read-path leak + corrected a wrong premise about the working set. The **third of four** decomposed pieces of Linear issue MYT-74. Plugs into the **74a reconcile pass** (extends the plan/validator/commit) and adds a purpose-built member read. Independent of 74b.

**Goal:** give players a campaign wiki — a member-readable, `known`-tier view of the world they're playing — and make it grow with play by **promoting** the `discoverable`/`secret` facts the party discovered during a session up to `known` at session end, as a third branch of the reconcile match the engine already performs.

---

## Where this sits

MYT-74 decomposes into four pieces. This is **74c**: the **player-facing campaign wiki** (a read) + the **tier-promotion** that the reconcile pass already has the inputs to do. 74a built the reconcile pass (working set → canon, with embedding + graph candidate retrieval) + the `encountered` play-marking; 74b built the post-session analysis/handoff; 74d (transcript search) is independent and later.

**The tier model (the design's spine — confirmed with the user):** `access_level` is a *promotion state machine*, not a per-player flag.

- **known** — public baseline knowledge about the world **or** something the party has learned through play. *This is the wiki.* Available from session 1 so players can browse the world they're dropped into.
- **discoverable** — facts unknown to players but easy to learn (a skill check, a conversation). **Not** subject to enforced ignorance — the Fast Thinker may freely know and use them before they're revealed. On discovery → promoted to `known`.
- **secret** — core plot secrets; the enforced-ignorance line. Revealed only when the **Slow Thinker sanctions it** (the ST-vet relays it, or the ST director stages it). On reveal → promoted to `known`.

So "discovery" is an `access_level` promotion to `known`, after which a fact (and its entity) appears in the wiki automatically.

**Why this isn't redundant with the existing world-snapshot.** `GET /api/campaigns/:campaignId/world-snapshot` (myth-exac) is an **owner-only dev-tool inspector** that returns the omniscient world's content (known-tier, or all tiers under a dev bypass) using the *full* composition (`worldSnapshotView`). It is not a player surface, and its composition carries content (the owner's raw `concept`, per-entity prose kernels, stat blocks) that is fine for an owner but **not** for players (§2/D8). 74c builds a **purpose-built, member-readable** read with a deliberately narrower wire shape.

---

## How promotion actually works (the load-bearing correction)

The reconcile pass is already read-then-write: for each working-set item it retrieves canon candidates (embedding + graph search) and the reconciler (Opus) decides match vs. mint vs. supersede. **Promotion is the third branch of that same match** — it needs no new discovery signal, no registry, no per-secret↔fact linkage. Per working-set item the reconciler decides:

- **Matches an existing non-`known` fact** (same underlying fact, e.g. "John is the mayor" already in canon at `discoverable`/`secret`) → **promote** it: emit its `factId` in `promotions`. Do not also mint/supersede.
- **Matches an existing `known` fact** → omit (already public — the existing reconciler rule).
- **No canon match (new), or only a partial/contradicting match** → mint a new `known` fact, or supersede the stale one with a `known` version (existing reconcile machinery).

**Secrets reach the working set only when the ST sanctions surfacing them** — and that is the structural gate that makes secret promotion safe (this is the premise the blind review corrected; the working set is **not** secret-free):

- A `secret`-tier working-set item exists only via the **ST-vet** (`st_injection` source): the FT looks something up, the vet (the single tier-safety gate, holding the playbook) decides whether to relay it and tags the tier — a `tier:'secret'` item means the vet **sanctioned** the reveal. The FT cannot author a `secret`-tier item itself (FT `ft_delta` items are tagged `tier:'known'` — they're public assertions).
- A **ST-director**-staged reveal (its direction "may carry SANCTIONED reveal content") is delivered by the FT and lands as a `known`-tier `ft_delta` whose content matches the canon secret fact.

Either way, a candidate secret fact can only be *matched* (and thus promoted) when a working-set item corresponding to it exists — and that item only exists because the ST gate let it through. The reconciler never free-scans the secret candidates to promote; **the working-set match is the gate, and the ST sanction is what populates the working set.** The match itself is the same trusted judgment the reconciler already makes for every canon write; promotion's residual risk (a spurious match) is exactly the residual risk of any reconcile match, bounded by the same eval, never by a player read path (the wiki is `known`-only + no-bypass + member-scoped — §2/§5).

---

## In / out of scope

**In scope.** (1) **Tier promotion at reconcile** — the reconciler emits a `promotions` list (existing candidate facts it matched to a working-set item and judged should become public); the validator confines it to live candidate ids; the commit flips those facts + their owning entities to `known`, in the existing reconcile transaction. (2) **The campaign-wiki read** — a member-readable, campaign-scoped, **purpose-built** `known`-tier projection (§2).

**Out of scope.** The **player wiki UI** (a Frontend ticket — 74c is the data/API layer only). **Real-time / mid-session promotion** (the flip happens only at reconcile). A **per-secret structured playbook / `[SECRET-n]`-to-`factId` registry** (the coarse single-`[SECRET-1]`-whole-playbook handle stays as-is — promotion doesn't need it, because the working-set match supplies the linkage). **Prose kernels and stat blocks on the player wire** (D8). The **marketplace fork** (`world_marketplace` is schema-ready, not built; §7). 74d.

---

## Decisions

- **D1 — Promotion lives in the reconcile pass, as a branch of the existing match (ZFC).** Not a real-time hook, no new signal. The reconciler already retrieves candidates and decides match/mint/supersede; promotion is "matched an existing non-`known` fact → flip it." Mechanical retrieve → LLM match → mechanical flip.
- **D2 — The discovery signal IS the working-set match.** A fact is promoted iff a working-set item this session matches it. The working set is the Scribe's record of what surfaced in play, so a match means it was surfaced. No separate "was it discovered" metric.
- **D3 — Secrets are ST-gated into the working set, and that gate is the floor.** The working set is **not** secret-free: a `secret`-tier item comes only from the ST-vet sanctioning a relay (`st_injection`), and a director-staged reveal lands as `known` content the FT delivered. So a secret can only be in a position to be promoted because the ST already sanctioned surfacing it. Secret-promotion safety = (ST sanction to enter the working set) × (working-set match to promote) × (the read is `known`-only/no-bypass/member-scoped). The residual (a spurious reconciler match) is the same eval-bounded risk as any canon write — **never reaching a player except through the `known`-tier read.**
- **D4 — Entity follows fact (deterministic).** The wiki filters *entities* by tier first, then their `known` facts (§2). A fact promoted to `known` on a still-non-`known` entity would be orphaned out of the view. So the commit **auto-promotes the owning entity of every promoted fact to `known`** — deterministic, not LLM judgment. The entity's *other* non-`known` facts stay hidden (still tier-filtered); revealing one fact reveals the entity's existence + that fact only. (And the wire carries no prose kernel for a play-promoted entity — D8 — so no characterization blob leaks with it.)
- **D5 — Promotion is a metadata flip, not a content rewrite.** `access_level` changes; `content` does not → no supersede, no re-embed (the content-derived embedding is already live and simply starts passing the `known` filter). Promotion only ever targets **live** facts (`superseded_by IS NULL`).
- **D6 — The wiki is member-readable, no bypass, ever.** A new endpoint, `requireCampaignMember` (any member), `bypass:false` hardcoded. The owner-only dev snapshot is unchanged.
- **D7 — Campaign-private by construction.** Promotion mutates `facts.access_level`, safe because `world_id` is 1:1 with campaign (each campaign mints its own world; `ON DELETE CASCADE`). See §7 for the marketplace forward-assumption.
- **D8 — The wiki uses a PURPOSE-BUILT narrow projection, not the dev snapshot's composition.** The player wire is: a **narrow world summary** (name/tone/themes/era + `known`-filtered vocabulary — **NOT** the owner's raw freeform `concept`), `known` entities (name + type), their `known` facts, and `known`-tier relationships among them. It carries **no prose kernels** (FT-facing generation artifacts, untier-gated → would surface a play-promoted entity's plot blob) and **no stat blocks** (not player-wiki content for v1). The owner-only snapshot keeps its full composition (concept + kernels + stat blocks) unchanged.

---

## 1. The promotion mechanism (extends 74a's reconcile)

The 74a reconcile: load working set → retrieve candidates (`findSimilarEntities` + `facts.listByEntities` at all tiers, with ids) → render (`renderCandidates` shows each candidate fact as `factId=… accessLevel=… <content>`) → reconciler (Opus) → validate (pure) → embed plan facts → commit (one tx, gated by `markReconciled`).

### 1.1 Schema — `llm/schemas/session-reconcile.ts`

Add one field to `ReconcilePlanSchema`, with a `.default([])` so an omission (or the `EMPTY_PLAN` literal, §1.5) degrades to empty rather than terminal-failing the stage:

```ts
export const ReconcilePlanSchema = z.object({
  entities: z.array(/* unchanged */),
  facts: z.array(/* unchanged */),
  relationships: z.array(/* unchanged */),
  /** MYT-74c — ids of EXISTING candidate facts (discoverable/secret) the
   *  reconciler MATCHED to a working-set item this session and judged should
   *  become public knowledge → promote to `known`. Each must be a live candidate
   *  factId (the validator enforces it). `.default([])` so an absent field (or a
   *  no-op EMPTY_PLAN) is `[]`, never a terminal repair failure. The reconciler
   *  NEVER lists a fact it is also superseding (a superseded fact is dead;
   *  promoteToKnown skips it defensively regardless). */
  promotions: z.array(z.string()).default([]),
})
```

### 1.2 Prompt — `prompts/session/session-reconciler.txt`

Add a promotion section (placeholders unchanged) AND update the JSON response skeleton at the foot of the template to include `"promotions": ["<factId>", …]` (schema/prompt co-evolution — a field absent from the skeleton is emitted inconsistently). The instruction gives the model the explicit per-item decision:

> For each working-set item, after you decide match/mint/supersede, also decide promotion. The candidate facts are shown with their `factId` and `accessLevel`.
> - If a working-set item **matches an existing candidate fact that is `discoverable` or `secret`** (the same underlying fact — the party surfaced it this session), put that `factId` in `promotions`. Do **not** also emit it as a new fact.
> - If it matches an existing **`known`** candidate fact, omit it (already public) — as you do today.
> - If it is **new** (no candidate match), mint it at its tier as usual; if it **refines/contradicts** an existing fact, supersede as usual — and do **not** also promote the superseded fact.
> A `secret` candidate fact will only have a matching working-set item when the Slow Thinker sanctioned its reveal this session; that is the only basis on which you may promote a secret. Emit `[]` when nothing was promoted.

### 1.3 Validator — `session/reconcile/validate.ts`

Add a reject reason + a check. Promotions are a **distinct op** — they do NOT pass through the `tier_downgrade` fact-floor (that floor guards fact-*add* ops; a promotion is a sanctioned upgrade on existing canon).

```ts
export type ValidateRejectReason =
  | 'dangling_match' | 'dangling_fact_subject' | 'dangling_relationship_endpoint'
  | 'supersede_target_not_live' | 'tier_downgrade' | 'attribution_dropped'
  | 'dangling_promotion' // a promotions[] id not in liveFactIds (not a real live candidate)
```

After the relationships loop, before `return {ok:true, map}`:

```ts
  // 6. Promotions: every promoted id must be a live candidate fact.
  for (const id of plan.promotions) {
    if (!ctx.liveFactIds.has(id)) return { ok: false, reason: 'dangling_promotion' }
  }
```

`ValidateCtx.liveFactIds` already holds the live candidate fact ids (it backs the supersede check) — no new context input. The reject `reason` stays a structural code only (no content) per the §5 log rule.

### 1.4 Commit — `session/reconcile/commit.ts` + the facts/entities repos

Add a step to `applyReconcileCommit`, inside the existing transaction, **after** the fact appends/supersedes (step 3) and the `markTouchedByPlay` (step 6), and **before** the `markReconciled` gate (step 7 — the last statement):

```ts
  // 6b. MYT-74c — promote matched discovered facts (and their owning entities) to
  //     `known`. A metadata flip: no supersede, no re-embed. promoteToKnown returns
  //     the DISTINCT owning entity ids of the facts it actually flipped (skipping
  //     already-known + superseded facts), and those entities are promoted too so
  //     the wiki view (which filters entities by tier first) doesn't orphan the
  //     now-known facts.
  if (plan.promotions.length > 0) {
    const promotedEntityIds = await tx.facts.promoteToKnown(plan.promotions)
    if (promotedEntityIds.length > 0) await tx.entities.promoteToKnown(promotedEntityIds)
  }
```

New repo methods:

- `repo/facts.ts` — `promoteToKnown(factIds: readonly string[]) → Promise<readonly string[]>`:
  `UPDATE facts SET access_level='known' WHERE id = ANY($1) AND access_level <> 'known' AND superseded_by IS NULL RETURNING entity_id`. **Dedup the returned `entity_id`s in JS** (`[...new Set(rows.map(r => r.entity_id))]`) — two promoted facts can share one entity; the SQL `RETURNING` yields the entity twice and the contract is "distinct owning entity ids." The `<> 'known'` + `superseded_by IS NULL` guards make it idempotent and never resurrect dead canon.
- `repo/entities.ts` — `promoteToKnown(entityIds: readonly string[]) → Promise<number>`:
  `UPDATE entities SET access_level='known', updated_at=now() WHERE id = ANY($1) AND access_level <> 'known'` returning rowCount. Idempotent (a co-promoted-and-touched entity gets a second harmless `updated_at` bump in the same tx — last-write-wins).

Both run on the tx-bound namespace. The reconcile tx is already idempotent via the `markReconciled` gate (a re-run rolls back, undoing the promotions too — they're inside the tx); the two UPDATEs are additionally self-idempotent. Duplicate ids in `promotions` are a no-op (the `ANY($1)` UPDATE is set-based).

### 1.5 The worker — `session/session-reconcile.ts`

`runReconcile` passes the reconciler's `plan` to `validateReconcilePlan` + `applyReconcileCommit` unchanged. **One required edit:** the empty-working-set short-circuit's `EMPTY_PLAN` literal must gain the field — `const EMPTY_PLAN: ReconcilePlan = { entities: [], facts: [], relationships: [], promotions: [] }` (the schema `.default([])` covers LLM output, but the hand-built literal is a separate `ReconcilePlan` value on the gate path). The structural success log gains `promotions: plan.promotions.length` (a count, never ids/content — §5); the reject log adds the same count.

---

## 2. The campaign-wiki read (purpose-built)

A new member-readable endpoint with a **deliberately narrow** wire shape — NOT a re-pointing of the owner-only `worldSnapshotView`.

- **Route:** `GET /api/campaigns/:campaignId/wiki` in `routes/campaigns.ts`.
- **Auth:** `preHandler: requireCampaignMember(repo)` — **any member** (not `'owner'`).
- **Readiness gate:** `pipelineRunsRepo.isStageCompleted(worldId, 'entity_relationships')` → `409 wiki_not_ready`. Resolve `campaign → worldId` via `repo.campaigns.getWorldId`; a **null** worldId (campaign not found) → `404 campaign_not_found` (never pass null into the view — it would 500).
- **The view — a new `campaignWikiView.fetch(client, worldId)`** (a sibling of `worldSnapshotView`, NOT a reuse), composing ONLY player-safe `known`-tier content:
  - a **narrow world summary** — a new `worlds.getWikiSummary(worldId)` allowlist projection: `name, tone, themes, era`, and the `known`-filtered `vocabulary_registry` entries. It **excludes `concept`** (the owner's raw freeform world seed, which can contain plot — the dev snapshot's `WorldSummary` includes it; the wiki must not). Single-sourced in `worlds.ts` like `getSnapshotSummary`, so the column list has one home and a future widening is a deliberate edit.
  - `known` **entities** (`entities.listByWorld(worldId, {accessLevels:['known']})` → name + type).
  - their `known` **facts** (`facts.listByEntities(entityIds, {accessLevels:['known'], liveOnly:true})`).
  - `known`-tier **relationships** among them (`relationships.listAmong(entityIds)` — already DB-filtered to internal pairs).
  - **NO prose kernels, NO stat blocks** (D8).
- **Rate limit:** per-**user** (the member-read precedent — `keyGenerator` → the authed user id, IP fallback), cap ~60/min (the `status` member-poll route's cap; the owner snapshot's 30/min per-IP is the wrong analog — different audience size + keying).

This is a small purpose-built composition; it does not touch the owner-only snapshot or `worldSnapshotView`.

---

## 3. The data flow

```
          during play (ST-gated):
            FT freely surfaces discoverable facts (ft_delta / known);
            ST-vet sanctions a secret reveal → st_injection / secret;
            ST director stages a reveal → FT delivers it → ft_delta / known.
            The Scribe extracts these into the session WORKING SET.
                                   │  (session ends)
                                   ▼
   74a reconcile:  load working set + candidate canon facts (ids + tiers)
                                   │
        reconciler (Opus): for each item → match / mint / supersede / PROMOTE
            plan { entities, facts, relationships, promotions:[matched non-known factIds] }
                                   │
        validate (promotions ⊆ liveFactIds)  →  commit (one tx):
            append/supersede facts → markTouchedByPlay →
            promoteToKnown(facts) → promoteToKnown(their entities) → markReconciled
                                   │
                                   ▼
        GET /api/campaigns/:id/wiki  →  campaignWikiView (known-only, narrow)
            the promoted facts + entities now appear in the party's wiki
```

At world-gen the wiki holds the baseline `known` facts. After each session, whatever the party discovered (and the ST sanctioned, for secrets) has been promoted, so it shows up.

---

## 4. Interface contracts / what changes

- **Changed:** `llm/schemas/session-reconcile.ts` (`promotions` + `.default([])`); `prompts/session/session-reconciler.txt` (the promotion section + the JSON skeleton); `session/reconcile/validate.ts` (`dangling_promotion`); `session/reconcile/commit.ts` (the promote step); `repo/facts.ts` (`promoteToKnown` → distinct entity ids); `repo/entities.ts` (`promoteToKnown`); `session/session-reconcile.ts` (the `EMPTY_PLAN` literal gains `promotions: []` + the structural promotion counts in the logs); `repo/worlds.ts` (`getWikiSummary` narrow projection, no `concept`); `repo/campaign-wiki-view.ts` (new `campaignWikiView.fetch`); `routes/campaigns.ts` (the `GET …/wiki` member route).
- **Reused:** the reconcile worker's retrieve→reconcile→validate→commit pipeline + its `markReconciled` idempotency gate; `requireCampaignMember`; the `pipeline_runs` stage-ready gate; the `entities`/`facts`/`relationships` tier reads.
- **No migration.** Promotion is an `UPDATE` of existing columns (the `access_level` CHECK already permits `'known'`, migration 014); the wiki is a read.

---

## 5. Enforced ignorance

- **The wiki read is `known`-only, no bypass, and now narrow.** `bypass:false` hardcoded; the new `getWikiSummary` projection drops `concept`; the view carries no prose kernels and no stat blocks (D8). This closes the blind-review SS1 leak (the dev snapshot's `WorldSummary.concept` = owner's raw freeform seed, and untier-gated prose kernels, reaching players). A player cannot receive `discoverable`/`secret` facts, the owner's seed prompt, or a play-promoted entity's characterization blob.
- **Secret promotion is structurally gated, not a free LLM scan (D2/D3).** A secret fact can only be promoted when a working-set item matches it, and a secret reaches the working set only via an ST-sanctioned surfacing (the vet's `secret`-tier relay, or a director reveal the FT delivered). The reconciler's match is the same trusted judgment behind every canon write; the validator confines `promotions` to live candidate ids (`dangling_promotion`).
- **Log surface (carry the 74a/MYT-73 rule):** the new `dangling_promotion` reason is a structural code; the success/reject logs carry `promotions.length` only — never fact ids or content.
- **Residual risk (named honestly):** a *spurious* reconciler match could promote a fact that wasn't really discovered. This is the same match-quality risk as any reconcile canon write, bounded by eval (`feedback_smoke_vs_eval`), and — critically — it **never reaches a player except through the `known`-tier, no-bypass, member-scoped read**, and for secrets is upstream-gated by the ST sanction required to populate the working set at all. A tighter per-promotion working-set corroboration in the validator is a possible future hardening; v1 relies on the match-gating + ST-sanction floor, consistent with the existing reconcile trust model.

---

## 6. Testing

- **Unit (validator):** a `promotions` id not in `liveFactIds` → `{ok:false, reason:'dangling_promotion'}`; a valid promotion passes and does NOT trip `tier_downgrade`; the reason carries no content.
- **Unit / real-PG (repo):** `facts.promoteToKnown([id])` flips a `discoverable` fact to `known`, returns its (deduped) `entity_id`, is a no-op on an already-`known`/superseded fact; `entities.promoteToKnown` flips + is idempotent. `worlds.getWikiSummary` returns name/tone/themes/era + `known` vocabulary and **does not** include `concept`.
- **Real-PG (commit):** a plan with `promotions:[discoverableId, secretId]` → both read back `known`, their entities read back `known`; a promotion of a fact superseded earlier in the same plan is a no-op; `EMPTY_PLAN` (now with `promotions:[]`) still fires the gate; the gate still rolls a re-run back.
- **Real-PG (the wiki read):** `GET …/wiki` as a non-owner member returns `200` with `known`-tier entities + facts + relationships only; a `discoverable`/`secret` fact (un-promoted) is absent; **the owner's `concept` is absent; no prose kernels / stat blocks are present**; after a promotion commit the promoted fact + its entity ARE present; a non-member → `403`; before stage 4 → `409 wiki_not_ready`; a campaign-not-found → `404`.
- **Leak matrix (break-it-to-prove-it):** a discoverable candidate fact the party did **not** surface this session stays `discoverable` and absent from the wiki (seed two discoverable facts, surface only one, assert exactly one promotes — the over-promotion guard); a secret never surfaced is never in `promotions` and never in the wiki; the wiki response contains no `concept`/kernel/stat-block fields (assert by key absence — there is no bypass knob to "force," the structural guarantee is the narrow projection).
- **Gated real-LLM smoke (driven before handback):** seed + drive (constructed-state) a session whose working set surfaces ONE discoverable fact (matched to an existing discoverable candidate) and one ST-sanctioned secret reveal, leaving a second secret untouched → run the REAL Opus reconciler → assert the discoverable + the revealed secret promote to `known` (and their entities), the untouched secret stays `secret`, and `GET …/wiki` returns the two promoted facts while the untouched secret + the owner's `concept` are absent. Promotion *judgment* quality is logged for eval, not asserted (`feedback_smoke_vs_eval`).

---

## 7. Forward assumption (the marketplace fork)

Promotion mutating `facts.access_level` is campaign-private **because `world_id` is 1:1 with campaign today** (each campaign mints its own world at create). `campaigns.source_world_id` + the `world_marketplace` table ("schema-ready, not built at launch") anticipate a future publish/fork feature. **Invariant for that feature:** forking a published world into a campaign must **copy** entities/facts into a fresh per-campaign `world_id` (which the per-campaign-world ownership + `ON DELETE CASCADE` already imply) — never reference-share one world across campaigns. Under copy-on-fork, 74c's promotion stays campaign-private with no change. A precondition on the (out-of-scope) marketplace work, not a 74c task.

---

## 8. Out of scope (restated)

The player wiki UI (Frontend), real-time/mid-session promotion, a per-secret structured-playbook/`[SECRET-n]`↔`factId` registry, prose kernels + stat blocks on the player wire, the marketplace fork, any change to the owner-only dev snapshot, 74d. 74c makes the campaign wiki real (member-readable, narrow, `known`-tier) and makes it grow with play (reconcile-time promotion as a branch of the existing match, ST-gated for secrets).

---

## 9. Blind-review record

**Round 1 (Constellations)** — 4 reviewers (Orion = enforced-ignorance/security, Lyra = reconcile-transaction correctness, Draco = LLM-orchestration/prompt, Cassiopeia = data-flow/read-path). **2 showstoppers, both fixed:**

- **SS1 — read-path leak (Orion C1 / Cassiopeia C1 / M3).** Reusing `worldSnapshotView` for a player surface served the owner's raw `concept` and untier-gated prose kernels (a play-promoted secret entity's full characterization). **Fixed:** §2/D8 — a purpose-built `campaignWikiView` over a narrow `getWikiSummary` (no `concept`), no prose kernels, no stat blocks. §5 no longer claims composition-reuse is safe.
- **SS2 — secret promotion on LLM judgment (Draco I3/I4 / Orion I2/I3), built on a wrong premise.** The original D3 ("working set is secret-free") was false; the reviewers + the architecture check corrected it. **Resolved:** D2/D3 — the working set is ST-gated for secrets (the vet's `secret`-tier relay / a director reveal), and promotion is the working-set *match*, so the ST sanction is the structural floor; no registry/declaration machinery (an overengineering detour, reverted). NITs folded in: `promotions: .default([])` + the `EMPTY_PLAN` literal (Orion I1 / Lyra C1); the JSON-skeleton + promote-vs-mint-vs-supersede 2×2 in the prompt (Draco I1/I2); the `promoteToKnown` distinct-entity-id dedup (Lyra I1); the commit step ordering vs. the real `markReconciled` gate (Lyra I3); the `getWorldId` null→404 branch (Cassiopeia M1); the per-user member rate-limit (Cassiopeia I3); the over-promotion + key-absence tests (Draco M3 / Cassiopeia M4). Stopping rule: 2 showstoppers → fix inline, ship; no round 2.
