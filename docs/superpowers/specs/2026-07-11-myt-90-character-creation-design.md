# MYT-90 — Character Creation Flow (design)

> **Status:** design, pre-implementation. Brainstormed 2026-07-11. **Blind-review round 1 folded in** (5 lenses: LLM-pipeline, backend-API, frontend-arch, product-flow, D&D-rules; 0 true showstoppers, all corrections applied inline — see the ⟲ markers).
> **Linear:** MYT-90 (Frontend milestone). Folds in party-wide starting-level + a small concept-reset backend surface by decision.
> **Depends on (shipped):** MYT-85 realtime transport (status SSE), MYT-53 per-player character pipeline, MYT-54 character integration, world reveal (MYT-89).
> **Boundary with MYT-91:** invite-link lifecycle + live party-join push updates belong to MYT-91. This issue owns the character-creation flow, the owner setup beats, the party-roster *shell*, and the finalize control.
> **Visual reference:** `docs/superpowers/specs/assets/2026-07-11-myt-90-character-creation-mockups/` — approved layout/composition/register per screen. Directional (real build uses `@mythrun/ui` tokens), not a constant-for-constant port.

## 1. Goal

Turn the 15-line `character-new` stub into the complete **phase-4 arc**: from the shipped world reveal through to a playable, party-integrated campaign. A player goes reveal → (owner) situation pick → (owner) starting-level pick → character creation (freeform *or* guided) → "coming into being" loading → "meet your character" reveal → confirm → party staging → finalize → play.

- **ZFC holds:** the app orchestrates; the LLM interprets the concept and produces the mechanical sheet. The one deterministic input we *inject* (not generate) is the party's starting level.
- **Register:** paper-y / 1-bit / square. Serif body (Source Serif 4), mono labels (IBM Plex Mono), `--radius: 0`, no circles, no voxel/3D. The loading beat reuses the shipped world-gen loading language, **not** the April spec's voxel silhouette (MYT-88, post-launch).

## 2. Scope

**In scope:**

1. **Backend — party-wide starting level (1–5):** `campaigns.starting_level`; owner-only route; submit gate; deterministic level injection into the concept/sheet stages; level-scaled generation for 1–5 with strengthened `validateCoherence`; constructed-state real-LLM smoke.
2. **Backend — situation `invitation`:** the starting-situation stage generates a per-situation character-creation whisper (which doubles as the `situationGroundingText` prompt — §4.2/§5.2). Register-encoded; constructed-state smoke.
3. **Backend — concept reset + confirm:** a route to reset a `completed` concept back to resubmittable (so "Start over" works), and persisted confirmation (`confirmed_at`) so the reveal→staging step survives reload. ⟲ (both surfaced by review)
4. **Frontend — the full flow:** owner situation pick (modify the shipped route), owner level pick, path chooser, freeform, guided builder, loading beat, sheet reveal (+ full-sheet expand), party roster shell + owner finalize, the member-join variant entry, and the failure/retry surface.
5. **Frontend — client-core character API layer** (currently unbuilt — §5.3) + the SRD catalog port.

**Out of scope:** invite lifecycle/receive/live-join (MYT-91), voxel/3D loading (MYT-88), in-session sheet tab (MYT-94), character integration LLM weave itself (MYT-54, shipped — we trigger it), laggard-after-finalize re-integration (§7 follow-up), levels >5, static card copy (MYT-100), multiclassing, homebrew.

## 3. The flow

### 3.1 Owner journey
`World reveal (shipped)` → **Situation pick** → **Starting level** → **Create** (A/B) → **Loading** → **Meet your character** → **Party staging** → **Begin** (finalize → integration → `active`) → play.

### 3.2 Member journey (via MYT-91 invite)
`Accept invite (MYT-91)` → **Brief world-intro summary** → **Create** (situation + level already set) → **Loading** → **Meet your character** → wait for owner finalize → play.

