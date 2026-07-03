# MYT-89 — Campaign Creation + World-Gen Experience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the end-to-end create flow — fork → freeform/guided → synthesize-preview + one-rework → returnable world-gen graph → world reveal (wiki) → starting-situation pick → campaign-page hand-off.

**Architecture:** Two new thin backend endpoints (`synthesize-preview`, `rework`) split today's atomic guided-create so the concept is gated and previewed before the credit-charged world-gen commit; a Redis preview store holds the gated concept. The frontend is the borderless `SeamlessInput` register for create, a `d3-force`-on-Canvas force-directed graph for world-gen (physics-only dep, rendered ourselves — no Three.js, no SVG-node explosion), and a browsable `known`-tier `WorldWiki` for the reveal. All flat 1-bit paper register.

**Tech Stack:** Fastify + TypeScript + Zod + Redis (backend); React + Vite + `@mythrun/ui` + `@mythrun/client-core` + `@mythrun/contract` + `d3-force` + Canvas 2D + i18next (frontend); Vitest + Storybook.

**Source spec:** `docs/superpowers/specs/2026-07-03-myt-89-campaign-creation-flow-design.md` — read it before implementing any task. Task references like "(spec §5)" point there.

## Global Constraints

Every task implicitly includes these. Copied from the spec:

- **Flat 1-bit paper register.** No 3D, no glow, no shadows (depth via borders/rules). Square, no circles, no status dots/badges/chips.
- **Borderless register through create + reveal.** `SeamlessInput` for fields; ghost buttons split by `Divider` rules for the fork; text-forward actions.
- **All UI composes `@mythrun/ui` + a Storybook story.** No ad-hoc UI. New reusable pieces become first-class components with stories.
- **All prose is an i18n key**; prose placeholders are the literal string `[ph: <purpose>]`. Only generic chrome gets real values.
- **Responsive by construction** — every surface works at ~375px AND desktop; `min-h-dvh`, `flex min-w-0`.
- **All backend access through `@mythrun/client-core`** (R5); **all wire types in `@mythrun/contract`.** Strict TS, no `any`, no non-null assertions unless unavoidable. Functions < 50 lines, modules < 400 lines. UUIDv7 for ids. Conventional Commits.
- **Enforced ignorance is server-side only.** The reveal wiki is `known`-tier (owner is a seated player, not a GM — decided). No tier filtering ever happens client-side; secret/discoverable data must not reach the browser.
- **Cross-phase dependencies:** B, C, D all depend on Phase A's contract + client-core. D's graph↔wiki shared selection depends on C.

## File Structure

### Phase A — Backend + contract + client-core
- `backend/src/llm/prep/revise-concept.ts` (NEW) — `reviseConcept(priorConcept, changeNote) → SynthesizerOutput` (the rework LLM primitive).
- `backend/src/llm/prompts/prep/revise-concept.txt` (NEW) — the revise prompt template.
- `backend/src/preview/preview-store.ts` (NEW) — Redis-backed preview store (`put`/`get`/`markReworked`, `${userId}:${previewId}` keying, TTL, `reworkCount`).
- `backend/src/routes/campaign-preview.ts` (NEW) — the `synthesize-preview` + `rework` route handlers (a focused module; keeps `campaigns.ts` from growing past 400 lines).
- `backend/src/routes/campaigns.ts` (MODIFY) — widen the guided create arm to `{mode:'guided', previewId}`; load the gated concept from the preview store.
- `backend/src/contract/backend-routes.ts` (MODIFY) — register both new routes.
- `backend/dev-tool/src/components/campaign-create-panel.ts` (MODIFY) — migrate the guided create off the removed `picks` arm (preview-then-commit).
- `frontend/contract/src/rest/campaign-create.ts` (NEW) — `SynthesizePreviewRequest/Response`, `ReworkRequest/Response`, `ConceptRejection`, widened `CreateCampaignRequest`.
- `frontend/client-core/src/api/campaign-create.ts` (NEW) — `synthesizePreview`, `reworkPreview`, `createCampaign` (+ hooks).

### Phase B — Create UI
- `frontend/ui/src/components/GhostChoiceList/{GhostChoiceList.tsx,GhostChoiceList.stories.tsx,index.ts}` (NEW).
- `frontend/src/routes/campaign-new.tsx` (MODIFY — the flow controller) + `frontend/src/routes/campaign-new/{fork,freeform,guided,preview,rejection}.tsx` (NEW — the screens).
- `frontend/src/routes/home/campaign-hub.tsx` or wherever `CampaignHubBody` lives (MODIFY — the populated-hub "New Campaign" CTA).
- i18n keys in `frontend/client-core/src/i18n/locales/en/common.json`.

### Phase C — World-gen graph
- `frontend/client-core/src/worldgen/graph-reducers.ts` (NEW — reconciled `deriveInventory`/`derivePlaceholderBuffer`) + `graph-fold.ts` (the per-event fold + rehydrate merge).
- `frontend/ui/src/components/WorldGenGraph/{WorldGenGraph.tsx,force-sim.ts,ghost-bloom.ts,entity-list.tsx,WorldGenGraph.stories.tsx,index.ts}` (NEW).
- `frontend/src/routes/campaign-detail.tsx` (MODIFY — phase-aware: render the graph while generating).
- `frontend/src/routes/worldgen/use-worldgen-stream.ts` (NEW — SSE wiring + rehydration).

