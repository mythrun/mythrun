# MYT-87 — Home Screen / Campaign Hub — Design

> **Status:** Brainstorm complete, design approved + revised after blind review (2026-06-30, 4 lenses: frontend, backend, color-gen/ZFC, UX/scope; 1 showstopper resolved by design decision). Next: user-review gate → writing-plans → beads → subagent-driven implementation.
> **Linear:** MYT-87 (Frontend milestone). **UX source:** UX Design spec §4.

## Goal

The player's home base between sessions: a quiet shelf of their campaigns, each rendered as a small "made object" carrying its world's identity, with a clear path to create a new one. The hub lists real campaigns, shows an empty state for new players, and routes a click to the campaign's detail.

## What already exists (reuse) vs what is net-new

**Reuse, do not rebuild:**
- **AppFrame header shell** (`frontend/src/app/app-frame.tsx`): the header row with slots for logomark, display name, credits, settings gear — placeholder-wired, responsive at 375px. MYT-87 wires live data in.
- **The `/home` data path** (`frontend/src/routes/home.tsx`): `useMyCampaigns` suspense query + `<Spinner>` fallback + route error boundary, all tested. MYT-87 keeps this spine, replaces the minimal card.
- **Most UI primitives:** `Card`, `Grid`, `Avatar`/`AvatarGroup` (square pigment tiles), `Banner`, `Wordmark`/`Logomark`, `IconButton`, `Button`, `Stack`, `Text`, `Heading`.

**Net-new (the blind review corrected the earlier "no net-new primitives" claim — it was false):**
- **A card-scale cover-dither component** (see §The cover-dither). The existing `Dither` is a *fixed-geometry* (120–160px), *two-solid-seam*, `paper`×`ember`-only footer primitive — it cannot be a variable-height card band, a mobile swatch, or accept the avatar pigments. The cover band is a new, purpose-built dither component (**requires brand-owner sign-off** as a new sanctioned dither use).
- **A curated `WorldColor` runtime enum** + a **backend palette-hex/luminance table** (see §The world-colour identity).
- **A `useBalance` client-core hook + `BalanceResponseSchema` contract** (the backend `GET /api/billing/balance` exists; the frontend contract does not).
- **A dashed/ghost `Card` variant** for the empty-state "unwritten" cover (`Card` only ships a solid border today).

## The design

### The campaign card — "The Cover"

Each campaign is a minimalist paperback cover. Brand's two layers split: a **serif narrative zone** (title, world · creator) and a **mono ledger zone** (party seals, record/state line). Flat 1-bit — square corners, hairline borders, square avatar seals, **no circles, no status dots, no badges**.

Anatomy (arrangement "Party high"), top to bottom:

