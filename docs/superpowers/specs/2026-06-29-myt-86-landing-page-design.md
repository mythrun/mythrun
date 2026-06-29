# MYT-86 — Public Landing Page — Design

> **Status:** Brainstormed 2026-06-29. Ready for blind review → writing-plans.
> **Linear:** MYT-86 (Frontend milestone). **Depends on:** MYT-83 (app shell, routing, the landing route stub), MYT-84 (auth + the `ThemeToggle` FAB), the `@mythrun/ui` design system.

## Goal

The public landing page: a visitor lands, gets the pitch in the brand's quiet register, and routes to sign-up. **Lean MVP** — hero + transparent pricing + an inverted footer, with a responsive nav. The optional 3-section scroll and the "See it in action" demo are deferred to follow-up tickets (they need things that don't exist yet).

## Brand frame (the visual source of truth — `../../Design/mythrun-design`)

Parchment & Ink — near-monochrome: **ember `#8A5A3C`** is the only saturated color, used sparingly as an accent; everything else is paper tones + the four semantic tokens. **Dithering is the only gradient technique** (smooth CSS/SVG gradients are forbidden) and it is a **section transition, not a background**. Pixel-art quill logomark. **Source Serif 4** prose / **IBM Plex Mono** chrome. Voice: second-person at-the-table, Lucas-Pope terse. The AI is infrastructure — never the pitch ("powered by Claude" is forbidden on this page). Quiet, patient, confident enough to be quiet.

## Scope

**In:** the responsive nav; the hero (clean crown); the transparent pricing line; the dither-to-inverted-footer; and a new **inline mode** for `ThemeToggle`. **Out (deferred):**
- The optional 3-section scroll (Create a world / Build your character / Play with friends) — needs MYT-88's animation system + the flow previews.
- The "See it in action" demo video — no real sessions / demo video exist yet.
- The real `$X` pricing value — lands with MYT-95 (billing).
- The real copy — Miklos writes it (placeholders here).

## The five units (all `@mythrun/ui`)

1. **Nav — responsive, minimal.** `Lockup` (or `HorizontalLockup`) on the left; a right cluster of the inline `ThemeToggle` + a "Sign in" `Button` → `/auth/signin`. **No content tabs.** The three compact items fit at ~375px, so no hamburger / collapse is needed — the nav just stays compact. Mono chrome.

2. **Hero / crown — clean paper, NO dither.** Centered, generous whitespace: the stacked quill `Lockup` (mark + wordmark) + an evocative line in Source Serif 4 (`[ph_landing_tagline: a terse at-the-table line, ~1 sentence — what a session feels like]`) + the primary CTA "Start your adventure" (ember/primary `Button`) → `/auth/signin`. The crown carries **no** dither (a dither is a transition, not a backdrop).

3. **Pricing line.** A single transparent line below the hero: `[ph_landing_pricing: one line — sessions start at $X, your first is free]`. Trust-building; the real `$X` lands with MYT-95.