### Phase D — Reveal + wiki + situation
- `frontend/client-core/src/worldgen/wiki-view-model.ts` (NEW — normalized view model + server-side data source).
- `frontend/ui/src/components/WorldWiki/{WorldWiki.tsx,WorldWiki.stories.tsx,index.ts}` (NEW).
- `frontend/src/routes/worldgen/reveal.tsx` (NEW — the exploration state, graph↔wiki shared selection, Continue).
- `frontend/src/routes/worldgen/situation-pick.tsx` (NEW — the 3-hook ghost pick).
- `frontend/src/routes/campaign-detail.tsx` (MODIFY — the active-campaign landing with stubbed MYT-90/91 seams).

---

# PHASE A — Backend + contract + client-core

Core infra. No shortcuts. Each task is TDD; backend tests run against `mythrun_test` (`DATABASE_URL_TEST`). Read `backend/src/__tests__/CONVENTIONS.md` before authoring tests.

### Task A1: `reviseConcept` LLM primitive + prompt

**Files:**
- Create: `backend/src/llm/prompts/prep/revise-concept.txt`
- Create: `backend/src/llm/prep/revise-concept.ts`
- Test: `backend/src/llm/prep/__tests__/revise-concept.test.ts`

**Interfaces:**
- Consumes: the existing `SynthesizerOutput` Zod schema + `SynthesizerOutputSchema` from `backend/src/llm/prep/synthesize-concept.ts` (`{concept: string.min(50).max(4000), intentSummary: {aesthetics[1-8], themes[1-8], sourcesInternal[1-5]}}`), and the single Anthropic abstraction layer used by `synthesize-concept.ts` (mirror its `generateObject` call — same client, same model tier Sonnet, `temperature 0.9`).
- Produces: `reviseConcept(priorConcept: string, changeNote: string): Promise<SynthesizerOutput>` — the rework primitive Task A4 calls.

- [ ] **Step 1: Write the prompt template.** `revise-concept.txt` — instruct: given an existing original world CONCEPT and a player's CHANGE NOTE, produce a REVISED original concept that honors the note while keeping what worked; 150–400 words; NO proper nouns from any source media; output matches the concept schema. Mirror the structure/guardrails of `synthesize-concept.txt` (read it first).
- [ ] **Step 2: Write the failing test.** Mock the Anthropic layer (as `synthesize-concept.test.ts` does). Assert `reviseConcept('a drowned city…', 'less water, more forgetting')` calls the model with a prompt containing both the prior concept and the change note, and returns the parsed `SynthesizerOutput`. Add a second test: an over-length/invalid model output throws (schema validation), matching `synthesize-concept`'s failure behavior.
- [ ] **Step 3: Run test → FAIL** (`pnpm --filter @mythrun/backend test revise-concept`). Expected: `reviseConcept` not defined.
- [ ] **Step 4: Implement `revise-concept.ts`.** Load the template, interpolate `{priorConcept}`/`{changeNote}`, call the Anthropic abstraction (Sonnet, temp 0.9), validate against `SynthesizerOutputSchema`, return. < 50 lines. No inline prompt string — load the `.txt` (per LLM-prompts-as-templates rule).
- [ ] **Step 5: Run test → PASS.**
- [ ] **Step 6: Commit** `feat(MYT-89): reviseConcept rework primitive + prompt`.

### Task A2: Redis preview store

**Files:**
- Create: `backend/src/preview/preview-store.ts`
- Test: `backend/src/preview/__tests__/preview-store.test.ts`

**Interfaces:**
- Consumes: the app's Redis client accessor (find how other modules get Redis — e.g. `backend/src/redis/` or the Fastify decoration; match the existing pattern), `SynthesizerOutput` type, `uuidv7()` (the repo's id helper).
- Produces:
  - `type PreviewRecord = { concept: string; intentSummary: SynthesizerOutput['intentSummary']; reworkCount: number }`
  - `putPreview(redis, userId, record): Promise<string>` (mints a UUIDv7 `previewId`, stores under key `campaign-preview:${userId}:${previewId}` with a 30-min TTL, returns `previewId`)
  - `getPreview(redis, userId, previewId): Promise<PreviewRecord | null>` (null when absent/expired)
  - `overwritePreview(redis, userId, previewId, record): Promise<void>` (replaces value, resets TTL — used by rework on gate-pass; sets `reworkCount:1`)

