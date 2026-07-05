# World-Gen Graph + Reveal Redesign — Design Spec

> **Linear:** MYT-89 follow-up (audit-driven redesign of the generation-graph + reveal experience).
> **Status:** Design approved (brainstormed + visually prototyped with Miklos), blind-reviewed (round 1 "Weather", 2 showstoppers fixed inline, nits folded in). §10 resolved (Miklos: tier relationships). Ready for the user-review gate → plan → build.
> **Canonical references (port the fog physics EXACTLY; do not re-derive):**
> - Fog field: [`assets/2026-07-05-worldgen-fog-reference.html`](./assets/2026-07-05-worldgen-fog-reference.html)
> - Two-act pacing + edge draw-in: [`assets/2026-07-05-worldgen-twoact-reference.html`](./assets/2026-07-05-worldgen-twoact-reference.html)

## 1. Context

MYT-89 shipped the campaign-creation + world-gen vertical. A live-use audit surfaced ~8 issues that are **one cohesive redesign** of two surfaces — the **generation graph** (what a player watches while their world builds, ~10–12 min) and the **reveal** (the finished world: graph + wiki). Two are outright bugs; the rest rethink the generation atmosphere and the reveal layout.

This is complex, precisely-tuned UI. **The fog prototype is the source of truth for the fluid physics** — a real simulation whose dozen interlocking constants were dialed in by eye. "Close enough" is not acceptable for the physics. **However, "port exactly" is scoped to the fog physics and the pacing — not to the prototype's render *surface* choices** (it paints the status card into the canvas and hard-codes a 900×470 field and 12 fixed entities; production is responsive, streams real entities, and must be accessible). This document resolves the decisions the prototype cannot: resolution/scaling (§3.6), frame-rate normalization (§3.2), label typography (§3.2), accessibility (§7), and component decomposition (§5).

## 2. Two root-caused bugs

### 2.1 Edges never render — `synthKey`↔UUID identity mismatch

The pipeline **does** emit `edge-added` (late stages — §3.1), and every `edge-added` carries **real entity UUID** endpoints (`streaming-extractor.ts`, `entity-consolidation.ts`, `coherence-pass.ts`). But live-gen **nodes are keyed by `synthKey`**, and `ForceSim.buildLinks` / `drawEdges` look a *node* up by the edge's UUID endpoint against a `synthKey`-keyed map → the lookup always misses → **every edge is filtered out**.

**The scoped fix in the prior draft (fix in `deriveEdges` OR re-key `deriveNodes`) is insufficient — it cannot fix the reveal.** The reveal is fed the *same live-merged stream* (`campaign-detail.tsx` → `useWorldGenStream` → `WorldReveal` → `WorldGenGraph`). In that stream `mergeNodes` dedups seed-vs-live by `displayId` and the **live copy wins**, so merged nodes are **heterogeneously keyed** (live-won nodes keep `synthKey`; seed-only nodes keep the UUID from `snapshotToSeed`). Seed edges carry UUID endpoints and are merged raw by `mergeEdges` — they **never pass through `deriveEdges`**. So a `deriveEdges`-local fix translates only live edges and still fails to connect live-won nodes; a `deriveNodes` re-key can't touch seed-only nodes.

**Required fix — one canonical id-space at/below the merge:** key the force-sim and the draw layer on **`displayId`** (already the resolved UUID for finalized + seed nodes; all edge endpoints are already UUIDs). This collapses live-won nodes, seed-only nodes, and every edge endpoint into one space. State the invariant explicitly: **node key-space === edge endpoint-space === `displayId`**, reconciled *post-merge*. **Retract the "fix in `deriveEdges`" option.**

**Name the keying ripple** (all currently assume `synthKey`): `onSelect` / drag-`pin` / `nearestKey` (`use-graph-canvas.ts`), `reveal.tsx`'s `buildIdBridge`, and — critically — `stage-reset`'s `${stage}/`-prefix delete in `deriveNodes` (re-keying finalized nodes off `synthKey` would silently break the prefix delete). The reconciliation must preserve `synthKey` where those paths need it (e.g. keep `synthKey` as a field for stage-reset) while keying the *render/sim identity* on `displayId`.

