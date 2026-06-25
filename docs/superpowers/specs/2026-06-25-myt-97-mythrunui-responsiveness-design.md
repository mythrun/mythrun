# MYT-97 — mythrunUI Responsiveness + Mobile-Viewport Gate (Design)

> **Status:** Design approved 2026-06-25 (brainstorm); refined after a 3-lens blind review (no showstoppers; convergent calibration findings folded in). Next: implementation plan.
> **Milestone:** Frontend. **Priority:** Urgent — sequenced ahead of the flow tickets (every flow inherits these primitives).

## 1. Context — the gap

mythrunUI (MYT-82) shipped without responsiveness as a *first-class, enforced* property. The components use static token classes, the Storybook stories render at the default wide canvas, and there is **no mobile-viewport check in any gate** — so a primitive that doesn't shrink/wrap/truncate passes every test because nothing ever renders it at a phone width.

Surfaced during MYT-83's mobile audit:

- The **app-frame header overflows horizontally at 375px** — the settings affordance is shoved off the right edge and the page scrolls sideways. It is a *composition* bug: `Stack` + `Text` + `Button`, each fine in isolation, overflow together because the long content can't shrink.
- Capability check: **`Stack` has no shrink/wrap, `Text` has no truncate.** The flex `min-width: auto` default blocks children from shrinking below their content.

Prior art on `main` from MYT-83: `Box minHeight="screen"` uses `100dvh` (the dynamic viewport — fills the mobile screen where `100vh` left a white gap), and the reversed-surface primitive. The breakpoint scale (`--breakpoint-sm … --breakpoint-2xl`) already exists in `theme.css` (Tailwind's), unused. (Review note: the codebase corroborates the "only a handful overflow" optimism — `Grid` already uses `minmax(0,1fr)`, `Modal` is `w-[min(92vw,32rem)]`, `Popover` clamps to the Radix available-width, and `Avatar`/`IconButton`/`Checkbox`/`Switch`/`RadioGroup` already declare `shrink-0`.)

## 2. Goals / non-goals

**Goals**

1. Every mythrunUI primitive **gracefully handles a constrained width** — nothing overflows the viewport, by content/container-driven (intrinsic) behavior.
2. A **durable CI gate** renders every story at a mobile (375px) and a desktop (`--breakpoint-xl` = 1280px) width and fails the build on horizontal overflow.
3. The gate covers **components *and* assembled screens** (the composition layer where the header bug lived), with a **screen-story-coverage forcing function** so the convention is enforced, not hoped.

**Non-goals**

- A full breakpoint-tuned responsive *redesign* of every component. Intrinsic is the default and is sufficient for "works on mweb."
- A pixel-perfect visual-regression baseline. The 375px gate guards *overflow* (the MYT-83 bug class); the standing "visually audit UI before push" rule + an optional 375px screenshot capture (§5) guard the *squish/overlap* class that overflow alone can't see.

## 3. The responsive model — intrinsic-first, breakpoints permitted

**Intrinsic by default, via the full canonical recipe** (the blind review caught that `min-width:0` is only half of it):

- **`min-width: 0` removes the flex content-floor** so a child *can* shrink. It is necessary but **not sufficient** — the graceful outcome (wrap or ellipsis) is a property of the *child*.
- **Shrinkable children** (text, content) wrap or truncate.
- **Fixed affordances** (icons, the settings button, avatars) opt OUT of shrinking with `flex-shrink: 0`, so the blanket `min-w-0` only bites content that can absorb it.

This is content- and container-driven (no magic numbers) and the *prop contract* (`Stack.wrap`, `Text.truncate`) is platform-neutral. **Native portability is by re-implementation behind the same prop, not automatic inheritance** (review correction): React Native's Yoga defaults `flexShrink` to 0 (opposite of web's 1) and `min-w-0` is a web impl detail, *not* a contract prop — so the native `Stack` must opt every shrinkable child in explicitly and native `Text` uses `numberOfLines={1}`. The contract is inherited (tsc-enforced); the *behavior* is a documented native obligation.

**Breakpoints are permitted, not forbidden.** Where a component needs a *structural* break (a nav that collapses to a hamburger, a row→column), it may use the `--breakpoint-*` tokens in its **web impl**. To make the "known, contained, *enumerable*" claim actually hold (the R4 analogy below requires it), every breakpoint use carries a **`@platform-divergent: breakpoint` doc-comment marker**, and the native-port enumeration target is `grep -rn '@platform-divergent: breakpoint'` (plus the raw `sm:|md:|lg:` prefixes). **No lint bans breakpoints.**

**The gate is outcome-based** — it asserts *no horizontal overflow* at 375px/desktop, agnostic to mechanism (intrinsic shrink or breakpoint collapse pass identically).

## 4. Primitive changes

