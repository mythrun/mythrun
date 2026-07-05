# World-Gen Graph + Reveal Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOT a workflow (Miklos's call — mostly-sequential).

**Goal:** Rebuild the world-generation graph + reveal into the audit-approved experience — a fluid-sim fog over a two-act (chaos→order) generation, a rewarding reveal moment, and a real wiki — while fixing the two diagnosed bugs and closing the relationship-tier enforced-ignorance leak.

**Architecture:** Backend first (relationship tiering — unblocks the reveal's edges/RELATED). Then the two frontend bug fixes + stream widening (unblock all visual work). Then the fog + generation graph as first-class `@mythrun/ui` + `client-core` units (DOM-free `FogSim` brain, Canvas draw helper, thin shell). Then the reveal (transition, layout, mobile drawer, wiki rebuild). Accessibility folded through, with a final pass.

**Tech Stack:** Node 24 + Fastify + Postgres (backend); React + Canvas + d3-force + Tailwind + `@mythrun/ui`/`@mythrun/client-core`/`@mythrun/contract` (frontend); Vitest + Storybook; pnpm.

**Spec:** `docs/superpowers/specs/2026-07-05-worldgen-graph-reveal-redesign-design.md`. **Fog is canonical:** `docs/superpowers/specs/assets/2026-07-05-worldgen-fog-reference.html` (physics + constants = SOLE authority; copy verbatim). Two-act pacing: `.../2026-07-05-worldgen-twoact-reference.html`.

## Global Constraints

- **Port the fog physics EXACTLY** from `2026-07-05-worldgen-fog-reference.html` — it is the sole authority for every constant (RD, doublet spacing, cloud freqs, splat weights, the `/0.30` divisor, wind magnitude, etc.). Copy verbatim; do not re-derive. The LOCKED params (wind 0.35 · density 0.40 · close 0.1 · margin 10 · steady 0.03 · fade ON · fog `#A89F8A` @0.5 · entities mono-ink `#231B12` shape-differentiated) are the runtime defaults.
- Flat 1-bit paper register; **crisp Bayer, no gradients**; **no circles**; entities mono-ink, **shape-differentiated** (no color-by-type, no node text-tags).
- Prose = `[ph: …]` i18n keys (DS owns no copy; consumers pass resolved keys).
- Desktop AND ~375px, via a **virtual coordinate space** (constant logical width, CSS-scaled).
- Strict TS, no `any`; functions < 50 lines; modules < 400 lines.
- **The fog is split: `FogSim` (client-core, brain) + draw helper (`@mythrun/ui`, render) + shell — never one primitive.** Fixed-timestep (frame-rate-normalized).
- All UI in `@mythrun/ui` with a Storybook story; props types in `@mythrun/client-core/contract`; wire types in `@mythrun/contract`; backend access via `client-core`.
- Enforced ignorance server-side; the reveal is **known-tier including relationships**. UUIDv7 PKs.
- Test convention: scoped fixtures + `createTestPool` (`backend/src/__tests__/CONVENTIONS.md`); backend real-LLM smokes are standalone `tsx` scripts under `backend/scripts/smoke/`, not vitest.

---

## File Structure

**Phase A (backend tiering):** `backend/migrations/031_relationship_access_level.sql` (new); `backend/src/db/__tests__/migrate-schema.test.ts` (pins); `backend/src/llm/schemas/entity-relationships.ts`, `coherence-output.ts` (add `access_level`); `backend/src/llm/prompts/prep/entity-relationships.txt`, `coherence-pass.txt` (framing); `backend/src/llm/prep/stages/entity-relationships.ts`, `coherence-pass.ts`, `entity-consolidation.ts` (persist + emit tier); `backend/src/repo/relationships.ts` (`InsertRelationshipInput`, `insertMany`/`insertOne`, `listAmong` filter); `backend/src/repo/world-inventory.ts`, `world-snapshot-view.ts` (thread tier); `backend/scripts/smoke/` (constructed-state smoke).

**Phase B (bugs + stream):** `frontend/client-core/src/worldgen/graph-reducers.ts` (`GraphEdge.arrivalIndex`, `edgeSourceStage`), `use-worldgen-stream.ts` (displayId reconciliation + `stages`/`cost` exposure), `force-sim.ts` (containment + displayId keying + dimensions); `frontend/ui/src/components/WorldGenGraph/use-graph-canvas.ts`, `canvas-draw.ts` (displayId keying + fit).

**Phase C (fog + graph):** `frontend/client-core/src/worldgen/fog-sim.ts` (NEW), `fog-params.ts` (NEW); `frontend/ui/src/components/WorldGenFog/` (NEW: `fog-draw.ts`, `WorldGenFogField.tsx`, story); `frontend/ui/src/components/WorldGenGraph/` (rework: layered canvases, shape nodes, buoy bob, Act-2 edges, `showList`/`selectable` gate; remove `GhostBloomField.ts`); `frontend/ui/src/components/WorldGenStatusCard/` (NEW DOM component + story).

**Phase D (reveal):** `frontend/ui/src/components/RevealTransition/` (NEW + story); `frontend/ui/src/components/Drawer/` (NEW + story); `frontend/ui/src/components/WorldWiki/` (rework → `WikiPage`, `WikiHome`, `RelatedFooter`, `InlineLink`); `frontend/client-core/src/worldgen/wiki-view-model.ts` (body-from-facts, empty-body, relationships → RELATED), `use-wiki-navigation.ts` (NEW hook); `frontend/src/routes/worldgen/reveal.tsx` (Grid `columns={2}`, compose transition + drawer).

**Phase E (a11y):** threaded through B–D; final pass file `frontend/ui/src/components/WorldGenGraph/` (aria-live + roving-tabindex), drawer focus.

---

## PHASE A — Backend relationship tiering (§10)

Core-infra + security surface. Mirrors the `facts`/`entities` tiering (`014_access_tier_rework.sql`). Enum: `known` | `discoverable` | `secret`.

### Task A1: Migration — `access_level` on `relationships` + covering index

**Files:** Create `backend/migrations/031_relationship_access_level.sql`; Modify `backend/src/db/__tests__/migrate-schema.test.ts`.

**Interfaces — Produces:** a `relationships.access_level TEXT NOT NULL DEFAULT 'secret' CHECK IN (known,discoverable,secret)` column + `idx_relationships_world_access`-equivalent.

- [ ] **Step 1 — Write the migration** (mirror `014:24-29`; backfill default `secret` = safest, so nothing surfaces until re-tiered):
```sql
-- 031_relationship_access_level.sql
-- Relationships gain an access tier so the world-gen reveal (RELATED footer + graph edges)
-- can filter to known-tier — closing the enforced-ignorance leak where a secret connection
-- between two known entities would otherwise surface. Mirrors 014's facts/entities tiering.
ALTER TABLE relationships
  ADD COLUMN access_level TEXT NOT NULL DEFAULT 'secret'
  CHECK (access_level IN ('known', 'discoverable', 'secret'));

-- Covering index for the both-endpoints + tier snapshot read (clone of idx_entities_world_access).
CREATE INDEX idx_relationships_access ON relationships(access_level);
```
- [ ] **Step 2 — Pin it in `migrate-schema.test.ts`.** Append `'031_relationship_access_level.sql'` to the pinned migration list (~line 788-819). Insert into `EXPECTED_CHECK_CONSTRAINTS` (~113-346), in `(table_name, conname)` order — a `relationships` entry between `purchases` and `session_messages`:
```ts
{ table_name: 'relationships',
  check_clause: `CHECK ((access_level = ANY (ARRAY['known'::text, 'discoverable'::text, 'secret'::text])))` },
```
Insert `'idx_relationships_access'` into `EXPECTED_IDX_NAMES` (~68-111) in alphabetical order (before `idx_relationships_source`).
- [ ] **Step 3 — Run the schema test** (serial project): `pnpm --filter @mythrun/backend test migrate-schema` → PASS (migration applies, pins match, idempotent re-run returns `[]`).
- [ ] **Step 4 — Full-suite migration gate** per `[[reference_migrate_schema_pin_per_migration]]`: `pnpm --filter @mythrun/backend test` → 0 failures.
- [ ] **Step 5 — Commit** `feat(MYT-89): migration — relationships.access_level (backfill secret)`.

### Task A2: LLM output schemas emit a per-relationship tier

**Files:** Modify `backend/src/llm/schemas/entity-relationships.ts` (`relationshipItemSchema`), `backend/src/llm/schemas/coherence-output.ts` (`addRelationshipPatch`, `fixRelationshipPatch`).

**Interfaces — Consumes:** `ACCESS_LEVEL = z.enum(['known','discoverable','secret'])` (mirror `entity-consolidation.ts:20`). **Produces:** relationship LLM outputs carry `access_level`.

- [ ] **Step 1 — Failing test** (`entity-relationships` schema test): assert a relationship object WITHOUT `access_level` fails parse and one WITH `access_level: 'secret'` passes; assert an invalid tier rejects.
- [ ] **Step 2 — Add the field** to `relationshipItemSchema` (`entity-relationships.ts:28-37`):
```ts
const relationshipItemSchema = z.object({
  from_name: z.string().min(1).max(200),
  to_name: z.string().min(1).max(200),
  relationship: z.string().min(2).max(60),
  description: z.string().min(10),
  access_level: z.enum(['known', 'discoverable', 'secret']),
})
```
And to `addRelationshipPatch` (`coherence-output.ts:62-69`) + `fixRelationshipPatch` (`.newAccessLevel?` optional, mirroring `newType`/`newDescription`).
- [ ] **Step 3 — Run** the schema tests → PASS.
- [ ] **Step 4 — Commit** `feat(MYT-89): relationship LLM schemas carry access_level`.

### Task A3: Prompts frame relationship secrecy

**Files:** Modify `backend/src/llm/prompts/prep/entity-relationships.txt` (relationships array spec ~32-38), `coherence-pass.txt` (`add_relationship_by_name` ~82).

**Interfaces — Consumes:** A2's schema field. **Produces:** prompt instructs the LLM to tag each relationship's `access_level`.

- [ ] **Step 1** — Add to the relationships array spec the `access_level` field + the framing (verbatim intent, in the file's terse register): *"access_level — `known` only if the CONNECTION ITSELF is public knowledge, independent of the two entities' own tiers. Two publicly-known entities can be **secretly** connected (`secret`); a connection hinted-at but unconfirmed is `discoverable`."* Mirror the existing `add_fact_by_name` access_level line (`coherence-pass.txt:83`) for the coherence prompt.
- [ ] **Step 2 — Commit** `feat(MYT-89): prompt framing for relationship access_level` (prompt+schema co-evolve, `[[feedback_prompt_schema_co_evolution]]`).

### Task A4: Persist + emit the tier through all three stages

**Files:** Modify `backend/src/repo/relationships.ts` (`InsertRelationshipInput`, `insertMany`, `insertOne`); `backend/src/llm/prep/stages/entity-relationships.ts` (`:444-471` persist), `coherence-pass.ts` (`applyAddRelationship`, `applyFixRelationship`), `entity-consolidation.ts` (`:288-299` + `PendingRelationship`).

**Interfaces — Consumes:** A2 outputs. **Produces:** `InsertRelationshipInput` gains `accessLevel: AccessLevel`; rows persist it; `insertIntegrationEdge` defaults `'known'` (PC edges are player-created, non-secret).

- [ ] **Step 1 — Failing repo test:** `insertMany`/`insertOne` round-trip `access_level`; `insertIntegrationEdge` yields `'known'`.
- [ ] **Step 2 — Thread it:** add `accessLevel` to `InsertRelationshipInput` (`relationships.ts:11-21`), add the column to the `insertMany`/`insertOne` INSERTs, default `'known'` in `insertIntegrationEdge`. In `entity-relationships.ts` map `a.access_level` into the insert; in `entity-consolidation.ts` extend `PendingRelationship` (`:85-90`) with `accessLevel` and carry it from the stage-4 buffer; in `coherence-pass.ts` carry `patch.access_level`.
- [ ] **Step 3 — Run** repo + stage tests → PASS. Then full backend suite.
- [ ] **Step 4 — Commit** `feat(MYT-89): persist relationship access_level across stages 4/4b/7`.

### Task A5: Snapshot filters relationships to known-tier + real-LLM constructed-state smoke

**Files:** Modify `backend/src/repo/relationships.ts` (`listAmong` signature + filter), `backend/src/repo/world-inventory.ts` (map shape), `backend/src/repo/world-snapshot-view.ts` (`:119` pass the tier filter); Create `backend/scripts/smoke/relationship-tiering.ts`.

**Interfaces — Consumes:** A1's column. **Produces:** `listAmong(client, entityIds, accessLevels)` filters to the tier list; the reveal snapshot omits `secret`/`discoverable` relationships.

- [ ] **Step 1 — Failing test:** seed two `known` entities + a `secret` relationship + a `known` relationship; `listAmong(client, [both ids], ['known'])` returns ONLY the known relationship; `['known','discoverable','secret']` (bypass) returns both.
- [ ] **Step 2 — Filter:** add `AND access_level = ANY($2)` to `listAmong` (`relationships.ts:186-197`), thread `accessLevels` from `world-snapshot-view.ts:119` (reuse its existing `accessLevels` array `:65-67`). Add `accessLevel` to the `world-inventory.ts` relationship map (`:41-54`) + `RelationshipRow`.
- [ ] **Step 3 — Run** → PASS; full backend suite → 0 failures; `pnpm --filter @mythrun/backend typecheck` + `lint`.
- [ ] **Step 4 — Constructed-state real-LLM smoke** (`[[feedback_constructed_state_smoke]]`): a standalone `tsx` script that runs stages 4→7 on a seeded world with a planted secret connection between two known entities, then asserts the reveal snapshot's `relationships` excludes the secret one. `pnpm tsx backend/scripts/smoke/relationship-tiering.ts`.
- [ ] **Step 5 — Commit** `feat(MYT-89): known-tier relationship filter in reveal snapshot + smoke`.

---

## PHASE B — The two bug fixes + stream widening (§2, §3.1/3.3/3.5)

### Task B1: Reconcile the graph to a single `displayId` id-space (fixes edges, both paths)

**Files:** Modify `frontend/client-core/src/worldgen/force-sim.ts` (key on `displayId`), `frontend/ui/src/components/WorldGenGraph/use-graph-canvas.ts` + `canvas-draw.ts` (positions keyed by `displayId`); keep `GraphNode.synthKey` as-is for `stage-reset`/pin.

**Interfaces — Consumes:** `GraphNode.displayId` (already the resolved UUID for finalized + seed nodes; edges already carry UUIDs). **Produces:** the invariant **node render-identity === edge endpoint-space === `displayId`**, reconciled post-merge. `ForceSim.sync`/`positions`/`pin`/`unpin` key on `displayId`; `nearestKey` returns a `displayId`; `onSelect` still receives what `reveal.tsx`'s bridge expects (see B1-note).

- [ ] **Step 1 — Failing test** (client-core): construct nodes where a live-won node keeps `synthKey='world_and_factions/factions/0'`, `displayId=<uuidA>`, plus a seed-only node `displayId=<uuidB>`, and an edge `{from: uuidA, to: uuidB}`. Assert `buildLinks` (or a new `buildLinksByDisplayId`) retains the edge (currently drops it).
- [ ] **Step 2 — Re-key the sim on `displayId`:** in `force-sim.ts`, change `byKey`/`seedNode`/`mergeNodes`/`buildLinks`/`positions`/`pin`/`unpin`/`linkForce.id` from `node.synthKey` to `node.displayId` (the SimNode field becomes `displayId`). `buildLinks` filters `byKey.has(e.from) && byKey.has(e.to)` — now UUID-vs-UUID, so edges survive.
- [ ] **Step 3 — Re-key the draw + pointer** in `use-graph-canvas.ts`/`canvas-draw.ts`: `drawNodes` reads `positions.get(node.displayId)`; `drawEdges` reads `positions.get(edge.from/to)` (already UUIDs — now they match); `nearestKey`/`pin`/`onSelect` operate in `displayId` space.
- [ ] **B1-note (the keying ripple, §2.1):** `reveal.tsx`'s `buildIdBridge` maps `synthKey↔displayId`; since the graph now selects by `displayId` (= entity id), the bridge can shrink to identity for selection — but `stage-reset`'s `deleteStagePrefix` in `deriveNodes` still needs `synthKey` (keep the field on `GraphNode`; it's untouched). Update `onSelect`'s contract doc: it now emits a `displayId`. Adjust `reveal.tsx`'s `onSelect`/`selectedKey` to pass `displayId` directly (drop the synthKey→id lookup), keeping `selectedEntityId` as the single source.
- [ ] **Step 4 — Run** the client-core + graph tests → PASS. Add a test proving a live-won node + seed-only node connect.
- [ ] **Step 5 — Commit** `fix(MYT-89): reconcile graph to a single displayId id-space — edges render on both paths`.

### Task B2: Viewport containment for both gen and reveal

**Files:** Modify `frontend/client-core/src/worldgen/force-sim.ts` (accept dimensions + boundary force + `distanceMax`), `frontend/ui/src/components/WorldGenGraph/use-graph-canvas.ts` (pass logical dimensions; fit).

**Interfaces — Produces:** `createForceSim(opts: { width: number; height: number })`; nodes stay within `[−w/2, w/2] × [−h/2, h/2]`.

- [ ] **Step 1 — Failing test:** run `settle()` on a sim with strong repulsion + no links; assert all `positions()` are within the bounds (currently a node escapes).
- [ ] **Step 2 — Add containment:** in `force-sim.ts`, add `forceX(0).strength(small)` + `forceY(0).strength(small)`, a `distanceMax` on `forceManyBody`, and a per-tick clamp in `tick()` to the passed half-dimensions. `createForceSim` takes `{width,height}` (the virtual coordinate space, B/C share it).
- [ ] **Step 3 — Thread dimensions** from `use-graph-canvas.ts` (the logical width from §3.6, Task C-setup) into `createForceSim`.
- [ ] **Step 4 — Specify the generation layout source (§8.4):** the generation graph keeps the (now-contained) force-sim for placement — nodes stream in and settle within bounds. Document this in `use-graph-canvas.ts` header.
- [ ] **Step 5 — Run → PASS; commit** `fix(MYT-89): contain the graph in the viewport (gen + reveal)`.

### Task B3: `GraphEdge` arrival-index + edge-source classification

**Files:** Modify `frontend/client-core/src/worldgen/graph-reducers.ts` (`GraphEdge.arrivalIndex`, `edgeSourceStage`).

**Interfaces — Produces:** `GraphEdge` gains `readonly arrivalIndex: number` (the event index it first appeared) + `readonly sourceStage: 'weave' | 'snap'` (classified by `synthKey` prefix: `entity_relationships/`|`entity_consolidation/` → `weave`, `coherence_pass/` → `snap`). Consumed by C6 (Act-2 penstroke sequencing).

- [ ] **Step 1 — Failing test:** feed `edge-added` events in order; assert each `GraphEdge.arrivalIndex` reflects first-seen order and `sourceStage` classifies by prefix.
- [ ] **Step 2 — Implement:** in `applyEdgeEvent`, record the event index on first insert; add `classifyEdgeStage(synthKey)`. `mergeEdges` preserves `arrivalIndex` (seed edges get `-1`, sort last-before-live or treated as already-present).
- [ ] **Step 3 — Run → PASS; commit** `feat(MYT-89): GraphEdge arrivalIndex + weave/snap classification`.

### Task B4: Widen `useWorldGenStream` to expose stages + cost

**Files:** Modify `frontend/client-core/src/worldgen/use-worldgen-stream.ts` (`phaseFromSnapshot` → keep `stages[]`, `cumulativeCostUsd`; expose on the return).

**Interfaces — Produces:** `WorldGenStream` gains `readonly stages: StageProgress[]` + `readonly costUsd: number | null` (from the first-frame snapshot payload the hook currently discards at `:98-102`).

- [ ] **Step 1 — Failing test:** feed a snapshot payload with `stages` + `cumulativeCostUsd`; assert the hook exposes them (currently dropped).
- [ ] **Step 2 — Implement:** widen `phaseFromSnapshot` to a `parseSnapshotProgress` returning `{phase, stages, costUsd}`; store + expose. Define `StageProgress` in contract.
- [ ] **Step 3 — Run → PASS; commit** `feat(MYT-89): expose stages[] + cost from the world-gen stream`.

### Task B5: Phase-B whole-suite verification

- [ ] `pnpm --filter @mythrun/client-core test && pnpm --filter @mythrun/ui test`, `typecheck`, `lint` (`eslint src`, `[[reference_eslint_src_vs_per_file_type_aware]]`) → all green. Commit any fixes. This closes the "edges render" bug end-to-end (verify with a reveal render test asserting `drawEdges` receives resolvable positions).

---

## PHASE C — Fog + generation graph (§3.2–3.7)

### Task C1: `fog-params.ts` — the locked params as typed constants

**Files:** Create `frontend/client-core/src/worldgen/fog-params.ts`.

**Interfaces — Produces:** `FOG_PARAMS` (wind/density/close/margin/steady/fade + color/alpha) + the internal constants copied verbatim from the reference (RD=13, doublet spacing 24, CELL=6, the `/0.30` divisor, cloud freqs, splat weights, wind `[-1.75,0.9]`, turbulence coeffs). `VIRTUAL_WIDTH`/`VIRTUAL_HEIGHT` (the §3.6 logical space).

- [ ] **Step 1** — Transcribe every constant from `2026-07-05-worldgen-fog-reference.html` into named exports (the file's header cites the reference as authority). No re-derivation.
- [ ] **Step 2 — Commit** `feat(MYT-89): fog params (verbatim from the canonical prototype)`.

### Task C2: `FogSim` — the DOM-free fluid core

**Files:** Create `frontend/client-core/src/worldgen/fog-sim.ts` + `__tests__/fog-sim.test.ts`.

**Interfaces — Produces:**
```ts
interface FogObstacle { x: number; y: number; w: number; h: number; vx: number; vy: number }
interface FogSim {
  step(dtMs: number, obstacles: readonly FogObstacle[], effectiveDensity: number): void
  density(): Float32Array   // GW×GH grid, temporally smoothed, box-cleared under obstacles
  readonly gw: number; readonly gh: number
}
function createFogSim(opts: { width: number; height: number; random?: () => number }): FogSim
```
Port verbatim: wind stream (spawn top+right flux-weighted / despawn+respawn), warm-start full-field seed, turbulence, potential-flow doublets + gated wake-close + drag-wake, particle exclusion (`EXR=12+margin`), splat → temporal low-pass (`steady`) → density-box clear. **Fixed-timestep** (accumulate `dtMs`, step in fixed increments). Injectable RNG (like `GhostBloomField`), so it's deterministic + testable. Particle count scales by area (`§3.6`): `N = round(BASE_N × (width×height)/(VIRTUAL_WIDTH×VIRTUAL_HEIGHT))`. **Perf (§3.7):** spatially bucket doublets (evaluate only within a few `RD`); skip the step when `effectiveDensity ≈ 0`.

- [ ] **Step 1 — Failing tests:** (a) determinism — same seed + same obstacle sequence → identical `density()`; (b) exclusion — no density inside an obstacle's box; (c) fixed-timestep — one `step(32)` ≈ two `step(16)` (frame-rate independence); (d) fade — `effectiveDensity=0` → all-zero density; (e) rejoin — a downstream cell behind an obstacle recovers density (not a permanent shadow).
- [ ] **Step 2 — Implement** by porting the reference physics into the pure core (no Canvas). Functions < 50 lines (split advection / doublet-field / splat / smooth / box-clear).
- [ ] **Step 3 — Run → PASS; commit** `feat(MYT-89): FogSim — DOM-free fluid core (ported verbatim)`.

### Task C3: Fog draw helper + `WorldGenFogField` shell + story

**Files:** Create `frontend/ui/src/components/WorldGenFog/fog-draw.ts`, `WorldGenFogField.tsx`, `WorldGenFogField.stories.tsx`; props in `frontend/client-core/src/contract/world-gen-fog.ts`.

**Interfaces — Consumes:** `FogSim`, `bayer.ts` (`thresholdAt`), `FOG_PARAMS`. **Produces:** `paintFog(ctx, density, gw, gh, {color, alpha, cloudMask})` — solid Bayer cells, fixed 0.5 alpha, no gradient; `WorldGenFogField` React shell (own canvas layer, rAF/DPR, fixed-timestep loop, reduced-motion → static settled density recomputed on entity-count change).

- [ ] **Step 1 — Failing test:** `paintFog` fills a cell iff `cov > thresholdAt` (unit-test the threshold decision on a stub ctx); no fractional alpha per cell.
- [ ] **Step 2 — Implement** the draw helper (reuse `thresholdAt` from `Dither/bayer.ts` — do NOT touch the SVG `Dither` component; pin the sin-hash-vs-xorshift chaos choice to `bayer.ts`'s `chaosAt` per §5) + the shell.
- [ ] **Step 3 — Story** (`Patterns/WorldGenFogField`): feed synthetic obstacles (the prototype's `ENTS`), a density slider, an entity-count slider driving fade — so the fog tunes in isolation.
- [ ] **Step 4 — Run + Storybook build; commit** `feat(MYT-89): WorldGenFogField — fog draw + shell + story`.

### Task C4: Status card — DOM component + story

**Files:** Create `frontend/ui/src/components/WorldGenStatusCard/WorldGenStatusCard.tsx` + story; props in contract.

**Interfaces — Consumes:** B4's `stages`/`phase`/`costUsd`. **Produces:** a DOM card (`Spinner` + phase `Text` + a progress element) — NOT canvas-painted; i18n `[ph: …]` phase labels; `%` = completed-stages / total (stage-count).

- [ ] **Step 1 — Story-first** (it's presentational): render with phase + 40% + spinner. Test: renders the phase label + an accessible progressbar (`role="progressbar"` `aria-valuenow`).
- [ ] **Step 2 — Implement; run → PASS; commit** `feat(MYT-89): WorldGenStatusCard (DOM, accessible)`.

### Task C5: Rework `WorldGenGraph` — layered canvases, shape nodes, buoy bob, gates

**Files:** Modify `frontend/ui/src/components/WorldGenGraph/WorldGenGraph.tsx`, `use-graph-canvas.ts`, `canvas-draw.ts`; **delete** `GhostBloomField.ts` + its story/tests.

**Interfaces — Consumes:** `WorldGenFogField`, `FogSim` obstacles (node capsules from positions), the reworked props. **Produces:** `WorldGenGraphProps` gains `showList?: boolean` (default true) + `selectable?: boolean` (default true) + `phase`/`stages` for the status card + a `settled?: boolean` (reveal). Fog is a **layer behind** the graph canvas (two stacked canvases). Nodes = shape glyphs (`drawGlyph` already does this — mono-ink) with **render-only buoy bob** (per-node phase offset; true position + clear-zone fixed). Node names render during gen (capsule geometry depends on it).

- [ ] **Step 1 — Failing tests:** (a) `showList={false}` → no `EntityList` in the DOM; (b) `selectable={false}` → pointer taps don't call `onSelect`; (c) the fog obstacles derive from node positions (capsule per node incl. label width). Keep `EntityList` for the a11y path only when `showList` (see E1 for the hidden-list a11y alternative during gen).
- [ ] **Step 2 — Implement:** compose `<WorldGenFogField>` (behind) + the node canvas (front); gate `EntityList`/selection; buoy bob in the node draw (render-only offset, port from the reference bob). Remove `GhostBloomField` usage from `startMotionLoop`. Feed the status card `phase`/`stages`.
- [ ] **Step 3 — Update the story** (both gen `showList=false` and settled variants). Run → PASS.
- [ ] **Step 4 — Commit** `feat(MYT-89): WorldGenGraph rework — fog layer, shape nodes, bob, gen gates; remove GhostBloom`.

### Task C6: Act-2 edge draw-in (penstroke, off the stream)

**Files:** Create `frontend/client-core/src/worldgen/use-edge-animation.ts` (timeline) + test; Modify `canvas-draw.ts` (`drawEdge` accepts a `progress` 0–1).

**Interfaces — Consumes:** `GraphEdge.arrivalIndex`/`sourceStage` (B3). **Produces:** `useEdgeAnimation(edges, now)` → per-edge draw `progress` (weave edges ease over ~2s from arrival; snap edges appear ~instant); drives `drawEdge(ctx, a, b, key, progress)` (partial quadratic).

- [ ] **Step 1 — Failing test:** a weave edge at `arrivalIndex` N has `progress` ramping 0→1 over the duration; a snap edge jumps to 1.
- [ ] **Step 2 — Implement** the timeline hook + partial-stroke in `drawEdge`. Run → PASS.
- [ ] **Step 3 — Commit** `feat(MYT-89): Act-2 penstroke edge draw-in off the SSE stream`.

### Task C7: Wire the generation route + fade-with-entities

**Files:** Modify `frontend/src/routes/worldgen/generating.tsx` (pass `showList={false}`, `selectable={false}`, `phase`, `stages`; the status card).

**Interfaces — Consumes:** C4/C5, B4. **Produces:** the live generation view — fog fades as `shownEntities/total` rises (fade param wired), status card top-left, no list/selection.

- [ ] **Step 1 — Failing render test:** `GeneratingView` renders `WorldGenGraph` with `showList={false}` + the status card; no `EntityList` node.
- [ ] **Step 2 — Implement; run → PASS; commit** `feat(MYT-89): generation view — fog + status card, no list/selection`.

### Task C8: Phase-C verification (incl. perf smoke)

- [ ] `pnpm --filter @mythrun/client-core test && --filter @mythrun/ui test`, `typecheck`, `lint`, Storybook build. A **manual perf check** (§3.7): a Storybook story with 41 synthetic entities — confirm 60fps (dev-tools perf) + `prefers-reduced-motion` freezes to a static settled density. Record the result. Commit fixes.

---

## PHASE D — Reveal + transition + wiki (§3.8, §4)

### Task D1: `Drawer` — mobile edge-handle sheet + story

**Files:** Create `frontend/ui/src/components/Drawer/Drawer.tsx` + story; props in contract. (No Drawer exists; `Modal` is a centered dialog — not reusable here.)

**Interfaces — Produces:** `Drawer` — full-width right sheet, a right-edge handle pinned in both states (summon ‹ / dismiss › same spot), `open`/`onOpenChange`, **retains children state across open/close** (mount-persistent; animate transform, don't unmount), focus-in/restore/trap (reuse Radix `Dialog` primitives like `Modal`, but as a side sheet), reduced-motion → no slide.

- [ ] **Step 1 — Failing tests:** handle toggles `open`; content stays mounted when closed (state persists); focus moves in on open + restores on close.
- [ ] **Step 2 — Implement; story** (`Patterns/Drawer`, mobile viewport); run → PASS.
- [ ] **Step 3 — Commit** `feat(MYT-89): Drawer — mobile edge-handle sheet`.

### Task D2: `wiki-view-model` — body-from-facts, empty-body, RELATED from tiered relationships

**Files:** Modify `frontend/client-core/src/worldgen/wiki-view-model.ts` (widen input to the relationships-bearing snapshot; `WikiEntity` gains `related: RelatedLink[]`; body-from-facts + empty-body flag) + tests.

**Interfaces — Consumes:** the widened `WorldGenSnapshot` (`relationships` now known-tier from Phase A). **Produces:** `WikiEntity` gains `readonly related: readonly { entityId: string; name: string; label: string }[]` (from `snapshot.relationships`, id→name resolved, `relationship_type` de-snaked) + `readonly hasBody: boolean`. Body is the composed known-tier facts (topic/content), NOT "flowing prose"; empty-body when no known facts.

- [ ] **Step 1 — Failing tests:** an entity with a relationship yields a `related` link with a de-snaked label + resolved target name; an entity with zero facts yields `hasBody: false`; `toWikiViewModel` input type is the relationships-bearing snapshot.
- [ ] **Step 2 — Implement:** widen the input type; index relationships by entity (both directions); de-snake `relationship_type` (`warded_by` → "warded by"); set `hasBody`.
- [ ] **Step 3 — Run → PASS; commit** `feat(MYT-89): wiki view-model — RELATED links + empty-body`.

### Task D3: `use-wiki-navigation` — the wiki history stack (client-core)

**Files:** Create `frontend/client-core/src/worldgen/use-wiki-navigation.ts` + test.

**Interfaces — Produces:** `useWikiNavigation()` → `{ current: WikiLocation; push(entityId); home(); back(); canBack }` (a platform-neutral stack, NOT router/component state). `WikiLocation = { type: 'home' } | { type: 'entity', entityId, scroll }`; retains scroll per entry (for the drawer's persistent state).

- [ ] **Step 1 — Failing test:** `push(A) → push(B) → back()` returns to A; `home()` resets; `canBack` reflects depth.
- [ ] **Step 2 — Implement; run → PASS; commit** `feat(MYT-89): useWikiNavigation — wiki history stack`.

### Task D4: `WorldWiki` rebuild — WikiHome / WikiPage / RelatedFooter / InlineLink

**Files:** Rework `frontend/ui/src/components/WorldWiki/WorldWiki.tsx`; Create `WikiHome.tsx`, `WikiPage.tsx`, `RelatedFooter.tsx`, `InlineLink.tsx` + stories; update contract props.

**Interfaces — Consumes:** D2's view model, D3's navigation. **Produces:** real wiki pages — `WikiHome` (search + browse-by-kind), `WikiPage` (back-nav, name+kind, body-from-facts or empty state, `RelatedFooter`), `RelatedFooter` (the `related` links), `InlineLink` (§8.1 decision — see D4-note). Replaces the inline-dropdown tree.

- [ ] **D4-note (resolve §8.1 inline links):** **Decision: drop inline prose links for v1; rely on the RELATED footer** (structured, UUID-resolved, no collision hazard) as the navigation mechanism. Fact `content` is short structured text; naive name-matching over it risks `Bell`/`Bell-Wardens` collisions and adds ZFC-tension pattern-matching. `InlineLink` is scaffolded (component + story) but the wiki body does not auto-linkify in v1 — RELATED carries cross-navigation. (Revisit if the prep engine ever marks mentions.)
- [ ] **Step 1 — Failing tests:** `WikiHome` renders search + kind groups with clickable entities; `WikiPage` renders the body + RELATED links + a working back button (via `useWikiNavigation`); an empty-body entity shows the empty state.
- [ ] **Step 2 — Implement** the sub-components + compose in `WorldWiki` (driven by `useWikiNavigation`); stories for each.
- [ ] **Step 3 — Run → PASS; commit** `feat(MYT-89): WorldWiki rebuild — home/page/related, back-nav`.

### Task D5: Reveal layout — desktop 50/50 + mobile drawer

**Files:** Modify `frontend/src/routes/worldgen/reveal.tsx` (Grid `columns={2}`; compose `WorldGenGraph settled` + desktop wiki pane / mobile `Drawer`).

**Interfaces — Consumes:** D1/D4, C5 (`settled`). **Produces:** desktop = `Grid columns={2}` (fixes the `auto-fill` empty-tracks bug — the two panes stretch to fill); mobile = fullscreen graph + `Drawer` wiki; bidirectional graph↔wiki selection (graph select → wiki page; wiki select → graph highlight); node-tap opens the drawer on mobile.

- [ ] **Step 1 — Failing tests:** desktop renders `Grid columns={2}` (not `auto-fill`); mobile (375px) renders the graph + a closed `Drawer`; selecting a graph node navigates the wiki and vice-versa.
- [ ] **Step 2 — Implement** (responsive: the `Drawer` only on the mobile breakpoint; desktop uses the pane). Simplify the `buildIdBridge` per B1-note (selection is `displayId`/entity-id throughout).
- [ ] **Step 3 — Run → PASS; commit** `feat(MYT-89): reveal layout — desktop 50/50 + mobile drawer`.

### Task D6: `RevealTransition` — the reward moment + story

**Files:** Create `frontend/ui/src/components/RevealTransition/RevealTransition.tsx` + story; props in contract; wire in `campaign-detail.tsx` (the gen→reveal switch).

**Interfaces — Consumes:** a completion signal + `prefersReducedMotion`. **Produces:** the §3.8 sequence — (1) fog-lift (final gust; fog totally gone), (2) settle + title fade-in, (3) layout resolve: **desktop** graph eases to left 50% + wiki slides in; **mobile** graph stays fullscreen + drawer handle nudges in. Reduced-motion → ~300ms cross-fade (fog cleared, layout final, title fades). Owns the timeline; composes the fog field (final gust) + graph (settle) + the layout shift.

- [ ] **Step 1 — Failing tests:** on the completion signal, the transition runs the 3 phases (assert observable end-state: fog density 0, title present, layout in final position); reduced-motion → the cross-fade path (no slide) still reaches the final state with the title.
- [ ] **Step 2 — Implement; story** (`Patterns/RevealTransition`, synthetic completed graph, a "replay" control, desktop + mobile viewports).
- [ ] **Step 3 — Wire** `campaign-detail.tsx`: insert the transition between `SettlingView`/`worldReady` and `<WorldReveal>` (the moment plays once on first reach of `world_ready`, then the static reveal). Run → PASS.
- [ ] **Step 4 — Commit** `feat(MYT-89): RevealTransition — the reward moment (desktop/mobile, reduced-motion)`.

### Task D7: Phase-D verification

- [ ] Full frontend suite + `typecheck` + `lint` (`eslint src`) + Storybook build. **Visual audit prep** (`[[feedback_frontend_visual_audit_before_push]]`): a local run of the gen→reveal flow (the dev tool) so Miklos can eyeball the moment before push. Commit fixes.

---

## PHASE E — Accessibility (§7)

### Task E1: Generation-phase accessible model

**Files:** Modify `WorldGenGraph.tsx` (aria-live region + visually-hidden entity list when `showList={false}`).

**Interfaces — Produces:** during gen (no visual list), an `aria-live="polite"` region announcing phase + entities as they arrive, and a `VisuallyHidden` entity list (reuse the `VisuallyHidden` component) so SR users aren't cut off.

- [ ] **Step 1 — Failing test:** `showList={false}` still renders an `aria-live` region + a visually-hidden list of entity names. Implement; run → PASS; commit.

### Task E2: Reveal keyboard + drawer focus

**Files:** Modify `WorldGenGraph` (settled: roving-tabindex hidden node list mirroring selection), `Drawer` (focus-in/restore/trap — done in D1; verify), `reveal.tsx` (mobile Back-button precedence: page-back → close-drawer → leave-route).

- [ ] **Step 1 — Failing tests:** keyboard selects a graph node (via the hidden roving list) → wiki navigates; the wiki `WikiHome` browse is the guaranteed keyboard path to every entity; mobile Back closes the drawer before leaving the route. Implement; run → PASS; commit.

### Task E3: `prefers-reduced-motion` across all motion sources

**Files:** Verify across `WorldGenFogField` (static settled density, recomputed on entity-count change — preserves the fade progress signal), buoy bob (disabled), Act-2 edges (instant), `RevealTransition` (300ms cross-fade), status card `%` becomes primary progress.

- [ ] **Step 1 — Tests** per source (each already has a reduced-motion branch from C/D — this is the consolidation pass): assert no rAF/motion under reduced-motion while the progress signal (fade + `%`) still updates. Run → PASS; commit `feat(MYT-89): reduced-motion across fog/bob/edges/transition`.

---

## Self-Review

**Spec coverage:** §2.1 → B1; §2.2 → B2; §3.1 (two-act + edge sources) → B3/C6; §3.2 fog → C1–C3; §3.3 status card → C4; §3.4 gates → C5/C7; §3.5 edges → B3/C6; §3.6 resolution → C1/C2 (`VIRTUAL_*`, area-scaled N); §3.7 perf → C2/C8; §3.8 reveal moment → D6; §4.1 layout → D5; §4.2 wiki → D2/D4; §4.3 reveal graph → C5/D5; §5 decomposition → the FogSim/draw/shell + Drawer/RevealTransition/wiki sub-components split throughout; §6 non-negotiables → Global Constraints; §7 a11y → E1–E3; §8 open items → resolved (D4-note inline-links dropped-for-v1; C4 %-stage-count; C2 reveal-reuse via `effectiveDensity` param; B2 gen-layout = contained force-sim); §10 tiering → A1–A5.

**Placeholder scan:** none — the fog "port from reference" points at concrete code (the reference IS the complete code); every other task shows the crux change.

**Type consistency:** `displayId` keying (B1) threads to force-sim + draw + reveal bridge; `FogObstacle`/`FogSim` (C2) consumed by C3/C5; `GraphEdge.arrivalIndex`/`sourceStage` (B3) consumed by C6; `WikiEntity.related`/`hasBody` (D2) consumed by D4; `useWikiNavigation` (D3) consumed by D4/D5; `stages`/`costUsd` (B4) consumed by C4.

**Dependency order:** A (backend, independent) → B (bugs, unblocks visual) → C (fog/graph, needs B) → D (reveal, needs A+C) → E (a11y, needs C/D). Within a phase, tasks are sequential where they share interfaces.
