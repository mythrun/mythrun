# MYT-87 — Home Screen / Campaign Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the home/campaign hub — a shelf of cover-cards carrying a per-world dithered colour identity, with the implicit-status model, the empty state, the header wiring, and the full backend vertical that produces + serves the colour pairs.

**Architecture:** A full-stack vertical. Backend: a new world-gen LLM stage emits a two-colour `WorldColor` pair (validated against a shared `@mythrun/contract` runtime enum, contrast-guarded with a re-roll); stored on `worlds`; backfilled for existing worlds; surfaced through an expanded `GET /api/campaigns/mine` (new `listHubCardsForUser`, two batched queries, a viewer-relative `cardPhase`, archived filtered). Frontend: two net-new `@mythrun/ui` primitives (a `CoverDither` reusing `bayer.ts`, a dashed `Card` variant), a `CampaignCard`, a responsive grid/index hub, and `useBalance`.

**Tech Stack:** Node 24 + Fastify + Postgres (backend), React + Vite + Tailwind v4 + `@mythrun/ui` (frontend), Anthropic via the single `ai.ts` abstraction, Zod contracts in `@mythrun/contract`, Vitest + Storybook test-runner (375/1280 overflow gate).

## Global Constraints

- TDD: a failing test defines "done" before implementation. `pnpm typecheck` + `pnpm lint` + `pnpm test` before any task is done.
- All UI from `@mythrun/ui`; net-new components are first-class (4-file set + barrels + a story; the `story-coverage` gate requires a sibling `*.stories.tsx`). `no-ad-hoc-ui` is OFF inside `frontend/ui/**`, ON in `frontend/src/**` (no raw `className`/`<div>` in screens).
- Paper register: square everything, **no circles, no status dots/badges**; state as mono-ledger TEXT or implicit in the data. Read the real component before building.
- Colours come ONLY from the curated `WorldColor` set (a runtime enum); raw hex is forbidden (R3). Dither only where there's committed contrast.
- All user-facing prose is `[ph_…]` i18n keys (catalog `frontend/client-core/src/i18n/locales/en/common.json` + a matching `descriptions.ts` entry — `resources.test.ts` pins identical key sets). Only generic chrome gets real values.
- Responsive: desktop grid AND 375px index, both under the overflow gate. Visual audit (light + dark) before push.
- Props live in client-core/contract (R1 brain/UI boundary); the shared RUNTIME enum + REST schemas live in `@mythrun/contract` (`frontend/contract/`, zod-only, react-free — the backend imports this, NOT client-core).
- `pipelineRoute: true` routes carry a 5-contract ripple (pipeline-routes, backend-routes, contract mock, 2 dev-tool manifests).
- Brand sign-off (Miklos, in the design repo) is required for the tiled cover-dither wall before T16 ships — a precondition, tracked as a bead blocker.

---

## File structure

**Backend / contract:**
- Create `frontend/contract/src/rest/world-color.ts` — the `WorldColorSchema` z.enum + `WorldColorPairSchema`.
- Create `backend/src/llm/prep/world-color-palette.ts` — backend hex + relative-luminance table for the `WorldColor` set + `contrastRatio(a,b)`.
- Create `backend/src/llm/prep/stages/world-color.ts` — the LLM colour stage + contrast re-roll.
- Create `backend/src/llm/prompts/prep/world-color.txt` — the prompt template.
- Create `backend/migrations/030_world_color_identity.sql` — 2 `worlds` columns.
- Create `backend/scripts/world-color-backfill.ts` — the backfill.
- Create `frontend/contract/src/rest/billing.ts` — `BalanceResponseSchema`.
- Modify `backend/src/llm/prep/world-gen-processor.ts` (stage array + dispatch arm), `backend/src/sse/derive-phase.ts` (mirror + viewer-relative), `backend/src/repo/worlds.ts` (`setColorPair`), `backend/src/repo/campaigns.ts` (`listHubCardsForUser`), `backend/src/routes/campaigns.ts` (`/mine` mapping), `backend/src/routes/billing.ts` (type the balance response), `frontend/contract/src/rest/campaigns.ts` (widen the summary) + `rest/index.ts`, `backend/src/db/__tests__/migrate-schema.test.ts` (pinning).

