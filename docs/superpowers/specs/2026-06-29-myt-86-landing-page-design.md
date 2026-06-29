# MYT-86 — Public Landing Page — Design

> **Status:** Brainstormed 2026-06-29; revised after blind review (Marceline / Mordecai / Flapjack / Chowder — 0 showstoppers, nits folded in). Ready for writing-plans (pending the user-review gate).
> **Linear:** MYT-86 (Frontend milestone). **Depends on:** MYT-83 (app shell, routing, the landing stub), MYT-84 (auth + the `ThemeToggle` FAB), the `@mythrun/ui` design system.

## Goal

The public landing page: a visitor lands, gets the pitch in the brand's quiet register, and routes to sign-up. **Lean MVP** — hero + transparent pricing + an inverted footer, with a responsive nav. The optional 3-section scroll and the "See it in action" demo are deferred to follow-up tickets (they need things that don't exist yet).

## Brand frame (the visual source of truth — `../../Design/mythrun-design`)

Parchment & Ink — near-monochrome: **ember `#8A5A3C`** is the only saturated color, used sparingly as an accent; everything else is paper tones + the four semantic tokens. **Dithering is the only gradient technique** (smooth CSS/SVG gradients forbidden) and it is a **section transition, not a background, and only where a contrast is committed**. Pixel-art quill logomark. **Source Serif 4** prose / **IBM Plex Mono** chrome. Voice: second-person at-the-table, Lucas-Pope terse. The AI is infrastructure — never the pitch ("powered by Claude" is forbidden). Quiet, patient, confident enough to be quiet.

## Scope

**In:** the responsive nav; the hero; the transparent pricing line; the dither-to-inverted-footer; **two small `@mythrun/ui` additions** (a `placement` mode for `ThemeToggle` + semantic-landmark support). **Out (deferred):**
- The optional 3-section scroll (Create a world / Build your character / Play with friends) — needs MYT-88's animation system + the flow previews.
- The "See it in action" demo video — no real sessions / demo video exist yet.
- The real `$X` pricing value — lands with MYT-95 (billing).
- The real copy — Miklos writes it (placeholders here).
- **Live Terms / Privacy destinations** — no `/terms`,`/privacy` routes exist yet; footer links are placeholders.

## The five units (composed from `@mythrun/ui`; nav / main / footer are semantic landmarks)

1. **Nav — `<nav>` landmark, responsive, minimal.** `HorizontalLockup` on the left (the brand's prescribed nav-bar lockup — `guidelines.md`: the horizontal mark-on-right secondary lockup is "for site nav bars / narrow headers"; the stacked `Lockup` is too tall for a band). A right cluster: the inline `ThemeToggle` + a **"Sign in" `Button` pinned to `variant="secondary"`** (NOT the default ember `primary`, so the hero CTA stays the page's *sole* ember accent — `signin.tsx` does this for the same reason). Both the nav "Sign in" and the hero CTA navigate to `/auth/signin` via **`useNavigate`** (`Button` is a real `<button>` with `onPress`, no `href`; the `@mythrun/ui` `Link` is a full-reload `<a>`, wrong for internal SPA nav — right only for the footer mailto/external link). No content tabs; the three compact items (HorizontalLockup + 48px toggle + Sign-in) fit at ~375px with `justify-between` slack (budget verified ≈ 230–270px of 375) → no hamburger. Mono chrome.

2. **Hero — `<main>` landmark, clean paper, NO dither.** A **visually-hidden `Heading level={1}`** carries the page's accessible / SEO title (the *visual* title is the stacked `Lockup`, which is `role="img"` + aria-label — not a heading; a public page needs a programmatic h1). Centered, generous whitespace: the stacked quill `Lockup` + an evocative line in Source Serif 4 (`[ph_landing_tagline: a terse at-the-table line, ~1 sentence — what a session feels like]`) + the **primary CTA** — an ember `primary` `Button` whose label is also brand prose Miklos writes: `[ph_landing_cta: a terse primary-CTA label — enter a session]` (NOT a hardcoded "Start your adventure" — that's a landing-page header, the brand owner's to write, and "adventure" is an abstraction off the concrete-noun terse register). The CTA → `/auth/signin`.

