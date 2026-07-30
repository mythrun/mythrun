# NavBar Redesign — Design

2026-07-30. Brainstormed with Miklos against seven concrete grievances; every
visual decision below was approved from rendered comparisons (real SVG assets,
real palette, to scale) in the visual companion, session
`.superpowers/brainstorm/376-1785421077/`.

## Context

The header shipped by MYT-99 reads as unconsidered despite its six documented
fixes. The grievances, with diagnosis:

1. **Brand lockup too small** — renders at 36px against the component's 56px
   default, in a fixed 64px bar at every viewport width.
2. **Spacing/typography whack** — four unrelated font sizes, three weights,
   flat 20px gaps, gutters unaligned with page content.
3. **Settings gear looks stupid / wrong icon set** — the gear IS the
   pixelarticons `settings` glyph (verbatim path data), rendered at `size="sm"`
   where the 24-grid pixel gear aliases into a generic cog. The icon set was
   never the problem; the size and the affordance were.
4. **Gear and "Add credits" lead to the same page** — a documented interim from
   MYT-99 ("until MYT-95 ships the dedicated buy flow"). MYT-95 shipped; the
   interim outlived its reason. `/settings` literally renders
   `billing.sectionTitle`.
5. **No hamburger** — and consequently no reachable Log out: client-core ships
   a `logout` endpoint that no UI component calls.
6. **Bottom border always on** — a constant `<Divider/>` under the bar.
7. **Mobile loses information** — identity and Add credits vanish below `sm`
   with no recovery affordance.

Theory anchors (NN/g, read during brainstorm): hamburger menus are mobile-only
(desktop hidden-nav costs ~39% task time, ~21% perceived difficulty); utility
navigation belongs top-right with text labels, not bare icons; don't over-hide
critical tools.

## Decisions (all user-approved)

| Decision | Choice |
|---|---|
| Brand asset | Full `HorizontalLockup` at EVERY viewport (mobile included) |
| Sizing | Fluid: lockup `clamp(30px, 22px + 2.12vw, 56px)` — 30px at 375, full 56px by 1600px. Bar padding `clamp(10px, 8px + 0.5vw, 16px)` |
| Desktop right cluster | Credits readout · labeled "Add credits" button · **display name as menu trigger** (with `chevron-down`). No gear, anywhere |
| Desktop menu contents | Sessions & billing · Log out |
| Mobile bar (below `sm`) | Lockup (30px) · credits readout · pixelarticons `menu` hamburger |
| Mobile menu contents | Display name (non-interactive header row) · Campaigns · Add credits · Sessions & billing · Log out |
| Border | None at rest. Hairline appears only once content scrolls beneath |
| Scroll compaction | Bar compacts ~15% when scrolled (lockup ×0.82, padding to the clamp floor), animated; disabled under `prefers-reduced-motion` |
| Typography | One 14px chrome size in `font-ui`, letter-spacing 0.01em; the credit NUMBER is the only weight accent (600, `tabular-nums`); label in `ink-tertiary`, value in ink |
| Rhythm | 32px between clusters, 8–16px within; horizontal gutters match the page content gutter (32px desktop / 16px mobile) |
| IA | `/settings` route renamed `/billing`, titled "Sessions & billing"; `/settings` 301-style client redirect for old links; "Add credits" deep-links to the buy section (`/billing#buy`); a real account-settings page is explicitly OUT of scope |

## Architecture

No new design-system primitives are needed — `Menu`, `Popover`, `Icon`
(`menu`, `chevron-down` glyphs), `HorizontalLockup`, `Button`, `Show`,
`Stack`, `Box`, `Divider` all exist. The work is composition plus one small
reusable behavior:

- **`useScrollElevation()`** (client-core, new): returns `{ elevated }` from an
  IntersectionObserver on a 1px sentinel rendered immediately below the header.
  Pure logic, no DOM assumptions beyond the sentinel ref it hands back.
  Elevated ⇢ hairline + compaction. Rationale: scroll listeners with thresholds
  jitter; a sentinel observer is binary and cheap.