Contract = `frontend/client-core/src/contract/*`; web impl = `frontend/ui/src/components/*`.

- **`Stack`** — apply `min-width: 0` to its children (CVA `[&>*]:min-w-0`). Lets children shrink only under constraint (no effect otherwise) and correctly cascades through nested Stacks. Add a **`wrap?: boolean`** prop (→ `flex-wrap`).
- **`Text`** — add a **`truncate?: boolean`** prop → single-line ellipsis (`overflow-hidden` + `text-ellipsis` + `whitespace-nowrap`). (All four Text roles are wrap-by-default today, so `min-w-0` already makes text shrink; `truncate` is the opt-in single-line case.)
- **Fixed-affordance protection (new, from review I1):** add `shrink-0` to **`Button`** (`whitespace-nowrap`, no overflow-hidden, no truncate — would spill under the new default) and to bare **`Icon`** (would squish). This joins the components that already self-protect (`Avatar`/`IconButton`/`Checkbox`/`Switch`/`RadioGroup`). This is a system-wide affordance decision stated here, not left to "the gate finds it."
- **The other components** — *not* changed speculatively. The gate (§5) + the 375px visual check light up the ones that actually overflow or squish; those get fixed.

New contract props: `Stack.wrap`, `Text.truncate`. `Box.minHeight` already exists. The child `min-w-0` and the affordance `shrink-0`s are impl details, not props.

**Audit is gate-driven *and visual* (review I3):** the overflow gate is **structurally blind** to the dominant side effect of a global `min-w-0` default — squish, overlap, over-truncation — none of which change `scrollWidth`. So the audit pairs the overflow gate with a 375px **visual review** (the standing UI-audit rule; optionally a `page.screenshot()` per story from the same Playwright run for a quick visual diff). The overflow boolean is the *regression-proof* net; the visual pass is the *squish* net.

## 5. The gate

