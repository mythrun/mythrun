# MYT-90 — Character Creation Flow (design)

> **Status:** design, pre-implementation. Brainstormed 2026-07-11.
> **Linear:** MYT-90 (Frontend milestone). Folds in party-wide starting-level backend infra by decision.
> **Depends on (shipped):** MYT-85 realtime transport (SSE status client), MYT-53 per-player character pipeline, MYT-54 character integration, world reveal (MYT-89).
> **Boundary with MYT-91:** invite-link lifecycle + live party-join updates belong to MYT-91. This issue owns the character-creation flow, the owner setup beats, the party-roster *shell*, and the finalize control.
> **Visual reference:** `docs/superpowers/specs/assets/2026-07-11-myt-90-character-creation-mockups/` — the approved layout/composition/register per screen. Directional (real build uses `@mythrun/ui` tokens), not a constant-for-constant port.

## 1. Goal

Turn the 15-line `character-new` stub into the complete **phase-4 arc**: from the shipped world reveal through to a playable, party-integrated campaign. A player goes reveal → (owner) situation pick → (owner) starting-level pick → character creation (freeform *or* guided) → "coming into being" loading → "meet your character" reveal → confirm → party staging → finalize → play.

Two of MYT-90's design principles come straight from the brand and existing architecture:

- **Enforced ignorance is not relevant here** — character creation is player-authored input, not DM cognition. But **ZFC holds**: the app orchestrates; the LLM interprets the concept and produces the mechanical sheet. The one deterministic input we *inject* (not generate) is the party's starting level.
- **Register:** paper-y / 1-bit / square. Serif body (Source Serif 4), mono labels (IBM Plex Mono), `--radius: 0`, no circles, no voxel/3D. The loading beat reuses the shipped world-gen loading language, **not** the April UX spec's voxel silhouette (MYT-88, post-launch).

## 2. Scope

**In scope (this issue):**

1. **Backend — party-wide starting level (levels 1–5).** New `campaigns.starting_level`; owner-only route to set it; gate character submit on it; thread it as a *deterministic constraint* into the character-concept + character-sheet stages; make generation level-scaled for 1–5 with strengthened coherence validation; constructed-state real-LLM smoke.
2. **Backend — situation `invitation` field.** The starting-situation stage generates a per-situation character-creation prompt ("whisper") grounded in that opening, alongside `title`/`locationName`/`prose`. Register-encoded prompt; constructed-state smoke.
3. **Frontend — the full flow:** owner situation pick, owner level pick, path chooser, freeform path, guided builder, loading beat, sheet reveal (+ full-sheet expand), party roster shell + owner finalize, and the briefer member-join variant entry.
4. **Frontend — SRD catalog** (class/species/background option lists) ported from the prototype into `client-core` as static data; card copy is `[ph:]` until the MYT-100 copy pass.

**Out of scope (other issues):**

- Invite-link generation, the receive/sign-up flow, and live party-join push updates → **MYT-91**.
- The voxel/3D animation system → **MYT-88** (post-launch). We use the 1-bit register instead.
- The in-session live Character Sheet tab → **MYT-94**.
- Character integration LLM weave itself → **MYT-54** (shipped; we only trigger it).

## 3. The flow

### 3.1 Owner journey

`World reveal (shipped)` → **Situation pick** (owner-only, party-wide) → **Starting level** (owner-only, party-wide, 1–5) → **Create your character** (path A/B) → **Loading beat** → **Meet your character** → **Party staging** → **Begin** (finalize → integration → `active`) → play.

### 3.2 Member journey (joins via MYT-91 invite)

`Accept invite (MYT-91)` → **Brief world intro summary** → **Create your character** (situation + level already set) → **Loading beat** → **Meet your character** → wait for owner finalize → play.

### 3.3 Phase routing

`campaign-detail.tsx` already routes deterministically on campaign phase/status. The character-creation beats live in the `character_creation` phase (world `complete`, campaign `setup`). Sub-step within the phase is driven by campaign + per-user state:

- `starting_level` null → owner sees **level pick** (after situation, which gates on `starting_situation_index`); members see a "waiting for the owner to set up the table" hold if either party setting is unset.
- Both party settings set + the current user has no `character_concepts` row (or it is `failed`) → **create**.
- The user's concept is `processing` → **loading beat**.
- The user's concept is `completed` and unconfirmed → **meet your character**.
- Confirmed → **party staging** (owner sees finalize; members see "waiting for the party").
- Campaign `active` → play.

## 4. Backend

### 4.1 Starting level (levels 1–5)

**Migration** `033_starting_level.sql`: `ALTER TABLE campaigns ADD COLUMN starting_level SMALLINT CHECK (starting_level BETWEEN 1 AND 5)`. Nullable — owner must set it, exactly like `starting_situation_index`. Pin the migrate-schema test (`reference_migrate_schema_pin_per_migration`).

**Route** `POST /api/campaigns/:campaignId/starting-level` (owner-only, mirrors `/starting-situation`): body `{ level: 1..5 }`. Gates: world `complete` (409 `world_not_complete`), owner-only (`requireCampaignMember 'owner'`), and **locked once character creation has begun** — 409 `level_locked` if any member's concept is `processing`/`completed` (same lock discipline as the situation). Surface `startingLevel` on the `GET /starting-situations` response (the FE reads both party settings there).