- [ ] **Step 1: Write failing tests.** With a test Redis (match how other backend tests get Redis — `ioredis` against the test instance, or a mock if that's the convention): `putPreview` returns a UUIDv7 and a subsequent `getPreview(sameUser, id)` returns the record; `getPreview(otherUser, id)` returns `null` (cross-user isolation — the key embeds userId); `getPreview` after TTL/absent returns `null`; `overwritePreview` replaces the record + sets `reworkCount:1`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Key format `campaign-preview:${userId}:${previewId}`; JSON-serialize the record; `SET … EX 1800`. < 50 lines.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(MYT-89): Redis preview store (user-keyed, TTL, reworkCount)`.

### Task A3: `synthesize-preview` route

**Files:**
- Create: `backend/src/routes/campaign-preview.ts` (the route module — registered by `campaigns.ts` or `app.ts`; match how route modules are wired)
- Modify: `backend/src/contract/backend-routes.ts` (add `POST /api/campaigns/synthesize-preview`)
- Test: `backend/src/routes/__tests__/campaign-preview.test.ts`

**Interfaces:**
- Consumes: `synthesizeConcept` (`synthesize-concept.ts`), `runInputGate` (`input-gate.ts`), `handleGateRejection` (the existing `422 {code:'concept_rejected', reason, rejectionMessage, synthesizedConcept?}` emitter in `campaigns.ts` — extract/reuse it), the rejection-storm cooldown helper (`campaigns.ts`), `repo.credits.getWorldGenBalance` (the non-charging peek — find its exact name in the credits repo), `putPreview` (A2), the rate-limit registration pattern (5/min create family).
- Produces: `POST /api/campaigns/synthesize-preview`. Request body `{picks: SynthesizerPickSchema.length(3)}`. Success `201 {previewId, concept}`. Reject `422 ConceptRejection`. Guards, in order: rate-limit → storm cooldown → **credit peek (`403 insufficient_credits`, non-charging)** → synthesize → gate → store.

- [ ] **Step 1: Write failing integration tests** (mock the LLM layer + gate as `campaigns-create.test.ts` does). Cases: happy path → `201 {previewId, concept}` + a `getPreview` returns the stored record with `reworkCount:0`; a 0-credit user → `403 insufficient_credits` and **no LLM call made** (assert the synth mock was not called — this is the cost-control fix, spec §5); a gate-rejecting concept → `422` with `synthesizedConcept` present; storm-cooldown active → `429`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the handler + register the route.** Zod-validate the body; run the guards in the exact order above; on gate pass `putPreview` then `201`. Extract the shared `handleGateRejection` if it's still inline in `campaigns.ts` so both routes use it (DRY). Add to `backend-routes.ts` (NOT `pipeline-routes.ts`).
- [ ] **Step 4: Run → PASS** + run the `backend-routes` drift test.
- [ ] **Step 5: Commit** `feat(MYT-89): synthesize-preview route (gated, credit-peeked, uncharged)`.

### Task A4: `rework` route

**Files:**
- Modify: `backend/src/routes/campaign-preview.ts` (add the rework handler)
- Modify: `backend/src/contract/backend-routes.ts` (add `POST /api/campaigns/preview/:previewId/rework`)
- Test: `backend/src/routes/__tests__/campaign-preview.test.ts` (extend)

**Interfaces:**
- Consumes: `getPreview`/`overwritePreview` (A2), `reviseConcept` (A1), `runInputGate`, `handleGateRejection`.
- Produces: `POST /api/campaigns/preview/:previewId/rework`. Body `{change: string}` (min 1, max ~800). Success `200 {previewId, concept}`. `410 preview_expired` (absent), `409 rework_exhausted` (`reworkCount ≥ 1`), `422 ConceptRejection`.

- [ ] **Step 1: Write failing tests.** Load a stored preview (via A3 or a direct `putPreview`), then: rework on a fresh preview → `200` with a revised concept + `getPreview` shows `reworkCount:1` and the overwritten concept; a **gate-rejected** rework → `422` AND `getPreview` still shows the ORIGINAL concept with `reworkCount:0` (gate-pass-only mutation — spec §5 Tinker Bell-I3); a second rework → `409 rework_exhausted`; an unknown/expired `previewId` → `410 preview_expired`; a cross-user `previewId` → `410` (isolation).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Order: load by `(authUserId, previewId)` → `410` if null → `409` if `reworkCount ≥ 1` → `reviseConcept` → gate → **on pass** `overwritePreview` (sets `reworkCount:1`) + `200`; **on reject** return `422` WITHOUT overwriting or incrementing.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(MYT-89): rework route (single-shot, gate-pass-only mutation)`.

### Task A5: Widen the guided create arm

**Files:**
- Modify: `backend/src/routes/campaigns.ts` (the `CreateCampaignBodySchema` guided arm + the create handler)
- Modify: `backend/dev-tool/src/components/campaign-create-panel.ts` (migrate to preview-then-commit)
- Test: `backend/src/routes/__tests__/campaigns-create.test.ts` (migrate the 3 guided cases)

**Interfaces:**
- Consumes: `getPreview` (A2).
- Produces: the guided source arm is now `{mode:'guided', previewId: string}` (was `{mode:'guided', picks}`). Commit loads the gated concept by `(authUserId, previewId)`; `410 preview_expired` if absent; then runs the existing commit path unchanged (storm cooldown → concurrent-gen guard → credit peek → queue → debit → insert → world-gen job → storm-counter reset on success). No re-synth, no re-gate. Freeform arm unchanged.

- [ ] **Step 1: Migrate the 3 `campaigns-create.test.ts` guided cases** to preview-then-commit (call `synthesize-preview` first, use the returned `previewId`). Add a new case: an expired `previewId` on commit → `410 preview_expired`. Run → FAIL (schema still expects `picks`).
- [ ] **Step 2: Update `CreateCampaignBodySchema`** guided arm to `{mode:'guided', previewId: z.string()}`; in the handler, replace the inline synth+gate for guided with a `getPreview` load (`410` if null) that yields the concept; freeform path untouched. Confirm the freeform arm still synth-gates.
- [ ] **Step 3: Run → PASS.**
- [ ] **Step 4: Migrate the dev-tool guided create** (`campaign-create-panel.ts`): call `synthesize-preview` then commit with `previewId` (or, if simpler for the dev harness, leave its guided button on the freeform arm — but keep an E2E path that exercises preview→commit). Run `pnpm dev-tool:typecheck`.
- [ ] **Step 5: Commit** `feat(MYT-89): widen guided create arm to previewId; migrate dev-tool + tests`.

### Task A6: Contract types

**Files:**
- Create: `frontend/contract/src/rest/campaign-create.ts`
- Modify: `frontend/contract/src/rest/index.ts` (or the barrel) to export them
- Test: `frontend/contract/src/rest/__tests__/campaign-create.test.ts`

**Interfaces:**
- Produces (Zod schemas + inferred types): `SynthesizerPick {title, whyILikeIt}`, `SynthesizePreviewRequest {picks: [3]}`, `SynthesizePreviewResponse {previewId, concept}`, `ReworkRequest {change}`, `ReworkResponse {previewId, concept}`, `ConceptRejection {code:'concept_rejected', reason, rejectionMessage, synthesizedConcept?}`, `CreateCampaignRequest` (discriminated: freeform `{kind:'new', source:{mode:'freeform', concept}}` | guided `{kind:'new', source:{mode:'guided', previewId}}`), `CreateCampaignResponse {campaignId}`. Bounds copied verbatim from the backend Zod (concept 20–4000, title 1–200, whyILikeIt 1–800, change 1–800).

- [ ] **Step 1: Write a failing test** asserting each schema parses a valid payload and rejects an out-of-bounds one (e.g. a 19-char concept fails, a 4-pick guided fails).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the schemas.** Match the backend bounds exactly. Export types via `z.infer`.
- [ ] **Step 4: Run → PASS** + `pnpm --filter @mythrun/contract typecheck`.
- [ ] **Step 5: Commit** `feat(MYT-89): campaign-create contract types`.

### Task A7: client-core hooks

**Files:**
- Create: `frontend/client-core/src/api/campaign-create.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel exports)
- Test: `frontend/client-core/src/api/__tests__/campaign-create.test.tsx`