**Runner.** `@storybook/test-runner` (Playwright) is the intended path; the plan must first **verify SB9 (`^9.1.20`) compatibility and weigh it against `@storybook/addon-vitest` (Storybook 9's blessed browser-mode story-testing)** — the addon reuses the repo's existing Vitest investment and may be cheaper/more deterministic. Either way the assertion + coverage below are identical.

**Assertion (calibrated, from review I1/I2):** for every story, set the viewport to **375px**, then **1280px** (`--breakpoint-xl`), and assert **`storyRoot.scrollWidth <= window.innerWidth`** — measuring `#storybook-root` against the *true* viewport (not `documentElement.clientWidth`, which excludes the scrollbar gutter and trips `vw`-sized overlays like `Modal`/`Toast`), with a **1px tolerance** for sub-pixel rounding. The gate run must **neutralize the global `p-6`/`layout:'padded'` preview padding** (a gate-specific preview / `layout:'fullscreen'` + a decorator that drops the padding) so a ≤375px-but-wide component doesn't false-fail against a ~295px real budget. A small **settle wait** (rAF / `waitForFunction`) precedes each measurement to avoid mid-reflow/animation flake.

**Coverage = components + screens.**

- **Overlay stories must render open (review I3):** Modal/Menu/Select/Popover/Tooltip/Toast portal to `document.body` only when open; the gate harness requires the open state (a default-open story or a `play` that opens) and asserts the portal is present before measuring — else 6 components are silently unmeasured.
- **Screen stories (review I2/I4, Neap-M1):** the app screens (frame, home hub, 404, **and the public branch** — landing/signin/callback/onboard/join/recap, several `:param`-bound) gain stories rendered through a decorator that composes **`createMemoryRouter` at the right entry with seeded params** + `AppProviders` (QueryClient + ApiContext + i18n) + the **seeded session store (`ready`)** + a **seeded `QueryClient`** (`setQueryData(['campaigns','mine'], …)` — `useMyCampaigns` is a *suspense* query, so a key/shape mismatch hangs forever; the harness **asserts the screen root testid** (`app-frame`/`route-home`) is present so a non-render fails loud, not as a timeout-flake). The app-frame story mounts a child route so the `<Outlet/>` is non-empty.
- **Adversarial content (review Ebb-I4):** screen/composition stories seed **worst-case-length** content (long display name, long campaign title), so intrinsic shrink is actually under test — a short `"Bob"` seed would pass at 375px yet overflow in prod (the MYT-83 class).
- **Wide-by-design opt-out (review Ebb-I3):** some existing stories scaffold wide on purpose (`Grid.stories w-[480px]`, `Dither.stories w-[28rem]`) and would false-fail. Define a sanctioned per-story opt-out (`parameters.overflowGate: false`) and a convention that demo wrappers use `max-w-full`. (The current `story-coverage` gate is all-or-nothing by directory with no opt-out, so this is new.)

**Topology (resolved — review I5/Ebb-I1):** **one frontend-level Storybook** scanning both `@mythrun/ui` and `@mythrun/web` stories. Hosting web stories in the *ui* Storybook is ruled OUT — it inverts the dependency (`ui → web`, a package cycle, since web already depends on ui). The frontend-level Storybook needs its own Vite/Tailwind-v4/`@fontsource`/token setup and a screen-specific preview (the ui `p-6` decorator + `a11y:{test:'error'}` params must not silently apply to screens). **Standing up the web/frontend Storybook is a first-class rollout step (§7), not a sub-bullet.**

**Coverage forcing-function (review Ebb-I5):** "every screen ships a story" needs its own gate — `story-coverage.mjs` globs `frontend/ui/src/components/*` *directories* and won't see flat `frontend/src/routes/*.tsx`. Add a **screen-story-coverage** check (glob `src/routes/*.tsx` + the `app/` screens, require a co-located `*.stories.tsx`), accounting for the file-vs-directory discriminator.

**CI / pre-push.** A new step (`build-storybook` once, reused → `test-runner`/addon) added to `frontend-check.yml` (raise the `timeout-minutes: 8`; cache `~/.cache/ms-playwright` via `actions/cache`; pin + `--with-deps` the browser). For `.husky/pre-push`: given "pushes are expensive," decide whether the overflow sweep runs pre-push or **CI-only** (lean CI-only; pre-push already runs `build-storybook`). Decide explicitly whether the new runner also wires **a11y** (`preview.tsx`'s `a11y:{test:'error'}` is inert today; turning it on could surface a latent axe backlog) — default: **overflow-only for this ticket**, a11y is a separate decision.

## 6. The known fix — the header

The app-frame header truncates to a **single quiet row** (not wrap): the identity `Text`s gain `truncate`, the `Stack` children shrink (the new `min-w-0`), the settings affordance keeps its size (`Button shrink-0`), so a long display name ellipsizes instead of shoving it off-screen. Locked in by the app-frame screen story (router-bearing decorator, §5) seeded with an **adversarial long** display name + gated at 375px. (This also handles a long *real* display name — the production reason it's needed.)

## 7. Rollout / testing (TDD)

1. **Primitive capabilities** — `Stack` child-shrink + `wrap`, `Text` truncate, and the `Button`/`Icon` `shrink-0` protection — failing story/unit test first, then impl, per capability.
2. **Stand up the frontend-level Storybook** (Vite/Tailwind/tokens/fonts + screen-specific preview) — a first-class step (review Ebb-I1).
3. **The gate** — runner (after the test-runner-vs-addon decision), the calibrated `postVisit` assertion, the open-overlay + router-bearing-screen + adversarial-content + opt-out machinery, the screen-story-coverage check, the CI/pre-push wiring.
4. **The gate + 375px visual pass light up** the overflowing/squishing components and screens → fix each (including the header). Add the screen stories.
5. Gate green across all stories at 375px + 1280px.

Order matters: the primitives + the gate come first, because the gate is what *reveals* the per-component audit work in step 4 (with the visual pass covering the squish class the overflow boolean can't).

## 8. Portability (R2/R3/R4)

The *prop contract* (`Stack.wrap`, `Text.truncate`) is platform-neutral and tsc-inherited by `ui-native`; the *behavior* (Yoga shrink opt-in, `numberOfLines`, the web-only `min-w-0`/`shrink-0` defaults) is a **documented native re-implementation obligation**, not auto-inherited (review M1/Neap-I4). A component reaching for a web breakpoint is a contained platform-divergence point — but, unlike the R4 renderer (lint-enforced, one module), breakpoints are spread across impls, so the spec adds the **enumeration mechanism** the analogy implies: the `@platform-divergent: breakpoint` marker + a documented grep target, so "known, contained, enumerable" actually holds for the native port.

## 9. Done when

- The 375px + 1280px overflow gate is **green across all stories** — every component (with overlays measured open) *and* the app-screen stories (frame, home, 404, public branch), each seeded with adversarial-length content.
- The **screen-story-coverage** check passes (every screen has a story).
- The app-frame header (and every component) renders with **no horizontal overflow** at 375px and 1280px, and **no squish/overlap** under the 375px visual pass.
- `Stack.wrap` and `Text.truncate` exist in the contract with stories + tests; `Button`/`Icon` carry `shrink-0`; breakpoint use is marked + grep-enumerable and remains unlinted.
- The gate is wired into `frontend-check.yml` (CI) and fails the build on a regression; the pre-push scope is decided.

## Appendix — adjacent fix-while-here

`frontend/client-core/src/contract/box.ts:28-30` documents `minHeight="screen"` as `100vh`, but `Box.tsx` ships `min-h-dvh` (100dvh). Correct the stale comment in this ticket (the spec §1 already cites `100dvh`).