**Gate** in `POST /characters`: if `starting_level` is null → 409 `starting_level_not_chosen` (parallels `starting_situation_not_chosen`). Add to the existing guard chain.

**Pipeline threading (deterministic, ZFC).** Level is a *known input*, not an LLM judgment:

- `character-creation-processor` reads `campaign.starting_level` and passes it into the stage chain.
- `character-concept` stage: the prompt currently pins `level: 1`. Replace with the injected party level as a hard constraint; the persisted `character.level` and `narrative.level` are set **deterministically** from `campaign.starting_level` (do not trust the LLM to echo it). The concept schema keeps `level` only as an echo the code overrides, or drops it — implementer's call at plan time; the invariant is *persisted level == campaign.starting_level*.
- `character-sheet` stage: the prompt is level-parametric across 1–5 (proficiency bonus by level, HP by level, class features gained through level N, subclass features once the class has a subclass by that level, ASI/feat at level 4, Extra Attack / 3rd-level spells at 5, level-appropriate known/prepared spells). The deterministic scaffolding (`spellSlotsFor`, `maxSlotLevel`, `validateCoherence`, hit dice) is already level-parametric — extend the prompt and strengthen `validateCoherence`.

**Level-scaled coherence validation** (deterministic, extends the existing `validateCoherence`): proficiency bonus matches level (2 for 1–4, 3 for 5); spell levels never exceed `maxSlotLevel(progression, level)` (already checked); feature/ability-improvement presence is level-consistent (e.g. an ASI-bearing level shows the stat bump or a feat). Terminal-fail the stage on violation so a mis-leveled sheet never persists.

**No `.max()` on prose fields** (`feedback_no_max_on_llm_prose_fields`). **Prompt + schema co-evolve** (`feedback_prompt_schema_co_evolution`).

### 4.2 Situation `invitation` field

The starting-situation stage produces three situations; add an `invitation` field (the character-creation whisper) to each, generated in the *same* call so it's grounded in that situation's specific hook (e.g. "What brought them to the empty caravan at Greenward Toll?"). It is player-facing generated prose — ships now, **not** deferred to the MYT-100 copy pass. Prompt encodes the brand register verbatim (same technique as the world-introduction stage: grounded actors/stakes, terse, no gesturing). Thread `invitation` onto the `StartingSituation` contract (`title`/`locationName`/`prose`/`invitation`) and the `/starting-situations` response. Constructed-state real-LLM smoke asserts the invitation reads in-register and names the situation's hook.

### 4.3 Contracts

`StartingSituationsResponse` gains `startingLevel: number | null` and each situation gains `invitation: string`. Character submit, `character-creation-progress`, and finalize contracts are unchanged (already shipped). Respect the contract ripple discipline (`reference_pipeline_route_contract_ripple`) if any touched route is a pipeline route (these are not).

## 5. Frontend

### 5.1 SRD catalog (`client-core`)

Port the option lists from the prototype (`/Users/miklos/Desktop/Files/Personal/mythrun-v5/backend/src/data/srd/{classes,species,backgrounds}.json`) into `@mythrun/client-core` as static reference data (`client-core/src/srd/`): class names + which level grants a subclass + subclass names, species names, background names. Sanctioned by CLAUDE.md ("SRD reference data ports from the prototype"). This is *presentational input data*, not backend logic — the guided builder shows it and flattens the choices into `conceptText`; the backend never receives structured choices. Card descriptions are `[ph:]` i18n keys until MYT-100.

### 5.2 Screens (see mockups)

1. **Situation pick** (`situation-pick.html`) — owner-only. 3 cards (title / location / prose), select → "This is where we begin". Members skip (already set).
2. **Level pick** (`level-select.html`) — owner-only. 5 cards (1–5) with a plain D&D grant gloss ("Level 3 · your subclass, 2nd-level spells"). Locks party-wide.
3. **Path chooser + freeform** (`path-chooser-freeform.html`) — "Tell us who you are" vs "Build your character". Freeform = a single calm textarea; its prompt whisper is the chosen situation's `invitation`. Escape hatch "or build step by step".
4. **Guided builder** (`guided-builder.html`) — one question at a time, D&D terminology: **Class → Subclass → Species → Background → Notes**. A progress rail carries prior choices. **Subclass step appears iff the class gains its subclass at or below the party's starting level** (e.g. Cleric/Sorcerer/Warlock at level 1; most others at level 3). Origin = species + background (one step, two selects). Notes = optional/skippable freeform. On submit, choices flatten into a well-formed `conceptText` string; POST is identical to the freeform path.
5. **Loading beat** (top of `meet-character.html`) — 1-bit "coming into being": a squared, dither-hatch figure filling in, with name → class/subclass → "rolling ability scores…" → equipment surfacing one at a time. Driven by SSE character-creation-progress. `prefers-reduced-motion` → instant.
6. **Meet your character** (`meet-character.html`) — a **field-guide entry, not a stat block**: large name; mono identity line (`Level 3 · Human Fighter · Champion · Toll-clerk of Greenward`); stat stripe (AC / HP / Proficiency / Hit Die / Speed); **six square ability tiles** (score + modifier); two prose paragraphs (physical + hook into the opening scene); "What she can do" (features) and "What she carries" (equipment) panels; a spells panel only for casters. Actions: **This is me →** (confirm), **See full sheet** (inline expand to the complete mechanical sheet — all skills/saves/equipment/spells; **no LLM call**), **Start over** (returns to the concept prompt; costs an LLM call).
7. **Party staging + finalize** (`party-finalize.html`) — owner post-character view. Solo (common launch case): one-person party + "invite a friend" slot + **Begin the adventure →** (+ "invite others first"). Party: live roster (you/ready/creating…) from `GET /character-creation-progress`, **owner-only** "Everyone's ready — begin →" (can begin before laggards finish). Begin → `POST /finalize-character-creation` → integration weave (MYT-54) → a brief atmospheric "weaving your party into the world" beat (session-prep loading register) → campaign `active` → opening scene.
8. **Member-join variant** — a briefer entry: a world-intro summary (name, tone, their starting location — reuse the world-introduction content), then straight into create (situation + level already set). The invite/receive flow that *precedes* this is MYT-91.