**Interfaces:**
- Consumes: the `defineEndpoint` pattern + `ApiContext` + `HttpError` (see `frontend/client-core/src/api/campaigns.ts` `getMyCampaigns` and `endpoint.ts`); the A6 contract types.
- Produces: `synthesizePreview(ctx, {picks})`, `reworkPreview(ctx, previewId, {change})`, `createCampaign(ctx, CreateCampaignRequest)` + their `useX` hook forms if the codebase uses hooks (mirror `useMyCampaigns`). Each maps the `ConceptRejection`/`rework_exhausted`/`preview_expired` codes onto `HttpError.body`/`.code` (no new plumbing — verified in the spec).

- [ ] **Step 1: Write failing tests** (MSW, as `campaigns.test.tsx` does): `synthesizePreview` posts `{picks}` and returns `{previewId, concept}`; a `422` surfaces as an `HttpError` with `.code==='concept_rejected'` and `.body.synthesizedConcept`; `reworkPreview` posts to the `:previewId` path; a `409` surfaces `.code==='rework_exhausted'`; `createCampaign` posts the discriminated body and returns `{campaignId}`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** via `defineEndpoint`. Barrel-export.
- [ ] **Step 4: Run → PASS** + `pnpm --filter @mythrun/client-core typecheck`.
- [ ] **Step 5: Commit** `feat(MYT-89): client-core campaign-create hooks`.

### Task A8: Real-LLM constructed-state smoke (Phase A gate)

**Files:**
- Create/extend: the smoke harness the project uses for real-LLM E2E (find the existing dev-tool/curl smoke pattern — spec §13 + the `dev_tool_e2e_smoke_required` convention).

**Interfaces:** none (a script/smoke).

- [ ] **Step 1:** Drive the real wire: `synthesize-preview {picks}` (real Sonnet) → assert `201 {previewId, concept}` + the concept is a plausible non-empty original; `rework {change}` → assert `200` revised concept differs + `reworkCount` now blocks a 2nd; `POST /api/campaigns {mode:'guided', previewId}` → assert `201 {campaignId}`, world-gen enqueued, credit debited, preview consumed. Assert the OBSERVABLE end state (DB `pipeline_runs` seeded, `worlds.status='generating'`, `credit_ledger` −1), not "200 OK".
- [ ] **Step 2:** Run it manually against real Anthropic + real PG/Redis/BullMQ; fix any real-behavior bug found (per the manual-smoke-not-optional rule). Document the run.
- [ ] **Step 3: Commit** `test(MYT-89): real-LLM preview→rework→commit smoke`.

---

# PHASE B — Create UI

Depends on Phase A (contract A6 + client-core A7). Borderless register throughout. Every new `@mythrun/ui` piece gets a Storybook story. Frontend tests via Vitest + Testing Library; heed [[reference_heavy_svg_render_ci_waitfor_timeout]] for multi-render tests. Read `SeamlessInput`, `Button`, `Divider` source (spec §Context) before building — match their exact props.

### Task B1: `GhostChoiceList` component

**Files:**
- Create: `frontend/ui/src/components/GhostChoiceList/GhostChoiceList.tsx`, `GhostChoiceList.stories.tsx`, `index.ts`
- Modify: `frontend/ui/src/index.ts` (barrel)
- Test: `frontend/ui/src/components/GhostChoiceList/GhostChoiceList.test.tsx`