**Frontend:**
- Create `frontend/ui/src/components/CoverDither/{CoverDither.tsx,.stories.tsx,.test.tsx}` + `frontend/client-core/src/contract/cover-dither.ts`.
- Create `frontend/src/routes/home-card.tsx` (the `CampaignCard`) + `frontend/src/routes/home-index-row.tsx` (the mobile row) — screen-level, or a `@mythrun/ui` `CampaignHub` if the responsive switch needs library-level breakpoint classes (see T15).
- Modify `frontend/ui/src/components/Card/Card.tsx` (+ contract) — dashed variant; `frontend/ui/src/components/Avatar/AvatarGroup.tsx` — ring fix; `frontend/client-core/src/api/campaigns.ts` (expand) + `frontend/client-core/src/api/billing.ts` (new `useBalance`); `frontend/src/storybook/screen-harness.tsx` (`seedBalance`); `frontend/src/routes/home.tsx` (rebuild) + `home.test.tsx` + `home.stories.tsx`; the i18n catalog + `descriptions.ts`.

---

## Phase 1 — Shared contract + token foundation

### Task 1: `WorldColor` runtime enum (shared contract)

**Files:**
- Create: `frontend/contract/src/rest/world-color.ts`
- Modify: `frontend/contract/src/rest/index.ts` (barrel)
- Test: `frontend/contract/src/__tests__/world-color.test.ts`

**Interfaces — Produces:** `WorldColorSchema` (`z.enum`), `type WorldColor`, `WorldColorPairSchema` (`z.object({from,to})`), `WORLD_COLORS` (the readonly name array). The curated set = the 12 avatar pigments (`ember,sienna,ochre,moss,pine,verdigris,lapis,iris,heather,rose,umber,slate`) + selected paper steps (`paper-50,paper-100,paper-200,paper-900`) + selected ember steps (`ember-100,ember-200,ember-700,ember-900`). **Excludes** the semantic ramps (success/warning/danger/info). Each name's CSS-var namespace is recorded for the consumer: pigments → `--color-avatar-{name}`, ramp steps → `--color-{name}`.

- [ ] **Step 1: failing test** — assert `WORLD_COLORS` has the curated members, excludes `success-500`/`danger-500`, includes `sienna` + `paper-100` + `ember-900`; `WorldColorPairSchema.parse({from:'sienna',to:'paper-100'})` succeeds; `.parse({from:'danger-500',…})` throws.
- [ ] **Step 2:** run `pnpm --filter @mythrun/contract test world-color` → FAIL (module missing).
- [ ] **Step 3: implement** — mirror the `CampaignSummarySchema` z.enum style (`frontend/contract/src/rest/campaigns.ts:20`). Export the enum, the pair object, and `WORLD_COLORS`. Add `export * from './world-color.js'` to `rest/index.ts:6`.
- [ ] **Step 4:** run → PASS. `pnpm --filter @mythrun/contract typecheck`.
- [ ] **Step 5: client-core drift guard** — a test in `frontend/client-core/src/contract/__tests__/` asserting every `WorldColor` name resolves to a real token (cross-check vs `AVATAR_COLORS` keys + the paper/ember ramp steps), so the curated set can't reference a non-existent token. Commit.

### Task 2: backend colour palette + luminance table

**Files:**
- Create: `backend/src/llm/prep/world-color-palette.ts`
- Test: `backend/src/llm/prep/__tests__/world-color-palette.test.ts`

**Interfaces — Produces:** `WORLD_COLOR_HEX: Record<WorldColor, string>` (hand-authored, hex), `relativeLuminance(hex)`, `contrastRatio(a: WorldColor, b: WorldColor): number`, `CONTRAST_FLOOR` (the legibility threshold). **Consumes:** `WorldColor` from `@mythrun/contract`.

