# MYT-94 Entity Highlighting + Knowledge Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 is a VERIFY-FIRST bead — do it before writing any code (spec §7). TDD is mandatory: a failing test that defines "done" precedes every implementation step.
>
> **Wave-2 sequencing (spec §7).** MYT-94 branches from main AFTER MYT-92 merges; it is planned against the **myt-92 worktree branch** (`.worktrees/myt-92`). Every reference to `SidebarPlaceholder` / `SessionShell` / `MessageStream.renderItem` / `DmMessage` / the transcript reducer is to 92's as-built shape; the controller reconciles any 92-merge deltas at bead-cutting. MYT-94 and MYT-93 both extend 92's `MessageStream` rendering seam and the play-route composition — those edits are **serialized by the controller** (93 lands the in-stream dice/skill cards; 94 lands the sidebar tabs + entity highlighting). The shared session-view-model surface is 92's transcript reducer, which already models `ledger_update` first-class (§7); 94 extends RENDERING and adds a NEW `ledger_update`→character-state reducer, never the transcript reducer shape.

**Goal:** Build the knowledge layer over 92's live-play screen (spec §6). Recognized entity names in **settled** DM prose get a subtle underline; hover reveals a monochrome structural differentiator + a leading type glyph (NO entity-type color); click opens a terse popover (name + type glyph + wiki lead line + "open in wiki"). The play sidebar — 92's collapsed placeholder seam — becomes a real three-tab panel (World Wiki / Relationship Graph / Character Sheet), **default OPEN** (per UX §9), desktop 30% panel + the shipped mobile Drawer. The wiki tab embeds the shipped `WorldWiki` (client-side search, stat blocks excluded); the graph tab mounts the shipped `WorldGenGraph` **drained**, fed by a canonical snapshot→graph adapter (known-tier edges only); the sheet tab is a NEW in-session variant of the member's `CuratedSheet` with live HP folded from a NEW `ledger_update`→character-state reducer. All reads come from the existing member-readable world-snapshot + character reads — **NO new backend read surface** (spec §1/§6). All new components land in `@mythrun/ui`; all caches/reducers/view-models land in `@mythrun/client-core`; the web route composes.

**Architecture:** client-core-brain + `@mythrun/ui` presentation over the `client-core/contract` prop seam (rules R1–R5). Enforced ignorance is **structural and server-side**: the knowledge cache is built from `getWorldSnapshot` (`GET /api/campaigns/:id/world-snapshot`), which is already member-readable + known-tier + plot-safe (server-filtered since cb05867f / member-readable since myth-0xwos). MYT-94 adds NO client-side tier filter, NO new endpoint, and consumes NO session frame that could carry pre-flip content — the cache **refetches on session boundaries** (the safe default; there is no tier-promotion frame on the WS channel to consume, and that invariant is asserted). The three tabs and the matcher all derive from ONE fetched snapshot. The matcher is pure and deterministic (ZFC: mechanical substring matching, no LLM). The graph and wiki reuse the shipped MYT-89 components and their existing adapters; the only NEW rendering is the entity-mention highlighting layered onto `DmMessage`'s settled prose and the in-session sheet.

**Tech Stack:** React + Vite + TS strict; `@mythrun/{contract,client-core,ui}` + web; Vitest + RTL; the shipped `getWorldSnapshot` / `getCharacter` / `getCharacters` endpoint slices, `toWikiViewModel`, `snapshotToSeed`, `sheetViewModel`, `WorldWiki`, `WorldGenGraph`, `Tabs`, `Popover`, `Drawer`, `Icon`; i18n `[ph:]` keys.

## Global Constraints