**Interfaces:**
- Consumes: `Divider` (`tone="border"`), the design tokens (`surface-hover`, `ink`, `ink-tertiary`, `accent-fg`), the platform-neutral prop pattern (see any `@mythrun/ui` component's contract in `@mythrun/client-core/contract`).
- Produces: `GhostChoiceList` — renders `items: {id, title, subtitle, onSelect}[]` as ghost buttons (`bg-transparent text-ink hover:bg-surface-hover`, generous padding, an ember `→`, no box/mark) separated AND framed by `Divider` rules (rule above first, between each, below last). Each item is a real `<button>` (keyboard-activable). No `radius` (flat).

- [ ] **Step 1:** Failing test — renders 2 items as buttons, a rule between them, `onSelect(id)` fires on click AND on Enter (keyboard). Assert no `border` class on the buttons (ghost, not boxed).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per the spec §2 treatment; static token class strings (Tailwind v4 scans source). < 50 lines.
- [ ] **Step 4:** Run → PASS. Write the Storybook story (a 2-choice fork example). Run `pnpm --filter @mythrun/ui storybook:build` (or the story-coverage check) to confirm the story registers.
- [ ] **Step 5:** Commit `feat(MYT-89): GhostChoiceList component + story`.

### Task B2: Create-flow controller + fork screen

**Files:**
- Modify: `frontend/src/routes/campaign-new.tsx` (replace the stub with the flow controller — a small state machine over the screens)
- Create: `frontend/src/routes/campaign-new/fork.tsx`
- Test: `frontend/src/routes/campaign-new.test.tsx`

**Interfaces:**
- Consumes: `GhostChoiceList` (B1), the router.
- Produces: `CampaignNewRoute` renders a `screen` state machine (`fork | freeform | guided | preview | rejection`) with per-screen `back` history; the fork screen (eyebrow, serif question heading, lede, `GhostChoiceList` with the two paths → sets `screen`). Data-testid `route-campaign-new` preserved.

- [ ] **Step 1:** Failing test — at `/campaigns/new` the fork renders both choices (i18n `[ph:]` keys present); clicking "Start from an idea" advances to the freeform screen; clicking "Build from what you love" advances to guided step 1.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the controller + fork. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): create-flow controller + fork screen`.

### Task B3: Freeform screen

**Files:**
- Create: `frontend/src/routes/campaign-new/freeform.tsx`
- Test: extend `campaign-new.test.tsx`

**Interfaces:**
- Consumes: `SeamlessInput` (`multiline`), `Button` (or the text-forward Begin), `createCampaign` (A7).
- Produces: the freeform screen — a `SeamlessInput multiline` (question = label), Begin (disabled < 20 chars), a switch-to-guided line. Begin → `createCampaign({kind:'new', source:{mode:'freeform', concept}})` with a **loading state** on Begin; on `201` navigate to `/campaigns/:id` (the generating route, Phase C); on `422 concept_rejected`/`content_filtered` → the rejection screen (B5-shared); on `503` → a calm retry.

- [ ] **Step 1:** Failing tests (MSW): typing < 20 chars keeps Begin disabled; ≥ 20 enables it; Begin shows loading then navigates to `/campaigns/:newId` on `201`; a `422` routes to the rejection state showing `rejectionMessage`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): freeform create screen`.

### Task B4: Guided screens (three one-at-a-time)

**Files:**
- Create: `frontend/src/routes/campaign-new/guided.tsx`
- Test: extend `campaign-new.test.tsx`

**Interfaces:**
- Consumes: `SeamlessInput`, the faint 3-tick affordance (compose from `Box`/tokens — or a tiny local `StepTicks`), `synthesizePreview` (A7).
- Produces: the guided screen — internal step state 1→2→3, each a name `SeamlessInput` + a why `SeamlessInput multiline`, autofocus first field, `Next →`/`Find my world →`, a `← Back` on steps 2–3 (picks persist in component state), step-1 switch-to-freeform. "Find my world" → `synthesizePreview({picks})` → the finding beat → sets `screen='preview'` with the returned `{previewId, concept}`; the three-exit LLM-failure handling (success/`422`/`503`).

- [ ] **Step 1:** Failing tests: three steps advance with Next; Back on step 2 returns to step 1 with the pick preserved; "Find my world" posts all 3 picks and, on `201`, moves to preview with the concept; a `422` → rejection state; a `503` → retry.
- [ ] **Step 2–4:** FAIL → implement → PASS. Retain the picks in `sessionStorage` (spec §11 pre-commit-refresh) so a reload re-prefills.
- [ ] **Step 5:** Commit `feat(MYT-89): guided create (one-at-a-time, back-step, sessionStorage)`.

### Task B5: Preview beat + rejection screen

**Files:**
- Create: `frontend/src/routes/campaign-new/preview.tsx`, `frontend/src/routes/campaign-new/rejection.tsx`
- Test: extend `campaign-new.test.tsx`

**Interfaces:**
- Consumes: `SeamlessInput`, `reworkPreview` + `createCampaign` (A7), the previewId from B4.
- Produces:
  - PREVIEW: eyebrow, the concept prose (no name), **Begin** (commit `{mode:'guided', previewId}`), **Ask for one change**, **Start over** (→ back to guided picks). After a rework, `Begin` is the only action (change spent) + the "one change used" note.
  - Change flow: a `SeamlessInput multiline` → **Rework** → the reworking beat → `reworkPreview` → PREVIEW′ (revised concept, change spent); `409 rework_exhausted` shouldn't occur in-UI (we gate at one) but handle defensively.
  - Rejection screen (shared with freeform): shows `rejectionMessage`; guided variant also shows `synthesizedConcept` + "edit as freeform" (drops into freeform pre-filled) / "start over"; `content_filtered` → a distinct terminal message.
  - Commit `410 preview_expired` → restart guided (pre-fill from sessionStorage).

- [ ] **Step 1:** Failing tests: PREVIEW shows the concept + Begin + Ask-for-change + Start over; Begin → `createCampaign(previewId)` → navigate to `/campaigns/:id`; Ask-for-change → Rework → PREVIEW′ shows the revised concept and only Begin; Start over → guided step 1; a commit `410` → guided restart; the rejection screen renders `rejectionMessage` (+ `synthesizedConcept` for guided).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): preview beat (rework, start-over) + rejection states`.

### Task B6: "New Campaign" CTA on the populated hub

**Files:**
- Modify: the populated-hub component (`CampaignHubBody` — locate it under `frontend/src/routes/home/`)
- Test: extend the hub test

**Interfaces:**
- Consumes: the router (`navigate('/campaigns/new')`).
- Produces: a quiet ghost/rule "New Campaign" affordance in the populated hub (consistent with the register), routing to `/campaigns/new`. (MYT-87 only shipped it on the empty hub — spec §11.)

- [ ] **Step 1:** Failing test — the populated hub renders a `new-campaign` CTA that navigates to `/campaigns/new`. **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): New Campaign CTA on the populated hub`.

