# MYT-90 Character Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete phase-4 arc — owner situation/level setup → freeform/guided character creation → 1-bit loading beat → field-guide sheet reveal → confirm → party staging → finalize → play — plus the party-wide starting-level backend infra (1–5) and the situation `invitation` whisper.

**Architecture:** ZFC-clean — the app orchestrates, the LLM interprets the concept and produces the mechanical sheet; the party starting level is a *deterministically injected* constraint, never an LLM judgment. Frontend is client-core-brain (view-models, flatten-to-conceptText reducer, SRD catalog, SSE hook) + `@mythrun/ui` presentational components on the enforced `client-core/contract` prop seam; the web app wires them via discrete routes + `CampaignPage`, routing on `campaign.status` + per-user concept status + viewer role.

**Tech Stack:** Node 24 + Fastify + TS strict + Postgres; React + Vite + Tailwind; `@mythrun/{contract,client-core,ui}` + web; Vitest; Zod; the AI SDK wrapper (`ai.ts`); the MYT-85 status SSE.

## Global Constraints

- **ZFC:** no heuristics / pattern-matching on LLM output; deterministic code only for policy/structure/math (CLAUDE.md principle 2).
- **No `.max()` on LLM prose fields** — `.min()` floors only (`feedback_no_max_on_llm_prose_fields`).
- **Named exports only; strict TS (no `any`, no assertions unless unavoidable); functions <50 lines; modules <400 lines.**
- **UUIDv7 PKs; all DB access through the repository layer; all Anthropic calls through `ai.ts`; prompts are template files, not inline strings.**
- **i18n:** every user-facing string is a key; generated/placeholder prose = `[ph: <purpose>]`; SRD *names* are canonical English in client-core, card *descriptions* are `[ph:]` web keys.
- **Persisted `character.level` == `campaign.starting_level`** (deterministic invariant).
- **Every migration** updates `migrate-schema.test.ts`'s pinned filename list + the relevant `EXPECTED_*` arrays (`reference_migrate_schema_pin_per_migration`).
- **A `pipelineRoute:true` route touches five contracts:** `pipeline-routes.ts`, `contract/backend-routes.ts`, the contract mock, `dev-tool/coverage.json`, `dev-tool/verify-registry.ts` (`reference_pipeline_route_contract_ripple`).
- **TDD:** failing test first, always. **Frequent commits** (Conventional Commits, one per task).
- **Design-system-first:** no ad-hoc UI; every reusable component in `@mythrun/ui` + a Storybook story; props from `client-core/contract`.
- **Responsive:** desktop AND ~375px, by construction.
- Test conventions: read `backend/src/__tests__/CONVENTIONS.md` + `frontend`'s equivalents before authoring tests.

---

## Phase A — Backend: starting level

### Task A1: Migration 033 (starting_level + confirmed_at)

**Files:**
- Create: `backend/migrations/033_starting_level.sql`
- Modify: `backend/src/db/__tests__/migrate-schema.test.ts` (filename list + `EXPECTED_CHECK_CONSTRAINTS` + column pins)

**Interfaces:**
- Produces: `campaigns.starting_level SMALLINT NULL` (`IS NULL OR BETWEEN 1 AND 5`); `character_concepts.confirmed_at TIMESTAMPTZ NULL`.

- [ ] **Step 1 — failing test:** add `033_starting_level.sql` to the pinned filename list and the two new constraint/column expectations in `migrate-schema.test.ts`; run the schema test → FAIL (file missing / constraint absent).
- [ ] **Step 2 — write the migration:**
```sql
-- backend/migrations/033_starting_level.sql
-- MYT-90: party-wide starting level (1–5) + persisted character confirmation.
ALTER TABLE campaigns
  ADD COLUMN starting_level SMALLINT
  CHECK (starting_level IS NULL OR starting_level BETWEEN 1 AND 5);

ALTER TABLE character_concepts
  ADD COLUMN confirmed_at TIMESTAMPTZ;
```
- [ ] **Step 3 — run** `pnpm --filter mythrun-backend test migrate-schema` → PASS. Apply to dev DB (`pnpm db:migrate`).
- [ ] **Step 4 — commit** `feat(MYT-90): migration 033 — campaigns.starting_level + character_concepts.confirmed_at`.

### Task A2: Repo read extension (`getWorldAndSituationIndex` → `starting_level`)