### 2.2 Physics escapes the viewport — applies to BOTH gen and reveal

The force sim has repulsion (`forceManyBody`, no `distanceMax`) + a weak `forceCenter`, no boundary force, and `paintFrame` draws **raw sim coordinates** (`translate(cssW/2, cssH/2)`, no fit/clamp). **Both** the generation graph and the reveal graph route through the same `createForceSim()` / `use-graph-canvas.ts`, so **containment must apply during generation too** — a node escaping mid-gen is the exact "should be impossible" bug, and the fog's density-box-clear (§3.2d) keys off node positions, so an off-screen node would clear fog off-screen.

**Required:** add a boundary force (`forceX`/`forceY` or a per-tick clamp in `tick()`) + a `distanceMax` cap in the sim, active for **both** phases. **Specify the generation layout source explicitly:** the fog prototype uses hard-coded positions, but the real `WorldGenGraph` lays out via the force-sim — the plan must state whether gen keeps the (now-contained) force-sim for placement or moves to another scheme; `WorldGenFogField` obstacle positions (§3.2) come from whatever that source is.

## 3. The generation experience

### 3.1 Two acts (chaos → order)

The audit quantified the real pipeline (world `019f3368…`, 41 entities → 78 edges, ~12 min): pre-entity stages (t+0→2:00, nothing on the graph) → **Act 1: all nodes stream in disconnected** (`world_and_factions`, `locations_and_npcs`, t+2:00→8:35, ~70%, **zero edges**) → **Act 2: the web stitches in** (`entity_relationships`, t+8:35→10:51, **86% of edges incrementally on the SSE wire**) → a small late **snap** (`coherence_pass`, 14%). **A third edge source exists:** `entity_consolidation` (stage 4b) emits phantom-ghost `edge-added` between those windows. The three sources are distinguishable by `synth_key` stage-prefix (`entity_relationships/…`, `entity_consolidation/relationships/…`, `coherence_pass/edges/…`) — **classify by prefix; weave stages 4b + `entity_relationships`, snap `coherence_pass`.**