### 3.3 Routing model ⟲ (rewritten — the derived pipeline `phase` is the WRONG signal)

**Do not route on the derived pipeline `phase`.** `derivePhase` returns `character_creation` *only transiently* while a concept is `processing`, falls back to `world_ready` once concepts are `completed`, and returns a **party-wide `failed`** if *any* member's concept fails — which the FE status client collapses to a coarse `terminal` that short-circuits to the world-gen `TerminalView` before any per-user branch runs. Routing on it would (a) dead-end a failed concept on the wrong screen and (b) let one member's failure terminal-screen the whole party.

**Route on three viewer-relative signals instead:** `campaign.status` (stable `setup` throughout creation), the **current user's** `character_concepts.status` (from `GET /character-creation-progress`), and **viewer role** (`CampaignSummary.creator === null` ⟹ owner). The state table, all within `campaign.status === 'setup'`:

| Condition (for the viewing user) | Screen |
|---|---|
| `starting_situation_index` null | owner → situation pick; member → "setting up the table" hold |
| situation set, `starting_level` null | owner → level pick; member → hold |
| both set, no concept row **or** concept `failed` | **create** (failed shows a character-context retry, not the world-gen terminal) |
| concept `processing` | **loading beat** |
| concept `completed`, `confirmed_at` null | **meet your character** |
| concept `completed`, `confirmed_at` set | **party staging** (owner: finalize; member: "waiting for the party") |
| concept `integrated` / campaign `active` | play |
| campaign `failed` (terminal integration failure) | character-context failure surface w/ retry — **not** the world-gen `TerminalView` |

**Route ownership** ⟲: keep the shipped **discrete-route** pattern — `campaigns/:id/situation` and `campaigns/:id/character/new` are real routes; `campaign-detail.tsx` delegates the settled `(world_ready, chosen)` + later states to `CampaignPage`. The reveal / party-staging / loading beats are mounted by **`CampaignPage`** (superseding its current stub seam), *not* by grafting a state machine onto `campaign-detail.tsx` (already a dense reveal-timing latch). Situation-pick and character-new stay/​become discrete routes; the reveal↔staging↔loading states live in the `CampaignPage` character surface keyed on the table above.

## 4. Backend

### 4.1 Starting level (1–5)

**Migration `033_starting_level.sql`** ⟲: `ALTER TABLE campaigns ADD COLUMN starting_level SMALLINT CHECK (starting_level IS NULL OR starting_level BETWEEN 1 AND 5)` — match the sibling `starting_situation_index` `IS NULL OR BETWEEN` shape. Pin **both** the migration-filename list *and* the normalized `campaigns` clause in `EXPECTED_CHECK_CONSTRAINTS` in `migrate-schema.test.ts`.

**Route `POST /api/campaigns/:campaignId/starting-level`** (owner-only, `pipelineRoute: true` — see §4.3): body `{ level: 1..5 }`. Gates: world `complete` (409 `world_not_complete`); owner-only; **locked** (409 `level_locked`) once any concept is `processing`/`completed` — reuses the existing `countLocked` primitive. Surface `startingLevel` on `GET /starting-situations`. ⟲ Extend the repo read `getWorldAndSituationIndex` (currently returns only `{world_id, starting_situation_index}`) to also return `starting_level`, for both the submit gate and the GET.

**Submit gate:** `POST /characters` adds 409 `starting_level_not_chosen` when `starting_level` is null (parallels `starting_situation_not_chosen`), in the existing guard chain.