### Task B7: i18n keys

**Files:** Modify `frontend/client-core/src/i18n/locales/en/common.json`.

- [ ] Add all `campaignNew.*` keys referenced in B2–B6 as `[ph: <purpose>]` placeholders (fork copy, freeform prompt/hint, guided prompts, preview/rework/start-over labels, rejection messages, CTA). Only generic chrome (Begin/Next/Back) gets real values. Run the no-hardcoded-strings lint. Commit `feat(MYT-89): i18n keys for the create flow`.

---

# PHASE C — World-gen graph

Depends on Phase A (contract). The graph is the centrepiece. **The reducers are RECONCILED, not copied** — the dev-tool's are typed against a stale `data:{name}` shape; the live `PipelineEvent` is flat. Read spec §6 in full before starting.

### Task C1: Reconcile the graph reducers into client-core

**Files:**
- Create: `frontend/client-core/src/worldgen/graph-reducers.ts`
- Test: `frontend/client-core/src/worldgen/__tests__/graph-reducers.test.ts`

**Interfaces:**
- Consumes: `PipelineEvent` (from `@mythrun/contract/events` — the LIVE flat shape: `entity-added {synthKey, entityKind, name, placeholderId?}`, `edge-added {synthKey, from, to, relationship}`, `entity-updated {synthKey, patch}`, `entity-removed {synthKey, reason}`, `edge-removed`, `finalized {synthKey, entityId}`, `stage-reset {stage}`). Reference the dev-tool `deriveInventory`/`derivePlaceholderBuffer` LOGIC (`backend/dev-tool/src/components/live-events-panel.ts:238,348`) but NOT its types/fixtures.
- Produces: `type GraphNode = {synthKey, kind, name, displayId, state, lastEventIndex}`; `type GraphEdge = {synthKey, from, to, relationship}`; `deriveNodes(events: PipelineEvent[]): GraphNode[]` and `deriveEdges(events): GraphEdge[]` (with `new-NNN` placeholder reconciliation + `stage-reset` prefix-delete + `finalized` synthKey→entityId swap), typed against the live contract, reading `e.name`/`e.entityKind` directly (NOT `e.data.name`).

- [ ] **Step 1:** Write **fresh** failing tests using LIVE `PipelineEvent` fixtures (build them from the `@mythrun/contract` types — do NOT copy the dev-tool's `data:{}` fixtures). Cover: add → node with `name`/`kind`; `entity-updated` merge-patch; `entity-removed` drops it; a placeholder `edge-added` (`from:'new-3'`) buffered until the ghost `entity-added {placeholderId:'new-3'}` resolves it; `stage-reset` prefix-deletes that stage's synthKeys; `finalized` swaps the id.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement — lift the fold + placeholder-buffer logic, re-type against `PipelineEvent`, drop the `data` indirection. Keep each function < 50 lines (split helpers if needed).
- [ ] **Step 4:** Run → PASS + `pnpm --filter @mythrun/client-core typecheck`.
- [ ] **Step 5:** Commit `feat(MYT-89): reconcile graph reducers to the live PipelineEvent contract`.

### Task C2: Force simulation with node-identity preservation

**Files:**
- Create: `frontend/ui/src/components/WorldGenGraph/force-sim.ts`
- Test: `frontend/ui/src/components/WorldGenGraph/__tests__/force-sim.test.ts`

**Interfaces:**
- Consumes: `d3-force` (`pnpm add d3-force` + `@types/d3-force` — meets the dependency bar, spec §14), `GraphNode`/`GraphEdge` (C1).
- Produces: a `ForceSim` wrapper: `create(): ForceSim`; `sync(nodes: GraphNode[], edges: GraphEdge[])` — **MERGES** the incoming set into a persistent internal node array (survivors keep their `x/y/vx/vy`; only new `synthKey`s are seeded near center; removed ones drop out), then updates `forceLink`, and re-heats the sim (`alpha`) modestly; `tick(): void`; `positions(): Map<synthKey, {x,y}>`; `pin(synthKey, x, y)`/`unpin`. `forceManyBody` + `forceLink` + `forceCenter`. This is the node-identity fix (spec §6 Vidia-I2) — NEVER `simulation.nodes(freshArray)` per event.

- [ ] **Step 1:** Failing tests: `sync` twice with an overlapping node set preserves the first set's node object identities + positions (survivors don't teleport); a genuinely-new node appears seeded; a removed node is gone; a burst `sync` (add 20 at once) doesn't reset existing positions.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): force-sim with node-identity merge (d3-force)`.

### Task C3: Ghost-bloom ambient layer

**Files:** Create `frontend/ui/src/components/WorldGenGraph/ghost-bloom.ts` + test.

**Interfaces:**
- Produces: `GhostBloomField`: `spawn(dt, nearPoints)` (emit faint transient blooms near the named graph), `update(t)`, `render(ctx)` — FIFO-capped particle set (bounded), each a dither bloom that fades. Procedural; no real data. Reduced-motion → no-op.