3. **Pricing line.** A single transparent line below the hero, a `Text` with a **mono/data role** (the transparency line sits on the data side of the brand's serif-prose / mono-data split): `[ph_landing_pricing: one line — sessions start at $X, your first is free]`. Real `$X` lands with MYT-95.

4. **Dither transition — light theme only.** The page's one dither moment — the `Dither` component, **vertical, `scale="hero"` (full-bleed 6px), `paper-100 → paper-900`** (the brand's sanctioned "Light → ink" pairing) — bridging the light page into the dark footer. **Theme-gated: rendered only in light theme.** In dark theme the page is already `paper-900`, so page→footer is dark-on-dark with no committed contrast → **no dither** (per the brand rule — "only where genuine color contrast is committed"); just the footer edge (a hairline `Divider` if separation is needed). This is deliberately **not** the signin-crown pattern: that crown fades into the page *field* (which flips with theme); this dither terminates into an **always-`paper-900` footer**, so a dark-theme dither would have no contrast at its terminus.

5. **Footer — `<footer>` landmark, inverted dark.** Ground = **`Box surface="reversed"`** (the precedented inversion — `not-found.tsx` uses it: it scopes `.dark` to the subtree so `--ink` → paper-100, giving light-on-dark text; a naive `bg-paper-900 text-ink` would be paper-900-on-paper-900 = invisible). `paper-900`, mono chrome, low-key. The legal/contact line is **`Trans` rich-text** (the `common.json` `richSample` precedent — `[ph_rich-text with a <1>link</1>]` consumed via `<Trans components={…}/>`) so the link labels live INSIDE the placeholder for Miklos: `[ph_landing_legal: <1>Terms</1> · <2>Privacy</2> · <3>Questions?</3> — a short legal/contact line]`, rendered with `components={{ 1: <Link/>, 2: <Link/>, 3: <Link/> }}`. Links carry a **non-color affordance** (underline — WCAG 1.4.1, since mono/single-color) + an adequate hit area on mweb. Terms / Privacy are **placeholder links** (no routes yet — a follow-up wires destinations); "Questions?" is a `mailto:` / contact link.

## `@mythrun/ui` additions (the two small design-system changes)

1. **`ThemeToggle` `placement` prop.** `placement="fab"` (the default — unchanged: the fixed-top-right FAB; the genesis screens **signin + onboard** keep it; note `callback` has no toggle) vs `placement="inline"` (drops only the `fixed top-right` classes → a normal in-flow 48px square, for a nav cluster). Optional prop + `fab` default leaves the existing screens + the toggle's test/story untouched. Add `export type ThemeTogglePlacement = 'fab' | 'inline'` to the `@mythrun/client-core` contract (`contract/theme.ts`, where `ThemeToggleProps` lives) AND re-export it from the `@mythrun/ui` barrel (every prop union is aliased + twin-barrelled). Update the now-stale "canonical FAB / self-positioning fixed top-right" docstrings on `contract/theme.ts` + `ThemeToggle.tsx`. The toggle's **accessible name** should be action/state-oriented ("Switch to dark theme", theme-aware) rather than the bare "Theme" — it's elevated into a nav here.

2. **Semantic-landmark support.** No current primitive emits `<nav>`/`<main>`/`<footer>`/`<header>` (`Box`/`Stack` hardcode `<div>`; only `Text` is polymorphic) — so the landing's nav/main/footer would otherwise be anonymous `<div>`s (an a11y/SEO miss on the most public page) or raw elements (which the no-ad-hoc-UI rail forbids). Add a minimal landmark capability — an `as: 'nav' | 'main' | 'footer' | 'header' | 'section'` prop on `Box` (preferred — it already owns `surface`/`minHeight`), or dedicated landmark wrappers — so the landmarks are first-class. This is also the natural home if the nav is later promoted from route-local.

## Theming

