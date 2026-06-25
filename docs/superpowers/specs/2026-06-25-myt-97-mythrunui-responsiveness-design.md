# MYT-97 — mythrunUI Responsiveness + Mobile-Viewport Gate (Design)

> **Status:** Design approved 2026-06-25 (brainstorm). Next: implementation plan.
> **Milestone:** Frontend. **Priority:** Urgent — sequenced ahead of the flow tickets (every flow inherits these primitives).

## 1. Context — the gap

mythrunUI (MYT-82) shipped without responsiveness as a *first-class, enforced* property. The components use static token classes, the Storybook stories render at the default wide canvas, and there is **no mobile-viewport check in any gate** — so a primitive that doesn't shrink/wrap/truncate passes every test because nothing ever renders it at a phone width.

Surfaced during MYT-83's mobile audit:

- The **app-frame header overflows horizontally at 375px** — the settings affordance is shoved off the right edge and the page scrolls sideways. It is a *composition* bug: `Stack` + `Text` + `Button`, each fine in isolation, overflow together because the long content can't shrink.
- Capability check: **`Stack` has no shrink/wrap, `Text` has no truncate.** The flex `min-width: auto` default blocks children from shrinking below their content.

Prior art already on `main` from MYT-83: `Box minHeight="screen"` uses `100dvh` (the dynamic viewport — fills the mobile screen where `100vh` left a white gap), and the reversed-surface primitive. The breakpoint scale (`--breakpoint-sm … --breakpoint-2xl`) already exists in `theme.css` (Tailwind's), unused.

## 2. Goals / non-goals

**Goals**

1. Every mythrunUI primitive **gracefully handles a constrained width** — nothing overflows the viewport, by content/container-driven (intrinsic) behavior.
2. A **durable CI gate** renders every story at a mobile (375px) and a desktop (~1280px) width and fails the build on horizontal overflow — so non-responsive surfaces can't ship, the same way `story-coverage` and the lint rails gate the other rules.
3. The gate covers **components *and* assembled screens** (the composition layer where the header bug lived).

**Non-goals**

- A full breakpoint-tuned responsive *redesign* of every component (responsive type scales, per-screen layouts). Intrinsic behavior is the default and is sufficient for "works on mweb."

## 3. The responsive model — intrinsic-first, breakpoints permitted

**Intrinsic by default.** Responsiveness is content- and container-driven (shrink, `min-width: 0`, truncation, wrapping) — it works at any width with no magic numbers, and it is expressible in the **platform-neutral contract** (`Stack.wrap`, `Text.truncate`), so the future native port inherits it (native flexbox shrinks; native text truncates via `numberOfLines={1}`).

**Breakpoints are permitted, not forbidden.** Where a component genuinely needs a *structural* break (a nav that collapses to a hamburger, a row that becomes a column on mobile), it may use the existing `--breakpoint-*` tokens (`sm:`/`md:`/`lg:`) in its **web impl**. The contract stays neutral; a breakpoint-using component is a *flagged platform-divergence point* — the native port supplies its own equivalent, the same contained-swap pattern as the R4 combat renderer. **No lint bans breakpoints.**

**The gate is outcome-based.** It asserts the *result* — zero horizontal overflow at 375px + desktop — not the *mechanism*. An intrinsically-shrinking row and a breakpoint-collapsing nav both pass identically.

## 4. Primitive changes

Contract = `frontend/client-core/src/contract/*`; web impl = `frontend/ui/src/components/*`.

- **`Stack`** — apply `min-width: 0` to its children (e.g. a CVA `[&>*]:min-w-0`). The flex `min-width: auto` default is *exactly* what forces a long child to overflow; `min-width: 0` lets children shrink **only when the container is too small** — no effect otherwise — so it is a safe default that makes every `Stack` constrain gracefully. Add a **`wrap?: boolean`** prop (→ `flex-wrap`) for genuine wrap cases (generally useful; not the header).
- **`Text`** — add a **`truncate?: boolean`** prop → single-line ellipsis (`overflow-hidden` + `text-ellipsis` + `whitespace-nowrap`). Native maps to `numberOfLines={1}`.
- **The other 30 components** — *not* changed speculatively. The new gate (§5) renders each at 375px and lights up the ones that actually overflow (a handful with fixed min-widths or non-shrinking content); those get fixed. The gate **finds** the audit work rather than us guessing it.

New contract props: `Stack.wrap`, `Text.truncate`. The child `min-w-0` is an automatic impl detail, not a prop.

## 5. The gate

- **`@storybook/test-runner`** (Playwright-backed) + a **`postVisit` hook** (`.storybook/test-runner` config). For every story: set the viewport to **375px**, then **~1280px**, and assert `document.documentElement.scrollWidth <= clientWidth` (no horizontal overflow). One hook, all stories — no separate test list, mirroring how `story-coverage` auto-covers "every component has a story."
- **Coverage = components + screens.** Alongside the 32 component stories, the app screens (the frame, home hub, 404, route stubs) gain **screen stories** rendered through a Storybook decorator that wraps them in the app providers with a **seeded `QueryClient`** (mock data via `queryClient.setQueryData`, plus the session store seeded `ready`) — so a screen renders fully with no network. This is what catches composition overflow like the header.
- **Storybook topology** (finalize in the plan): one gate must see both the `@mythrun/ui` component stories and the `@mythrun/web` screen stories. Likely a frontend-level Storybook scanning both packages' `*.stories`, or the test-runner run against both Storybooks. The decision is mechanical; the requirement is one 375px+desktop overflow gate over both story sets.
- **CI / pre-push.** A new step (`build-storybook` → `test-runner`) added to `frontend-check.yml` and `.husky/pre-push` (diff-scoped to `frontend/`), with the Playwright browser install the test-runner needs.
- **Standing convention:** every screen ships a story → auto-gated at 375px. Each future flow ticket extends the gate for free by adding its screen's story.

## 6. The known fix — the header

The app-frame header truncates to a **single quiet row** (Miklos's call — not wrap): the identity `Text`s gain `truncate`, the `Stack` children shrink (the new `min-w-0`), so a long display name ellipsizes instead of shoving the settings affordance off-screen. Locked in by a new app-frame screen story gated at 375px. (The long *placeholder* strings overflow today; the same fix also handles a long *real* display name, which is the production reason it's needed.)

## 7. Rollout / testing (TDD)

1. Add the primitive capabilities (`Stack` child-shrink + `wrap`, `Text` truncate) — failing story/unit test first, then impl, per capability.
2. Stand up the gate (test-runner + the `postVisit` hook + the CI/pre-push wiring + the Storybook topology).
3. The gate lights up the overflowing components and screens → fix each (including the header). Add the screen stories.
4. Gate green across all stories at 375px + desktop.

Order matters: the primitives + the gate come first, because the gate is what *reveals* the per-component audit work in step 3.

## 8. Portability (R2/R3/R4)

Intrinsic responsiveness lives in the platform-neutral contract (`wrap`, `truncate`) — the native port inherits it. A component that reaches for a web breakpoint is a known, contained platform-divergence point (the native port supplies its own structural break), explicitly permitted and consistent with the R4 renderer-swap pattern. The gate (a web/Playwright concern) validates the web impl; the native port will carry its own equivalent gate when it exists.

## 9. Done when

- The 375px + desktop overflow gate is **green across all stories** — the 32 components *and* the app-screen stories (frame, home, 404, stubs).
- The app-frame header (and every component) renders with **no horizontal overflow** at 375px and desktop.
- The gate **fails the build on a regression**, wired into `frontend-check.yml` + pre-push.
- `Stack.wrap` and `Text.truncate` exist in the contract with stories + tests; breakpoint use remains available and unlinted.