- [ ] **Step 1:** Failing tests: particles are FIFO-capped (never exceeds the cap under sustained spawn); each particle lifecycles out (fade → removed). **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(MYT-89): ghost-bloom ambient field (capped)`.

### Task C4: `WorldGenGraph` component (Canvas + a11y list + mobile)

**Files:**
- Create: `frontend/ui/src/components/WorldGenGraph/WorldGenGraph.tsx`, `entity-list.tsx`, `WorldGenGraph.stories.tsx`, `index.ts`
- Modify: `frontend/ui/src/index.ts`
- Test: `frontend/ui/src/components/WorldGenGraph/WorldGenGraph.test.tsx`

**Interfaces:**
- Consumes: `ForceSim` (C2), `GhostBloomField` (C3), `GraphNode`/`GraphEdge` (C1).
- Produces: `WorldGenGraph` — props `{nodes, edges, selectedKey?, onSelect(synthKey), reducedMotion?}`. Renders a Canvas (square ink glyphs by kind, hand-drawn ink edges, hover-raise on fine pointers, drag-to-pin on fine pointers only) driven by a `requestAnimationFrame` loop that ticks the sim + renders the ghost field. The fold does NOT run in the rAF loop — nodes/edges come in as props (parent folds per event). ALSO renders an **accessible `entity-list`** (keyboard-navigable DOM `<ul>` of entities as they arrive, `name` + `kind`; activating an item = `onSelect`); the Canvas is `aria-hidden`. Mobile (~375px): tap-to-select, no drag; fits viewport. `reducedMotion` → tick-to-convergence + redraw per prop change, no churn/blooms.

- [ ] **Step 1:** Failing tests: given `nodes`, the accessible list renders one item per entity with name+kind; keyboard-activating an item calls `onSelect(synthKey)`; the Canvas has `aria-hidden`; `reducedMotion` renders without starting the rAF churn (assert no ghost spawn). Use a small fixture; bump `asyncUtilTimeout` if the render is heavy.
- [ ] **Step 2–4:** FAIL → implement → PASS. Story: a **bursty** scripted event fixture (per spec §6 — not a metronome) driving the graph through a mini generation.
- [ ] **Step 5:** Commit `feat(MYT-89): WorldGenGraph (Canvas + accessible list + mobile) + story`.

### Task C5: `useWorldGenStream` — SSE wiring + rehydration + failure

**Files:**
- Create: `frontend/src/routes/worldgen/use-worldgen-stream.ts`
- Test: `frontend/src/routes/worldgen/__tests__/use-worldgen-stream.test.ts`

**Interfaces:**
- Consumes: `createSseStatusClient` (client-core), `deriveNodes`/`deriveEdges` (C1), the world-snapshot fetch (a client-core hook — add `getWorldSnapshot(ctx, campaignId)` if absent), `resumeGeneration` (a client-core hook for `POST …/resume`).
- Produces: a hook returning `{phase, nodes, edges, status, retry}` — opens the SSE, accumulates `PipelineEvent`s into an event log, folds to nodes/edges. **Rehydration (spec §6 Iridessa-C1):** on (re)mount, once `phase ≥ world_snapshot_ready`, fetch `world-snapshot` ONCE and seed the graph, then continue folding live events; before that, the graph is honestly sparse. Maps `world_snapshot_ready` → "still generating." **Failure:** on `world_gen_failed`, `retry()` calls resume and **branches on the response** (`202` → keep watching; terminal `409 world_gen_capped`/`phase_not_yet_implementable` → a `status:'terminal'` the UI shows as "can't retry"). `close()` on unmount.

- [ ] **Step 1:** Failing tests (mock the SSE client + snapshot fetch): events fold into nodes/edges; a mount at `phase: world_snapshot_ready` fetches the snapshot once and seeds; a mount before it does NOT fetch (sparse); `world_gen_failed` + `retry` → `202` keeps status live; `retry` → `409 world_gen_capped` → `status:'terminal'`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): useWorldGenStream (SSE + rehydration + resume branching)`.

### Task C6: Phase-aware `/campaigns/:id` routing + the generating view

**Files:**
- Modify: `frontend/src/routes/campaign-detail.tsx` (make it phase-aware)
- Create: `frontend/src/routes/worldgen/generating.tsx` (the world-gen experience screen — composes `WorldGenGraph` + `useWorldGenStream`)
- Test: extend `campaign-detail.test.tsx`

**Interfaces:**
- Consumes: `useWorldGenStream` (C5), `WorldGenGraph` (C4), the campaign-status source (the existing detail-route data or a status hook).
- Produces: `/campaigns/:id` renders the **generating view** (graph + a11y list, minimal chrome, concept echo, failure-with-branching-retry) while the world is generating; renders the campaign page (Phase D) once past setup. This makes the hub card the return path (spec §7 Silvermist-I1) — no new route.

- [ ] **Step 1:** Failing tests: a campaign in `generating` renders the graph experience at `/campaigns/:id`; a `world_ready` transition swaps to the reveal (Phase D — stub the reveal here, D3 fills it); an `active` campaign renders the campaign page. **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): phase-aware campaign route + generating view`.

---

# PHASE D — Reveal + wiki + situation

Depends on Phase A (contract) + Phase C (the graph, for the shared selection). `known`-tier only, server-side scoped.

### Task D1: Wiki view model + server-side data source

**Files:**
- Create: `frontend/client-core/src/worldgen/wiki-view-model.ts`
- Test: `frontend/client-core/src/worldgen/__tests__/wiki-view-model.test.ts`

**Interfaces:**
- Consumes: the world-snapshot response type (`@mythrun/contract` — add a `WorldSnapshot` type if the FE lacks one, mirroring the backend `world-snapshot-view` shape: entities grouped by type, locations nested via `entity_hierarchy`, each with `known`-tier facts).
- Produces: `type WikiViewModel = {groups: {kind, entities: {id, name, facts, children?}[]}[]}`; `toWikiViewModel(snapshot): WikiViewModel` (normalize the snapshot into the view model — the SEAM MYT-94 will feed a character-scoped source into). The DATA SOURCE is an injected function `() => Promise<WorldSnapshot>` (owner → `getWorldSnapshot`); NO tier filtering happens here (server already returned `known`-tier). Document that MYT-94 supplies a different server endpoint, not a client filter.

- [ ] **Step 1:** Failing test: `toWikiViewModel` groups by kind, nests child locations under parents, carries facts. **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): wiki view model + server-side data-source seam`.

