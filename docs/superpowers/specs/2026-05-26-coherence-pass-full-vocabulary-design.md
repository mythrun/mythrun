# Coherence Pass — Full Patch Vocabulary Design

> **Status:** draft, pre-implementation. Pending blind-review + user sign-off.
> **Beads:** myth-imxg (patch vocabulary gap), myth-p4sz (synthKey lookup bug).
> **Related ship:** myth-2ob3 (name-based LLM I/O, just shipped).

## 1. Problem

The myth-2ob3 ship fixed the UUID-hallucination class — coherence-pass patches now resolve and apply at high rate against the DB. The downstream consequence surfaced two structural gaps:

### 1a. Coherence can identify wrong-endpoint relationships but cannot fix them.

The post-ship smoke world (`The Narrowing Path`, world `019e65a2-...`) has 76 relationships, of which **7 contain `description` text that explicitly negates the (source, target, type) triple they're attached to**. Examples verbatim from the DB:

- `Clerk Bevin Threll --serves--> The Merchant Concord` / description: *"He serves Lorrendale's governing body, not the Merchant Concord."*
- `Ash Veddra --suspected_infiltrator_of--> The Brotherhood` / description: *"She is not a monk and is not suspected of Factional Taint within the Brotherhood."*
- `Old Mera Vist --tends--> The Offering Stone` / description: *"Old Mera Vist sits at the seventh shrine on the Shrine Road, not at the Offering Stone. The relationship description incorrectly places her at the Offering Stone."*
- `The Marrenhal Stair --connects_to--> Stillwater Monastery` / description: *"It does not connect to the monastery's Terraces — it is a separate structure in Lorrendale below the pass."*
- `Joren Beck --stationed_at--> Wardens' Post (Lorrendale Side)` / description: *"Joren Beck works out of the Vell-side post, not the Lorrendale-side post."*

These descriptions are reviewer voice (*"The relationship description incorrectly places her at..."*), not creator voice. They came from coherence-pass `fix_relationship_by_name` patches that updated the description to annotate the error but could NOT change the type or endpoints because the schema doesn't permit it. The model's least-bad option was to keep the wrong relationship and add a description explaining why.

A blind coherence reviewer rated the world **weak** solely because of this pattern (vs. **strong** on prose, world-building, playability).

### 1b. Coherence cannot add missing facts or relationships the prose implies.

The spec design said "No new entities or relationships, ever" — preventing coherence from drifting into world-expansion. In practice this also forbids fixing the case where stage 2/3/4's structured output dropped a fact or relationship the prose clearly implies (e.g., an NPC's prose mentions they serve a specific faction, but the structured `member_of` relationship was never emitted).

### 1c. `fix_relationship_by_name` and `delete_relationship_by_name` SSE events drop.

In `coherence-pass.ts:266` and `:309`, the apply step looks up the old relationship's synthKey via `synthKeyByEntityId[relationshipId]`. But `synthKeyByEntityId` is keyed by **entity** UUIDs, not relationship UUIDs — the lookup always returns undefined, so `edge-removed` events are suppressed. DB writes succeed; only the wire feed misses these events. Filed as myth-p4sz; folded into this design.

## 2. Architectural decisions

### 2.1 Extend the relationship-patch surface

The coherence pass gains three new capabilities for relationships and facts (no entity-add):

| Patch kind | Status | Capability |
|---|---|---|
| `fix_relationship_by_name` | **extended** | Now accepts optional `newSource` + `newTarget` in addition to existing `newType` + `newDescription`. Full relationship rewrite in one patch. |
| `add_relationship_by_name` | **new** | INSERT a relationship between two existing entities that the prose implies but stage 4 didn't emit. |
| `delete_relationship_by_name` | unchanged | Remove. |
| `fix_fact_by_name` | unchanged | Update content. |
| `add_fact_by_name` | **new** | INSERT a fact on an existing entity that the prose implies but the fact list missed. |
| `delete_fact_by_name` | **new** | Remove a stale fact contradicted by prose. |
| `fix_prose_by_name` | unchanged | Update prose kernel. |
| `rename_entity_by_name` | unchanged | Rename. Applied last per myth-2ob3 §4.1. |