### 5.3 `client-core`

- **View-models / state:** a `useCharacterCreation` machine (path chooser → path A/B → submit → progress → reveal → confirm), a guided-builder reducer (steps, conditional subclass, flatten-to-conceptText), a `situationInvitation` selector, a sheet-reveal view-model (curated vs full), a party-roster view-model over `character-creation-progress`.
- **API/contract:** starting-level get/set; situations response (`invitation` + `startingLevel`); character submit (exists); progress (exists, SSE-backed); finalize (exists). Follow the frontend portability rules (client-core brain / platform UI, `feedback_frontend_portability_architecture`).

### 5.4 `@mythrun/ui` components (each with a Storybook story + tests)

`SituationCard`, `LevelCard`, `PathChooser`, `FreeformPrompt`, `GuidedBuilder` (class grid, step rail, one-at-a-time sequencer), `CharacterLoadingBeat` (1-bit fill-in; reuse `Dither`), `CharacterSheetReveal` (ability tiles, stat stripe, feature/equipment/spell panels, full-sheet expand), `PartyRoster`. Design-system-first (`feedback_components_live_in_design_system`); no ad-hoc UI; square register, no chips/dots (`feedback_mythrun_no_circles_paper_register`). Responsive by construction, desktop **and** ~375px (`feedback_frontend_desktop_and_mweb`). All strings i18n; prose = `[ph:]` (`feedback_frontend_no_hardcoded_strings_i18n`).

### 5.5 `web` routing

Extend `campaign-detail.tsx` phase routing (§3.3) to mount the character-creation sub-screens. Fill in the `character-new` route. Screen-story coverage for each new screen (the storybook browser sweep gates it).

## 6. Testing

- **TDD throughout** (`superpowers:test-driven-development`): failing test first for each behavior.
- **Backend:** unit tests for the level gate/route, level-scaled `validateCoherence` (per-level cases), the concept/sheet level injection; **constructed-state real-LLM smokes** (`feedback_constructed_state_smoke`, `feedback_dev_tool_e2e_smoke_required`) for (a) a level-1 and a level-5 character end-to-end (assert the sheet is valid at that level), and (b) the situation `invitation` prose. Smoke ≠ eval (`feedback_smoke_vs_eval`).
- **Frontend:** component tests + Storybook stories for every `@mythrun/ui` component; the guided-builder flatten logic and conditional-subclass logic unit-tested; the sheet-reveal curated-vs-full expand; the party-roster view-model. 100×4 scoped coverage. Storybook browser sweep for each screen.
- **Verification before completion** (`superpowers:verification-before-completion`): typecheck + lint + test across all touched packages; dev-tool verifier if any dev-tool file changes; a real wire-level smoke of the create→sheet path before hand-off (`feedback_manual_smoke_is_not_optional`).
- **Visual audit** before push (`feedback_frontend_visual_audit_before_push`): Miklos audits the built screens locally before the push.

## 7. Non-goals / deferred

- Voxel/3D loading (MYT-88), in-session sheet tab (MYT-94), invite lifecycle (MYT-91), levels >5, static card copy (MYT-100), multiclassing, homebrew classes.

## 8. Risks / open

- **Level-5 generation quality** is the main risk. Mitigation: bound to 1–5, strengthen `validateCoherence`, real-LLM smoke at both ends of the range. If level-5 generation proves unreliable in the smoke, that's a genuine finding to surface — not a silent cap (`reference_unpushed_vertical_accumulates_ungated_gaps`, root-cause-first).
- **Subclass-at-level correctness** in the guided builder: the "does this class have a subclass by level N" table is deterministic SRD reference data ported from the prototype; unit-test it against the 12 classes × levels 1–5.
- **Member-join world summary** overlaps MYT-91's receive flow; keep the summary component in MYT-90 and let MYT-91 route into it.
