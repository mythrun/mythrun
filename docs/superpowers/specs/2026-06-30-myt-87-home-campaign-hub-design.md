# MYT-87 — Home Screen / Campaign Hub — Design

> **Status:** Brainstorm complete, design approved + revised after blind review (2026-06-30, 4 lenses: frontend, backend, color-gen/ZFC, UX/scope; 1 showstopper resolved by design decision). Next: user-review gate → writing-plans → beads → subagent-driven implementation.
> **Linear:** MYT-87 (Frontend milestone). **UX source:** UX Design spec §4.
> **Visual rework LOCKED 2026-07-01** — see the revision block immediately below; it supersedes the original card / grid / cover-dither / world-colour / dark-mode design where they conflict.

---

## REVISION 2026-07-01 — visual rework (supersedes §The campaign card, §The grid/index, §The cover-dither component, §The world-colour identity, and the dither parts of §Frontend below)

The first implementation (T1–T16, committed locally, unpushed) shipped the data/backend vertical correctly but diverged from the design visually. After a live design session (mockups + a Haiku-vs-Sonnet colour taste-off + a full contrast enumeration + an interactive dark-mode toggle test), the following are LOCKED. Where this section conflicts with the original design below, **this section wins.**

### Card — a book cover
- **Portrait, ~3:2 (height:width)** — a paperback/spine, not a wide banner. Fixed, good-looking card width; the grid fits **as many as comfortably fit per row, then wraps** (fluid auto-fill sized to the card — NOT a fixed column count). Card quality over grid math.
- **Dither header ~40% of card height, full-bleed**, bottom-bordered in ink. Title (serif) at the top of the body; **party seals + record/state line as the foot "imprint,"** air between. No text on the dither. The mono state line + `cardPhase` model is unchanged from the original spec.

### Cover-dither — a full-fill gradient (rebuild)
- The dither **fills its window bottom→top** as a true Bayer gradient between the two colours (light end at top → dark end at bottom). NOT a transition-strip with solid ends (the first build reused the footer `Dither`'s fixed 20-cell band, which read as a band floating with side-scatter — the bug behind "suspended in the middle").
- Works at **any host size**, including the small mobile swatch (fixed ~44–48px square) — cell size chosen so grain stays visible.
- **Theme-responsive via CSS, no canvas re-render:** render the fixed Bayer pattern with two colour *classes* (ground/accent); set the light-mode pair AND the dark-mode (re-ink) pair as CSS custom properties, with `.dark` selecting the dark pair. The pattern is constant; only the two hex values flip.

### Colour model — Sonnet picks, code guarantees contrast
- **Model: Sonnet, not Haiku.** A blind taste-off (12 worlds each) showed Haiku picks decent hues but no contrast discipline and leans on neutral paper; **Sonnet's restrained, often-monochromatic taste won decisively.** One Sonnet call at world creation (once per world, ever) — a negligible tier bump for a real jump in taste. ZFC: route the aesthetic judgment to the model that can actually handle it.
- **The pick:** Sonnet one-shots **two palette colours** (any hue, any step) from the WIDENED palette, constrained so the two steps are **≥6 rungs apart** on the 10-rung ladder (50…900). Enumeration proved ≥6 rungs guarantees ~3.0+ WCAG contrast in the worst hue combo (5 rungs or fewer can dip to ~2.5). Code **validates the rung distance and re-rolls** if a pick violates it (both models obeyed it 100% in testing; the guard stays). No luminance-snapping — the model keeps the aesthetic choice; code only enforces the mechanical floor. This REPLACES the original "luminance floor + re-roll, expect paper-ground+accent" model — with per-hue ramps, Sonnet can pick two genuinely complementary chromatic colours that also read (e.g. light-coral × dark-teal).

### Palette — per-hue ramps become real tokens
- The 12 brand pigments (moss, pine, verdigris, lapis, iris, heather, rose, sienna, ochre, umber, slate, ember) are single mid-tone values today (near-equiluminant → two of them can't dither). **Extend `generate-palette.mjs`** to run each pigment through the same OKLCH luminance ladder used for ember/semantic ramps, emitting `--color-{hue}-{step}` for all 10 steps of all 12 hues (into `colors.generated.css` + `tokens.manifest.json` + the drift guard). Additive (light/dark variants of existing hues).
- The `WorldColor` runtime enum (in `@mythrun/contract`) expands to this widened set (paper + ember + the 12 pigment ramps); the backend luminance table takes the new hexes. The ≥6-rung rule replaces the enum-membership contrast concern.

### Dark mode — re-ink (theme-adaptive)
- **The cover re-inks in dark mode:** the light end drops to `lightHue-400` (the hue's smouldering mid-tone) and the dark end deepens to `darkHue-900` (near-black), so the cover reads as a dark object with the colour glowing, cohering with the dark card. (`lightHue`/`darkHue` = the hues of the two picked colours; for a mono pick both are the same hue.) Chosen over "frozen" after a live toggle test — a moody, intentional dark surface beats a bright light-mode cover sitting on a dark screen. The dither is subtler in dark by design (contrast ~2.5). Rendered via the CSS ground/accent classes above.

### Mobile & copy
- **Mobile index:** uniform, compact rows (fixed height, smaller type); the swatch is a small fixed square running the same full-fill dither (legible at that size). Replaces the variable-height rows + the broken swatch.
- **Copy:** the `[ph_…]` placeholder VALUES must be short — roughly the length of the real copy ("Shaping your world", "Make your character", "4 sessions · 2 days ago") — not verbose meta-descriptions. The long placeholders were breaking the layout, especially on mobile.

### Grid enhancement
- The `@mythrun/ui` `Grid` needs a **px / non-token `minColumnWidth`** so it can auto-fill at the ~230px card width (its `auto-fit` `minColumnWidth` is a SpaceToken capped at 64px today). This is the fluid-shelf mechanism (bead `myth-xdmq3`, pulled into this rework).

### What stays from the first build (unchanged)
The backend data plumbing is correct and stays: the two `worlds` colour columns, `setColorPair`, the mandatory backfill (re-run with Sonnet), the viewer-relative `cardPhase` (the setup-gated fix), the `/mine` expansion, `BalanceResponseSchema` + `useBalance`, the Card `dashed` variant, the AvatarGroup `surface` ring. The rework revises the luminance-hex table, the CoverDither (rebuild), the colour stage (Sonnet + ≥6-rung + re-ink), the CampaignCard (book cover), the mobile index + the Grid enhancement, and the copy — and adds the token-generation task.

---

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