1. **Cover-dither band** — a card-scale dither between the campaign's two world-colours, sized so the card is built *around* the band's natural height (~40% feel), full-bleed, bottom-bordered in ink. **No text ever on the dither.**
2. **Title** — campaign name, Source Serif 4.
3. **World · creator** — italic. Shows "· by [Creator]" only when `worlds.created_by != caller` (the joined creator display name); a player's own world shows none.
4. **Party seals** — square `Avatar` tiles (mono initials on a name-derived pigment), overlapping `AvatarGroup`, max 5 then `+N`, directly under the title.
5. **Record / state line** — IBM Plex Mono, at the foot. This line carries BOTH the play record AND the implicit status as plain text (no dot/chip — the register is preserved). It reads, by the campaign's viewer-relative phase:
   - **Generating world…** (world-gen in progress)
   - **World generation failed** (terminal; the click routes to the detail/retry)
   - **Create your character** (you've joined but have no character — *your* turn)
   - **Waiting for players** (you're ready; not all members have characters)
   - **Not played yet** (all ready, zero sessions)
   - **N sessions · 2 days ago** (the play record)

Status is implicit — conveyed by this line plus the party seals — never by a discrete status element.

### The grid (desktop) and the index (mobile)

**Desktop — covers on the wall.** A responsive `Grid` of cover cards, 1–3 columns by width (UX §4).

**Mobile (≤ ~640px) — contents in the hand.** An **index list**: each row is a small cover-dither **world swatch** + title + world · creator + the same mono state line, hairline-divided. Reads as a table of contents. **One component** (`hidden md:grid` / `md:hidden`), measured at 375 and 1280 in one screen story (the overflow gate covers both).

Tapping a card/row opens the campaign **detail** (modal/sheet — body out of scope; MYT-87 owns the click target).

### The header

Wire the existing AppFrame slots:
- **Logomark** — the real pixel-art mark (replace the `Text` placeholder).
- **Display name** — from the session/user.
- **Credits** — live session-credit balance via a new client-core `useBalance` hook + a new `BalanceResponseSchema` contract (the backend endpoint exists; the frontend contract is net-new). The "+" routes toward billing (MYT-95 owns the target — interim target required, no dead click).
- **Settings gear** — routes toward settings (interim target required).

### The empty state

No campaigns → a centered first-run shelf: a single **"Unwritten" cover** (a new dashed/ghost `Card` variant; a faint paper→paper-300 ghosted band — no chosen world-colour yet), an evocative one-line invitation (`[ph_home_empty]`), and a "+ Create a campaign" CTA. (Today "no campaigns = new creator" holds since invites are link-based; flag so MYT-91 doesn't inherit a hard-coded creator-only empty state.)

### The "New Campaign" CTA

Prominent toolbar action (and the empty-state CTA) → the Campaign Creation flow (MYT-89).

## Architecture

### Backend — expand `GET /api/campaigns/mine`

Today returns `{id, worldId, name, status, language, createdAt, updatedAt}`. The needed data exists in the schema (`worlds`, `campaign_members`→`users`, `campaign_characters`/`characters`, `sessions`). New `listHubCardsForUser` repo method (NOT an overload of `listByUser`, which other tests rely on as a bare-row reader). Per-campaign payload:

```
{
  id, name,
  worldName,                                   // join worlds
  worldColors: { from: WorldColor, to: WorldColor } | null,   // null until generated (renders the ghost/loading band)
  creator: string | null,                      // users.display_name WHERE worlds.created_by != caller, else null
  party: [{ userId, displayName, hasCharacter }],  // members (invite_accepted=true) → users; hasCharacter = character_id != null
  sessionCount, lastPlayedAt,                   // from a LATERAL aggregate (no fanout)
  cardPhase: 'generating' | 'failed' | 'needs-character' | 'waiting-for-players' | 'not-played' | 'played'
}
```

- **`cardPhase` is a backend-derived, VIEWER-RELATIVE enum**, built on the existing `derive-phase.ts` extended with the caller's character + party completeness. It preserves the `failed` signal the earlier `worldReady` boolean erased, and supplies the viewer-relative states. The frontend maps `cardPhase` → the mono state line + the click target.
- **`avatarPigment` is NOT a wire field** — pigment is a deterministic frontend derivation (`avatarColorFor(displayName)`); returning it from the backend creates a second source of truth and a dead column.
- **Archived/failed:** **filter `archived` out of `/mine`** (a later archive view); **keep `failed`** (it renders "World generation failed" + a retry route). Add the `WHERE campaigns.status != 'archived'` filter.
- **Query shape (avoid fanout/N+1):** two batched queries — (1) `campaigns ⋈ worlds ⋈ users(creator)` with `sessionCount`/`lastPlayedAt` via `LEFT JOIN LATERAL (SELECT count(*), max(started_at) FROM sessions WHERE campaign_id = c.id)`; (2) a **batched** party roster `WHERE cm.campaign_id = ANY($ids) AND cm.invite_accepted = true`, grouped in app code. Never a single members×sessions join (cartesian → wrong counts), never per-campaign `getPartyRoster` in a loop (N+1).
- **Migration discipline:** the two `worlds` colour columns update `migrate-schema.test.ts`'s pinned list + EXPECTED arrays.

### The cover-dither component (net-new mythrunUI)

A card-scale dither primitive purpose-built for the cover/swatch: variable host geometry (card band + mobile square), renders the 4×4 Bayer between two `WorldColor`s, square-pixel-crisp at its sizes. It is distinct from the footer `Dither` (which stays locked for its transition use). **Brand sign-off required** — a tiled wall of per-card dithers is a new sanctioned dither use beyond the curated footer/splash/print set; confirm with the brand owner and verify the contrast guard holds across a dozen simultaneous pairs.

### The world-colour identity

- **Generated by the LLM in the existing backend world-gen pipeline** (`world-gen-processor.ts` stage list, MYT-51/71 — NOT the MYT-89 frontend flow; the earlier spec mis-routed this). A new stage (or a field on `concept_intake`/`coherence_pass`, which already carry the vibe) emits the pair via `generateObject` + the existing validator-retry loop. ZFC-correct: the LLM makes the aesthetic judgment; code does structural validation + a mechanical luminance check.
- **A curated `WorldColor` runtime enum** — NOT the `PaletteColor` type (which is a compile-time template-literal type, excludes the avatar pigments, and includes the semantic alarm ramps). Define a real `z.enum([...])` of a curated set: the 12 avatar pigments + selected paper steps + selected ember steps, **excluding** success/warning/danger/info. Single source in the shared `@mythrun/contract` package so both the cover-dither and the backend validator use it. The LLM is constrained to this enum → off-brand is structurally impossible.
- **Backend luminance source:** the backend has no `culori`/palette hex today. Add a backend palette-hex table (with a drift-guard test against the frontend token source, mirroring `tokens.test.ts`) so the contrast guard has something to compute against.
- **Contrast guard (deterministic):** check the luminance gap; on a too-low pair, **re-roll** (feed the rejected pair back to the LLM — keeps the aesthetic choice with the model; reuses the validator-retry loop) rather than code deterministically snapping a colour (which would have code make an aesthetic decision). Pin the metric (luminance gap; note pure-luminance ignores hue). Note: the avatar pigments cluster in a narrow mid-luminance band, so most surviving pairs are light-paper-ground + chromatic-accent — accept that the identity is "a paper/ember-or-pigment ground-to-accent per world," not "two freely-chosen equiluminant chromatics."
- **Stored on `worlds`** (two columns), inherited by campaigns/forks. Plot-free + PUBLIC-tier-safe (no enforced-ignorance concern adding to player-facing projections).
- **Backfill is MANDATORY, not a fallback:** every existing `complete` world gets a real pair (re-run the stage with `worlds.tone/themes/key_tensions` as vibe context, or a deterministic vibe-derived assignment). The ONLY no-pair render path is the `generating` window (the ghost band) — assert in a test that no `complete`/`played` world renders a default. This avoids the forbidden silent stub-fallback.

### Frontend

- A screen-level `CampaignCard` composed from `Card` + the new cover-dither + `AvatarGroup` + serif/mono text; the dither colours come from `worldColors` (null → the ghost band during generation).
- One responsive component (grid ⊕ index behind a shared data hook).
- The `useMyCampaigns` expansion (new payload) + the new `useBalance` hook, both via client-core (R5 — no raw fetch in a screen).
- The empty state (dashed Card variant) + the New Campaign CTA.
- Retire the now-dead `STATUS_LABEL_KEY` map + its `home.status.*` i18n keys.
- Visual-audit note: `AvatarGroup`'s overlap ring is `ring-bg`; on `bg-surface` CardBody it may show a faint halo — verify in the audit (cluster on a `bg-bg` zone or a surface-following ring).

## Out of scope (deferred, with clean seams + interim targets)

- **Pending-invite banner → MYT-91** (no per-user pending-invite model today; banner slot left).
- **Campaign detail modal/sheet body** — MYT-87 owns the click target only.
- **Credits "+" buy flow → MYT-95** — interim target (placeholder route / disabled affordance), no dead click.
- **Settings screen** — interim target.
- **Archived campaigns view** — archived is filtered from `/mine`; a dedicated view is later.

## Constraints

- All UI from `@mythrun/ui` (the cover-dither + dashed-Card are new *first-class* mythrunUI additions with stories, not ad-hoc). No ad-hoc UI.
- All prose is `[ph_]` i18n placeholders; brand owner writes real copy.
- Responsive desktop grid AND 375px index; visual audit (light + dark) before push.
- Paper register: square, no circles, no status dots/badges; state as mono-ledger text or implicit. Read the real `@mythrun/ui` component before building.
- Dither only where there's committed contrast; never under text; new tiled use needs brand sign-off.

## Testing

- Card: title, world, creator-conditional, party seals (`+N`, single-seal), the mono state line for EACH `cardPhase` (generating / failed / needs-character / waiting-for-players / not-played / played), per-campaign cover-dither colours, null-colours → ghost band.
- Grid (desktop) + index (mobile) at 375 / 1280 (overflow gate); screen stories.
- Empty state + New Campaign CTA navigation; deferred affordances hit interim targets, not dead clicks.
- Header: live display name + credits (`useBalance`).
- Backend `/mine`: the two-query shape (correct counts, no fanout), `cardPhase` derivation incl. `failed`, archived filtered, the creator predicate, batched party roster.
- Cover-dither: renders at card + swatch sizes, crisp; contrast guard across many pairs.
- Colour generation: structured output validates against the `WorldColor` enum (LLM can't emit off-brand or a semantic ramp); contrast re-roll; backfill leaves no `complete` world without a pair (asserted); constructed-state smoke against real LLM if generation lands here.

## Open questions for the plan

1. **Generation scope:** the colour stage lives in the backend world-gen pipeline. Does MYT-87 pull in the stage + the mandatory backfill, or split the generation into its own backend bead while MYT-87 ships the schema columns + `WorldColor` enum + cover-dither + `/mine` field + the backfill? (Either way the consuming surface is MYT-87's.)
2. **`cardPhase` derivation home:** extend `derive-phase.ts` in place (it's currently not viewer-relative), or a hub-specific derivation wrapping it with the caller's character + party data?
3. **Cover-dither + brand sign-off:** confirm with the brand owner that a tiled wall of per-card dithers is sanctioned, and lock the cover-dither's cell size / geometry so the grain stays visible at both card and swatch scale.