**Deterministic level injection (ZFC)** ⟲: level is a known input, not an LLM judgment. In `character-creation-processor`, override `conceptOutput.level = campaign.starting_level` **before** `setConceptOutput` — this one move carries the persisted `characters.level`, hit dice, `spellSlotsFor`, and `validateCoherence`, all of which already read `narrative.level`. The concept prompt's pinned `- level: 1.` is removed; the concept schema's `level` becomes a code-overridden echo (do **not** trust the LLM's value). The invariant: *persisted `character.level` == `campaign.starting_level`*.

**Level-scaled sheet prompt** ⟲: the sheet prompt is hard-pinned to level 1 in ≥5 places and `renderPrompt` injects no level. Add a `{{level}}` placeholder, thread `narrative.level`, and teach **caster onset**: half-casters have no slots at L1, third-casters none below L3 (`HALF_TABLE[1]=[]`, `THIRD_TABLE[1..2]=[]`) — else a level-1 paladin/ranger emitting a leveled spell burns the 3-attempt regenerate budget → terminal fail. Prompt covers: proficiency bonus by level, HP by level, features gained through level N, subclass features once the class has a subclass by that level, ASI/feat at level 4, Extra Attack / progression-appropriate spells at 5.

**`validateCoherence` (deterministic, honest coverage)** ⟲:
- Keep: spell-level ≤ `maxSlotLevel(progression, level)` (shipped); leveled-spells ⟹ progression ≠ none.
- **Add:** proficiency bonus == (level ≤ 4 ? 2 : 3) — `proficiency_bonus` is a structured int.
- **Add:** an HP *band* from structured fields only — `hit_die`, CON modifier, level: floor ≈ `hit_die + conMod + (level−1)·max(1, 1+conMod)`, ceiling `= level·(hit_die + conMod)` **plus a small per-level slack** (e.g. Hill Dwarf +1/level) to avoid false terminal-fails. This is the cheapest high-value guard for the §8 level-5 risk.
- **Drop the proposed "ASI-presence" check** — it is *not* deterministically buildable: final ability scores carry no pre-ASI baseline to diff, and detecting a feat means string-matching free-prose `features[]` (a ZFC violation). State plainly: **missing-ASI and subclass-feature presence at level N are NOT gated by `validateCoherence`; they ride on prompt quality and the guided builder.** (Only add a structured `asi_or_feat_taken` field if a future bead wants to gate it.)

⟲ The strengthened validation asserts *validity*, not level-*appropriateness* (an under-leveled but internally-valid sheet still passes). The smoke (§6) must state this limitation, not imply it catches under-leveling.

No `.max()` on prose fields. Prompt + schema co-evolve.

### 4.2 Situation `invitation` — the grounding prompt ⟲

The starting-situation stage adds an `invitation` field per situation, generated in the *same* call as `title`/`locationName`/`prose` so it's grounded in that opening's hook. **The `invitation` is the character-creation whisper AND the elicitation for `situationGroundingText`** (§5.2): it's the 2nd-person prompt ("What brought them to the empty caravan at Greenward Toll?") whose answer the player types. This resolves the `situationGroundingText` gap end-to-end.

- The prompt needs a **real register block** (NOT/YES contrast, like the world-introduction stage), and must now hold two voices: the existing 3rd-person `why_interesting` and the 2nd-person `invitation`. Budget for it; it is not a one-line addition.
- `.min()` floor, no `.max()` (the whisper can't come back as one word).
- **Backward-compat** ⟲: worlds whose `starting_situation` stage ran pre-MYT-90 have no `invitation` in their JSONB. Make `invitation` **optional on the read schema** with a generic client fallback prompt, so `getStartingSituations` doesn't hard-fail Zod for old (dev/test) campaigns. New worlds always generate it. No migration needed (JSONB, no inner CHECK).

### 4.3 Contracts ⟲ (correction: the touched routes ARE pipeline routes)

`POST /starting-situation`, `GET /starting-situations`, and `POST /characters` all carry `config: { pipelineRoute: true }`. The new `POST /starting-level` mirrors them, so it is a pipeline route too. Per `reference_pipeline_route_contract_ripple`, adding it touches **five contracts**: `pipeline-routes.ts`, `contract/backend-routes.ts`, the contract mock, and the **two dev-tool manifests** (`coverage.json` + `verify-registry.ts`). Omitting `pipeline-routes.ts` **fails app boot**; omitting `backend-routes.ts` reds the drift test. The dev-tool situation panels (`starting-situations-panel.ts` / `situation-pick-panel.ts`) also need the new `startingLevel`/`invitation` shape. The `/starting-situations` response gains `startingLevel: number | null` and each situation gains optional `invitation: string`.

### 4.4 Concept reset + confirmation ⟲ (new — both surfaced by review)

- **Reset (for "Start over"):** at the reveal the concept is `completed`, which `POST /characters` rejects (409 `concept_locked`); no reset route exists. Add an owner/self route (e.g. `POST /characters/reset`, self-scoped) that flips the caller's own `completed` concept back to a resubmittable state (`failed`/`submitted` semantics + clears the character row), so "Start over" → create works. Same lock semantics respected (can't reset once `integrated`/campaign `active`).
- **Confirmation:** add `confirmed_at TIMESTAMPTZ NULL` to `character_concepts` + a self route to set it ("This is me"). Refresh-stable: the routing table (§3.3) keys party-staging on `confirmed_at`, so a reload in the completed→active window no longer bounces the user back to the reveal. (Miklos-priority: refresh survival, per the gen-resilience wave.)
- **Completion signal** ⟲: the processor emits `{type:'phase', phase:'character_creation_complete', userId}`, but `PipelinePhase` has no such value and the `phase` event arm carries no `userId` — so consuming it either bounces the FE to `GeneratingView` or drops it silently. Fix: give character-creation completion a **properly-typed, `userId`-carrying** event on the status stream, OR drive the loading-beat→reveal swap off the per-user concept status via a progress poll as the reliable backstop. Pin the exact signal so the loading beat can't spin forever.

## 5. Frontend

### 5.1 SRD catalog (`client-core/src/srd/`) ⟲

Port the option lists from the prototype (`.../mythrun-v5/backend/src/data/srd/{classes,species,backgrounds}.json`) into `@mythrun/client-core` as static reference data, exposed via a new `"./srd"` subpath export (mirroring `@mythrun/client-core/worldgen`). Presentational input data, not backend logic — the guided builder shows it and the client-core reducer flattens choices into `conceptText`.

- **Author an explicit `{class → subclassLevel}` table** ⟲ — the prototype JSON has no machine-readable subclass-level field (the level is implicit in `features_by_level` positions). The correct SRD-2014 table: `{cleric,sorcerer,warlock → 1; druid,wizard → 2; barbarian,bard,fighter,monk,paladin,ranger,rogue → 3}`. Unit-test all 12 classes × levels 1–5 (§8). **This table must agree with the backend's level-scaling assumptions** — a mismatch yields a conceptText the sheet stage can't satisfy coherently.
- The SRD has exactly **one subclass per class** — the guided "Subclass" step is a single-option **confirm/flavor reveal**, not a selection grid; don't source more (they aren't in the SRD).
- **Canonical English names** ⟲: the flatten composes conceptText from the SRD catalog's canonical English names (LLM input is locale-independent); only the *display* card copy is `[ph:]` i18n keys in the web layer.
- **SRD-vs-PHB posture** ⟲: only Acolyte (background) and Grappler (feat) are in SRD 5.1; the prototype's other backgrounds are PHB. Backgrounds are presentational-only (flattened to text; mechanically valid 5e) — accept them as "5e-flavored." For the level-4 slot, **the prompt defaults to ASI** (not an arbitrary feat), since a confabulated non-SRD feat would pass validation.

