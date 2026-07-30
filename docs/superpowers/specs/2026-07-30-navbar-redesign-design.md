# NavBar Redesign — Design (v2, post blind review)

2026-07-30. Brainstormed with Miklos against seven concrete grievances; every
visual decision was approved from rendered comparisons (real SVG assets, real
palette, to scale) in the visual companion, session
`.superpowers/brainstorm/376-1785421077/`. Revised after a three-lens blind
review (Garamond/interaction+a11y, Baskerville/responsive+layout,
Caslon/IA+routing): one showstopper (the scroll mechanics were unspecified —
§Scroll mechanics is new and normative) and the "no design-system work" claim
was false four ways — §Design-system work now enumerates it honestly.

## Context

The header shipped by MYT-99 reads as unconsidered despite its six documented
fixes. The grievances, with diagnosis:

1. **Brand lockup too small** — renders at 36px against the component's 56px
   default, in a fixed 64px bar at every viewport width.
2. **Spacing/typography whack** — four unrelated font sizes, three weights,
   flat 20px gaps, gutters unaligned with page content.
3. **Settings gear looks stupid / wrong icon set** — the gear IS the
   pixelarticons `settings` glyph, rendered at `size="sm"` where the 24-grid
   pixel gear aliases into a generic cog. Size and affordance were the
   problem, not the icon set.
4. **Gear and "Add credits" lead to the same page** — a documented interim
   from MYT-99 that outlived MYT-95 shipping. `/settings` literally renders
   `billing.sectionTitle`.
5. **No hamburger** — and consequently no reachable Log out: client-core
   ships a `logout` endpoint no UI calls.
6. **Bottom border always on** — a constant `<Divider/>` under the bar.
7. **Mobile loses information** — identity and Add credits vanish below `sm`
   with no recovery affordance.

Theory anchors (NN/g): hamburger menus are mobile-only (desktop hidden-nav
costs ~39% task time); utility navigation belongs top-right with text labels;
don't over-hide critical tools.

## Decisions (user-approved; numbers corrected per review)

| Decision | Choice |
|---|---|
| Brand asset | Full `HorizontalLockup` at EVERY viewport. Sizes below are BOX heights — the asset's 1284×548 viewBox carries internal padding, so drawn art is ~half the box; box width = height × 2.343 |
| Sizing | Fluid: lockup `clamp(30px, 22px + 2.12vw, 56px)` — 30px at 375, full 56px from ~1604px. Bar vertical padding `clamp(10px, 8px + 0.5vw, 16px)`. Horizontal bar gutter FIXED 32px, aligned with the content Box gutter (`--space-6`), all viewports. Note: below `sm` the bar's height is governed by the 48px hamburger control, not the lockup |
| Desktop right cluster | Credits readout · labeled "Add credits" button (`size="md"` — 14px) · **display name as menu trigger** (trailing `chevron-down`). No gear, anywhere |
| Desktop menu contents | Sessions & billing · Log out |
| Mobile bar (below `sm`) | Lockup (30px) · credits readout · `IconButton icon="menu" size="lg"` (24px glyph in a 48px control — native 24-grid, no aliasing; coarse-pointer floor guarantees ≥44px) |
| Mobile menu contents | Display name (non-interactive HEADER row — a real menu-label kind, not a disabled item; row omitted when identity is unavailable) · Campaigns · Add credits · Sessions & billing · Log out |
| Border | None at rest. The hairline is an ALWAYS-MOUNTED bottom border that swaps color transparent → `--border` on elevation (no 1px layout shift) |
| Compaction | The bar's layout box NEVER changes height (zero CLS). On elevation the LOCKUP alone compacts via `transform: scale(0.82)`, origin left-center — desktop only (`sm+`); below `sm` the control-governed bar height makes compaction meaningless. `prefers-reduced-motion`: states still swap, transitions disabled |
| Typography | One 14px chrome size, letter-spacing 0.01em — a NEW `chrome` type role (see §Design-system work). Credit NUMBER is the only weight accent (600, `tabular-nums`); label `ink-tertiary`, value ink. Credits label is **"Credits"** (per the approved mocks), not "Session credits" |
| Rhythm | 32px between clusters, 8–16px within |
| IA | `/settings` → `/billing`, titled "Sessions & billing"; `/settings` redirects (`<Navigate replace>` preserving search + hash, inside the authed AppFrame branch); "Add credits" deep-links to the buy section via `/billing#buy` with a REF-BASED scroll (below); a real account-settings page is OUT of scope |
| fullBleed | Desktop "Add credits" button stands down (myth-u5qro). The mobile menu's Add-credits ROW stays — the analogue of today's billing-reachable-behind-the-gear phone arrangement. Elevation is inert (the play stage scrolls internally) |