**Files:**
- Modify: `backend/src/repo/campaigns.ts` (the `getWorldAndSituationIndex` read, ~:204-215)
- Test: `backend/src/repo/__tests__/campaigns.test.ts`

**Interfaces:**
- Produces: the read returns `{ world_id, starting_situation_index, starting_level }` (add the column to the SELECT + return type).

- [ ] **Step 1 — failing test:** seed a campaign with `starting_level = 3`; assert the read returns `starting_level: 3`. Run → FAIL.
- [ ] **Step 2 — add `starting_level` to the SELECT + the return type.**
- [ ] **Step 3 — run the repo test → PASS.**
- [ ] **Step 4 — commit** `feat(MYT-90): getWorldAndSituationIndex returns starting_level`.

### Task A3: `POST /starting-level` route + submit gate + 5-contract ripple

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts` (new route after `/starting-situation`; add `starting_level_not_chosen` to the `/characters` guard chain; surface `startingLevel` on `GET /starting-situations`)
- Modify: `backend/src/repo/campaigns.ts` (a `setStartingLevel(campaignId, level)` writer)
- Modify: `backend/src/contract/pipeline-routes.ts`, `backend/src/contract/backend-routes.ts`, the contract mock, `backend/dev-tool/coverage.json`, `backend/dev-tool/verify-registry.ts`
- Test: `backend/src/routes/__tests__/campaign-characters.test.ts`, `backend/src/contract/__tests__/*` (drift tests)

**Interfaces:**
- Consumes: `getWorldAndSituationIndex` (A2), `countLocked` (existing).
- Produces: `POST /api/campaigns/:campaignId/starting-level` `{ level: 1..5 }` → 204; 409 `world_not_complete` | `level_locked`; 403 non-owner. `GET /starting-situations` response gains `startingLevel: number | null`.

- [ ] **Step 1 — failing tests:** (a) owner sets level 3 → 204 + column written; (b) non-owner → 403; (c) world not complete → 409 `world_not_complete`; (d) a `processing` concept present → 409 `level_locked`; (e) `POST /characters` with `starting_level` null → 409 `starting_level_not_chosen`; (f) `GET /starting-situations` includes `startingLevel`. Run → FAIL.
- [ ] **Step 2 — implement** the route (mirror `/starting-situation`: `config: { pipelineRoute: true }`, `requireCampaignMember('owner')`, world-complete check, `countLocked > 0 → level_locked`, `setStartingLevel`), the submit-gate branch, and the GET field. Add the five contract entries (boot enforces `pipeline-routes.ts`; the drift test enforces `backend-routes.ts`).
- [ ] **Step 3 — run** the route tests + `app-pipeline-contract.test.ts` + `backend-routes.test.ts` + `pnpm --filter @mythrun/dev-tool typecheck` → all PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): starting-level route + submit gate + contract ripple`.

### Task A4: Deterministic level injection (concept + sheet)

**Files:**
- Modify: `backend/src/llm/prep/character-creation-processor.ts` (override `conceptOutput.level = campaign.starting_level` before `setConceptOutput`; load `starting_level` into the processor context)
- Modify: `backend/src/llm/prompts/prep/character-concept.txt` (remove the pinned `- level: 1.`)
- Modify: `backend/src/llm/prompts/prep/character-sheet.txt` (add `{{level}}`; replace the ≥5 level-1 hardcodes with level-parametric guidance incl. caster onset)
- Modify: `backend/src/llm/prep/stages/character-sheet.ts` (thread `{{level}}` through `renderPrompt`)
- Test: `backend/src/llm/prep/__tests__/character-creation-processor.test.ts`, `stages/__tests__/character-sheet.test.ts`

**Interfaces:**
- Consumes: `campaign.starting_level` (A2).
- Produces: for a party level N, the persisted `character.level === N`, `spellSlotsFor(progression, N)` slot rows, and `validateCoherence(sheet, N)` all keyed on N.

- [ ] **Step 1 — failing test:** with `campaign.starting_level = 5`, drive the processor with a mocked concept whose `level` is (wrongly) 1; assert the persisted character `level === 5` and the sheet stage received level 5 in its prompt render. Run → FAIL.
- [ ] **Step 2 — implement** the processor override + prompt `{{level}}` threading + the sheet-prompt level-parametric rewrite (proficiency by level; HP by level; features through N; subclass features when `subclassLevel[class] ≤ N`; ASI at 4; caster onset — half-casters no slots at L1, third-casters none <L3).
- [ ] **Step 3 — run** the processor + sheet-stage tests → PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): inject party starting level into concept + sheet stages`.

### Task A5: Strengthen `validateCoherence`

**Files:**
- Modify: `backend/src/llm/prep/stages/character-sheet.ts` (`validateCoherence`)
- Test: `backend/src/llm/prep/stages/__tests__/character-sheet.test.ts`

**Interfaces:**
- Produces: `validateCoherence(sheet, level)` additionally throws on proficiency-bonus mismatch and out-of-band HP. **Does NOT** check ASI/feat presence (documented as prompt-only).

- [ ] **Step 1 — failing tests:** (a) level-5 sheet with `proficiency_bonus: 2` → throws; (b) level-1 sheet with 40 HP → throws (over-band); (c) level-5 fighter with 9 HP → throws (under-band); (d) a valid level-5 sheet passes; (e) a Hill-Dwarf-slack case at the band edge passes. Run → FAIL.
- [ ] **Step 2 — implement:**
```ts
// proficiency bonus by level (1–4 → 2, 5 → 3)
const expectedPb = level <= 4 ? 2 : 3
if (sheet.proficiency_bonus !== expectedPb) {
  throw new LlmSemanticError(
    `character-sheet: proficiency_bonus ${sheet.proficiency_bonus} != ${expectedPb} for level ${level}`,
  )
}
// HP band from structured fields (hit_die, CON mod, level) + per-level slack for racial HP (e.g. Hill Dwarf +1/level)
const conMod = Math.floor((sheet.con - 10) / 2)
const SLACK_PER_LEVEL = 1
const hpFloor = sheet.hit_die + conMod + (level - 1) * Math.max(1, 1 + conMod)
const hpCeil = level * (sheet.hit_die + conMod) + level * SLACK_PER_LEVEL
if (sheet.max_hit_points < hpFloor || sheet.max_hit_points > hpCeil) {
  throw new LlmSemanticError(
    `character-sheet: max_hit_points ${sheet.max_hit_points} outside [${hpFloor}, ${hpCeil}] for L${level}`,
  )
}
```
- [ ] **Step 3 — add a code comment** stating ASI/feat/subclass-feature presence is prompt-guarded, not validated (ZFC — no prose matching, no baseline to diff). Run tests → PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): validateCoherence — proficiency + HP-band checks (level-scaled)`.

### Task A6: Situation `invitation` field + register block

**Files:**
- Modify: `backend/src/llm/schemas/*starting-situation*` (add `invitation: z.string().min(...)`, no max)
- Modify: `backend/src/llm/prep/stages/starting-situation.ts` (thread `invitation` into the per-hook output + JSONB write)
- Modify: `backend/src/llm/prompts/prep/starting-situation.txt` (add the 2nd-person invitation with a NOT/YES register block, like `world-introduction.txt`)
- Modify: `frontend/client-core/src/api/campaigns.ts` (`StartingSituationSchema.invitation` **optional** + a fallback in the mapper)
- Test: `backend/src/llm/prep/stages/__tests__/starting-situation.test.ts`

**Interfaces:**
- Produces: each situation carries `invitation: string`; the read schema tolerates its absence for pre-MYT-90 worlds.

- [ ] **Step 1 — failing test:** mock the LLM to return three hooks each with an `invitation`; assert the stage persists `invitation` in the JSONB and the response surfaces it; separately, a fixture lacking `invitation` still parses (optional). Run → FAIL.
- [ ] **Step 2 — implement** the schema field, the prompt register block (encode the grounded-not-gesturing contrast verbatim, as in world-introduction), the JSONB write, and the optional-with-fallback client schema.
- [ ] **Step 3 — run** the stage test → PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): situation invitation whisper (grounding prompt)`.

### Task A7: Concept reset + confirm routes

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts` (two self-scoped routes)
- Modify: `backend/src/repo/character-concepts.ts` (a `resetConcept(campaignId, userId)` + `confirmConcept(campaignId, userId)` writer)
- Modify: the five contracts (both are `pipelineRoute`-style member routes — mirror `/characters`)
- Test: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Interfaces:**
- Produces: `POST /api/campaigns/:campaignId/characters/reset` → 204 (flips the caller's own `completed`/`failed` concept back to resubmittable, clears the character row); 409 `not_resettable` if `integrated`/campaign `active`. `POST …/characters/confirm` → 204 (sets `confirmed_at`); idempotent.

- [ ] **Step 1 — failing tests:** (a) reset a `completed` concept → 204 + status resubmittable + character row cleared; (b) reset after `integrated` → 409 `not_resettable`; (c) confirm a `completed` concept → 204 + `confirmed_at` set; (d) confirm is idempotent. Run → FAIL.
- [ ] **Step 2 — implement** the repo writers (transactional) + the two routes (self-scoped `requireCampaignMember` any-member; the reset respects the same locks as submit) + contract entries.
- [ ] **Step 3 — run** route + contract drift tests → PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): concept reset (Start over) + confirm (confirmed_at) routes`.

### Task A8: Per-user completion signal on the status stream

**Files:**
- Modify: `backend/src/llm/prep/character-creation-processor.ts` (emit a properly-typed completion event carrying `userId`)
- Modify: `backend/src/contract/pipeline-events.ts` (add the event to the union / `PipelinePhase`, `userId`-bearing)
- Test: `backend/src/llm/prep/__tests__/character-creation-processor.test.ts`, `backend/src/contract/__tests__/pipeline-events.test.ts`

**Interfaces:**
- Produces: on concept completion, a status-stream event `{ type: 'character_creation_complete', userId }` (typed in the contract) that the FE `useCharacterCreationStream` filters by `user_id`.

- [ ] **Step 1 — failing test:** drive the processor to completion; assert it publishes a `character_creation_complete` event carrying the concept's `userId`, and that the contract validator accepts it. Run → FAIL.
- [ ] **Step 2 — implement** the typed event + emit. (Registration ripple: `TOOL_TO_KIND`/codec if applicable — `reference_ft_tool_needs_codec_registration` analog for pipeline events.)
- [ ] **Step 3 — run** tests → PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): typed per-user character-creation completion event`.

### Task A9: Constructed-state real-LLM smokes

**Files:**
- Create: `backend/scripts/smoke/myt-90-character-smoke.ts` (level-1 + level-5 character end-to-end; invitation prose)
- (Follows the `myt-zaqxh-intro-smoke.ts` pattern.)

**Interfaces:** asserts a *valid at that level* sheet (proficiency, HP band, spell-level cap) for L1 and L5, and that a generated `invitation` reads in-register + names the situation hook. **Comment: asserts validity, not level-appropriateness.**

- [ ] **Step 1 — write the smoke** seeding a `complete` world + `starting_level`, submitting a concept, running the real pipeline, asserting the persisted sheet passes `validateCoherence` at L1 and L5, and printing the sheet + invitation for eyeball.
- [ ] **Step 2 — run** against real Anthropic + dev PG; capture output. If L5 generation is unreliable, **surface it** (root-cause-first; do not silently cap).
- [ ] **Step 3 — commit** `test(MYT-90): constructed-state real-LLM smoke (L1/L5 + invitation)`.

---

## Phase B — client-core (contracts, API layer, view-models, SRD)

### Task B1: SRD catalog + subclass-at-level table

**Files:**
- Create: `frontend/client-core/src/srd/{classes,species,backgrounds}.ts`, `frontend/client-core/src/srd/subclass-level.ts`, `frontend/client-core/src/srd/index.ts`
- Modify: `frontend/client-core/package.json` (add `"./srd"` subpath export)
- Test: `frontend/client-core/src/srd/__tests__/subclass-level.test.ts`

**Interfaces:**
- Produces: `CLASSES: readonly ClassName[]` (12), `SPECIES`, `BACKGROUNDS` (canonical English names); `SUBCLASS_LEVEL: Record<ClassName, 1|2|3>`; `subclassOfferedAt(className, level): boolean`.

- [ ] **Step 1 — failing test:** assert `SUBCLASS_LEVEL` = `{cleric:1, sorcerer:1, warlock:1, druid:2, wizard:2, barbarian:3, bard:3, fighter:3, monk:3, paladin:3, ranger:3, rogue:3}` and `subclassOfferedAt('druid', 2) === true`, `subclassOfferedAt('fighter', 2) === false`, across all 12 × levels 1–5. Run → FAIL.
- [ ] **Step 2 — port** the name lists from the prototype JSON; author the explicit `SUBCLASS_LEVEL` constant + helper; wire the subpath export.
- [ ] **Step 3 — run** the 12×5 test → PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): SRD catalog + subclass-at-level table (client-core)`.

### Task B2: client-core character API slices + contracts

**Files:**
- Create: `frontend/client-core/src/api/characters.ts` (submit, get-characters, progress, finalize, reset, confirm), `frontend/client-core/src/api/starting-level.ts` (get via situations / set)
- Modify: `frontend/client-core/src/api/campaigns.ts` (situations response `startingLevel` + situation `invitation`), `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/api/__tests__/characters.test.tsx`

**Interfaces:**
- Produces: `submitCharacter({campaignId, conceptText, situationGroundingText})`, `getCharacterCreationProgress(campaignId)`, `finalizeCharacterCreation(campaignId)`, `resetCharacterConcept(campaignId)`, `confirmCharacter(campaignId)`, `setStartingLevel({campaignId, level})` — each `defineEndpoint` with a Zod response schema.

- [ ] **Step 1 — failing tests:** each slice sends the right method/path/body and parses the response shape; the submit slice sends **both** `conceptText` and `situationGroundingText`. Run → FAIL.
- [ ] **Step 2 — implement** the slices + schemas + barrel exports (mirror `chooseStartingSituation`).
- [ ] **Step 3 — run** → PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): client-core character API layer`.

### Task B3: Prop-contract files

**Files:**
- Create: `frontend/client-core/src/contract/character/*.ts` (one per `@mythrun/ui` component: `LevelCardProps`, `FreeformPromptProps`, `GuidedBuilderProps`, `CharacterLoadingBeatProps`, `CharacterSheetRevealProps`, `PartyRosterProps`)
- Modify: `frontend/client-core/src/contract/index.ts` (re-export)
- Test: type-only (tsc); a barrel test asserting exports.

**Interfaces:** DOM-free prop types. `GuidedBuilderProps` is **controlled** — `{ step, priorChoices, options, onSelect, onBack }`, no internal flow state.

- [ ] **Step 1** — author the prop types (see each U-task's Consumes block for exact fields) + re-exports.
- [ ] **Step 2** — `pnpm --filter @mythrun/client-core typecheck` → PASS; barrel test → PASS.
- [ ] **Step 3 — commit** `feat(MYT-90): client-core prop contracts for character components`.

### Task B4: View-models (`client-core/src/character/`)

**Files:**
- Create: `frontend/client-core/src/character/create-machine.ts`, `guided-reducer.ts` (+ `flatten.ts`), `sheet-view-model.ts`, `party-roster-view-model.ts`
- Test: co-located `__tests__/`

**Interfaces:**
- Produces: `guidedReducer(state, action)` + `flattenToConceptText(choices): string` (canonical English, e.g. `"I am a Fighter, a Champion. I come from a Human background as a Toll-clerk. …notes"`); `createMachine` transitions (chooser→A/B→submit→progress→reveal→confirm/reset); `sheetViewModel(sheet): { curated, full }`; `partyRosterViewModel(progress, viewerRole)`.

- [ ] **Step 1 — failing tests:** `flattenToConceptText` composes the exact English string from choices and **omits the subclass clause when `subclassOfferedAt` is false**; the guided reducer advances/back/skips-subclass correctly; the create machine transitions; the roster view-model marks the viewer + owner-finalize eligibility. Run → FAIL.
- [ ] **Step 2 — implement.**
- [ ] **Step 3 — run** → PASS (100×4 scoped).
- [ ] **Step 4 — commit** `feat(MYT-90): character creation view-models + flatten`.

### Task B5: `useCharacterCreationStream`

**Files:**
- Create: `frontend/client-core/src/character/use-character-creation-stream.ts`
- Test: co-located.

**Interfaces:**
- Consumes: the status SSE (`sse-status-client`), the A8 `character_creation_complete` event.
- Produces: `useCharacterCreationStream(campaignId, userId) → { beats, done }` — filters campaign-wide events to `userId`, maps stages → loading beats (name → class/subclass → ability scores → equipment), sets `done` on the completion event.

- [ ] **Step 1 — failing test:** feed a scripted event stream (mixed users); assert only the viewer's events produce beats and `done` flips on the viewer's completion event, ignoring other users'. Run → FAIL.
- [ ] **Step 2 — implement** (mirror `use-worldgen-stream.ts`).
- [ ] **Step 3 — run** → PASS.
- [ ] **Step 4 — commit** `feat(MYT-90): per-user character-creation SSE hook`.

---

## Phase C — @mythrun/ui components

> Each U-task: prop-contract already in `client-core/contract` (B3). Component is presentational, imports props from `@mythrun/client-core/contract`, ships a Storybook story + tests, square register, responsive. **Decide primitive-vs-composition:** `SituationCard`/`PathChooser` may be web-route compositions of existing primitives (`GhostHookList`, DS `Card`) — build as DS components only if reused; otherwise compose in-route (note the call in the task).

### Task C1: `LevelCard`
- Files: `frontend/ui/src/components/LevelCard/{LevelCard.tsx,.stories.tsx,.test.tsx}` + `ui/src/index.ts`.
- Props (`LevelCardProps`): `{ level: 1|2|3|4|5, grantGloss: string, selected: boolean, onSelect: () => void }`.
- Steps: failing render/interaction test → implement (5 stacked/across per mockup `level-select.html`) → story (all 5 + selected) → PASS → commit `feat(MYT-90): LevelCard`.

### Task C2: `FreeformPrompt`
- Files: `.../FreeformPrompt/*` + index.
- Props: `{ prompt: string, whisper: string, value: string, onChange, onSubmit, placeholder }`.
- Steps: TDD → implement (single calm textarea per `path-chooser-freeform.html`) → story → commit `feat(MYT-90): FreeformPrompt`.

### Task C3: `GuidedBuilder` (presentational)
- Files: `.../GuidedBuilder/*` + index.
- Props (`GuidedBuilderProps`, controlled): `{ step, rail, question, options, selectedId, onSelect, onNext, onBack, onSkipToFreeform }`.
- Steps: TDD (renders current step's options; fires `onSelect`/`onNext`/`onBack`; no internal step state) → implement (class grid + rail per `guided-builder.html`) → stories (class step, mid-sequence, single-subclass confirm) → commit `feat(MYT-90): GuidedBuilder (presentational)`.

### Task C4: `CharacterLoadingBeat`
- Files: `.../CharacterLoadingBeat/*` + index (reuse `Dither`).
- Props: `{ beats: LoadingBeat[], reducedMotion: boolean }`.
- Steps: TDD → implement (1-bit fill-in figure + surfacing rows per `meet-character.html` top) → story → commit `feat(MYT-90): CharacterLoadingBeat`.

### Task C5: `CharacterSheetReveal` (+ full-sheet expand)
- Files: `.../CharacterSheetReveal/*` + index.
- Props (`CharacterSheetRevealProps`): `{ curated, full, expanded: boolean, onToggleExpand, onConfirm, onStartOver }`.
- Steps: TDD (field-guide layout; ability tiles; spells panel only when caster; expand toggles full without an LLM call; the three actions fire) → implement per `meet-character.html` → stories (martial, caster, expanded, 375px) → commit `feat(MYT-90): CharacterSheetReveal`.

### Task C6: `PartyRoster`
- Files: `.../PartyRoster/*` + index.
- Props: `{ members: RosterMember[], viewerIsOwner: boolean, canBegin: boolean, onBegin, onInvite }`.
- Steps: TDD (solo vs party; owner-only Begin; laggard "creating…" rows) → implement per `party-finalize.html` → stories (solo, party-with-laggard, member view) → commit `feat(MYT-90): PartyRoster`.

---

## Phase D — web wiring + routing

### Task D1: Modify situation-pick (owner-gate + card register + invitation + nav)
- Files: Modify `frontend/src/routes/worldgen/situation-pick.tsx`; web i18n keys.
- Steps: TDD (owner sees the pick; member sees a hold; post-pick navigates to level-pick; `invitation` surfaced) → implement (add owner gate via `creator`, switch to `SituationCard`/cards, rewire nav) → screen story → commit `feat(MYT-90): situation-pick — owner gate + level-pick handoff`.

### Task D2: Level-pick route
- Files: Create `frontend/src/routes/campaign/level-pick.tsx`; `router.tsx` entry; i18n.
- Steps: TDD (5 `LevelCard`s; owner-only; POST `setStartingLevel`; nav to create) → implement → screen story → commit `feat(MYT-90): level-pick route`.

### Task D3: Path chooser + freeform route
- Files: Create `frontend/src/routes/campaign/character-create.tsx` (fills `character/new`); i18n.
- Steps: TDD (chooser → A/B; freeform collects conceptText **and** the invitation-answer → `situationGroundingText`; submits the two-field body) → implement → screen story → commit `feat(MYT-90): character-create — chooser + freeform`.

### Task D4: Guided builder wiring
- Files: Modify `character-create.tsx` (guided branch); use `guidedReducer` + `flattenToConceptText`.
- Steps: TDD (guided choices flatten to conceptText; subclass step skipped per `subclassOfferedAt`; the invitation-answer still collected) → implement → story → commit `feat(MYT-90): guided builder wiring`.

### Task D5: Loading beat wiring
- Files: Modify `character-create.tsx` (processing state) using `useCharacterCreationStream`.
- Steps: TDD (beats render from the viewer's stream; swap to reveal on `done`) → implement → commit `feat(MYT-90): loading beat wiring`.

### Task D6: Reveal + confirm/reset wiring
- Files: Modify the `CampaignPage` character surface to mount `CharacterSheetReveal`; wire `confirmCharacter` / `resetCharacterConcept`.
- Steps: TDD (This-is-me sets confirmed → staging; Start over resets → create; See-full-sheet expands, no network) → implement → commit `feat(MYT-90): sheet reveal + confirm/reset`.

### Task D7: Party staging + finalize
- Files: Modify `CampaignPage` (party surface) mounting `PartyRoster`; wire `finalizeCharacterCreation` + the weave beat.
- Steps: TDD (solo Begin; owner-only party Begin enabled when owner concept completed; finalize → weave → active) → implement → commit `feat(MYT-90): party staging + finalize`.

### Task D8: Routing table + failure surface (CampaignPage)
- Files: Modify `frontend/src/routes/campaign-page.tsx` (the §3.3 table: route on `campaign.status` + per-user concept status + `creator` role; failed/integration-failure → character-context retry, NOT the world-gen `TerminalView`; integrating → weave beat; member hold).
- Steps: TDD (each row of the §3.3 table renders the right screen; a failed concept shows retry not terminal; a member before setup sees the hold; reload with `confirmed_at` stays on staging) → implement → screen stories per state → commit `feat(MYT-90): character-creation routing table + failure surface`.

### Task D9: Member-join variant summary
- Files: Create `frontend/src/routes/campaign/join-summary.tsx` (world-intro summary → create entry); wire the MYT-91 handoff point (a plain route MYT-91 navigates into).
- Steps: TDD (renders the world-intro summary; situation+level already set; flows into create) → implement → story → commit `feat(MYT-90): member-join world-intro summary`.

---

## Phase E — verification

### Task E1: Merged battery + dev-tool verifier + smoke + audit
- [ ] Backend full suite + global coverage; contract drift; all frontend batteries; storybook browser sweep (new screens).
- [ ] `pnpm --filter @mythrun/dev-tool typecheck`; dispatch the **dev-tool verifier** (manifests changed in A3/A7 — marker required).
- [ ] Run the A9 real-LLM smoke; walk the create→sheet→confirm→finalize flow on the live stack (curl + SSE + DB).
- [ ] **Miklos visual audit** of the built screens (desktop + 375px) before push.
- [ ] Wiki sync subagent; then the single push.

---

## Self-review

**Spec coverage:** §4.1 → A1–A5; §4.2 → A6; §4.3 → A3 (ripple); §4.4 → A7 (reset/confirm) + A8 (completion signal); §5.1 → B1; §5.2 → D1–D9; §5.3 → B2/B4/B5; §5.4 → B3 + C1–C6; §5.5 → D1–D8; §6 → E1 + per-task TDD + A9; §7 laggard follow-up → filed as a bead, not built; §8 client/backend table agreement → B1 test + A4 prompt. ✅ all sections mapped.

**Placeholder scan:** each task names exact files, interfaces, and test intent; load-bearing code (migration, validateCoherence, flatten, subclass table, HP band) is inline. UI/wiring tasks carry props + test intent + the mockup reference. No "TBD".

**Type consistency:** `starting_level`, `confirmed_at`, `submitCharacter`, `flattenToConceptText`, `subclassOfferedAt`, `SUBCLASS_LEVEL`, `useCharacterCreationStream`, `character_creation_complete` used consistently across tasks; prop-contract names (B3) match the C-task Props blocks.

**Laggard follow-up:** filed as a bead (§7), not a task — correct (entangled with MYT-91).