### 5.2 Screens (see mockups)

1. **Situation pick** ⟲ — **modify** the shipped `worldgen/situation-pick.tsx` (today a non-gated `GhostHookList` that navigates to `/campaigns/:id`): add owner-gating, switch the register to `SituationCard`, surface `invitation`, and rewire post-pick navigation to **level pick**. Not greenfield.
2. **Level pick** — owner-only; 5 cards (1–5) with a plain, **approximate** D&D grant gloss ⟲ (hedge caster-specific claims — "spellcasters gain 2nd-level spells", since half-casters/martials differ). Locks party-wide.
3. **Path chooser + freeform** — "Tell us who you are" vs "Build your character". **The freeform path collects both required fields** ⟲, one-at-a-time: "Who are you?" → `conceptText`, then the situation's `invitation` whisper → `situationGroundingText`.
4. **Guided builder** — one question at a time, D&D terms: **Class → Subclass → Species → Background → Notes**, progress rail carrying prior choices. The **Subclass step appears iff `subclassLevel[class] ≤ starting_level`** (per the §5.1 table). Origin = species + background. The reducer flattens the choices into `conceptText`; `situationGroundingText` is still collected via the same `invitation` whisper step. Both paths POST the **two-field** body.
5. **Loading beat** ⟲ — 1-bit "coming into being". Real-time source is the **MYT-85 status SSE** (`/status/stream`), **filtered to the current user's** `user_id` (the stream is campaign-wide); NOT the `character-creation-progress` GET (a snapshot). Needs a **stage→beat mapping** (name → class/subclass → "rolling ability scores…" → equipment). The swap to the reveal fires on the per-user completion signal (§4.4). `prefers-reduced-motion` → instant.
6. **Meet your character** — field-guide entry, not a stat block (name; mono identity line; AC/HP/Prof/Hit-Die/Speed stripe; six square ability tiles; two prose paragraphs; "What she can do" / "What she carries"; spells panel only for casters). Actions: **This is me →** (sets `confirmed_at`), **See full sheet** (inline expand, no LLM call), **Start over** (calls the reset route, then create — costs an LLM call).
7. **Party staging + finalize** ⟲ — owner post-character view. **Solo (launch-critical, airtight):** one-person party + invite slot + **Begin the adventure →**. **Party:** live roster from `GET /character-creation-progress`, owner-only **Begin**. Finalize rule: enabled once the owner's own concept is `completed`; integration weaves all currently-`completed` concepts. **Laggard boundary:** a member who completes *after* finalize is a known limitation (integration loads only `completed` at fire time; the campaign then flips `active` and finalize 409s `not_in_setup`) — flagged as a §7 follow-up entangled with MYT-91's live-join work, not solved here. Begin → `POST /finalize-character-creation` → weave beat (session-prep loading register) → `active` → opening scene. **Integration failure** → the character-context failure surface (§3.3), not the world-gen terminal.
8. **Member-join variant** — briefer entry: a world-intro summary (reuse world-introduction content), then create (situation + level already set). The invite/receive flow preceding it is MYT-91; MYT-90 owns the summary + create entry.