### Task D2: `WorldWiki` component

**Files:**
- Create: `frontend/ui/src/components/WorldWiki/WorldWiki.tsx`, `WorldWiki.stories.tsx`, `index.ts`; modify barrel
- Test: `frontend/ui/src/components/WorldWiki/WorldWiki.test.tsx`

**Interfaces:**
- Consumes: `WikiViewModel` (D1), design-system `Text`/`Heading`/`Divider`/`SeamlessInput` (for search).
- Produces: `WorldWiki` — props `{model, selectedId?, onSelect(id), query?, onQuery}`. Browsable grouped tree (factions/locations/npcs/items; nested locations), each entity opens to its facts; a search field filters entities. Flat paper register. Responsive (stacked at 375px). Selecting an entity calls `onSelect`.

- [ ] **Step 1:** Failing tests: renders groups + entities from a fixture model; search narrows the list; selecting an entity → `onSelect(id)` + shows its facts. **Step 2–4:** FAIL → implement → PASS. Story from a fixture model.
- [ ] **Step 5:** Commit `feat(MYT-89): WorldWiki component + story`.

### Task D3: Reveal exploration state (graph ↔ wiki)

**Files:**
- Create: `frontend/src/routes/worldgen/reveal.tsx`
- Test: `frontend/src/routes/worldgen/__tests__/reveal.test.tsx`

**Interfaces:**
- Consumes: `WorldGenGraph` (C4, settled), `WorldWiki` (D2), `toWikiViewModel` + `getWorldSnapshot` (D1), the graph nodes from C.
- Produces: the reveal — the settled graph + the wiki side by side (stacked/tabbed at 375px), **shared selection** (selecting a graph node selects the wiki entity and vice-versa — map by entity id), an explore prompt, and a **Continue →** to the situation pick. Fetches the full `known`-tier snapshot for the wiki (world is complete now, no 409).

- [ ] **Step 1:** Failing tests: renders graph + wiki; selecting a wiki entity highlights the graph node (shared state); Continue navigates to the situation pick. **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): world reveal (graph ↔ wiki shared selection)`.

### Task D4: Starting-situation pick

**Files:**
- Create: `frontend/src/routes/worldgen/situation-pick.tsx`
- Add client-core hook: `getStartingSituations(ctx, campaignId)` + `chooseStartingSituation(ctx, campaignId, index)` (if absent) in `frontend/client-core/src/api/`
- Test: `frontend/src/routes/worldgen/__tests__/situation-pick.test.tsx`

**Interfaces:**
- Consumes: `GET …/starting-situations` (3 `{index, title, locationName, prose}`) + `POST …/starting-situation {index}` (owner) via client-core.
- Produces: a quiet screen — the 3 hooks as selectable **ghost items** (borderless, square, rules — NOT boxed cards, NOT radio dots; reuse `GhostChoiceList` or a sibling), each showing `title` + `locationName` + `prose`. Selecting → `POST …/starting-situation` → navigate to the campaign page. `409 situation_locked` (already chosen) → proceed to the campaign page.

- [ ] **Step 1:** Failing tests: renders the 3 hooks; selecting posts the index and navigates; a `409 situation_locked` still proceeds. **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): starting-situation pick`.

### Task D5: Campaign-page landing + MYT-90/91 seams

**Files:**
- Modify: `frontend/src/routes/campaign-detail.tsx` (the `active`/past-setup branch from C6)
- Test: extend `campaign-detail.test.tsx`

**Interfaces:**
- Produces: the campaign page the owner lands on after the situation pick — the world identity (name, cover) + **stubbed seams**: a placeholder "invite players" region (MYT-91) and an "everyone makes a character" region (MYT-90), each a clearly-marked stub wired to the shape of the existing routes but not built out. This is the explicit MYT-89 boundary (spec §10).

- [ ] **Step 1:** Failing test: an `active`/setup-complete campaign renders the campaign page with the invite + character stub regions (testids). **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(MYT-89): campaign-page landing + MYT-90/91 seams`.

---

## Self-Review

- **Spec coverage:** create fork (B2), freeform (B3), guided (B4), preview+rework+start-over (B5), rejection (B5), synthesize-preview+rework backend (A3/A4), widened commit (A5), world-gen graph + ambient + a11y + mobile (C2–C4), rehydration + failure branching (C5), phase-aware routing (C6), wiki (D1/D2), reveal shared-selection (D3), situation pick (D4), landing + seams (D5), CTA (B6), contract+client-core (A6/A7), real-LLM smoke (A8). Every spec §1–§11 requirement maps to a task.
- **Type consistency:** `previewId`, `{previewId, concept}`, `ConceptRejection`, `GraphNode/GraphEdge`, `WikiViewModel` are named identically across producing/consuming tasks.
- **No placeholders:** UI mechanical detail defers to the spec + design system (cited), which is content, not a TBD; the load-bearing/tricky code (reducers, force-sim merge, gate ordering, rehydration) carries explicit test specs.

## Execution

**Subagent-Driven** (per the CLAUDE.md workflow): decompose into beads (below) → dispatch a fresh Opus implementer per bead, controller commits per-task, review between tasks, broad review at the end. Phase order A → B/C (parallelizable after A) → D. Run the full pre-push gate at each phase boundary ([[reference_unpushed_vertical_accumulates_ungated_gaps]]).