- **Enforced ignorance / ZFC (hard boundary):** the cache is built ONLY from the member-readable `getWorldSnapshot` projection (known-tier, server-filtered). Add NO new read surface, NO client-side tier logic, NO consumption of any session frame for cache promotion. The matcher is mechanical (substring/longest-match) — no heuristic classification, no pattern-matching on LLM prose (the prose is displayed verbatim; matching is against a data-derived name index). **A dev-seeded SECRET relationship edge between two known entities must be absent from the graph — this leak assertion is a REQUIRED test** (unit + E2E).
- **Highlighting on SETTLED prose only.** Never re-segment a streaming turn (no mid-stream reflow — spec §6). The streaming `DmMessage` path is byte-unchanged; segmentation runs once per settled row, memoized on the (stable) settled text.
- **Monochrome register — NO entity-type color** (spec §6 pin; UX §12's NPC-blue/location-amber/faction-green is deliberately dropped). The differentiators are structural + CVD-safe: an underline-style change on hover/focus + a small leading type glyph (person/pin/banner for npc/location/faction) from the pixelarticons vocabulary. **[Flagged — see Ambiguity C: this stands unless Miklos overrides.]**
- **Named exports only; strict TS (no `any`, no assertions unless unavoidable); functions < 50 lines; modules < 400 lines.** Split the matcher / cache / reducers / view-models into cohesive files to hold the line.
- **Design-system-first (R5):** no ad-hoc UI. Every new component lives in `@mythrun/ui` with a Storybook story + tests, imports props from `@mythrun/client-core/contract`, is square-register (no circles, no status dots/chips), and works desktop AND ~375px by construction. Two typefaces only: `--font-body` (Source Serif 4) for DM/wiki prose, `--font-ui` (IBM Plex Mono) for chrome/mechanical/data readouts + the popover chrome.
- **i18n:** every user-facing string is a key with a `[ph:]` placeholder value; `client-core/src/i18n/locales/en/common.json` + `client-core/src/i18n/descriptions.ts` in lockstep (the `resources.test.ts` drift test asserts identical key sets). MYT-100 is the one copy pass — do NOT write real copy. Entity names, facts, and prose are DATA (from the model), never keys.
- **Reduced motion:** the graph mounts static under `prefers-reduced-motion` (the shipped `reducedMotion` prop); no highlight animation is the only signal (the underline is present statically; hover is an enhancement).
- **Accessibility:** the 100×4 bar (100% statements/branches/functions/lines on new source) + the CI storybook browser sweep (a11y contrast + overflow gates) both gate. `EntityMention` is keyboard-activatable (it opens the popover); the popover traps/returns focus (shipped `Popover`); the graph tab passes `nodeListLabel` (the keyboard node-selection path, since the canvas is `aria-hidden`); the type glyph is decorative where adjacent to the name, labeled where standalone.
- **§7 declared collision surfaces (do NOT restructure wholesale):**
  - `frontend/src/routes/play/session-shell.tsx` — 92 owns it; 94 replaces the `SidebarPlaceholder` mount with the real `KnowledgeSidebar` and flips the sidebar default to OPEN + adds the mobile Drawer path. MYT-93's in-stream card edit to the same shell is serialized by the controller.
  - `frontend/ui/src/components/MessageStream/MessageStream.tsx` — 92 owns `renderItem`; 94 extends the `dm` arm (settled highlighting) and appends optional `highlight`/`onEntityOpen` props to `MessageStreamProps`. MYT-93 extends the mechanical arms. **Append-only to `MessageStreamProps`; the two wave-2 renderItem edits are serialized.**
  - `frontend/ui/src/index.ts` + `frontend/client-core/src/index.ts` + `frontend/client-core/src/contract/index.ts` barrels + i18n `common.json`/`descriptions.ts` — append-only; controller resolves at merge.
  - `frontend/client-core/src/contract/icon.ts` + `frontend/ui/src/components/Icon/glyphs.ts` — 94 appends three glyph names + their path data (the `Record<IconName, Glyph>` keeps add-a-name-without-a-glyph a compile error).
- **No `pipelineRoute` ripple, no migration, no dev-tool manifest, no backend work:** this issue touches none of those surfaces. If a task tempts you toward a new endpoint or a schema change, STOP — it is out of scope (spec §1/§6).
- Test conventions: co-located `__tests__/x.test.ts(x)`, Vitest + RTL; stories per component; mirror `backend/src/__tests__/CONVENTIONS.md` (single isolation, no shared mutable state). Frequent commits (Conventional Commits, one per task).

---

## Phase 0 — Verify-first (spec §7)

### Task 1: Drive the member world-snapshot model + a `ledger_update` frame live (no code)

**Files:** Create `tmp/sdd/myt94-verify-notes.md` (plan-adjacent scratch; NOT committed).

**Interfaces:**
- Consumes (observe, do not build): `GET /api/campaigns/:campaignId/world-snapshot` (the member-readable known-tier projection), `GET /api/campaigns/:campaignId/characters` + `.../characters/:charId`, and a live session's `ledger_update` WS frame.
- Produces: a recorded, observed contract the cache / matcher / graph / sheet tasks build against.

Before building anything, confirm the as-shipped shapes on the live dev stack (`:3030`, `x-mythrun-dev-sub` auth). Do NOT trust the plan's transcription over the live wire.

- [ ] **Step 1 — bring up the dev stack** (`pnpm dev`) and pick a campaign that is past `world_snapshot_ready` with a finalized member character (an owner-completed campaign that ran world-gen + character creation). Record the campaignId + the member's userId + characterId.
- [ ] **Step 2 — world-snapshot:** `curl` the member world-snapshot with the dev auth header. Record verbatim: the `entities[]` shape (`{id, entityType, name}` — confirm `entityType ∈ {npc,location,faction,item,pc}` and that `accessLevel`/prose-kernel/stat-block fields are ABSENT from the wire, stripped by `WorldSnapshotSchema`), `facts[]` (`{id, entityId, topic, content}`), `entityHierarchy[]`, `relationships[]` (`{sourceEntityId, targetEntityId, relationshipType}`), and `introduction?`. **Confirm the projection is identical for a NON-owner member** (fetch as a non-owner member sub) — this is the plot-safe read MYT-94 depends on.
- [ ] **Step 3 — secret-edge leak probe (the required assertion's target):** seed (via psql or the dev-tool) a `secret`-tier relationship edge between two KNOWN entities. Refetch the member world-snapshot and **confirm the secret edge is ABSENT from `relationships[]`** (server-side known-tier filter, post-myth-got9q). Record the seeded edge ids + the confirmed absence — this is the E2E leak-assertion fixture. If the edge LEAKS, STOP and surface it to the controller (that is a backend enforced-ignorance bug, not a frontend concern, but it blocks the done-when).
- [ ] **Step 4 — character read:** `curl` `/characters` (roster → the member's `characterId`) then `/characters/:charId` and record the `CharacterFull` shape (`character.hit_points`/`max_hit_points`/`armor_class`/… + `skills`/`features`/`equipment`/`spells`/`concept?`), confirming it drives `toRevealViewModel`→`CuratedSheet`.
- [ ] **Step 5 — `ledger_update` frame:** run a real session turn that mutates HP (e.g. take damage in a skill/combat beat) and capture the live `ledger_update` WS frame verbatim (`{turnId, characterName, kind, summary, hp?, maxHp?, gold?, condition?, …}`). Record which fields the `kind:'hp'` and `kind:'condition'` variants populate. **Confirm the condition variant carries NO explicit add/remove flag** (drives Ambiguity E).
- [ ] **Step 6 — write `tmp/sdd/myt94-verify-notes.md`** with the verbatim shapes for steps 2–5. Every later task cites these notes where they differ from this plan. **If the world-snapshot omits `relationships`, or the secret edge leaks, or the ledger frame differs materially, surface it to the controller before proceeding.**

---

## Phase A — client-core brain

### Task 2: Knowledge cache — one snapshot fetch, three projections, boundary refetch

**Files:**
- Create: `frontend/client-core/src/session/knowledge-cache.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel — append-only)
- Test: `frontend/client-core/src/session/__tests__/knowledge-cache.test.tsx`

**Interfaces:**
- Consumes: `getWorldSnapshot` (`api/campaigns.ts`, → `WorldGenSnapshot`), `toWikiViewModel` (`worldgen/wiki-view-model.ts`), `snapshotToGraph` (Task 4), `buildEntityIndex` (Task 3), `useApiContext`.
- Produces:
  - `useKnowledgeCache(campaignId, refreshToken, deps?) → KnowledgeCache`:
```ts
export interface KnowledgeCache {
  readonly wiki: WikiViewModel | null      // for the World Wiki tab (via toWikiViewModel)
  readonly graph: GraphSeed | null         // for the Relationship Graph tab (via snapshotToGraph)
  readonly index: EntityIndex | null       // for the highlighting matcher (via buildEntityIndex)
  readonly loading: boolean                // true only before the FIRST settle
  readonly failed: boolean                 // last (re)fetch rejected AND no cache ever resolved
}
```
  - `GraphSeed` = `{ nodes: GraphNode[]; edges: GraphEdge[] }` (re-export from Task 4).

**Design (pin in the module header):**
- ONE `getWorldSnapshot(ctx, campaignId)` fetch; on resolve derive all three projections from the same snapshot (`toWikiViewModel(snap)`, `snapshotToGraph(snap)`, `buildEntityIndex(snap)`). This mirrors `useWikiModel` (reveal-wiki-panel.tsx) — quiet refetch: `loading` is only ever true before the first settle; the current cache stays live until a fresh one resolves; a refetch failure keeps the old cache; an `active` flag drops a late resolve after unmount / a superseded refetch.
- **Boundary refetch is the ONLY promotion path (spec §6 invariant).** `refreshToken` bumps re-fetch. The caller bumps it on session mount and on WS reconnect (`session_reconnect`) — the safe boundaries. **There is NO tier-promotion frame on the session WS channel** (verified: the `ServerFrame` union in `contract/events/session-events.ts` carries none), so the cache can never ingest pre-flip content. **This invariant is asserted:** a test drives every `ServerFrame` type through the cache's consumer and asserts NONE of them mutates the cache (only a `refreshToken` bump refetches). Cite spec §6: "otherwise the cache refetches on session boundaries (safe default)."
- A 409 `snapshot_not_ready` race (shouldn't happen in-session — the world is complete) settles to `failed` with the calm empty-cache; the tabs render their calm `[ph:]` unavailable line.

- [ ] **Step 1 — failing tests** (spy `getWorldSnapshot` resolving a fixture snapshot): (a) resolves → `wiki`/`graph`/`index` all non-null, `loading:false`; (b) a `refreshToken` bump re-fetches and swaps in the fresh cache; (c) a rejected FIRST fetch → `failed:true`, all projections null; (d) a rejected REFETCH keeps the prior cache (no flash); (e) unmount drops a late resolve; (f) **the invariant test:** a helper that folds an arbitrary `ServerFrame` does NOT mutate the cache (only `refreshToken` does). Run → FAIL (module missing).
- [ ] **Step 2 — implement.** Mirror `useWikiModel`'s effect shape (an `active` flag, `refreshToken` in the dep array). Keep the module < 150 lines.
- [ ] **Step 3 — barrel + run** the cache test → PASS. Barrel-export `useKnowledgeCache`, `KnowledgeCache`.
- [ ] **Step 4 — commit** `feat(MYT-94): knowledge cache — one snapshot, three projections, boundary refetch`.

### Task 3: The entity matcher — names-only, longest-match, word-boundary

**Files:**
- Create: `frontend/client-core/src/session/entity-index.ts`
- Test: `frontend/client-core/src/session/__tests__/entity-index.test.ts`

**Interfaces:**
- Consumes: `WorldGenSnapshot` (entities + facts), `EntityKind`.
- Produces (the matcher types + builder — pure, DOM-free):
```ts
// The type glyph vocabulary — the four world-lore kinds map to a leading glyph;
// 'item'/'pc' fall through to a neutral glyph (items are rarely highlighted; a
// pc is not world lore). No COLOR is derived from this (spec §6 monochrome pin).
export type EntityGlyph = 'npc' | 'location' | 'faction' | 'other'

/** One run of settled DM prose: plain text, or a matched entity mention. */
export type ProseSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'entity'; readonly text: string; readonly entityId: string; readonly glyph: EntityGlyph }

/** The terse popover card — the one-tap knowledge surface. `leadLine` is the
 *  entity's first known fact content (there is NO per-entity prose kernel on the
 *  wire — see Ambiguity A); empty when the entity has no known facts. */
export interface EntityCard {
  readonly entityId: string
  readonly name: string
  readonly glyph: EntityGlyph
  readonly leadLine: string
}

/** The compiled matcher. `segment` runs per settled message; `card` resolves the
 *  popover content lazily on open. Both pure + fast (no fetch, no LLM). */
export interface EntityIndex {
  segment(text: string): readonly ProseSegment[]
  card(entityId: string): EntityCard | null
}

export function buildEntityIndex(snapshot: WorldGenSnapshot): EntityIndex
```

**Design (pin in the module header):**
- **Names-only** (spec §6: no alias field exists in any known-tier projection; alias support = a widened read = out of batch). Highlightable kinds: `npc`/`location`/`faction` (world-lore entities a player would recognize mid-narrative). `item`/`pc` are NOT highlighted by default (items clutter prose; a PC is the player's own name) — **flag if the controller wants items in.**
- **`buildEntityIndex`** precomputes ONCE (called by the cache on fetch, not per render):
  - `cardById: Map<entityId, EntityCard>` — name + `glyph` (from `entityType`) + `leadLine` (the first fact's content for that entity, facts grouped id-ordered like `indexFactsByEntity`).
  - A **longest-match, word-boundary** matcher over the highlightable names. Build ONE combined `RegExp` from the escaped names **sorted longest-first**, wrapped in `\b(?:…)\b`, flags `gi`. Ordered alternation makes the FIRST (longest) alternative win at each start position, so `"Gorm the Bloody"` beats `"Gorm"`; `\b` enforces no-partial-word (no hit inside `"Gormless"`); `matchAll` yields non-overlapping matches left-to-right. Preserve the original casing in the emitted segment `text`; resolve the entity by the LOWERCASED matched string against a `idByLowerName: Map`.
  - Handle the empty-index case (no highlightable names) → `segment` returns a single `text` segment (the whole string); `card` returns null.
- **`segment(text)`** walks the `matchAll` results, emitting `text` runs between matches and `entity` runs for matches. Deterministic, allocation-light, no backtracking blowup (a single linear scan). Duplicate names (two entities share a name) resolve to the FIRST by a stable order (name then id) — **flag as a minor accepted residual; ambiguous world-names are rare and the popover still opens a valid page.**

- [ ] **Step 1 — failing tests** (pure, no React): (a) a snapshot with `npc "Elenya"`, `location "Highreach"`, `faction "The Ashen Hand"` → `segment("Elenya walked to Highreach.")` yields text/entity/text/entity/text segments with the right ids + glyphs; (b) **longest-match:** `"Gorm the Bloody"` and `"Gorm"` both present → the longer wins in `"Gorm the Bloody nods"`; (c) **no partial word:** `"Highreach"` present → NO hit inside `"Highreacher"`; (d) case-insensitive match preserves original casing in the emitted `text`; (e) `item`/`pc` names are NOT segmented as entities; (f) `card(id)` returns name + glyph + first-fact `leadLine`; an entity with no facts → empty `leadLine`; a missing id → null; (g) empty highlightable set → one `text` segment for any input. Run → FAIL.
- [ ] **Step 2 — implement.** Extract `escapeRegExp`, `glyphForKind`, `buildLeadLines`. Keep `segment` < 30 lines.
- [ ] **Step 3 — run** (100×4 scoped) → PASS.
- [ ] **Step 4 — commit** `feat(MYT-94): entity matcher — names-only longest-match word-boundary index`.

### Task 4: Canonical snapshot→graph adapter (+ the secret-edge leak unit assertion)

**Files:**
- Create: `frontend/client-core/src/worldgen/snapshot-to-graph.ts` (extracts the shipped `snapshotToSeed`)
- Modify: `frontend/client-core/src/worldgen/use-worldgen-stream.ts` (delegate to the canonical export), `frontend/client-core/src/worldgen/index.ts` (barrel), `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/worldgen/__tests__/snapshot-to-graph.test.ts`

**Interfaces:**
- Produces: `snapshotToGraph(source: GraphSeedSource): GraphSeed` — the entities→`GraphNode[]` + relationships→`GraphEdge[]` map, finalized (`state:'finalized'`, `lastEventIndex:-1`, edge `sourceStage:'snap'`, `arrivalIndex:-1`). Re-export `GraphSeed`, `GraphSeedSource`.

**Design:** the shipped `snapshotToSeed` (in `use-worldgen-stream.ts`) ALREADY produces exactly what the in-session graph needs: finalized, static nodes/edges from a known-tier snapshot. Rather than author a divergent second adapter (which would risk different known-tier semantics), **make it canonical** — extract it to its own module, export it as `snapshotToGraph`, and have `use-worldgen-stream.ts` import + delegate (the binder-coverage rule: an extracted binder is uncovered until a consumer calls it — the worldgen caller keeps it covered). The known-tier guarantee is inherited: `WorldGenSnapshot.relationships` is already server-filtered to known-tier (the endpoint), so `snapshotToGraph` renders exactly the snapshot's edges and **cannot invent a secret edge**. **[Flag — see Ambiguity G: spec §6 calls this "a NEW adapter"; the recommendation is canonical reuse for identical semantics, framed as new *exposure* work, not a parallel implementation.]**

- [ ] **Step 1 — failing tests:** (a) `snapshotToGraph` maps N entities → N finalized nodes (kind = `entityType`, `displayId === id`); (b) M relationships → M edges (`from`/`to`/`relationship`, `sourceStage:'snap'`); (c) **leak assertion (unit):** given a snapshot whose `relationships` does NOT contain a seeded secret edge (the server already filtered it — Task 1 step 3), the output edges do NOT contain it — i.e. the adapter emits ONLY snapshot edges, never a synthesized one (assert edge count === `relationships.length` and every output edge maps to an input edge). Run → FAIL.
- [ ] **Step 2 — implement** the extraction; rewire `use-worldgen-stream.ts` to import `snapshotToGraph` (delete the inline copy). Run the FULL `use-worldgen-stream` test to confirm the delegation is behavior-identical.
- [ ] **Step 3 — barrel + run** → PASS. Export `snapshotToGraph`, `GraphSeed`.
- [ ] **Step 4 — commit** `feat(MYT-94): canonical snapshot→graph adapter (worldgen delegates) + leak assertion`.

### Task 5: `ledger_update` → character-state reducer

**Files:**
- Create: `frontend/client-core/src/session/ledger-reducer.ts`
- Test: `frontend/client-core/src/session/__tests__/ledger-reducer.test.ts`

**Interfaces:**
- Consumes: `ServerFrame` (the `ledger_update` variant).
- Produces:
```ts
/** The live character-state overlay folded from ledger_update frames — the
 *  authoritative post-mutation values for the viewer's own sheet. Everything is
 *  a SET (the frame carries post-mutation values, not deltas — the double-write
 *  authoritative-SET rule), so re-applying a frame is idempotent. */
export interface CharacterOverlay {
  readonly hp: number | null
  readonly maxHp: number | null
  readonly gold: number | null
  readonly conditionLog: readonly string[]   // chronological condition summaries (see Ambiguity E)
}
export const emptyOverlay: CharacterOverlay
export function reduceLedger(overlay: CharacterOverlay, frame: FrameOf<'ledger_update'>): CharacterOverlay
```

**Design (pin in the header):**
- The frame is a **post-mutation delta carrying authoritative values** (`kind:'hp'` → `hp`+`maxHp`; `kind:'gold'` → `gold`; `spell_slot`/`feature` carry their post-values). SET them (idempotent — a replay on reconnect re-applies harmlessly). Cite the authoritative-SET-not-delta rule.
- **Conditions:** the frame carries `condition` + a prose `summary` but **NO add/remove flag** (Task 1 step 5 confirms). A deterministic active-condition SET is therefore NOT derivable (ZFC: we must not parse the prose `summary`). For the batch, append the `summary` to a chronological `conditionLog` (the sheet renders it as a quiet "recent changes" list), rather than fabricate a maintained set. **[Flag — see Ambiguity E. The done-when only requires live HP, which IS deterministic.]**
- Filter to the VIEWER's own character at the CALL site (the sheet hook, Task 6, passes only frames whose `characterName` matches the viewer's) — the reducer stays a pure fold.

- [ ] **Step 1 — failing tests:** (a) `kind:'hp'` frame SETS `hp`+`maxHp`; a second hp frame overwrites (SET, not accumulate); (b) `kind:'gold'` SETS `gold`; (c) `kind:'condition'` appends its `summary` to `conditionLog`; (d) re-applying the same hp frame is idempotent (SET); (e) `emptyOverlay` has all-null values + empty log. Run → FAIL.
- [ ] **Step 2 — implement.** Keep `reduceLedger` < 30 lines (a `kind` switch).
- [ ] **Step 3 — run** → PASS.
- [ ] **Step 4 — commit** `feat(MYT-94): ledger_update → character-state overlay reducer (authoritative SET)`.

### Task 6: In-session sheet view-model (`useSessionSheet`)

**Files:**
- Create: `frontend/client-core/src/session/use-session-sheet.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/session/__tests__/use-session-sheet.test.tsx`

**Interfaces:**
- Consumes: `getCharacters` (roster → the viewer's `characterId`), `getCharacter` (→ `CharacterFull`), the raw→`CuratedSheet` adapter (`sheetViewModel` + `toCharacterSheetSource`), `reduceLedger`/`emptyOverlay` (Task 5), the live `SessionView.items` (92's transcript, which carries `ledger_update` items first-class).
- Produces:
```ts
export interface SessionSheetState {
  readonly sheet: CuratedSheet | null     // the base curated sheet (member's own character)
  readonly overlay: CharacterOverlay      // live HP/gold/conditions folded from ledger_update
  readonly loading: boolean
  readonly failed: boolean
}
export function useSessionSheet(
  campaignId: string, viewerUserId: string, viewerCharacterName: string,
  ledgerFrames: readonly FrameOf<'ledger_update'>[], deps?,
): SessionSheetState
```

**Design (pin in the header):**
- Resolve the viewer's `characterId` from `getCharacters(campaignId)` (match `member.userId === viewerUserId`), then `getCharacter(campaignId, charId)` → `CharacterFull`, adapt to `CuratedSheet` via the existing raw→sheet adapter. **Promote the raw→sheet adaptation into client-core** (currently `toCharacterSheetSource`+`toRevealViewModel` live in the character-new WEB route): move `toCharacterSheetSource` beside `sheetViewModel` in client-core so the in-session view-model is brain-side (R1); the character-new route delegates. **[Flag — see Ambiguity D-adjacent: minor edit to a shipped adapter; the controller may prefer reuse-in-place if the move is contentious.]**
- Derive the overlay by folding the viewer's own `ledger_update` frames (filtered on `characterName === viewerCharacterName`) through `reduceLedger`. The caller (the shell) passes the ledger frames extracted from `SessionView.items` — the reducer never re-reads the transport.
- Fetch once on mount; a member with no finalized character (shouldn't happen at play time — everyone finalized to start) settles to a calm empty sheet.

- [ ] **Step 1 — failing tests** (spy the two reads): (a) resolves the viewer's characterId from the roster + fetches + adapts → a non-null `CuratedSheet`; (b) a viewer absent from the roster → `failed`/empty; (c) an `hp` ledger frame for the viewer's character updates `overlay.hp`; (d) a ledger frame for ANOTHER character is ignored; (e) a rejected fetch → `failed`. Run → FAIL.
- [ ] **Step 2 — implement.** Keep the module < 150 lines.
- [ ] **Step 3 — barrel + run** → PASS. Export `useSessionSheet`, `SessionSheetState`.
- [ ] **Step 4 — commit** `feat(MYT-94): in-session character-sheet view-model (curated + live overlay)`.

### Task 7: Session-knowledge prop-contracts (`@mythrun/client-core/contract`)

**Files:**
- Create: `frontend/client-core/src/contract/session-knowledge.ts` (+ re-export the matcher types)
- Modify: `frontend/client-core/src/contract/index.ts` (re-export — append-only)
- Test: type-only (tsc) + the existing `contract.test.ts` barrel assertion.

**Interfaces (DOM-free prop types, R1; neutral callbacks only):**
- Re-export `ProseSegment`, `EntityCard`, `EntityGlyph`, `EntityIndex` (Task 3) through the contract surface (mirror how `world-wiki.ts` re-exports the wiki model).
- `EntityMentionProps` — `{ text: string; glyph: EntityGlyph; label: string /* i18n key for the a11y "entity: <name>" role */ }` (the trigger is a focusable inline span; the popover wraps it).
- `EntityPopoverProps` — `{ card: EntityCard; open: boolean; onOpenChange: (open: boolean) => void; onOpenInWiki: () => void; label: string; typeLabel: string; openInWikiLabel: string; children: ReactNode /* the EntityMention trigger */ }`.
- `KnowledgeSidebarProps` — the three-tab panel:
```ts
export interface KnowledgeSidebarProps {
  cache: KnowledgeCache            // wiki + graph + index (index unused here; the shell uses it for highlighting)
  sheet: SessionSheetState
  // The graph↔wiki bridge + the external "open this entity" push (from a chat highlight click):
  selectedEntityId?: string
  onSelectEntity: (entityId: string) => void
  activeTab: KnowledgeTab           // 'wiki' | 'graph' | 'sheet' — controlled so a chat click can force 'wiki'
  onTabChange: (tab: KnowledgeTab) => void
  wikiQuery: string
  onWikiQuery: (q: string) => void
  reducedMotion: boolean
  // …all chrome labels as resolved i18n keys (tab labels, search labels, graph a11y, sheet labels, unavailable lines)
}
export type KnowledgeTab = 'wiki' | 'graph' | 'sheet'
```
- `SessionSheetPanelProps` — `{ sheet: CuratedSheet; overlay: CharacterOverlay; ...resolved labels (hpLabel, conditionsLabel, emptyLabel) }`.

- [ ] **Step 1** — author the prop types + the matcher-type re-exports + the `contract/index.ts` re-export block. `pnpm --filter @mythrun/client-core typecheck` + the barrel test → PASS.
- [ ] **Step 2 — commit** `feat(MYT-94): client-core prop contracts for the knowledge sidebar + entity highlighting`.

---

## Phase B — `@mythrun/ui` components

> Each U-task: a presentational component importing props from `@mythrun/client-core/contract`, a Storybook story + tests, square register, two-faces-only, responsive to ~375px, reduced-motion honored. Append to the `ui/src/index.ts` barrel.

### Task 8: Type glyphs (extend `IconName` + `GLYPHS`)

**Files:**
- Modify: `frontend/client-core/src/contract/icon.ts` (append 3 names to the `IconName` union), `frontend/ui/src/components/Icon/glyphs.ts` (append 3 `Glyph` entries)
- Create: `frontend/ui/src/components/Icon/glyph-for-kind.ts` (the `EntityGlyph → IconName` map) — OR colocate the tiny map in `EntityMention`.
- Test: extend `frontend/ui/src/components/Icon/__tests__` (the `Record<IconName, Glyph>` completeness is compile-enforced; add a render test for each new glyph).

**Interfaces:**
- Append `'entity-npc'`, `'entity-location'`, `'entity-faction'` to `IconName` (names in the DS's own vocabulary; the underlying glyphs are person / pin / banner from pixelarticons). Add their verbatim 24-grid `<path d>` data to `GLYPHS` (copied from `pixelarticons/svg/{users,map,flag}.svg` or the closest person/pin/banner shapes — pin the exact source file in the glyph comment). Map `EntityGlyph → IconName`: `npc→entity-npc`, `location→entity-location`, `faction→entity-faction`, `other→` no glyph.

- [ ] **Step 1 — failing tests:** each new `IconName` renders its paths; the `EntityGlyph→IconName` map covers `npc`/`location`/`faction`. Run → FAIL.
- [ ] **Step 2 — implement.** Copy the path data VERBATIM from the pixelarticons source (cite the file). The `Record<IconName,Glyph>` makes a missing glyph a compile error.
- [ ] **Step 3 — run** the icon tests + story → PASS.
- [ ] **Step 4 — commit** `feat(MYT-94): entity type glyphs (npc/location/faction) in the icon vocabulary`.

### Task 9: `EntityMention` (inline underline + monochrome hover glyph)

**Files:** `frontend/ui/src/components/EntityMention/{EntityMention.tsx,.stories.tsx,.test.tsx}` + barrel.

**Behavior:** an inline `<button>`-semantics span rendered INSIDE serif prose. Resting state: a **subtle underline** (barely visible — a low-contrast `text-decoration`, NOT a colored hyperlink). Hover/focus: the underline **style changes** (e.g. thin→solid / dotted→solid — a structural, non-color change) AND a small **leading type glyph** appears (the `Icon` for the `glyph`) — monochrome, `currentColor`, no type color. Keyboard-focusable; Enter/Space activates (opens the popover — the popover is the wrapping component). Square register, inline, no layout shift on hover (reserve the glyph's inline space or render it absolutely so hover doesn't reflow the paragraph). `label` is the a11y name ("entity: <name>", resolved i18n key with the name interpolated as data).

- [ ] Steps: TDD (renders `text`; underline present at rest; hover/focus reveals the glyph + changes underline style; no COLOR class applied; focusable + activatable; hover causes NO reflow) → implement (compose `Icon`; the underline via a token utility, hover via `:hover`/`:focus-visible`; guard against inline reflow) → stories (npc/location/faction at rest + hovered; inside a prose paragraph; 375px) → PASS → commit `feat(MYT-94): EntityMention (subtle underline, monochrome hover glyph)`.

### Task 10: `EntityPopover` (terse card)

**Files:** `frontend/ui/src/components/EntityPopover/{EntityPopover.tsx,.stories.tsx,.test.tsx}` + barrel.

**Behavior:** composes the shipped `Popover` (`trigger` = the `EntityMention`; `label` required a11y name; controlled `open`/`onOpenChange`). Content is **terse** (spec §6): the entity name (serif) + the leading type glyph + the `typeLabel` (mono) + the `leadLine` (one line, `--font-body`, from `card.leadLine`; omitted when empty) + an "open in wiki" action (a `Button`/`Link` firing `onOpenInWiki`). NOTHING else — the rich knowledge (facts, related, intro prose) lives one tap away in the wiki tab. Square register, no avatar/circle.

- [ ] Steps: TDD (renders name + glyph + typeLabel + leadLine; empty leadLine omits the line; "open in wiki" fires `onOpenInWiki`; the popover opens on the trigger; a11y label present) → implement (compose `Popover` + `Icon` + `Text`/`Heading` + `Button`) → stories (npc with leadLine; faction without; open state; 375px) → commit `feat(MYT-94): EntityPopover (terse card + open-in-wiki)`.

### Task 11: `DmMessage` settled highlighting + `MessageStream` seam

**Files:** Modify `frontend/ui/src/components/DmMessage/DmMessage.tsx`, `frontend/ui/src/components/MessageStream/MessageStream.tsx`; Create `frontend/ui/src/components/DmMessage/HighlightedProse.tsx`; extend `frontend/client-core/src/contract/dm-message.ts` + `message-stream.ts` (append-only optional props); tests + stories for each.

**Interfaces:**
- Append to `DmMessageProps` (optional — 92's callers unaffected): `highlight?: EntityIndex; onEntityOpen?: (entityId: string) => void` + the popover chrome labels (`popoverLabel`, `openInWikiLabel`, and a `typeLabelFor: (glyph) => string` or three resolved labels).
- Append to `MessageStreamProps` (optional): `highlight?: EntityIndex; onEntityOpen?: (entityId: string) => void` — passed straight through to the `dm` arm of `renderItem`.

**Design (pin in the headers):**
- **Streaming path unchanged.** `DmMessage` renders `StreamingProse` exactly as today while `streaming` is true OR `highlight` is undefined. **Only when settled (`!streaming`) AND `highlight` is present** does it render `HighlightedProse` instead.
- `HighlightedProse` renders the SAME `prose-body <p>` wrapper/typography as `StreamingProse`'s settled output (so the streaming→settled handoff has ZERO reflow — pin: read `StreamingProse` and match its settled DOM/classes exactly). Its children = `useMemo(() => highlight.segment(text), [highlight, text])` mapped to: a raw text node for a `text` segment, and an `<EntityPopover>` wrapping an `<EntityMention>` for an `entity` segment (card via `highlight.card(entityId)`; `onOpenInWiki` → `onEntityOpen(entityId)`). **The `useMemo` keyed on the (stable) settled `text` means segmentation runs ONCE per settled row, never on every render** — this is the "without re-parsing on every render" requirement (spec §6).
- `MessageStream.renderItem`'s `dm` arm becomes `<DmMessage text={item.text} streaming={item.streaming} highlight={highlight} onEntityOpen={onEntityOpen} … />`. Extract the dm arm into a small `<DmProseRow>` if needed to hold the memo per row (the current `renderItem` is a plain function — a component is required for the hook). Player + mechanical arms are untouched (MYT-93 owns the mechanical arms).

- [ ] **Step 1 — failing tests:** (DmMessage) (a) streaming → `StreamingProse`, no mentions even if `highlight` present (no mid-stream highlighting); (b) settled + `highlight` → mentions render for matched names, plain text elsewhere; (c) settled + NO `highlight` → plain prose (92 back-comK compat); (d) segmentation is memoized (a re-render with identical `text` does not recompute — assert via a spy `segment`); (e) clicking a mention's "open in wiki" fires `onEntityOpen(entityId)`. (MessageStream) (f) `highlight`/`onEntityOpen` thread through to a settled dm row; a streaming dm row shows no mentions. Run → FAIL.
- [ ] **Step 2 — implement** `HighlightedProse` (match `StreamingProse` settled typography), the `DmMessage` branch, the `MessageStream` pass-through. Keep each < 50-line fn.
- [ ] **Step 3 — run** DmMessage + MessageStream tests + stories (a settled DM row with mentions; a streaming row without) → PASS.
- [ ] **Step 4 — commit** `feat(MYT-94): settled-prose entity highlighting (DmMessage/HighlightedProse + MessageStream seam)`.

### Task 12: `SessionSheet` (in-session sheet variant)

**Files:** `frontend/ui/src/components/SessionSheet/{SessionSheet.tsx,.stories.tsx,.test.tsx}` + barrel.

**Behavior:** a NEW in-session sheet — the member's `CuratedSheet` rendered WITHOUT the creation-flow chrome. It reuses `CharacterSheetReveal`'s presentation (identity line, the AC/HP/… stat stripe, ability tiles, prose, features, equipment, spells) but **strips the `onConfirm`/`onStartOver`/`onToggleExpand` affordances** (those are the "meet your character → into party / start over" creation payoff — wrong for in-session). It **overlays the live `CharacterOverlay`**: when `overlay.hp` is non-null, the HP stat renders `hp/maxHp` (live) instead of the base sheet's static HP `SheetStat`; a quiet conditions line renders `overlay.conditionLog` (recent changes) when non-empty. Square register; scrolls inside the tab panel.

**Design note:** factor the shared presentation so `CharacterSheetReveal` and `SessionSheet` don't duplicate the stat-stripe/ability-tile/entry-list rendering — extract the read-only sheet body into a shared internal (e.g. `SheetBody`) that both compose, `CharacterSheetReveal` adding the reveal chrome and `SessionSheet` adding the live overlay. **[Flag if the controller prefers a standalone SessionSheet with a small amount of duplication over refactoring the shipped CharacterSheetReveal.]**

- [ ] Steps: TDD (renders name/stats/abilities/features/equipment from `CuratedSheet`; NO confirm/start-over control; `overlay.hp` overrides the HP stat; `conditionLog` renders when non-empty; a caster's spells render) → implement (compose the shared sheet body; overlay HP) → stories (martial, caster, mid-combat HP overlay, 375px) → commit `feat(MYT-94): SessionSheet (in-session curated sheet + live overlay)`.

### Task 13: `KnowledgeSidebar` (the three-tab panel + graph↔wiki bridge)

**Files:** `frontend/ui/src/components/KnowledgeSidebar/{KnowledgeSidebar.tsx,.stories.tsx,.test.tsx}` + barrel. (Optionally split the three panels into sibling files `WikiTab.tsx`/`GraphTab.tsx`/`SheetTab.tsx` under the same folder to hold the 400-line ceiling.)

**Behavior:** composes the shipped `Tabs` (three `TabItem`s, controlled `value`/`onChange`, a `label` a11y key) — one panel each:
1. **World Wiki** — the shipped `<WorldWiki model={cache.wiki} selectedId={selectedEntityId} onSelect={onSelectEntity} query={wikiQuery} onQuery={onWikiQuery} …labels />`. Search is the shipped client-side filter. **Stat blocks are structurally absent** (the `WorldSnapshotSchema` strips prose kernels + stat blocks; `WikiViewModel` carries only name + facts + related + intro). A calm `[ph:]` unavailable line when `cache.wiki === null`.
2. **Relationship Graph** — the shipped `<WorldGenGraph nodes={cache.graph.nodes} edges={cache.graph.edges} interactive fillHost forcefulSettle showLabels selectedKey={selectedEntityId} onSelect={onSelectEntity} reducedMotion={reducedMotion} shownEntities={n} totalEntities={n} nodeListLabel={…} />` mounted **DRAINED** — pass `shownEntities === totalEntities` (both = `nodes.length`) so `shown ≥ total` empties the fog field (the shipped drain floor; there is NO fog-off prop). **Do NOT pass `forceParams`/`densityParams`** (locked defaults — "ForceParams untouched"). `interactive: true` wires node selection (UX §9: clicking a node opens its wiki entry); a node tap fires `onSelectEntity`.
3. **Character Sheet** — `<SessionSheet sheet={sheet.sheet} overlay={sheet.overlay} …labels />`; calm unavailable line when `sheet.sheet === null`.

**The graph↔wiki bridge** (already a first-class shipped seam): `WorldGenGraph.onSelect(displayId)` and `WorldWiki.onSelect(id)` both report through `onSelectEntity`; `selectedEntityId` is fed to BOTH as `selectedKey`/`selectedId` so a selection on either side highlights the other. A node tap ALSO switches `activeTab` to `'wiki'` (via `onTabChange`) so the tap lands on the entity's wiki page (UX §9).

- [ ] Steps: TDD (three tabs render; switching tabs shows the right panel; the wiki panel receives `cache.wiki`; the graph mounts with `shownEntities===totalEntities` + `interactive`; a graph `onSelect` reports through `onSelectEntity` AND requests the wiki tab; `selectedEntityId` threads to both; null cache/sheet render calm lines) → implement (compose `Tabs` + `WorldWiki` + `WorldGenGraph` + `SessionSheet`) → stories (each tab; a selected entity bridging graph↔wiki; empty states; 375px) → PASS → commit `feat(MYT-94): KnowledgeSidebar (three tabs + graph↔wiki bridge, graph drained)`.

> **Sub-step (Ambiguity B — decide with the controller before implementing the wiki tab):** the shipped `WorldWiki` search (`filter-model.ts`) matches on entity **name only**. Spec §6 says search covers "the fields the shipped wiki renderer shows" (name + facts). **Recommendation:** extend `filterEntity` to ALSO match `entity.facts` (topic/content), preserving the name-match + ancestor-path behavior and updating the shipped `WorldWiki` tests — one search implementation, stat blocks still structurally excluded. If the controller prefers minimal blast radius, reuse name-only (the done-when "search finds an entity" is met either way). Whichever is chosen, add the leak assertion: **the search index/filter operates over `WikiViewModel` only, so no stat-block field is reachable** (assert a fixture carrying a would-be stat field never surfaces in results).

---

## Phase C — web wiring

### Task 14: Play-route composition — sidebar default-open, mobile drawer, entity-click → wiki

**Files:**
- Modify: `frontend/src/routes/play/session-shell.tsx` (replace the `SidebarPlaceholder` mount)
- Delete/retire: `frontend/src/routes/play/sidebar-placeholder.tsx` (92's seam; its `session-sidebar-seam`/`session-sidebar-toggle` testids + collapse behavior migrate into the real sidebar composition — preserve the testids so 92's shell tests keep meaning, or update them in lockstep)
- Create: `frontend/src/routes/play/knowledge-panel.tsx` (the route-local composition: owns the cache + sheet hooks + tab/selection/query state + the desktop-collapsible / mobile-Drawer shell around `<KnowledgeSidebar>`)
- Modify: web i18n (`common.json` + `descriptions.ts` — append-only `[ph:]` keys under `play.knowledge.*`)
- Test: `frontend/src/routes/play/__tests__/knowledge-panel.test.tsx` + extend `session-shell` tests.

**Interfaces:**
- Consumes: `useKnowledgeCache`, `useSessionSheet`, `KnowledgeSidebar`, the shipped `Drawer` + `Show` + `IconButton`, `SessionView` (for the `ledger_update` frames + the reconnect boundary → `refreshToken` bump), the viewer identity (`viewerUserId`/`characterName` already threaded to `SessionShell`).
- Produces: the real sidebar — the seam MYT-92 left as `SidebarPlaceholder`.

**Design:**
- **Default OPEN** (spec §6 / UX §9 — flip 92's `useState(false)` to open-by-default). Collapsible via the existing chevron toggle (preserve the `session-sidebar-toggle` testid). Width ~30% (tune 92's `w-[18rem]`).
- **Desktop (`Show above="lg"`):** the collapsible 30% panel hosts `<KnowledgeSidebar>` directly.
- **Mobile (`Show below="lg"`):** MYT-92 wired NO mobile drawer; MYT-94 adds it via the shipped `<Drawer>` (right-slide, mount-persistent — tab state + wiki nav survive close/open; `title`/`openLabel`/`closeLabel` as `[ph:]` keys) hosting the SAME `<KnowledgeSidebar>`.
- **Refetch boundary:** bump the cache's `refreshToken` on mount and whenever the transport transitions back to `connected` after a `reconnecting` (the `session_reconnect` boundary) — the safe-default promotion path (spec §6). Derive from `SessionView.connection`.
- **Ledger frames → sheet:** extract the `ledger_update` frames from `SessionView.items` (92 models them first-class) and pass to `useSessionSheet` (it filters to the viewer's character).
- **Chat highlight → sidebar:** the `MessageStream`'s `onEntityOpen(entityId)` (Task 11) is wired here to: set the sidebar's `selectedEntityId` + `activeTab='wiki'` + **open the sidebar if collapsed** (UX §9: "clicking an entity highlight opens the sidebar to the relevant wiki entry if the sidebar is collapsed") / open the mobile Drawer. Thread `cache.index` + `onEntityOpen` into `<MessageStream highlight={cache.index} onEntityOpen={…}>`.
- Keep each file < 400 lines / functions < 50 (extract the desktop vs mobile shell + the selection/tab state). Add the `[ph:]` keys to `common.json` + `descriptions.ts` in lockstep.

- [ ] **Step 1 — failing tests** (inject fake hooks via deps): (a) the sidebar renders OPEN by default; the toggle collapses/expands it; (b) `MessageStream` receives `highlight` (the cache index) once the cache resolves; (c) clicking a chat entity highlight sets the wiki tab + selectedEntityId + opens the sidebar if collapsed; (d) a `ledger_update` in the transcript updates the sheet tab's HP; (e) at 375px the sidebar is the Drawer (summonable), chat is full-bleed (min-w-0, no horizontal scroll); (f) a reconnect bumps the cache refetch. Run → FAIL.
- [ ] **Step 2 — implement** the composition + retire the placeholder. Preserve/port the `session-sidebar-seam`/`session-sidebar-toggle` testids.
- [ ] **Step 3 — run** the panel test + `session-shell` tests + screen story + `resources.test.ts` (i18n drift) → PASS.
- [ ] **Step 4 — commit** `feat(MYT-94): play sidebar — knowledge tabs default-open, mobile drawer, chat-highlight → wiki`.

---

## Phase D — verification

### Task 15: Merged battery + E2E done-when smoke

**Files:** none new (verification). A Playwright E2E under the repo's smoke convention, or a documented manual wire-walk (curl/SSE/psql + a browser) per the CLAUDE.md dev-tool-E2E rule.

- [ ] **Step 1 — full batteries:** `pnpm --filter @mythrun/client-core test`, `pnpm --filter @mythrun/ui test`, the web route tests; `pnpm typecheck`; `pnpm lint` (whole `src`, for the type-aware rules); scoped coverage at 100×4 on the new source; the Storybook browser sweep on the new stories (a11y contrast + overflow gates — heavy graph/WorldWiki renders may need an `asyncUtilTimeout` bump per the heavy-SVG-render CI rule). All green.
- [ ] **Step 2 — E2E done-when (spec §6, verbatim):** on the live dev stack, in a REAL session:
  - a known NPC's name **highlights** in settled DM prose (never mid-stream); click opens the **popover** (name + type glyph + lead line + open-in-wiki);
  - the **wiki tab search** finds an entity; **stat blocks appear NOWHERE** in the tab or its search (assert the rendered tab + a search over a stat-bearing seed surfaces no AC/HP);
  - the **graph** renders known-tier only — the **dev-seeded secret edge (Task 1 step 3) is ABSENT** (the leak assertion: inspect the member world-snapshot `relationships` on the wire AND the rendered graph);
  - the **sheet tab tracks a live HP change** from a `ledger_update` (drive a damage beat; psql-verify the character HP; assert the tab reflects it).
  - **Wire smoke:** inspect the `world-snapshot` response (`relationships` excludes the secret edge), a real `ledger_update` frame, and the character read. Assert observable END STATE (a highlighted mention, an open popover, a searched-and-found entity, the absent edge, the updated HP), not "page loaded / no errors" (the Playwright-asserts-end-state rule).
- [ ] **Step 3 — wiki sync:** dispatch the `docs/wiki/AUTHORING.md` subagent (parameterized with MYT-94) before the merge's final push (the controller owns the push per the worktree flow).
- [ ] **Step 4 — commit** any verification scaffolding as `test(MYT-94): knowledge-sidebar + highlighting E2E smoke + merged battery`.

---

## Filed beads (not built here — declared scope)

- **Real-time wiki updates during a session.** UX §9 wants the wiki to update in real time as the Scribe extracts facts; MYT-94 refetches the snapshot on session boundaries only (spec §6 boundary-refetch pin — no new read/event surface). A live wiki-delta event (a Scribe-emitted known-tier projection frame) is a named backend follow-up.
- **Per-character knowledge divergence.** UX §12 wants each player to see only their character's *delivered* facts; MYT-94 uses the world-level member-readable known-tier projection (the shipped `getWorldSnapshot`). A character-scoped read (the TODO in `wiki-view-model.ts`/`world-snapshot.ts`) is superseded by spec §6's "no new read"; a true per-character projection is a later issue (Ambiguity D).
- **Live tier-flip projections on the WS channel.** IF a future backend emits a post-flip known projection of a promoted entity on the session channel, the cache MAY consume it (spec §6 invariant) — deferred until such a frame exists.
- **Maintained active-condition set on the sheet.** The `ledger_update` frame carries no add/remove flag for conditions (Ambiguity E); a deterministic active-condition set needs a wire change (an add/remove field). Filed; the batch shows a chronological condition log.

---

## Self-review

**Spec §6 coverage:** knowledge cache (member-readable snapshot, boundary refetch, tier-flip invariant asserted) → Task 2; the matcher (names-only, longest-match, no-partial-word, completed-messages-only, pure) → Task 3; highlight rendering without per-render re-parse → Task 11 (memoized `segment` on settled text); the terse popover (type glyph + lead line + open-in-wiki) → Tasks 9/10; the three tabs — embedded `WorldWiki` + client-side search over rendered fields (stat blocks structurally excluded), the graph adapter + drained mount + known-tier edges + the REQUIRED secret-edge leak assertion, the in-session sheet + `ledger_update` reducer → Tasks 4/5/6/12/13; sidebar/drawer composition (desktop default-OPEN, mobile Drawer) → Task 14; i18n `[ph:]` → Tasks 7/8/14; verify-first → Task 1; final E2E per the done-when verbatim → Task 15. ✅ all mapped.

**Enforced ignorance / ZFC:** no new read surface, no new endpoint, no client-side tier filter; the cache is built only from the server-filtered member projection; no session frame promotes the cache (invariant asserted); the matcher is mechanical (no LLM, no prose pattern-matching); the secret-edge leak assertion is required (unit + E2E). ✅

**§7 collision discipline:** `session-shell.tsx` edit scoped to the sidebar mount (93's mechanical-card shell edit serialized by the controller); `MessageStream.renderItem` dm-arm extension + append-only `MessageStreamProps` props (93 extends the mechanical arms); barrels + i18n append-only; `icon.ts`/`glyphs.ts` append-only (compile-enforced completeness); graph adapter made canonical (worldgen delegates). ✅

**Reuse leverage:** `toWikiViewModel`, `snapshotToSeed`→`snapshotToGraph`, `WorldWiki` (search + graph↔wiki bridge built in), `WorldGenGraph` (drain floor + interactive + fillHost), `sheetViewModel`/`toRevealViewModel`, `Tabs`/`Popover`/`Drawer`/`Icon`, `useWikiModel`'s refetch shape — all shipped; MYT-94's NEW code is the matcher, the ledger reducer, the sheet view-model, the three highlighting components, the type glyphs, and the composition.

**Placeholder scan:** load-bearing code inline (the cache interface, the matcher types + algorithm, the graph-adapter extraction, the ledger reducer + overlay, the sheet view-model, the contract prop types, the highlight seam threading, the graph drained-mount props, the composition wiring). UI tasks carry exact props + test intent + composition notes. No "TBD".

**Type consistency:** `KnowledgeCache`/`EntityIndex`/`ProseSegment`/`EntityCard`/`EntityGlyph`, `snapshotToGraph`/`GraphSeed`, `CharacterOverlay`/`reduceLedger`, `SessionSheetState`/`useSessionSheet`, `KnowledgeSidebarProps`/`KnowledgeTab`, the appended `DmMessageProps`/`MessageStreamProps` optional props, and the three appended `IconName`s are used consistently across tasks.