## Scroll mechanics (normative — the showstopper fix)

- The bar is `position: sticky; top: 0`, keeping its flow slot (the fullBleed
  "header + content = one viewport" math is unaffected). z-index: one layer
  above content, below the Menu portal's `--z-dropdown` (add `--z-sticky: 100`
  if no token exists).
- **Elevation signal:** a 1px, absolutely-positioned sentinel at the TOP of
  the scrolled document (above the header in DOM, `position:absolute; top:0`,
  occupying no flow space). `IntersectionObserver`, default root; `elevated =
  !isIntersecting`. Fires within ~1px of scroll — decoupled from bar height,
  no rootMargin compensation, no hysteresis coupling with compaction.
  A sentinel *below* a sticky bar is wrong (IO does not model occlusion; it
  fires a full bar-height late) — do not "simplify" back to that.
- **Zero-CLS rule:** elevation may change paint only (border color,
  transform), never the bar's layout box. This is why compaction is a
  transform on the lockup, not a height/padding change, and why the hairline
  is a color swap on an always-present border.
- The hook lives in `frontend/src/platform/web/use-scroll-elevation.ts` —
  NOT client-core (IntersectionObserver is a web API; client-core stays
  platform-neutral). It accepts `forceElevated?: boolean` so stories/tests can
  pin the state deterministically.
- **`/billing#buy` scroll:** React Router does not fragment-scroll, and the
  buy section mounts inside a Suspense boundary, so a DOM `id` anchor works in
  NO navigation mode. Instead: the billing page holds a ref on the purchase
  section; an effect fires after the suspended content resolves — if
  `location.hash === '#buy'`, `scrollIntoView` with `scroll-margin-top` = bar
  height var (the sticky bar would otherwise occlude it). No `id` attribute
  needed (BaseProps has no `id`; this dodges a DS change).

## Design-system work (enumerated — replaces the false "composition only" claim)

1. **Menu** (contract + ui + stories): a `header` row kind (renders as
   Radix `DropdownMenu.Label` — the identity row must NOT be a disabled
   menuitem, which screen readers announce as dimmed); a Popover-style width
   cap (`min(20rem, available)` — today's content has `min-w` but no max, so
   a long name would clip past the viewport, invisibly to the overflow gate
   since the portal is position:fixed); a coarse-pointer min-height floor on
   items (44px, matching Button/IconButton convention); **dark-theme
   highlight fix** — `data-highlighted` currently swaps to `--surface-hover`,
   which in dark theme equals `--surface-raised` (both paper-700), making
   keyboard focus and hover INVISIBLE in the menu; use `--surface-active`
   (paper-600) or a dedicated token for the raised tier. Menu has no current
   consumers, so this latent collision goes live with us.
2. **HorizontalLockup** (contract + ui + story): a fluid sizing mode — accept
   a CSS length for `size` or a `fluid` flag (SVG `height:100%` +
   `aspect-ratio` box) — today's numeric-only `size` writes SVG width/height
   attributes and cannot take `clamp()`.