- **`AppFrame`** (web, rewrite of the header region): fluid sizing via inline
  CSS custom properties (`--bar-lockup`, `--bar-pad` holding the clamp()
  expressions — tokens stay in one place), the two responsive arrangements,
  the menu(s), the sentinel + elevated state.
- **`HeaderMenu`** (web, new file beside app-frame): the shared menu content
  list, parameterized by viewport arrangement (desktop: no Campaigns/Add
  credits rows; mobile: full list) so the two menus cannot drift. Renders DS
  `Menu`. Log out calls client-core `logout`, then hard-navigates to `/`
  (auth state must not survive in memory).
- **Routes** (web): `billing` route + redirect element for `settings`.
  `SETTINGS_PATH` const dies; `BILLING_PATH = '/billing'`, `BUY_ANCHOR =
  '#buy'`. The billing page gains `id="buy"` on its purchase section.

### Menu behavior

DS `Menu` supplies keyboard nav + aria. Trigger: desktop = ghost button whose
label is the display name + `chevron-down` icon (`aria-expanded`,
`aria-haspopup="menu"`); mobile = `IconButton icon="menu"` at 22px in a 44px
target. Items are labeled text only — no icons inside the menu (utility-nav
guidance: labels carry meaning; icons would re-import the ambiguity we're
removing). Identity fetch failure (HeaderIdentity's existing boundary):
desktop trigger falls back to the literal menu icon button (mobile
arrangement's trigger) so the menu never disappears with the name.

### fullBleed (live play stage)

Unchanged policy, new mechanics: on `fullBleed` routes the "Add credits"
button stands down (myth-u5qro — no concession-hawking during the overture);
the menu remains (it now carries Sessions & billing, so billing stays
reachable, same as today's gear-arrangement). Scroll elevation is inert on
fullBleed (the stage doesn't scroll the document).

### Copy (new i18n keys, register: Lucas-Pope terse)

- `frame.menu` = "Menu" (a11y label, mobile trigger)
- `frame.accountMenu` = "Account menu" (a11y label, desktop trigger)
- `frame.campaigns` = "Campaigns"
- `frame.sessionsBilling` = "Sessions & billing"
- `frame.logout` = "Log out"
- `billing.sectionTitle` stays; the route/title mismatch resolves by the
  rename, not new copy.

Flagged for the standing copy veto pass.

## Testing

- `use-scroll-elevation.test.ts` — sentinel visible ⇢ not elevated; sentinel
  exits viewport ⇢ elevated; observer disconnects on unmount.
- `app-frame.test.tsx` additions — desktop: name-trigger opens menu with
  exactly [Sessions & billing, Log out]; no gear testid remains; Add credits
  navigates to `/billing#buy`. Mobile (375): hamburger opens full list;
  credits readout present; identity absent from the bar but present as menu
  header. fullBleed: buy hidden, menu present. Logout: calls the endpoint,
  navigates to `/`.
- Redirect test — `/settings` lands on `/billing`.
- Storybook — AppFrame stories: rest, elevated, mobile, mobile-menu-open,
  desktop-menu-open, fullBleed. The CI-only 375px overflow + a11y sweep gates
  them (contrast: all text ≥ 4.5:1 on paper-100 — ink-tertiary at full
  opacity passes at 5.18:1, verified during the WhisperLedger fix).
- Visual audit — Miklos reviews the built result locally BEFORE push (standing
  rule; no push until his OK).

## Out of scope

- A real account-settings page (display name editing, theme, etc.) — future
  ticket; the menu simply doesn't link a page that doesn't exist.
- Primary-nav sections beyond Campaigns (none exist yet).
- Any change to `HeaderCredits`/`HeaderIdentity` data plumbing (boundaries
  stay; only their placement moves).
