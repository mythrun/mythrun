# MYT-87 — Home Screen / Campaign Hub — Design

> **Status:** Brainstorm complete, design approved (2026-06-30). Next: blind-review → writing-plans → beads → subagent-driven implementation.
> **Linear:** MYT-87 (Frontend milestone). **UX source:** UX Design spec §4.

## Goal

The player's home base between sessions: a quiet shelf of their campaigns, each rendered as a small "made object" carrying its world's identity, with a clear path to create a new one. The hub lists real campaigns, shows an empty state for new players, and routes a click to the campaign's detail.

## What already exists (do not rebuild)

- **AppFrame header shell** (`frontend/src/app/app-frame.tsx`): the header row with slots for logomark, display name, credits, and a settings gear — wired to i18n placeholders, responsive at 375px. MYT-87 wires the live data into these slots; it does not rebuild the row.
- **The `/home` data path** (`frontend/src/routes/home.tsx`): `useMyCampaigns` suspense query + a `<Spinner>` fallback + the route-level error boundary, all tested (loading / data / empty / error). MYT-87 keeps this spine and replaces the minimal name+status card with the real design.
- **Every UI primitive the hub needs already ships in `@mythrun/ui`:** `Card`, `Grid`, `Avatar`/`AvatarGroup` (square pigment tiles), `Banner`, `Wordmark`/`Logomark`, `IconButton`, `Dither` (4×4 Bayer), `Button`, `Stack`, `Text`, `Heading`. **No net-new primitives are required** — the campaign card is a screen-level composition; only the dither's per-campaign coloring is new wiring.

## The design

### The campaign card — "The Cover"

Each campaign is a minimalist paperback cover. The brand's two layers are split deliberately: a **serif narrative zone** (title, world · creator) and a **mono ledger zone** (party seals, record). Flat 1-bit throughout — square corners, hairline borders, square avatars, **no circles, no status dots, no badges**.

Anatomy (top to bottom), arrangement "Party high":