- [ ] **Step 1: failing test** — `contrastRatio('paper-100','ember-900')` ≥ `CONTRAST_FLOOR`; `contrastRatio('sienna','ochre')` < `CONTRAST_FLOOR` (the equiluminant-pigment case from the review); a **drift guard** reading `frontend/ui/src/styles/tokens.manifest.json` + `frontend/client-core/src/tokens/scales.ts` `AVATAR_COLORS` and asserting `WORLD_COLOR_HEX` matches the frontend source for every member. (Precedent: `frontend/src/__tests__/tokens.test.ts:4,28-32`.)
- [ ] **Step 2:** run → FAIL. (If the cross-package manifest import doesn't resolve under backend vitest/tsconfig — the scout flagged this — read the JSON via `readFileSync(resolve(...,'../../../frontend/ui/src/styles/tokens.manifest.json'))` instead of an import.)
- [ ] **Step 3: implement** — the hex table (copy values from `scales.ts` AVATAR_COLORS + `colors.generated.css`/manifest for the ramp steps), the sRGB→linear + Rec.709 luminance fn (copy the inline formula from `frontend/ui/src/styles/semantic-contrast.test.ts`), `contrastRatio`. Set `CONTRAST_FLOOR` empirically so paper↔pigment passes and pigment↔pigment fails.
- [ ] **Step 4:** run → PASS. **Step 5:** commit.

## Phase 2 — Net-new `@mythrun/ui` primitives

### Task 3: `CoverDither` component

**Files:**
- Create: `frontend/ui/src/components/CoverDither/{CoverDither.tsx,CoverDither.stories.tsx,CoverDither.test.tsx}`
- Create: `frontend/client-core/src/contract/cover-dither.ts`
- Modify: `frontend/ui/src/index.ts` (2 barrel entries), `frontend/client-core/src/contract/index.ts` (re-export)
- Test: the `.test.tsx`

**Interfaces — Produces:** `CoverDither` + `CoverDitherProps extends BaseProps` (NO children): `{ from: WorldColor; to: WorldColor; size: 'band' | 'swatch'; 'data-testid'? }`. **Consumes:** `WorldColor` (contract), `bayer.ts` exports.

It is a NEW component (NOT a `Dither` variant — `Dither` is a fixed-geometry, child-less, two-solid-seam *transition strip*; the scout confirmed). It reuses `bayer.ts` (`BAYER_4X4`, `chaosAt`, `thresholdAt`, `buildBand`, `CELL_PX`) but builds a FULL-FIELD grid sized to its host (the card-band aspect / the mobile square), resolving each `WorldColor` to its correct CSS var (pigment → `var(--color-avatar-{name})`, ramp → `var(--color-{name})`). Square-pixel crisp at both sizes (cell size chosen so grain stays visible per the brand). Decorative → `aria-hidden`.

- [ ] **Step 1: failing test** — renders an SVG/canvas filling its host; the two colours resolve to the right `var(--color*)`; `from="sienna"` → `var(--color-avatar-sienna)` not `var(--color-sienna)`; axe-clean (decorative). Use `Avatar.test.tsx` (jest-axe + ref + token-class) as the model.
- [ ] **Step 2:** run `pnpm --filter @mythrun/ui test CoverDither` → FAIL.
- [ ] **Step 3: implement** — copy the `Dither.tsx` SVG-pattern approach but make the transition axis fill the host (not lock to `BAND_CELLS*cellPx`); a `worldColorToVar(name)` helper switching namespaces. Story: `title:'Texture/CoverDither'`, autodocs, a grid of several pairs at band + swatch sizes; **do NOT set `overflowGate:false`** (it must pass the gate at its real sizes).
- [ ] **Step 4:** run → PASS; `pnpm --filter @mythrun/ui story-coverage` + `lint:css`. **Step 5:** commit.

### Task 4: `Card` dashed variant

**Files:** Modify `frontend/ui/src/components/Card/Card.tsx` (cva) + `frontend/client-core/src/contract/card.ts` (`frame?: 'solid' | 'dashed'`). Test: `Card.test.tsx`.

- [ ] **Step 1: failing test** — `<Card frame="dashed">` has `border-dashed`; default `frame="solid"` keeps `border-border-strong`; composes with `collapse`/`surface`. **Step 2:** FAIL. **Step 3:** extend the cva `variants`/`defaultVariants` (model: `Card.tsx:30`), add the prop to the contract. **Step 4:** PASS + story update. **Step 5:** commit.

### Task 5: `AvatarGroup` ring fix

**Files:** Modify `frontend/ui/src/components/Avatar/AvatarGroup.tsx` + contract. Test: `AvatarGroup.test.tsx`.

The review flag: `RING = ring-2 ring-bg` = page colour; on a `Card` (`--surface`) the overlap ring mismatches. Add a `surface?: 'bg' | 'surface'` prop (default `'bg'`, back-compat) selecting `ring-bg` vs `ring-surface`; the hub passes `surface="surface"`.

- [ ] **Step 1: failing test** — `<AvatarGroup surface="surface">` rings with `ring-surface`; default stays `ring-bg`. **Step 2:** FAIL. **Step 3:** implement (the `RING` cn + the prop). **Step 4:** PASS + story. **Step 5:** commit.

## Phase 3 — Backend colour generation

### Task 6: `worlds` colour schema migration

**Files:** Create `backend/migrations/030_world_color_identity.sql`. Modify `backend/src/db/__tests__/migrate-schema.test.ts`. Test: the full migrate-schema suite.

```sql
-- 030_world_color_identity.sql  — per-world dither identity (MYT-87)
ALTER TABLE worlds ADD COLUMN color_from TEXT;
ALTER TABLE worlds ADD COLUMN color_to   TEXT;
```
(Plain nullable TEXT — null = not-yet-generated → the ghost band. The `WorldColor` enum is enforced at the app/contract layer + the backfill, not a DB CHECK, to avoid pinning the enum twice; revisit if a CHECK is wanted.)

- [ ] **Step 1:** append `030_world_color_identity.sql` to the pinned migration list (`migrate-schema.test.ts:788-818`). No EXPECTED_TABLES/IDX/FK/CHECK change (two plain cols, no CHECK). Add a focused "columns exist" describe-block (precedent `:980-994`).
- [ ] **Step 2:** run the FULL `pnpm --filter @mythrun/backend test migrate-schema` → it must pass on a FRESH db (see the warm-vs-fresh memory; run via the test DB). **Step 3:** n/a (migration is the impl). **Step 4:** PASS. **Step 5:** commit.

### Task 7: `worlds.setColorPair` repo binder

**Files:** Modify `backend/src/repo/worlds.ts`. Test: `backend/src/repo/__tests__/worlds.test.ts`.

**Produces:** `setColorPair(worldId, pair: {from: WorldColor; to: WorldColor}): Promise<void>` on the worlds binder (model: `applyConcept`/`setVocabularyRegistry`). Writes-only (idempotent SET, not a delta — see the authoritative-set memory).

- [ ] **Step 1: failing test** (scoped fixture per CONVENTIONS.md) — insert a world, `setColorPair(id, {from:'sienna',to:'paper-100'})`, assert `color_from/color_to` persisted. **Step 2:** FAIL. **Step 3:** the binder (`UPDATE worlds SET color_from=$2, color_to=$3 WHERE id=$1`). **Step 4:** PASS. **Step 5:** commit.

### Task 8: world-gen colour stage

**Files:** Create `backend/src/llm/prep/stages/world-color.ts` + `backend/src/llm/prompts/prep/world-color.txt`. Modify `backend/src/llm/prep/world-gen-processor.ts` (stage array `:76-91` + dispatch arm `:445-636`), `backend/src/sse/derive-phase.ts` (`WORLDGEN_STAGES` mirror `:66-81`). Test: `backend/src/llm/prep/stages/__tests__/world-color.test.ts`.

**Produces:** a stage that, given the world's vibe (`concept/tone/themes`), calls `generateObject({model: HAIKU, schema: WorldColorPairSchema, …})`, applies the contrast guard (`contrastRatio(from,to) >= CONTRAST_FLOOR`), **re-rolls** on failure (feed the rejected pair back into the prompt, max N attempts — keeps the aesthetic choice with the LLM per ZFC; NOT a deterministic snap), then `tx.worlds.setColorPair`. Placed AFTER `concept_intake` (so `tone/themes` are loaded).

- [ ] **Step 1: failing test** — mock `generateObject` to return a low-contrast pair then a good pair; assert the stage re-rolls and persists the good pair; assert it validates against `WorldColorPairSchema` (a non-`WorldColor` mock value is rejected by the schema). Model: `vocabulary-intake.ts` stage shape.
- [ ] **Step 2:** FAIL. **Step 3:** implement the stage (prompt via `readFileSync` + `.replace`; Haiku rates; the re-roll loop), add the array entry + the `if (stage === 'world_color')` dispatch arm + the `derive-phase` mirror. **Step 4:** PASS. **Step 5:** commit.
- [ ] **Step 6: constructed-state real-LLM smoke** (per the dev-tool-E2E-smoke memory) — seed a world just past concept_intake, run the stage with REAL Haiku, assert a valid in-enum contrast-passing pair persists. (This is the eval that mocks can't give.)

### Task 9: colour backfill script

**Files:** Create `backend/scripts/world-color-backfill.ts` + a `world:color-backfill` package.json script. Test: a dry-run unit test of the arg parsing + the per-world call.

Model: `backend/scripts/world-embed-backfill.ts` (parseArgs `--world`/`--all`/`--force`, `loadEnv`, Pool, `createRepo`, JSON-line log, top-level `.catch`→exit 1). `--all` iterates `SELECT id FROM worlds WHERE status='complete' AND color_from IS NULL`, runs the colour stage (real LLM) per world.

- [ ] **Step 1: failing test** — arg parsing (mutually-exclusive `--world`/`--all`), and that a seeded complete-but-no-colour world gets a pair after a `--world <id>` run (mock the LLM). **Step 2:** FAIL. **Step 3:** implement mirroring `world-embed-backfill.ts`. **Step 4:** PASS. **Step 5:** commit.
- [ ] **Step 6:** add a migrate-schema/contract test asserting NO `status='complete'` world is left with null colours after backfill is the operational gate (run the real backfill against staging as a runbook step before T16 — the no-stub-fallback guarantee).

## Phase 4 — Backend `/mine` + balance

### Task 10: viewer-relative `cardPhase`

**Files:** Modify `backend/src/sse/derive-phase.ts` (add `viewerUserId` + a hub `cardPhase` mapping) + its call sites (`routes/campaigns.ts:233-251` `loadSnapshot`). Test: `derive-phase.test.ts`.

**Produces:** `deriveCardPhase({campaign, world, viewerHasCharacter, partyAllReady}): CardPhase` where `CardPhase = 'generating'|'failed'|'needs-character'|'waiting-for-players'|'not-played'|'played'`. Keep `derivePhase` (the existing global pure fn) intact; ADD `deriveCardPhase` (a thin viewer-relative wrapper) rather than break the existing signature + its call sites.

- [ ] **Step 1: failing test** — table-driven: `world.status='failed'`→`failed`; `world.status='generating'`→`generating`; active + `!viewerHasCharacter`→`needs-character`; active + viewerHasCharacter + `!partyAllReady`→`waiting-for-players`; active + ready + `sessionCount=0`→`not-played`; else `played`. **Step 2:** FAIL. **Step 3:** implement (pure fn). **Step 4:** PASS. **Step 5:** commit.

### Task 11: `/api/campaigns/mine` expansion

**Files:** Modify `frontend/contract/src/rest/campaigns.ts` (widen `CampaignSummarySchema` → a `HubCardSchema`/expanded summary: add `worldName`, `worldColors: WorldColorPairSchema.nullable()`, `creator: z.string().nullable()`, `party: z.array(z.object({userId,displayName,hasCharacter}))`, `sessionCount`, `lastPlayedAt: z.iso.datetime().nullable()`, `cardPhase`; DROP nothing the frontend still needs — keep `id,name`; `worldId`/`status`/`language` can stay or move per consumer), `frontend/contract/src/rest/index.ts`, `backend/src/repo/campaigns.ts` (`listHubCardsForUser`), `backend/src/routes/campaigns.ts` (`/mine` mapping). Test: `backend/src/routes/__tests__/campaigns-list.test.ts` + the contract `rest.test.ts`.

**`listHubCardsForUser` — two batched queries (NO fanout/N+1):**
1. `campaigns ⋈ worlds ⋈ users(creator)` + `LEFT JOIN LATERAL (SELECT count(*) sc, max(started_at) lp FROM sessions WHERE campaign_id=c.id) s` , `WHERE cm.user_id=$1 AND cm.invite_accepted=true AND c.status != 'archived' ORDER BY c.created_at DESC`. Selects `worldName`, `world.color_from/to`, `creator = (CASE WHEN w.created_by != $1 THEN cu.display_name END)`, `sc`, `lp`, the statuses.
2. Batched party roster `WHERE cm.campaign_id = ANY($ids) AND cm.invite_accepted = true` (model: `getPartyRoster` JOINs `character_concepts`/`campaign_characters` for `hasCharacter = character_id IS NOT NULL`), grouped per campaign in app code.
Compose: per campaign call `deriveCardPhase(...)` with the viewer's `hasCharacter` (from the roster filtered to `$1`) + `partyAllReady`. Drop `avatarPigment` (frontend derives). Map `color_from/to` → `worldColors` (null when either is null).

- [ ] **Step 1: failing test** — seed 2 campaigns (one with party+sessions, one archived, one failed-world); assert `/mine` returns the expanded shape, the archived one is ABSENT, `cardPhase` is correct, `sessionCount` is right (no fanout doubling), `worldColors` null when ungenerated, `creator` null for own world. **Step 2:** FAIL. **Step 3:** implement the repo method + the route mapping. **Step 4:** PASS. **Step 5:** the `pipelineRoute` ripple — update the 5 contracts (pipeline-routes, backend-routes, contract mock, 2 dev-tool manifests) per `reference_pipeline_route_contract_ripple`; `pnpm dev-tool:verify` (needs a live backend). Commit.

### Task 12: `BalanceResponseSchema` contract + balance route typing

**Files:** Create `frontend/contract/src/rest/billing.ts` (`BalanceResponseSchema` modelling the snake_case wire shape `{session, world_gen, active_subscription: {...}|null}`), modify `rest/index.ts`, type `backend/src/routes/billing.ts:62-91` `handleBalance` against it. Test: `rest.test.ts` + a backend balance-route test.

- [ ] **Step 1: failing test** — `BalanceResponseSchema.parse(<real handler shape>)` succeeds; the handler return is `satisfies BalanceResponse`. **Step 2:** FAIL. **Step 3:** author the schema (mirror `campaigns.ts`; keep snake_case to match the existing wire). **Step 4:** PASS. **Step 5:** commit.

## Phase 5 — Frontend hub

### Task 13: client-core hooks + ScreenHarness `seedBalance`

**Files:** Modify `frontend/client-core/src/api/campaigns.ts` (the `MyCampaignsResponse` type follows the widened schema — no code change beyond the type flowing through), create `frontend/client-core/src/api/billing.ts` (`getBalance` + `useBalance`, key `['billing','balance']`, model `useMyCampaigns`), modify `frontend/src/storybook/screen-harness.tsx` (`seedBalance?` → `queryClient.setQueryData(['billing','balance'], …)`). Tests: existing hook tests + a harness test.

- [ ] **Step 1: failing test** — `useBalance` parses a balance response via the new endpoint; `ScreenHarness` with `seedBalance` pre-seeds the cache so a balance-reading screen doesn't suspend-hang. **Step 2:** FAIL. **Step 3:** implement (the `defineEndpoint` + `useSuspenseQuery` pair; the harness prop). **Step 4:** PASS. **Step 5:** commit.

### Task 14: `CampaignCard` + `cardPhase` → mono-text

**Files:** Create `frontend/src/routes/home-card.tsx` (`CampaignCard`). Modify the i18n catalog (`home.card.*` phase keys) + `descriptions.ts`. Test: `frontend/src/routes/__tests__/home-card.test.tsx`.

The card: `Card` (band = `CoverDither from={worldColors.from} to={worldColors.to}` or the ghost when null) over title (`Heading`) + world·creator (`Text`, creator-conditional) + party (`AvatarGroup surface="surface"` of square `Avatar`s, max 5) + the mono record/state line. A `cardPhase → i18n key` map (static literal, like the retired `STATUS_LABEL_KEY`): `generating→home.card.generating`, `failed→home.card.failed`, `needs-character→home.card.needsCharacter`, `waiting-for-players→home.card.waiting`, `not-played→home.card.notPlayed`, `played→` the record string (`N sessions · <relative>`). The whole card is the click target (→ detail; interim route).

- [ ] **Step 1: failing tests** — each `cardPhase` renders its expected line; `played` renders the session/last-played record; `worldColors=null` renders the ghost band; creator hidden when null; `+N` overflow at >5 party. **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + the i18n keys pass `resources.test.ts`. **Step 5:** commit.

### Task 15: responsive hub container (grid ⊕ index)

**Files:** Create `frontend/src/routes/home-index-row.tsx` (the mobile row: `CoverDither size="swatch"` + title + world + mono line). The responsive switch: since raw `hidden md:grid` is banned in `src/`, EITHER (a) a new `@mythrun/ui` `Responsive`/`CampaignHub` component that does the breakpoint show/hide INSIDE the library (where `className` is legal) and renders the grid vs the index, OR (b) `Grid columns="auto-fit"` if the card+row can be unified into one reflowing layout. **Decide in implementation:** the card and the index-row are visually distinct, so (a) — a small library-level responsive container — is the in-system path. Test: `home-index-row.test.tsx` + the container.

- [ ] **Step 1: failing test** — the index row renders the swatch + title + state line; the responsive container renders the grid of `CampaignCard`s at desktop and the index list at mobile (assert via the library component's breakpoint classes, testable in the ui package where className is legal). **Step 2:** FAIL. **Step 3:** implement the row + the container (option a). Story-coverage if it's a new ui component. **Step 4:** PASS. **Step 5:** commit.

### Task 16: home route wiring + screen stories + header

**Files:** Modify `frontend/src/routes/home.tsx` (replace `STATUS_LABEL_KEY` + the minimal card with the responsive container; the empty state = the dashed `Card` "Unwritten" cover + `[ph_home_empty]` + the New Campaign CTA → MYT-89 route; the header credits via `useBalance`), `home.test.tsx` (expand the MSW cases: each `cardPhase`, empty, archived-absent, balance), `home.stories.tsx` (`seedCampaigns` covering the phases + `seedBalance`; a separate empty-state story). Modify `app-frame.tsx` if the header credit-wiring lives there. Retire the dead `home.status.*` keys. Test: the above + `screen-story-coverage` + the overflow gate.

- [ ] **Step 1: failing tests** — the home screen renders the grid of cards (seeded), the empty state (no campaigns), the live credits; navigation: New Campaign → the creation route, card click → the detail route (interim). **Step 2:** FAIL. **Step 3:** implement; remove `STATUS_LABEL_KEY` + its keys. **Step 4:** PASS; `pnpm --filter @mythrun/web screen-story-coverage` + the overflow gate (375/1280) on the new stories. **Step 5:** commit.
- [ ] **Step 6: visual audit** — build Storybook, render the hub + empty + mobile index in light AND dark, STOP for Miklos's visual audit before the push (per the visual-audit-before-push rule). Incorporate, then the controller does the single push + the wiki sync + flips MYT-87.

---

## Self-review

**Spec coverage:** card (T14) ✓ · grid+index responsive (T15) ✓ · header credits (T13/T16) ✓ · empty state (T4/T16) ✓ · per-world colour identity: enum (T1) + luminance (T2) + CoverDither (T3) + gen stage (T8) + backfill (T9) + storage (T6/T7) + /mine field (T11) ✓ · implicit status / cardPhase (T10/T14) ✓ · `/mine` expansion + archived filter + two-query (T11) ✓ · `useBalance` (T12/T13) ✓ · deferrals (banner→MYT-91, modal body, credits-buy→MYT-95) honoured as interim routes (T16) ✓.

**Placeholder scan:** no TBD/TODO; the one judgement call (T15 option a vs b) is resolved to (a) with the rationale stated. Brand sign-off (T3/T16) is a tracked precondition, not a placeholder.

**Type consistency:** `WorldColor`/`WorldColorPairSchema` (T1) flow to T2 (`Record<WorldColor,…>`), T3 (`CoverDitherProps`), T8 (the stage schema), T11 (the payload). `CardPhase` (T10) flows to T11 (the payload) + T14 (the mono-text map). `cardPhase` enum strings match across T10/T11/T14.

**Open seams for decomposition into beads:** T1→T2 (enum before luminance); T1→T3 (enum before CoverDither); T6→T7→T8→T9 (schema→binder→stage→backfill); T10→T11 (cardPhase before /mine); {T1,T2,T6}→T8; {T3,T4,T5}→T14; {T11,T12,T13}→{T14,T15,T16}. Wire these with `bd dep`.