Theme-aware (light + dark via the nav toggle); both on-brand (paper-100 warm light / paper-900 warm dark). **The footer is always the reversed/dark surface.** The page→footer **dither fires only in light theme** (the committed light→dark contrast); dark theme drops it (dark-on-dark → no dither, per the brand rule). **WCAG AA caveat:** the ember `primary` Button is **sub-AA in dark theme** (its hardcoded `paper-50` label on `bg-accent` = ember-400 ≈ **3.25:1** vs the 4.5:1 floor; light theme's ember-600 ≈ 5.30:1 is fine). The fix lives in the shared Button / accent-on-fill token (a `@mythrun/ui` / MYT-82 concern, not MYT-86 markup) — the plan **pins a dark-theme CTA contrast check** and notes the token fix as the precondition for the "AA in both themes" claim. Body text (tagline / pricing via `--ink` / `--ink-tertiary`) clears AA in both themes.

## Copy / placeholders

Every user-facing string is an i18n key under a `landing.*` namespace. **Prose** — the tagline, **the hero CTA**, the pricing line, the footer legal line — uses `[ph_<name>: <intent + length hint>]`, length-matched to the expected real copy (Miklos writes it). **Only truly generic chrome** gets a real value — here just the nav **"Sign in"** label (consider "Continue", for register-consistency with `signin.google` / `onboard.continue` — Miklos's call). The footer Terms / Privacy / Questions labels live **inside** the `Trans` `[ph_landing_legal]` placeholder (they are NOT separate real-value keys). `descriptions.ts` needs an entry for **every** new key (including the "Sign in" chrome) or the `resources.test.ts` drift test fails. **Remove the obsolete `stub.landing` key** from `common.json` + `descriptions.ts` (+ any stub route/story reference) — it goes dead when the real page replaces the stub, and `i18n:todo` would otherwise report it as unwritten forever.

## Responsive

Desktop + ~375px mweb, responsive by construction (`min-h-dvh` via `Box minHeight="screen"`, flex with `min-w-0`; lockup + toggle are `shrink-0`). The nav stays compact at 375px (budget verified, no collapse). The hero / pricing / dither / footer stack cleanly. `prefers-reduced-motion` is moot (no animated primitives in the Lean MVP; the global reduced-motion reset is a backstop for the theme-flip color transition).

## Components / files (firmed in the plan)

- `frontend/src/routes/landing.tsx` — replace the stub; route-local `LandingNav` / `LandingHero` / `LandingFooter` (composition-only; YAGNI route-local until a 2nd consumer).
- `frontend/ui/src/components/ThemeToggle/ThemeToggle.tsx` (+ `@mythrun/client-core` `contract/theme.ts`, the `@mythrun/ui` barrel, an inline-mode story, the docstrings) — the `placement` prop + the `ThemeTogglePlacement` alias.
- `frontend/ui/src/components/Box/Box.tsx` (+ its contract) — the landmark `as` capability (or new landmark wrappers) + a test/story.
- `frontend/client-core/src/i18n/locales/en/common.json` + `descriptions.ts` — add `landing.*` (incl. chrome descriptions); **remove `stub.landing`**.
- `frontend/src/routes/landing.stories.tsx` — replace the stub story with the full landing at 375 + 1280.

## Verification

- **Vitest:** the route renders the five units + the `nav`/`main`/`footer` landmarks + the visually-hidden `h1`; the hero CTA and nav "Sign in" navigate to `/auth/signin`; the inline `ThemeToggle` renders + toggles, and `placement="fab"` still self-positions (genesis screens unbroken); no overflow at 375px.
- **a11y:** an `h1` exists; the toggle's accessible name conveys action/state; footer links carry a non-color affordance; **a dark-theme CTA contrast check** (flags the ember-on-dark sub-AA so it's a conscious gate, not a silent ship).
- **`@mythrun/ui`:** the `placement` prop has its own test + story; the landmark `as` has a test.
- **i18n:** `pnpm i18n:todo` output **includes** the landing prose placeholders (`landing.tagline` / `cta` / `pricing` / `legal`) and **excludes** the landing chrome (the tool lists every `[ph_` catalog-wide, so the assertion is inclusion/exclusion, not a scoped list); `stub.landing` no longer appears; the no-hardcoded-strings + no-ad-hoc-UI lint rails pass; `screen-story-coverage` passes.
- **Visual audit:** Miklos audits the rendered page before the push (build → local-OK → STOP for his exam → incorporate → push) — light + dark.

## Deferred (follow-up tickets)

- The optional 3-section scroll (needs MYT-88 + the flow previews); the "See it in action" demo; the real `$X` (MYT-95); the Terms / Privacy route destinations.
- The authed app-frame adopting `ThemeToggle placement="inline"` in its header.
- The shared Button / accent-on-fill **dark-theme contrast token fix** (MYT-82), if not resolved within MYT-86.