**Why:** the user directive is "give the coherence engine the legs it needs to be effective." Limiting coherence to UPDATE-only-on-existing-rows prevents it from healing wrong-endpoint relationships and missing-row gaps that stage 4 produces. The vocabulary expansion is conservative: relationships and facts are properties of existing entities (not new entities), so the "no new entities, ever" invariant is preserved.

### 2.2 No new entity capabilities

`add_entity_by_name` is **explicitly out of scope** (per user decision). Coherence still cannot create entities. The reasoning: phantom declarations from stage 4 are the sanctioned path for adding missing entities (stage 4b materializes them). Lifting that to coherence would invite world-expansion drift that we'd then need to retroactively police.

### 2.3 Add patches resolve against the inventory only

`add_relationship_by_name` resolves both endpoint names against the existing entity inventory. **No phantom-declaration support** — coherence runs after stage 4b, so by the time it executes, all entities the world contains already exist. If a name doesn't resolve, the patch drops with WARN (same as fix patches today).

`add_fact_by_name` resolves the entity name against the existing inventory. Same drop-on-unresolvable semantics.

### 2.4 myth-p4sz fix: persist the relationship synthKey + split the lookup map

The original myth-p4sz bug was `synthKeyByEntityId[relationshipId]` — looking up a relationship's UUID in an entity-keyed map. The naive fix (a second map keyed by relationshipId) doesn't work because **no current data path persists relationship synthKeys anywhere**. Stage 4 mints `entity_relationships/relationships/${sourceIndex}` at stream time and discards the index once finalized events publish.

**Decision: persist `synth_key` as a column on the `relationships` table** (migration; nullable text). Stage 4 and stage 4b set it at INSERT time using the same shape they already emit on `finalized` SSE events. Stage 7's coherence pass loads the relationships inventory + their synthKeys via `loadWorldInventory`, populating `synthKeyByRelationshipId` from the persisted column. `applyFixRelationship` and `applyDeleteRelationship` look up the old synthKey via this map; the lookup succeeds for any relationship persisted by stages 4 or 4b.

For relationships that coherence itself INSERTs (`add_relationship_by_name` or `fix_relationship_by_name` with endpoint changes), the apply step mints a fresh synthKey of the shape `coherence_pass/edges/${newId}` and persists it on the new row. Future coherence runs (cross-session retries; not common but possible) would find these synthKeys via the same load path.

The lookup map is `ApplyContext.synthKeyByRelationshipId: Readonly<Record<string, string>>`, populated once at stage 7 start from the post-`loadWorldInventory` snapshot. The map is not mutated mid-pass; relationships INSERTed by coherence itself use locally-known synthKeys in the apply function, not the map.

Schema change: `migrations/NNN_relationships_synthkey.sql` adds the column and backfills existing rows with `entity_relationships/relationships/<lexical-order-index>` as a best-effort placeholder (the original sourceIndex is lost for existing worlds; the placeholder gives downstream code a non-null value to work with).

### 2.5 Patch ordering invariants

Today: `rename_entity_by_name` applies LAST so other patches resolve against the pre-rename context (myth-2ob3 §4.1).

After this change: same rule. `add_*` and `delete_*` patches apply in `otherPatches` order alongside `fix_*` patches; renames go last. **No new ordering rule needed**, because `add_*` doesn't depend on the existing context's freshness (it INSERTs a new row), and `delete_*` resolves against the pre-rename context per the existing rule.

Edge case: what if the model emits `add_relationship_by_name X→Y` AND `rename_entity X→X'` in the same batch? The add resolves against pre-rename `X` (succeeds against inventory); the rename applies later and updates entity X's name. The added relationship row's source is still `X`'s UUID — renames don't affect UUIDs. Behavior is correct.