### 5.3 `client-core` — the character API layer is a real deliverable ⟲

None of character-submit / get-characters / progress / finalize / starting-level are wired in `client-core/src/api/` today (only the backend routes exist). MYT-90 authors all of them: `defineEndpoint` slices + Zod response schemas + `index.ts` barrel exports, plus the `StartingSituation` (`invitation`) and response (`startingLevel`) additive changes to the existing situations client.

- **View-models under `client-core/src/character/`** ⟲ (not `create/` — collides with MYT-89's `guided-draft.ts`): the create-flow machine (chooser → A/B → submit → progress → reveal → confirm/reset), the guided-builder **reducer** (steps, conditional subclass, flatten-to-conceptText from canonical English names), a sheet-reveal view-model (curated vs full), a party-roster view-model over progress, and a **`useCharacterCreationStream`** over the status SSE filtered by the current `user_id` (analogous to `use-worldgen-stream.ts`).
- ⟲ Consider persisting the guided picks (there's no character-side analog of the `guided-draft.ts` sessionStorage seam) so "Start over" / reload can re-prefill; the provisioned `guided_choices` DB column stays empty under the flatten decision — note that and update the stale `campaign-characters.ts` schema comment.

### 5.4 `@mythrun/ui` components ⟲

Each new component: a **prop-contract file in `client-core/src/contract/`** first (DOM-free, re-exported from `contract/index.ts`), then the `@mythrun/ui` component importing those props (the enforced 96-import seam), plus a Storybook story + tests. Components are **controlled/presentational** — the guided-builder *sequencing* lives in the client-core reducer, not the component. Reconcile granularity with existing primitives ⟲: some pieces (`SituationCard`, `PathChooser`) may be web-route compositions of shipped primitives (`GhostHookList`, DS cards) rather than new DS components — state which are genuinely reusable. Candidate new components: `LevelCard`, `FreeformPrompt`, `GuidedBuilder` (presentational), `CharacterLoadingBeat` (reuse `Dither`), `CharacterSheetReveal`, `PartyRoster`. Square register, no chips/dots; responsive desktop **and** ~375px; strings i18n, prose `[ph:]`. The `ui/src/patterns/CharacterCreation.stories.tsx` showcase is superseded (it's a showcase, "NOT a component").

### 5.5 `web` routing

Discrete routes: modify `worldgen/situation-pick.tsx` (§5.2.1); fill `character/new`. The reveal / party-staging / loading states mount in **`CampaignPage`** (§3.3), superseding its stub seam. Screen-story coverage for each new screen (the storybook browser sweep gates it).

## 6. Testing

- **TDD throughout.** Failing test first per behavior.
- **Backend:** unit tests for the level gate/route, the reset + confirm routes, the extended `validateCoherence` (per-level cases incl. the HP band and prof-by-level; assert the dropped ASI check is *not* claimed), the level-injection override, and the pipeline-route contract ripple. **Constructed-state real-LLM smokes** for (a) a level-1 and a level-5 character end-to-end — asserting the sheet is *valid at that level* (⟲ **and stating explicitly this asserts validity, not level-appropriateness**), and (b) the situation `invitation` prose (in-register, names the hook). Smoke ≠ eval.
- **Frontend:** component tests + stories for every `@mythrun/ui` component; the guided-builder flatten (canonical English) + conditional-subclass (12×5 table); the sheet curated-vs-full expand; the party-roster view-model; the `useCharacterCreationStream` per-user filtering; the failed/retry and reload-stability (confirmed_at) routing. 100×4 scoped coverage; storybook browser sweep per screen.
- **Verification before completion:** typecheck + lint + test across all touched packages; **dev-tool verifier** (dev-tool manifests change — §4.3); a real wire-level create→sheet smoke before hand-off. **Miklos visual audit** before push.

## 7. Non-goals / follow-ups

- **Laggard re-integration** (a member completing after finalize joins the active campaign) — follow-up bead, entangled with MYT-91.
- Voxel/3D loading (MYT-88), in-session sheet tab (MYT-94), invite lifecycle (MYT-91), levels >5, static copy (MYT-100), multiclassing, homebrew, structured `guidedChoices` persistence-for-mechanics (superseded by flatten).

## 8. Risks / open

- **Level-5 generation quality** — the main risk. Mitigation: bound to 1–5, deterministic floors in `validateCoherence`, real-LLM smoke at both ends. Qualitative appropriateness is *not* gated (rides on prompt) — if the smoke shows level-5 unreliability, that's a genuine finding to surface, not a silent cap.
- **Client/backend subclass-table agreement** ⟲ — the client-core `{class → subclassLevel}` table and the backend's level-scaling prompt/validation are two copies of one SRD fact with no shared enforcement; unit-test both against the same 12×5 matrix and note the coupling.
- **SRD-vs-PHB content** — decision recorded in §5.1 (accept 5e-flavored backgrounds; default level-4 to ASI). Revisit if a licensing pass tightens it.