1. **Dithered header band** — ~40% of the card height, full-bleed, bottom-bordered in ink. The band is a real 4×4 Bayer dither between the campaign's **two world-colors** (see Color identity). **No text ever sits on the dither** (brand rule: the band is never a text ground).
2. **Title** — the campaign name, Source Serif 4, prominent.
3. **World · creator** — italic, smaller. Shared worlds show "· by [Creator]"; a player's own world shows no creator.
4. **Party seals** — square `Avatar` tiles (mono initials on a pigment), overlapping `AvatarGroup`, max 5 then `+N`. Rides directly under the title (it's the "who").
5. **Record** — IBM Plex Mono, pushed to the foot like a page number: `"4 sessions · 2 days ago"`, or `"Not played yet"` when unplayed.

There is **no status element**. Status is implicit in the data: no party → pre-player; party but no sessions → pre-first-session ("Not played yet"); world still generating → no color band yet (see below). This was a deliberate decision — an explicit status chip/dot read as a dashboard tic, against the paper register.

### The grid (desktop) and the index (mobile)

**Desktop — covers on the wall.** A responsive grid of cover cards, 1–3 columns by width (UX §4). The wall of distinct dithered covers is the page's signature.

**Mobile (≤ ~640px) — contents in the hand.** The covers collapse to an **index list**: each row is a small dithered square (the world's color identity, preserved at thumbnail size) + the title + world · creator, with a hairline divider between rows. Reads as a table of contents — scannable, scales to any number. (We explicitly rejected a swipe carousel: it hides the list and optimizes for browsing-as-pleasure when the hub's job is find-and-enter.)

Tapping a card/row opens the campaign's **detail** (a modal/sheet — its contents are out of scope here; MYT-87 only owns the card and the click target).

### The header

Wire the existing AppFrame slots to live data:
- **Logomark** — the real pixel-art mark (not the `Text` placeholder).
- **Display name** — from the session/user.
- **Credits** — the live session-credit balance via a new client-core `useBalance` hook (`GET /api/billing/balance` exists). The "+" buy affordance routes toward billing (MYT-95 owns the target screen); MYT-87 wires the balance + the affordance, not the purchase flow.
- **Settings gear** — routes toward settings (target is a later ticket).

### The empty state

No campaigns → a centered first-run shelf: a single **"Unwritten" cover** (dashed frame, a colorless ghosted dither — the world's pair isn't chosen until creation), an evocative one-line invitation (`[ph_home_empty]`, real copy is the brand owner's), and a "+ Create a campaign" CTA.

### The "New Campaign" CTA

Prominent action in the hub toolbar (and the empty-state CTA), routing to the Campaign Creation flow (MYT-89).

## Architecture

### Backend — expand `GET /api/campaigns/mine`

Today it returns only `{id, worldId, name, status, language, createdAt, updatedAt}`. The card needs more; the underlying data all exists (verified against the schema — `worlds`, `campaign_members`→`users`, `campaign_characters`/`characters`, `sessions`). Expand the per-campaign payload to:

```
{
  id, name,
  worldName,                                   // join worlds
  worldColors: { from: <PaletteColor>, to: <PaletteColor> },   // the world's identity pair
  creator: string | null,                      // "by [Creator]" only for shared worlds
  party: [{ userId, displayName, avatarPigment, hasCharacter }],  // members → users + char readiness
  sessionCount: number,
  lastPlayedAt: string | null,                 // max(session timestamp)
  worldReady: boolean                          // world generation complete (drives the band's loading state)
}
```

The `hasCharacter` + `worldReady` facts let the frontend render the implicit status without a derived status enum. Scope the join/aggregate carefully (it runs per hub load); `migrate-schema` pinning rules apply if a column is added.

### The per-world color identity

- **Generated by the LLM at world creation** (the prep engine, which already authors the world with its vibe in context). ZFC: the aesthetic judgment — which two colors evoke this world — is delegated to the model.
- **Closed palette set, names not hex.** Candidates: the 12 avatar pigments + the paper ramp (light + dark) + the ember ramp. The LLM returns palette *names* via structured output validated against the `PaletteColor` enum, so an off-brand color is structurally impossible.
- **Deterministic contrast guard.** Code checks the luminance gap between the pair; if too low to dither legibly, it re-rolls or snaps one end to a paper step. Enforces the brand's "dither only where there's genuine contrast" rule mechanically.
- **Stored on the world** (two columns on `worlds`), inherited by its campaigns — the identity belongs to the world.
- **Fallback (sensible default, not a degraded stub):** a world without a pair renders the canonical paper-100 → ember dither.

**Dependency / seam to resolve in the plan:** generation lives in the prep engine (world-gen, MYT-89's neighborhood); MYT-87 *consumes* the pair. The plan must settle whether MYT-87 pulls in the prep-engine hook + a backfill for existing worlds, or generation is split into its own bead. Either way the schema column + the `/mine` field + the contrast guard are MYT-87's, so the card can render.

### Frontend

- A screen-level `CampaignCard` (cover layout) composed from `Card` + `Dither` (per-campaign colors) + `AvatarGroup` + serif/mono text. The `Dither` colors come from `worldColors`.
- A responsive container: `Grid` of cards on desktop, an index list of rows on mobile (one component, breakpoint-driven, or two presentational components behind one data layer — decide in the plan).
- The `useBalance` client-core hook (new) for the header credits.
- The empty state + the New Campaign CTA.
- All reached through client-core hooks only (R5 — no raw fetch in a screen).

## Out of scope (deferred, with clean seams)

- **Pending-invite banner → MYT-91.** Today's invites are code/link-based; there's no "my pending invites" model or endpoint. The banner needs that, which is the invite system's domain. MYT-87 leaves a banner slot; MYT-91 fills it.
- **Campaign detail modal/sheet contents** — MYT-87 owns the click target, not the modal body.
- **The credits "+" target (buy flow) → MYT-95.** MYT-87 wires the balance display + the affordance.
- **Settings screen** — gear routes toward it; target is a later ticket.

## Constraints

- All UI from `@mythrun/ui`; no ad-hoc UI (agent stops if a primitive is missing).
- All prose is `[ph_]` i18n placeholders; the brand owner writes real copy. Only generic chrome gets real values.
- Responsive by construction: desktop grid AND the 375px index. Visual audit (light + dark) before push.
- Paper register: square everything, no circles, no status dots/badges, mono for data, serif for narrative. Read the real `@mythrun/ui` component before building.
- Dither only where there's committed contrast; never under text.

## Testing

- Card rendering: title, world, creator-conditional, party seals (incl. `+N` overflow and single-seal), record incl. "Not played yet", per-campaign dither colors.
- Implicit status: no-party, party-no-sessions, world-not-ready render correctly.
- Grid (desktop) and index (mobile) at 375 / 1280 — the overflow gate covers both; screen stories for each.
- Empty state + New Campaign CTA navigation.
- Header: live display name + credits (`useBalance`), CTA + gear targets.
- Backend `/mine` expansion: the join/aggregate shape, the contrast guard (low-contrast pair gets corrected), the fallback pair.
- Color-pair generation: structured output validates against the palette enum (LLM can't emit off-brand); constructed-state smoke against real LLM if the generation lands in this ticket.

## Open questions for the plan

1. Color-pair **generation scope**: pull the prep-engine hook + backfill into MYT-87, or split into its own bead (MYT-87 ships schema + `/mine` field + guard + a backfill, generation wired in MYT-89)?
2. Responsive card vs index: one breakpoint-driven component, or two presentational components behind a shared data hook?
3. The contrast-guard correction: re-roll the LLM, or deterministically snap one end to the nearest paper step?