**Drive the edge animation off the live SSE `edge-added` stream, not the DB snapshot** — `created_at` collapses the 67 incremental edges into one batch timestamp (they'd snap, not weave). The phase-gate already supports this: the seed only lands at `world_snapshot_ready` (after `entity_relationships` commits), so during the weave the graph is pure-live.

### 3.2 The fog field — CANONICAL physics, port exactly from the reference prototype

The generation atmosphere is **fog rendered as a real fluid simulation** — not a texture, not a sprinkle, not an alpha gradient. It carries Act-1 progress: thick over the empty canvas, thinning to nothing as the world fills. Built as first-class `@mythrun/ui` + `client-core` units (§5), not cobbled.

**Model:** tracer particles advected by a velocity field = *uniform wind + turbulence + potential-flow doublets around each entity obstacle*, binned into a density grid, temporally smoothed, modulated by a rolling cloud mask, and rendered as **crisp ordered-Bayer dither** (the brand's locked 4×4 matrix, 15% chaos, 6px cells). **Every drawn cell is full-on or off at a fixed 0.5 alpha — no per-cell alpha gradient anywhere.** Density = *how many* cells clear the Bayer threshold, never a faded cell.

The interlocking pieces (all in the reference — summarized for intent):

- **a. Wind — an open stream.** Base wind blows **down-left**; particles **spawn on the top + right edges** (flux-weighted), stream across, and **despawn off any edge, respawning on inflow** — a continuous feed, nothing recirculating. **Warm-start: seed particles across the WHOLE canvas at mount** (edge-spawn is respawn-only) so the fog is thick from frame 1, not filling in from the corner.
- **b. Turbulence** — a small curl perturbation for organic wander.
- **c. Potential-flow doublets — "river around a rock."** Each entity is a **capsule** (marker + its rendered text) approximated by K point-doublets along it. The *uniform-flow + cylinder-doublet* field makes the fog **part at the front, wrap the sides, and knit back together downstream** — automatically, because it's the real field. A gated **wake-convergence ("close") term** (active only in the true wake) re-knits faster; a **drag-wake** term lets a dragged node shove the fog.
- **d. Entity forcefield — two hard guarantees.** (1) **Particle exclusion:** any particle inside a label's capsule (`EXR = 12 + margin`) is projected back to the boundary. (2) **Density-box clear:** before render, the smoothed density inside each label's box is zeroed (box widened to cover the bob). Together: **no fog ever under a label.**
- **e. Density render.** Splat particles (3×3 kernel) → **temporal low-pass** (`dsm += (dens − dsm) × steady`) → **× wind-scrolled cloud-billow mask** (low-freq noise → fog rolls in as *masses*, not a sandblast) → **normalize + × effective density** → threshold `cov > 0.85·Bayer + 0.15·chaos` (per-cell `chaos` is a **static** hash — it does **not** flicker) → fill a solid 6px cell at 0.5 alpha.
- **f. Fade-with-entities.** `effectiveDensity = density × (1 − shownEntities / totalEntities)^0.85`. Thick over empty; **gone at the full graph.** *The fog is the Act-1 progress indicator.* `totalEntities` = the snapshot's entity total.
- **g. Buoy bob — render-only.** Each node bobs like a buoy (soft vertical rise/fall + slight sway, per-entity phase). **The true position and its fog clear-zone stay fixed;** only the drawn marker + name drift.

**LOCKED parameters (bake as defaults):**
> **wind 0.35 · density 0.40 · close 0.1 · margin 10 · steady 0.03 · fade ON** · fog color **paper-400 `#A89F8A`** @ **0.5** alpha · entities **mono ink `#231B12`**, **shape-differentiated** (no color-by-type, no text type-tags).

**The prototype is the SOLE authority for every constant.** The LOCKED list above is not exhaustive — the render normalization divisor, turbulence coefficients, cloud frequencies/scroll/contrast, splat-kernel weights, doublet radius + spacing, wind magnitude, and particle count all live in the prototype and must be **copied verbatim, not re-derived**. Type differentiation is by **icon shape** (the app's existing convention), not hue — the prototype's diamond/square is a placeholder; use the app's real node icons (note: their widths feed the capsule geometry, §c/d).

**Frame-rate normalization (required — the naive port is wrong).** The prototype's advection (`X += vx`) and temporal smoothing (`× steady`) are **per-frame**, while turbulence/cloud/bob are **time-based** — so at 120Hz (ProMotion Macs/phones, target hardware) the fog streams/smooths ~2× fast and decouples from the cloud scroll. Implement a **fixed-timestep accumulator** (or dt-scale advection displacement and convert `steady` to a time-constant). Name this in the component contract so it isn't lost.

**Label typography drives the physics.** The capsule geometry (`RD`, doublet spacing, `EXR`) was tuned against the prototype's `14px Georgia` text widths. **Nodes render their names during generation** (the river-parts-around-marker-**and-text** effect depends on it); pin the exact brand label font/size the capsule is measured against, and confirm the geometry holds for real (i18n, variable-length, streamed) names.

### 3.3 The status card — a DOM component, NOT canvas-painted

Top-left of the graph: **spinner + current phase name + a %-done bar.** The `%` is **stage-based** (coarse — sits then jumps; duration-weighting is a future refinement). Requires widening `useWorldGenStream` to expose the snapshot's `stages[]` (currently discarded) + optionally `cumulativeCostUsd`. Phase copy = per-stage narration (i18n `[ph: …]`).

**The prototype paints this into the canvas — do NOT port that.** The graph canvas is `aria-hidden`, so a canvas-painted card is invisible to screen readers, non-selectable, and un-i18n-able. Build the card as its **own small `@mythrun/ui` DOM component** (from existing `Spinner` + a progress element + `Text`), overlaid as a real DOM sibling on the canvas, with its own story. "Port exactly" (§6) covers fog physics + pacing, not this card.

### 3.4 No list, no selection during generation

The fog + graph own the whole space — **no *visual* entity list and no pointer selection during gen.** But this is a visual choice, not an accessibility one: the accessible representation of the streaming entities is still required (§7). Requires a `showList`/`selectable` gate on the graph component (today `WorldGenGraph` renders the list unconditionally).

### 3.5 Edges — Act 2 draw-in

Edges **stroke in as slow, deliberate penstrokes** (~2s, eased) one at a time as they arrive on the SSE stream (§3.1) — not a magnetic snap; coherence-pass edges may snap. **`GraphEdge` needs an arrival-index field** (analogous to `GraphNode.lastEventIndex`; it currently has none) so the render can sequence the weave by arrival order. Dedup the phantom-placeholder edge against its later stage-4b UUID re-emission.

### 3.6 Resolution & scaling — REQUIRED (the prototype is fixed-size; production is not)

The prototype is a fixed **900×470** field with 12 entities; production runs the fog in a **~450–600px desktop half-pane** and a **~375px mobile fullscreen**, at real entity counts (~41). All fog constants are absolute pixels tuned at 900×470, so a naive port is denser/wrong at every real size — "port exactly" is unsatisfiable without a scaling rule. Resolve it:

- **Render in a fixed virtual coordinate space** (a constant logical width, e.g. 900), CSS-scale the canvas to the pane — so the tuned pixel constants (`CELL`, `RD`, doublet spacing, cloud frequencies) hold visually at every width.
- **Scale particle count `N` by canvas *area*** to hold particle *density* constant (density = N/area is the tuned quantity, not N).
- **Mobile density handling:** at ~41 entities on ~375px the graph must remain legible + tappable — specify **fit-to-view or pan/zoom** for dense graphs and a **minimum per-node touch target** (the prototype's ~32px grab radius is a good floor). Decide per-constant whether it scales with size or stays fixed in CSS-px.

### 3.7 Performance — acceleration is required, not optional

The core loop is O(particles × doublets): with ~41 entities the doublet count is ~180–200 (not the ~20 an earlier draft assumed), so ~4,800 × ~185 ≈ **~900k field evals/frame** plus a per-particle exclusion pass and `Math.exp` in the wake term — a real 60fps risk, peaking exactly at the Act-1 climax. **Required in the build (not deferred):** (a) spatially bucket doublets and evaluate only those within a few `RD` of a particle (the field decays as 1/r⁴ — far-field ≈ 0, so this is fidelity-preserving); (b) skip the advection+field+render passes when `effectiveDensity ≈ 0` (fog invisible near Act-1 end); (c) confirm 60fps at 41 entities on target hardware before sign-off. The per-frame grid pass (~11k cells × cloud/chaos/Bayer) is also real cost — measure it.

### 3.8 The reveal moment — a rewarding gen→reveal transition (NOT a flash-cut)

Completion is a **beat, not a state-swap** — it rewards the player who actually watched the ~10-minute build. On the final entity + final edge, do **not** hard-cut to the reveal layout. Instead, a short orchestrated moment (~3–4s; reduced-motion → a ~300ms cross-fade). It **diverges by platform** at the layout step. This is a first-class specified sequence (a `RevealTransition`, §5), storyable with a synthetic completed graph — port its choreography precisely, don't hand-wave a CSS transition.

1. **The fog lifts** (~1s). The `fade` has already thinned the fog toward zero (§3.2f); the finish completes it as a **final gust** — the last particles are carried off the down-wind edges and despawn, so the atmosphere visibly *clears* rather than dissolving in place. The completed web stands alone on clean paper. (Fog is **totally gone** by the end of this step — a hard invariant.)
2. **The world settles** (~1s, overlapping). The graph eases into rest: node positions settle, the buoy bob calms to a slower resting rhythm, and the world's title/eyebrow (`[ph: …]`) quietly fades in — understated, brand-terse, no fanfare.
3. **The layout resolves** (~0.8s) — platform-specific:
   - **Desktop:** the fullscreen graph **eases to the left 50%** as the **wiki panel slides in from the right** — the §4.1 50/50 layout *arriving in motion*, not appearing. The graph reflows/rescales into its half (per §3.6's virtual coordinate space), never cropped.
   - **Mobile:** the graph **stays fullscreen** (it already is in the reveal); the **wiki drawer handle slides in from the right edge** with a one-time attention nudge, inviting exploration. Nothing occludes the just-revealed world — the player sees their whole map first, then chooses to open the wiki.

**Reduced-motion:** skip the lift/settle/slide choreography — cross-fade gen→reveal in ~300ms with the fog already cleared and the layout already in its final position (the title still fades in). The completion is still *marked*, just not animated.

## 4. The reveal experience

### 4.1 Layout

- **Desktop (≥ ~900px):** **50 / 50 graph | wiki, full width.** This needs **no new shell component** — the existing `Grid` primitive supports `columns={2}` (a true `1fr 1fr`); the current bug is only that `reveal.tsx` uses `columns="auto-fill" minColumnPx={340}` (leaving empty trailing tracks). One-line prop fix, plus removing the graph's internal side-list.
- **Mobile (~375px):** **graph fullscreen; the wiki is a full-width edge-handle drawer** sliding from the right. **The handle is pinned to the screen's right edge in both states** (so summon ‹ and dismiss › are literally the same spot). The drawer is **full-width when open** (prose needs the room at 375px) → **the graph is hidden while open**; therefore **node-tap-to-open** works from the closed state, and the shared graph↔wiki selection round-trips (tap node → drawer opens to it → dismiss → tap next). The drawer **keeps its state** across open/close (same page + scroll — never resets). Define the nav stack (§4.2) and drawer focus management (§7).

### 4.2 The wiki — real pages, not dropdowns

Replace the inline expand/collapse tree with an actual wiki:

- **Per-entity pages** — back-nav, name + kind, a **body composed from the entity's known-tier facts** (NOT "flowing prose" — a fact is a short `{topic, content}` statement; the body is these composed/ordered, not narrative prose; the LLM's sensory `prose_kernels` are *not* used — they're stripped from the client snapshot and carry no per-detail tier). **Specify the empty-body state:** a `known` entity whose facts are all `discoverable`/`secret` has *no* known facts → its page shows the name/kind with an explicit empty state, not a blank.
- **RELATED footer** — the entity's relationships as **labeled links** (display-format the snake_case `relationship_type`, e.g. `warded_by` → "warded by"). *This is where the graph's edges live as text.* Filters to **known-tier** relationships (§10 — relationships gain an `access_level`).
- **Inline entity links** — **name-matching is the ONLY available mechanism** (the pipeline marks no mentions; every cross-entity reference is name-based). The earlier "prep-engine-marked" option does not exist — removed. Name-matching over fact `content` has real hazards (substring collisions like `Bell` / `Bell-Wardens` / `The Bell-Loft`, possessives, non-canonical references like "the Abbot"); **specify collision/alias rules, or drop inline links and rely on the RELATED footer** (already structured + UUID-resolved) as the navigation mechanism. This is a scoping decision for planning, not a coin-flip.
- **Home / search** — browse-by-kind (places / factions / people / things); also the guaranteed **accessible** entry to every entity (§7).
- **Back-nav** — internal wiki history; define its interaction with the mobile Back button (§7).

**Data plumbing:** the RELATED footer + graph edges both need `relationships`, which is on the wire (`WorldGenSnapshot`) but **not in the wiki's typed contract** (base `WorldSnapshotSchema` has only entities/facts/hierarchy; `toWikiViewModel` never reads relationships). Widen the wiki `WorldSnapshot`/`WikiDataSource` input (or re-point at `WorldGenSnapshot`) and add relationship indexing (id→name resolution for labels + link targets). The `description` free-text is dropped from the client relationship schema — fine for labeled links.

### 4.3 The reveal graph

Settled: **fog fully faded**, entities + edges visible and **contained** (§2.2), nodes **selectable** (selection ↔ wiki, both directions: graph-click highlights the wiki page and vice-versa; define whether a graph click pushes onto the wiki back-stack). Edges are drawn (not snapping). Edges + their labels render **known-tier** relationships only (§10).

## 5. Design-system modifications — REQUIRED (do not cobble)

Extend `@mythrun/ui` + `client-core` over assembling from misfit primitives — mirroring the codebase's own proven split (client-core sim/reducers = brain; `@mythrun/ui` Canvas/DOM = platform render). Each new reusable unit gets a Storybook story.

- **`FogSim`** (NEW, `client-core/src/worldgen/`) — DOM-free fluid core: takes `obstacles` (node capsules `{x,y,w,h,vx,vy}`) + the locked params + `time`, advances the sim, returns the density grid. Pure, unit-testable, injectable RNG (like `GhostBloomField`), fixed-timestep. This purity is what makes it **storyable with synthetic obstacles** (exactly the prototype's `ENTS`).
- **Fog draw helper** (NEW, `@mythrun/ui`, alongside `canvas-draw.ts`) — Bayer-thresholds the density grid to solid cells. **Import the Bayer primitive from the existing `frontend/ui/src/components/Dither/bayer.ts`** (`thresholdAt`/`chaosAt`/`BAYER_4X4`/`CELL_PX` already exist and are already reused by `GhostBloomField`; promote the file to a shared location if needed). **Do not touch the SVG `Dither` component.** Reconcile the one grain difference: the prototype uses a sin-hash chaos; `bayer.ts` uses xorshift `chaosAt` — pin which is canonical for the fog.
- **`WorldGenFogField`** (NEW, `@mythrun/ui`) — thin React/hook shell composing `FogSim` + the draw helper + rAF/DPR/pointer-drag. **Fog and graph are layered canvases** (fog behind, graph front) — keeps the fog independently storyable and avoids one mega-controller.
- **`WorldGenGraph`** (reworked) — composes the fog layer + node layer (shape icons, buoy bob) + Act-2 edge draw-in; gated `showList={false}`/`selectable={false}` during gen. **Give the edge-draw-in timeline a named client-core home** (an `EdgeDrawIn`/`use-edge-animation` alongside `graph-reducers.ts`), not inline in the 270-line controller. **Remove `GhostBloomField`** — the fog replaces it (delete the class + its story/tests).
- **Status card** (NEW, §3.3) — its own DOM component + story.
- **`WorldWiki`** (reworked) → decompose into named storyable sub-components — **`WikiPage`, `WikiHome`, `RelatedFooter`, `InlineLink`** — with the **nav/history stack in a `client-core` hook (`useWikiNavigation`)**, not component-internal or router state. Its prop contract is **blocked by the §4.2 inline-link decision** — resolve that first.
- **Mobile wiki drawer** (NEW, `@mythrun/ui`) — genuinely net-new (no `Drawer`/`Sheet` primitive exists); own component + story, interface = state-retention across open/close + same-spot summon/dismiss + tap-node-to-open. **Desktop 50/50 is NOT a new component** (existing `Grid columns={2}`). State what migrates from the `reveal.tsx` route into `@mythrun/ui` vs. stays in the route (selection-bridge, snapshot fetch).
- **`RevealTransition`** (NEW, `@mythrun/ui`, §3.8) — orchestrates the gen→reveal moment (fog-lift → settle + title → platform-specific layout resolve), driven by a completion signal + `prefers-reduced-motion`. Owns the timeline; composes the fog field (final gust), the graph (settle), and the layout shift (desktop 50/50 slide vs. mobile drawer-handle reveal). Storyable with a synthetic completed graph so the beat can be tuned in isolation.

No ad-hoc UI. Modules < 400 lines, functions < 50 — which is *why* the fog is split into sim + draw + shell rather than one primitive.

## 6. Non-negotiables

- **Port the fog physics + pacing exactly** (the prototypes are canonical for those). Everything else — render surface of the status card, resolution/scaling, frame-rate handling, node icons, accessibility — is specified here and overrides the prototype's toy choices.
- Flat 1-bit paper register; **crisp Bayer, no gradients**; square, **no circles**; entities **mono ink, shape-differentiated**.
- Prose = `[ph: …]` i18n keys.
- Desktop AND ~375px, responsive by construction (§3.6).
- Strict TS (no `any`); functions < 50 lines, modules < 400; all UI in `@mythrun/ui` + a story; all backend access via client-core; all wire types in `@mythrun/contract`.
- Enforced ignorance stays server-side; the reveal is **known-tier**, relationships now included (tiered per §10).

## 7. Accessibility (required — a Canvas graph needs a parallel accessible model)

- **During generation:** the visual list is gone (§3.4), but the streaming entities need an accessible representation — an **`aria-live` region** announcing phase + entities as they arrive, and/or a **visually-hidden entity list**. "No visual list" ≠ "no accessible representation."
- **Reveal:** the wiki's **browse-by-kind (§4.2) is the guaranteed accessible path** to every entity. Provide keyboard graph selection (a visually-hidden **roving-tabindex** node list mirroring selection) so the Canvas graph isn't keyboard-dead.
- **Drawer:** move focus into the drawer on open, restore to the triggering node/handle on close, trap focus while the full-width drawer occludes the graph. Define mobile Back-button precedence (wiki page back vs. close drawer vs. leave route) and root-page Back behavior.
- **`prefers-reduced-motion` across ALL motion sources:** fog advection/turbulence (recompute a *static settled density on each entity-count change* — preserving the fade-with-entities progress signal rather than a blanket freeze that would kill the only progress cue), the buoy bob (disable), and Act-2 edges (appear instantly, no penstroke). Under reduced-motion the status-card `%` becomes the primary progress affordance. The reveal moment (§3.8) degrades to a ~300ms cross-fade (fog already cleared, layout final, title still fades in).
- Node hit target: a generous **invariant** radius (bob is render-only, so the visible marker drifts from the fixed hit point — keep the target on the true position).

## 8. Open items (resolve in planning / implementation)

1. **Inline-link scope** (§4.2) — name-matching with specified collision/alias rules, or drop inline links and lean on the RELATED footer. (The "prep-marked" option was a phantom and is removed.)
2. **`%` weighting** (§3.3) — stage-count (ship first) vs. duration-weighted.
3. **Reveal graph renderer** (§4.3) — reuse `WorldGenFogField` with fog fully faded (composes trivially once §5's `FogSim` takes `effectiveDensity` as a param) vs. a dedicated settled renderer. Prefer reuse.
4. **Generation layout source** (§2.2) — contained force-sim vs. another placement scheme; determines how `WorldGenFogField` gets obstacle positions.

## 10. RESOLVED — relationship tiering (enforced ignorance)

**Decision (Miklos): tier relationships.** The redesign makes relationships player-facing for the first time (RELATED footer §4.2, reveal edges §4.3), and relationships carry no `access_level`, so a secret connection between two `known` entities (e.g. `secretly_serves` / "the hidden architect of the corruption") would leak on the happy path. This is a **deterministic** enforced-ignorance leak (not the accepted, LLM-gated *facts* risk in `project_secret_protection_threat_model`), so we close it properly.

**Required build work — a precondition for shipping the §4.2 RELATED footer + §4.3 edge labels. Core-infra + security surface: build it right, no shortcut.**
- **Migration:** add `access_level` (`known` | `discoverable` | `secret`) to the `relationships` table, mirroring `facts`/`entities`. Backfill existing rows to the **safest** tier (`secret`) so nothing surfaces until re-tiered.
- **Pipeline:** `entity_relationships` (stage 6) + `coherence_pass` (stage 10) emit a per-relationship tier — the prompt(s) gain a tier field + framing (**a relationship is `known` only if the connection *itself* is public, independent of the endpoints' tiers** — two known entities can be secretly connected). Update the Zod output schema (co-evolve prompt + schema; a constructed-state real-LLM smoke to confirm the tier is honored).
- **Snapshot:** `relationships.ts` `listAmong` filters to `access_level = 'known'` for the reveal (and to the character-visible set for the MYT-94 player path), alongside the existing both-endpoints-surfaced predicate.
- Sequencing note: unlabeled edges could ship before tiering if we ever needed to split it, but the decision is to tier — so the pipeline change lands with (or before) the reveal.