## 3. Schema changes

### 3.1 `fix_relationship_by_name` — extended

```ts
const fixRelationshipPatch = z.object({
  kind: z.literal('fix_relationship_by_name'),
  // Identify the existing row to replace
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  current_type: z.string().min(2).max(60),
  // Edit any subset of the four fields
  newSource: z.string().min(1).max(200).optional(),   // NEW
  newTarget: z.string().min(1).max(200).optional(),   // NEW
  newType: z.string().min(2).max(60).optional(),
  newDescription: z.string().min(10).max(600).optional(),
  rationale: z.string().min(20).max(400),
}).refine(
  (p) => p.newSource !== undefined || p.newTarget !== undefined || p.newType !== undefined || p.newDescription !== undefined,
  { message: 'fix_relationship_by_name requires at least one of newSource, newTarget, newType, newDescription' },
)
```

Apply semantics: DELETE the row identified by `(source_name, target_name, current_type)`, then INSERT a new row with each field overridden by `new*` if present, falling back to the existing value otherwise. Same delete+insert pattern as the current `fix_relationship_by_name` does for type/description; just extended to source/target.

The `.refine()` rules out the empty-patch no-op at parse time, so the apply step never sees a patch with zero new* fields. The Vercel SDK's structured-output validation rejects the patch before it reaches the apply dispatcher; the model retries (per the wrapper's repair chain) or the patch drops at Zod validation. Either way, no special-casing in apply.

**Partial-failure semantics for `newSource`/`newTarget`:** when either is present, the apply step resolves the name against the inventory via `resolveProseTarget`. If either resolves to `dropped` (unknown or ambiguous), the **entire patch drops** with a structured WARN — no partial application. This mirrors the existing all-or-nothing pattern: a patch either applies fully or doesn't apply at all.

### 3.2 `add_relationship_by_name` — new

```ts
const addRelationshipPatch = z.object({
  kind: z.literal('add_relationship_by_name'),
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  relationship: z.string().min(2).max(60),
  description: z.string().min(10).max(600),
  rationale: z.string().min(20).max(400),
})
```

Apply: resolve `source_name` and `target_name` against the inventory (drop with WARN if either is unresolvable). INSERT a new `relationships` row with a fresh UUIDv7. Emit `edge-added` SSE event with the new synthKey.

### 3.3 `add_fact_by_name` — new

```ts
const addFactPatch = z.object({
  kind: z.literal('add_fact_by_name'),
  entity_name: z.string().min(1).max(200),
  topic: z.string().min(1).max(120),
  content: z.string().min(10).max(2000),
  access_level: z.enum(['known', 'discoverable', 'secret']),
  rationale: z.string().min(20).max(400),
})
```

Apply: resolve `entity_name` against the inventory (drop with WARN if unresolvable). INSERT a new `facts` row with a fresh UUIDv7 + the specified topic/content/access_level. Emit a `fact-added` SSE event (see §6).

**Tier-assignment trust.** The model picks `access_level` per fact, matching the existing pipeline pattern. Stages 2/3/4 already trust the LLM to assign tiers at write time on every fact they emit (`access_level: z.enum(['known','discoverable','secret'])` on `factItemSchema`). Coherence runs before the world is canonical — the Fast Thinker doesn't snapshot the world until after stage 9 completes — so a coherence-time tier choice is functionally equivalent to a stage-2/3/4 tier choice from the player's perspective: they only ever see post-coherence canon.

Principle #1 ("Enforced ignorance is a hard boundary, not a prompting suggestion") governs READ-time filtering at session time — the Fast Thinker's snapshot-fetch queries `known`-tier only, and that filter is non-bypassable. Principle #1 does NOT constrain pre-canon write-time tier-assignment judgment, which the pipeline trusts the LLM with everywhere.