4. **Dither transition.** The one dither moment on the page — the `Dither` component, **vertical, `paper → paper-900`**, theme-aware (mirroring the signin-crown precedent: it grounds on the current theme's paper step and resolves to the inverted step) — bridging the light page into the dark footer. This is the page's single committed high-contrast color transition, so it is dithered (per the brand's dither rule).

5. **Inverted footer — dark.** `paper-900` ground in light theme (the inverted step); mono chrome, low-key: `[ph_landing_legal: a short Terms · Privacy line]` + a "Questions?" contact link (mailto or contact route).

## `ThemeToggle` inline mode (the cross-cutting addition)

Today `ThemeToggle` hardcodes `fixed top-right` — the genesis-screen FAB (MYT-84 §11), occluding the dither crown on signin/onboard/callback, which have no nav. The landing page **has** a nav whose top-right corner holds "Sign in", so a fixed-top-right FAB would collide with the nav band.

Resolution (the approved pattern): the toggle is **top-right everywhere**, but its mechanism adapts to context. `ThemeToggle` gains a **`placement` prop**:
- `placement="fab"` (the default — unchanged): the fixed-top-right FAB. Genesis screens keep rendering `<ThemeToggle/>` as today.
- `placement="inline"`: the same 48px-square sun/moon control as a normal in-flow element (no `fixed` positioning), for a nav's right cluster.

The landing nav uses `placement="inline"`; the authed app-frame's header adopts the same inline mode later (a small follow-up). Behavior (`useTheme().toggle`, the sun/moon glyph, the square + focus ring) is identical in both modes — only the positioning differs. This establishes the **"top-right toggle: FAB on genesis screens, nav-item on nav pages"** pattern across the product.

## Theming

Theme-aware: light + dark via the nav toggle — both on-brand (paper-100 warm light / paper-900 warm dark). The **footer is always `paper-900`** — the inverted/contrasting step relative to the brand's light default. The page→footer **dither fires only where a contrast is committed** (the brand's own rule — "the brand only uses dithering where genuine color contrast is committed to"): in **light** theme the light page → dark footer is a real contrast and is dithered; in **dark** theme the page is already `paper-900`, so page→footer is dark-on-dark with no contrast — no dither, just a plain edge (a hairline divider if visual separation is needed). The exact dark-theme footer separation is a visual-audit detail. No separate "fixed-light" landing — the toggle is present, so the page responds to it.

## Copy / placeholders

Every user-facing string is an i18n key under a `landing.*` namespace. **Prose values** use `[ph_<name>: <intent + length hint>]`, **length-matched to the expected real copy** so the layout holds when the real text drops in (Miklos writes it). **Functional action labels** ("Sign in", "Start your adventure") and footer link labels (Terms / Privacy / Questions?) get real values — they're generic chrome / the action itself. `pnpm i18n:todo` should flag exactly the prose placeholders (the `[ph_` ones), not the chrome.

## Responsive

Desktop + ~375px mweb, responsive by construction (`min-h-dvh`, flex with `min-w-0`). The nav stays compact at 375px; the hero, pricing, dither, and footer stack cleanly. `prefers-reduced-motion` is moot here (no motion in the Lean MVP).

## Components / files (firmed in the plan)

- `frontend/src/routes/landing.tsx` — replace the stub; compose the five units from `@mythrun/ui`. Likely split into small route-local subcomponents (`LandingNav`, `LandingHero`, `LandingFooter`) for focus; **if the nav is genuinely reusable by the authed app-frame, promote it to `@mythrun/ui`** — the plan decides (default: keep route-local until a second consumer exists, per YAGNI).
- `frontend/ui/src/components/ThemeToggle/ThemeToggle.tsx` — add the `placement` prop (+ an inline-mode story); the prop type lives in the `@mythrun/client-core` contract (where `ThemeToggleProps` is defined).
- `frontend/client-core/src/i18n/locales/en/common.json` + `descriptions.ts` — the `landing.*` keys.
- `frontend/src/routes/landing.stories.tsx` — replace the stub story with the full landing at 375 + 1280.

## Verification

- **Vitest:** the route renders the five units; "Start your adventure" + "Sign in" both navigate to `/auth/signin`; the inline `ThemeToggle` renders + toggles the theme; no overflow at 375px.
- **`@mythrun/ui`:** the `ThemeToggle` `placement` prop has its own test + story; `placement="fab"` still self-positions (genesis screens unbroken).
- **Storybook + gates:** the landing story renders at 375 + 1280; `screen-story-coverage` passes; `i18n:todo` flags only the prose placeholders; the no-hardcoded-strings + no-ad-hoc-UI lint rails pass.
- **Visual audit:** Miklos audits the rendered page before the push (this IS a consumer-facing surface — build → local-OK → STOP for his exam → incorporate → push).

## Deferred (follow-up tickets)

- The optional 3-section scroll (needs MYT-88 + the flow previews).
- The "See it in action" demo.
- The real `$X` pricing value (MYT-95).
- The authed app-frame adopting `ThemeToggle placement="inline"` in its header (small follow-up when that header is wired).