3. **Button** (contract + ui + story): a trailing icon slot (`iconTrailing`)
   — the icon slot is leading-only and icon-in-children is contract-banned.
   Desktop trigger label: `max-width` ~16rem with truncation (display names
   are unbounded; the repo's own adversarial story uses 70 chars).
4. **Type role** (client-core tokens + ui typography): a `chrome` role — 14px,
   0.01em tracking. No existing role matches (data = 14px plain, meta = 12px).
5. **Icon/IconButton**: NO new sizes — the hamburger is `lg` (24px in 48px).

## Architecture (web)

- **`AppFrame`** (rewrite of the header region): fluid sizing via CSS custom
  properties (`--bar-lockup`, `--bar-pad`); the two responsive arrangements
  via `Show`; sticky positioning + sentinel + elevated state; testids are
  arrangement-scoped (`frame-credits-desktop` / `frame-credits-mobile` —
  both arrangements mount, so unscoped testids would double-match; note
  HeaderCredits' per-navigation invalidation effect will run once per
  mounted instance).
- **`HeaderMenu`** (new, beside app-frame): one parameterized menu-content
  list so the desktop and mobile menus cannot drift. Desktop trigger: ghost
  Button, label = display name (the VISIBLE name is the accessible name — no
  aria-label override; voice-control users must be able to say what they
  see), trailing chevron. Identity pending OR failed: the trigger falls back
  to `IconButton icon="menu"` in BOTH arms (a null pending fallback would
  leave Log out unreachable during every cold `/me` fetch). Menus close on
  arrangement change (a breakpoint resize with a portal open would strand an
  open menu whose trigger is display:none).
- **Log out:** await `logout`; on 2xx hard-navigate `/` (module-scoped token
  + QueryClient die with the document); on failure show the standing error
  Toast and do NOT navigate — navigating with a live refresh cookie
  resurrects the session on the next load, which is the worst possible
  outcome for the one action about leaving. Single-fire: item disabled while
  pending.
- **Routes:** `billing` route + `settings` redirect. Shared consts in one
  module (`BILLING_PATH`, `BUY_ANCHOR`): three `/settings` consumers exist —
  app-frame.tsx:41, billing/checkout-return.tsx:19,
  billing/checkout-cancelled.tsx:10 (update their comments, which describe
  the old IA). `settings.tsx`/`settings.stories.tsx` rename with the route
  (screen-story-coverage pairs them). Wiki pages pinning `/settings`
  (frontend/billing-credits.html, campaign-hub.html) sync per the standing
  protocol this cycle.

## Copy (new/changed i18n keys, register: Lucas-Pope terse; flagged for veto)

- `frame.credits` = "Credits" (replaces the "Session credits" label — matches
  the approved mocks and buys the 375px arrangement its slack)
- `frame.menu` = "Menu" (a11y label, icon triggers)
- `frame.campaigns` = "Campaigns"
- `frame.sessionsBilling` = "Sessions & billing" (duplicates
  `billing.sectionTitle`'s string — intentional, menu label vs page title;
  flagged so the veto pass sees both)
- `frame.logout` = "Log out"
- The mobile menu's Add-credits row reuses `frame.buyCredits` (one string for
  button and row, no drift)
- REMOVED: `frame.settings` (dead with the gear), `frame.accountMenu` (the
  visible name is the accessible name)

## Testing

- Global test setup: an `IntersectionObserver` stub (jsdom has none; without
  it every AppFrame-mounting suite throws).
- `use-scroll-elevation.test.ts` — stub-driven: intersecting ⇢ not elevated,
  not-intersecting ⇢ elevated, disconnect on unmount, `forceElevated` wins.
  Real scroll behavior is validated on the Storybook/visual-audit leg, not in
  jsdom.
- `app-frame.test.tsx` — desktop: name-trigger opens menu with exactly
  [Sessions & billing, Log out]; no gear testid; Add credits navigates to
  `/billing#buy`. Mobile (375): hamburger opens the full list with the
  identity header row; credits readout in the bar. fullBleed: desktop buy
  hidden, menus present, mobile Add-credits row present. Logout: success ⇢
  endpoint called + hard-nav; failure ⇢ toast, NO navigation. Identity
  pending/failed ⇢ icon trigger present (menu never unreachable).
- Redirect: `/settings?x=1#buy` lands on `/billing?x=1#buy` (replace
  semantics). Billing: arriving with `#buy` scrolls the purchase section into
  view after suspense resolves (assert the scroll target, not just the URL).
  `router.test.tsx`'s data-free authed stub moves off `/settings` (it was
  chosen for mounting no queries; `/billing/cancelled` has the same
  property).
- Storybook — AppFrame stories: rest, elevated (`forceElevated`), mobile,
  mobile-menu-open, desktop-menu-open (BOTH themes — the dark-theme
  highlight fix must be visible), fullBleed, adversarial: 70-char display
  name at a mid viewport, 5-digit credit balance at 375. REMOVE the stories'
  current `a11y: {test:'off'}` exemption — the gate only gates what it
  measures.
- Visual audit — Miklos reviews the built result locally BEFORE push.

## Out of scope

- A real account-settings page (future ticket; the menu links nothing that
  doesn't exist).
- Primary-nav sections beyond Campaigns.
- `HeaderCredits`/`HeaderIdentity` data plumbing (boundaries stay; placement
  and label copy change only).