The **aggregate** risk (the model systematically downgrading secrets across many worlds) is real and is the §7.4 smoke's job to detect — see the tier-balance check there. Per-patch tier choices are model judgment, same as stage 2's; aggregate behavior is the gate.

### 3.4 `delete_fact_by_name` — new

```ts
const deleteFactPatch = z.object({
  kind: z.literal('delete_fact_by_name'),
  entity_name: z.string().min(1).max(200),
  fact_topic: z.string().min(1).max(120),
  rationale: z.string().min(60).max(400),  // higher floor: deletes are irreversible
})
```

Apply: resolve `(entity_name, fact_topic)` via the existing `resolveFact` resolver (drop with WARN on unresolvable or ambiguous). DELETE the fact. Emit `fact-removed` SSE event (per §6).

Rationale floor is **60 chars** (vs. 20 for the other patches): deletes are irreversible, the model must spell out *why* the fact is unfixable rather than just contradicted by a `fix_fact_by_name`. Cheap prompt-discipline tightening.

### 3.5 Discriminated union update

`CoherencePatchSchema` extends to 8 kinds (was 5). Same `z.discriminatedUnion('kind', [...])` shape; just add the three new entries.

## 4. Apply-step changes

### 4.1 Resolver additions

`name-resolution.ts` gains ONE new resolver for the `add_relationship_by_name` patch's two-name endpoint resolution:

```ts
export type AddRelationshipResolution =
  | { kind: 'resolved'; sourceEntityId: string; targetEntityId: string }
  | { kind: 'dropped'; reason: 'unknown_source' | 'unknown_target' | 'ambiguous_source' | 'ambiguous_target' }

export function resolveAddRelationship(
  ctx: NameResolutionContext,
  emitted: { source_name: string; target_name: string },
): AddRelationshipResolution
```

`add_fact_by_name` reuses the existing `resolveProseTarget` directly (single-entity-name resolution; identical semantics). `delete_fact_by_name` reuses the existing `resolveFact` (entity_name + topic). No new resolver needed for either.

The `fix_relationship_by_name` case's optional `newSource`/`newTarget` resolution also reuses `resolveProseTarget`. The dispatcher (§4.4) calls `resolveProseTarget` twice (for newSource, if present, and newTarget, if present) in addition to the existing `resolveFixRelationship` for the (current_*) triple lookup.

### 4.2 Apply functions

Three new apply helpers in `coherence-pass.ts`:

```ts
async function applyAddRelationship(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'add_relationship_by_name' }>,
  sourceEntityId: string,
  targetEntityId: string,
  ctx: ApplyContext,
): Promise<ApplyResult>

async function applyAddFact(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'add_fact_by_name' }>,
  entityId: string,
  ctx: ApplyContext,
): Promise<ApplyResult>

async function applyDeleteFact(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'delete_fact_by_name' }>,
  factId: string,
  ctx: ApplyContext,
): Promise<ApplyResult>
```

The existing `applyFixRelationship` gains source/target resolution + the new DELETE-INSERT logic that may write different endpoints.

### 4.3 myth-p4sz fix

`ApplyContext` gains `synthKeyByRelationshipId: Readonly<Record<string, string>>` populated by the stage handler from the inventory's relationship synthKeys.

`applyFixRelationship` (line 266) and `applyDeleteRelationship` (line 309) replace `synthKeyByEntityId[relationshipId]` with `synthKeyByRelationshipId[relationshipId]`. The `else { warnUnknown }` branches become genuinely-defensive (only fires when a relationship row exists in `inv.relationshipsById` but not in the synthKey map — which would be a stage-handler bug).

### 4.4 Dispatcher

`applyPatch` gains three new cases:

```ts
case 'add_relationship_by_name': { ... resolveAddRelationship ... }
case 'add_fact_by_name': { ... resolveAddFact ... }
case 'delete_fact_by_name': { ... resolveFact ... }
```

Each new case follows the existing pattern: resolve → log WARN on drop → call the apply helper with resolved IDs.

## 5. Prompt rewrite

`backend/src/llm/prompts/prep/coherence-pass.txt` gains:

- A "How to add missing relationships and facts" section explaining when to use `add_relationship_by_name` and `add_fact_by_name`. Specifically: **only when the prose of an existing entity directly states or strongly implies the relationship/fact AND it's not already in the structured output**. Not for plot speculation.
- A "How to fix wrong-endpoint relationships" section explaining that `fix_relationship_by_name` can now rewrite source/target. Use this when the relationship's description correctly identifies the right entities but the type or endpoints disagree.
- A "How to delete a contradicted fact" section explaining `delete_fact_by_name`. Use when the prose makes a fact's content factually wrong AND there's no plausible content update that would fix it (i.e., the fact shouldn't exist at all).
- A "patch order" reminder: renames apply last (existing rule); within the rest, the order is whatever the model emits.

Verb-shape guidance for the `relationship` field in `add_relationship_by_name` (and the `newType` in `fix_relationship_by_name`) stays the same — short snake_case predicate, ≤30 chars.

## 6. SSE event emission

**New event types — `fact-added` and `fact-removed`.** The proposed-but-wrong approach of emitting `entity-updated { patch: { facts: [...] } }` violates the RFC 7396 merge-patch contract (`pipeline-events.ts:118-120`: *"Nested objects/arrays REPLACE wholesale"*). The frontend would replace the entire facts array with a single-element array (losing the rest) or treat the patch as a no-op. Instead, add per-fact event types to `pipeline-events.ts`:

```ts
| { type: 'fact-added'; entitySynthKey: string; factId: string; topic: string; content: string; accessLevel: 'known' | 'discoverable' | 'secret' }
| { type: 'fact-removed'; entitySynthKey: string; factId: string }
```

Symmetric with `entity-added/removed` and `edge-added/removed`. Honest to the wire contract; the FE consumer can update its facts collection per-row without merge-patch ambiguity.

**`fix_fact_by_name` retroactively emits a `fact-updated` event** (also new) for symmetry; today it emits nothing and forces the FE to re-query. Same shape as `fact-added`. Cheap consistency win.

| Patch kind | Event(s) emitted | When |
|---|---|---|
| `fix_relationship_by_name` (no endpoint change) | `edge-removed` + `edge-added` (new synthKey) | Per current behavior |
| `fix_relationship_by_name` (endpoint change) | `edge-removed` + `edge-added` | Gate fires only if BOTH old endpoints AND both new endpoints are `known`-tier (or bypass). Asymmetric cases (old known, new not, or vice versa) suppress both events — the FE can't render an edge whose endpoint isn't in its snapshot. |
| `add_relationship_by_name` | `edge-added` | New synthKey `coherence_pass/edges/${newId}`, new UUID. Same synthKey shape as the fix-replacement. Gate on both endpoints `known`-tier. |
| `delete_relationship_by_name` | `edge-removed` | Existing synthKey looked up via the new `synthKeyByRelationshipId` map (§2.4). |
| `fix_fact_by_name` | `fact-updated` (NEW) | Replaces today's "no event emitted" non-behavior. |
| `add_fact_by_name` | `fact-added` | Carries factId + topic + content + accessLevel (always = owning entity's tier per §3.3). |
| `delete_fact_by_name` | `fact-removed` | Carries factId + entitySynthKey. |
| `fix_prose_by_name` | `entity-updated { patch: { prose } }` | Unchanged (single scalar field, merge-patch shape works). |
| `rename_entity_by_name` | `entity-updated { patch: { name } }` | Unchanged. |

Access-level tier gating per myth-exac T16 still applies — events only surface for `known`-tier entities (or bypass). Fact events filter on the **fact's** access level (which equals the owning entity's tier per §3.3), so a `secret`-tier fact added to a `secret`-tier entity emits no wire event — correct, since the FT client doesn't snapshot secret-tier rows.

## 7. Tests

### 7.1 Unit tests

New resolver tests for `resolveAddRelationship` and `resolveAddFact` (4-6 cases each).

### 7.2 Apply-step tests

New cases in `coherence-pass.test.ts`:
- `add_relationship_by_name` inserts a row + emits `edge-added`
- `add_relationship_by_name` drops with WARN on unresolvable name
- `add_fact_by_name` inserts a row + emits `entity-updated`
- `add_fact_by_name` drops with WARN on unresolvable entity
- `delete_fact_by_name` removes the row + emits `entity-updated`
- `delete_fact_by_name` drops with WARN on unresolvable (entity, topic)
- `fix_relationship_by_name` with `newSource` rewrites the source endpoint
- `fix_relationship_by_name` with `newTarget` rewrites the target endpoint
- `fix_relationship_by_name` with both `newSource` and `newTarget` rewrites both
- `fix_relationship_by_name` with no new* fields is a no-op (skip + WARN, OR INSERT-with-no-changes — pick one)
- myth-p4sz regression: `delete_relationship_by_name` now emits `edge-removed` (today the SSE event is suppressed by the synthKey-map-miss WARN)

### 7.3 Schema tests

Update `coherence-output.test.ts` to validate each of the three new kinds + the extended `fix_relationship_by_name` shape.

### 7.4 Live smoke

Per myth-2ob3 §9.3:
- ≥80% coherence-pass apply rate (preserved).
- **Lexical self-flagging count.** Run a real-LLM world-gen, then grep the `relationships.description` column for the lexical signatures of self-flagging (case-insensitive): `not at the`, `is not`, `does not`, `not a `, `incorrectly`, `is wrong`, `actually`, `not really`. Manually audit hits for true contradictions vs. legitimate negations ("not yet bound by formal treaty"). **Target: ≤1 true self-flagging description per 76 relationships** (proportional to the Narrowing Path baseline of 7/76). The lexical regex is the automated first pass; eyeball confirms true positives.
- **Vocabulary-uptake check.** Aggregate emit counts per patch kind, post-coherence. Pre-change baseline (Narrowing Path): mostly `fix_relationship_by_name` (description-only) and `delete_relationship_by_name`. Post-change expectation: at least some `fix_relationship_by_name` patches carry `newSource` or `newTarget`; some `add_relationship_by_name` and `add_fact_by_name` emit. Zero of the new kinds = prompt failed to teach the model.
- **myth-p4sz regression check.** `delete_relationship_by_name` and `fix_relationship_by_name` produce `edge-removed` events on the SSE feed. Dev-tool drawer should show non-zero counts.
- **Aggregate tier-balance check.** Snapshot pre-coherence fact-tier counts (`known` / `discoverable` / `secret`) from the inventory at stage 7 start. After coherence applies, count again. Compute per-tier delta. The model is allowed to add/remove facts at any tier — that's existing-pipeline trust, same as stages 2/3/4 — but the net direction matters at the aggregate level. **Target: post-coherence world preserves comparable proportions of `discoverable` and `secret` content** (within ±20% of baseline, or absolute count drop ≤ 2 facts, whichever is more generous on small worlds). If coherence systematically downgrades secrets to known across smoke runs (e.g., loses 50%+ of secret-tier facts world-over-world), the prompt is broken at the tier-judgment surface and needs to be re-pinned. Per-patch tier choice is model judgment, same as stage 2's; this aggregate signal is the gate against systematic destruction of secrets.

## 8. Migration of existing worlds

No data migration. The existing world `019e65a2-...` ("The Narrowing Path") will keep its 7 self-flagging relationships unless someone re-runs coherence on it (which isn't a normal flow). Future worlds will use the expanded vocabulary.

## 9. Rollout

Single PR. Schema + prompt + apply + tests all ship together. Close-loop per CLAUDE.md:

- Dev-tool verifier dispatched once with `E2E: required` (touches `backend/src/` reachable from a dev-tool call).
- Wiki update via the AUTHORING.md subagent: the coherence-pass narrative in `world-gen.html` lists the 5 patch kinds — update to 8 + the extended fix_relationship semantics.
- Push code + wiki together.

## 10. Known degradation surfaces

- **Coherence-pass cost goes up.** With more vocabulary, the model emits more patches per world. Today coherence is ~$0.21/world. Estimated post-change range: **$0.30-0.70/world**. Range is wide because over-emission is hard to predict — if the model treats "strongly implies" generously, the patch count could grow 4-5×, pushing per-world cost to the upper end. At launch volume (200-500 concurrent sessions), $0.40 of additional spend per world is material; the smoke run reports per-world cost so the estimate gets validated, and a follow-up may pin the prompt harder if the cost lands above $0.50.
- **`add_*` patches risk over-emission.** Removing the hard "no new relationships" ban and replacing it with the soft "only when strongly implies" constraint is a known LLM behavior shift, not a neutral edit. The prompt design needs to lean on concrete worked examples (the §5 rewrite will include 2-3) to teach the threshold. Smoke-time aggregate emit counts catch egregious over-emission; the eyeball audit catches subtle drift.
- **`add_relationship_by_name` duplicate-triple risk.** If the model emits `add_relationship_by_name(X, Y, type)` for a triple that already exists in the inventory, the INSERT creates a near-duplicate. Defense: in `applyAddRelationship`, check `relIdByTriple` before insert; if the exact triple exists, drop with WARN (`would_be_duplicate`) and skip. One-line guard in the apply function.
- **`add_fact_by_name` topic collision.** If the model adds a fact under a topic that already has a fact on that entity, the resulting set has two facts at the same `(entity, topic)`. Future `fix_fact_by_name` and `delete_fact_by_name` against that pair will then drop with `ambiguous_fact`. Defense: in `applyAddFact`, check the existing fact list for the (entity, topic) pair; if present, drop with WARN (`would_be_duplicate_topic`) and skip. One-line guard.
- **Stage 4b interaction (confirmation).** Coherence runs after stage 4b. The inventory loaded at stage 7 start includes ghost entities materialized by 4b + their relationships, persisted to the DB with their stage-4b synthKeys (per §2.4's persistence column). `add_relationship_by_name` against a ghost endpoint resolves normally — the ghost is a real entity by the time coherence sees it. No special handling needed.
- **Performance.** Each `add_*` is an INSERT + a name-resolution lookup; both are ~ms. No regression expected.
- **Tier-judgment trust on `add_fact_by_name`.** The model picks `access_level` per fact, matching the existing stage-2/3/4 trust pattern. Per-fact tier choice is judgment, not a leak vector — coherence runs pre-canon so post-coherence tiers ARE the canon. The risk is **aggregate** (systematic secret-tier erosion across many worlds), not per-patch. Defense: §7.4's aggregate tier-balance check. If smoke runs show coherence consistently downgrading secrets, the prompt is broken and gets re-pinned; the schema doesn't try to enforce a judgment the LLM is already trusted with everywhere else.

## 11. Non-goals

- `add_entity_by_name`, `delete_entity_by_name` — coherence cannot create or delete entities. Phantom declarations from stage 4 are the entity-add channel.
- Fact `replace` patches (rewrite topic + content together). The model can `delete_fact_by_name` + `add_fact_by_name` if topic needs to change. Adding a single combined kind is YAGNI.
- Cross-world coherence (e.g., "this NPC is similar to one in another world"). Not in scope.
- Lifting the `min(5)` relationship floor on stage 4's schema. Out of scope.

## 12. Open questions

None at spec-writing time. All decisions above are committed pending sign-off.
