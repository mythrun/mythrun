# MYT-82 — mythrunUI Component Library + Storybook — Design Spec

> **Type**: Feature design spec
> **Date**: 2026-06-22 · **Linear**: MYT-82 (Frontend milestone, Day 3) · **Revised** after round-1 blind review (Griffin/Kraken/Phoenix/Chimera/Basilisk).
> **Depends on**: MYT-79 (workspace + lint rails), MYT-80 (i18n), MYT-81 (design tokens) — all shipped.
> **Inherits**: the portability decision record `docs/superpowers/specs/2026-06-20-frontend-portability-architecture.md` (rules R1–R5) and the methodology rule (every reusable component lives in the design system + has a Storybook story).

---

## 1. Goal

Build the MaterialUI-shaped component **system** the entire app is assembled from — the system *before* the app. MYT-82 delivers: (a) the platform-neutral component **contract** + the shared package that holds it, (b) the **completed token foundation** (the design language + the token scales MYT-81 didn't ship), (c) a **Storybook** and the foundational primitives, and (d) the **enforcement gates** (with their concrete CI wiring) that keep all of this from rotting.

Feature-specific *composite* components (campaign-card, roll-card, chat-message, entity-popover, character-sheet) are **out of scope** — built into mythrunUI within their own feature issues, never ad-hoc.

## 2. Architecture

MYT-82 **creates `@mythrun/client-core`** and seeds it with the two platform-neutral things the design system needs, then builds the web design system against it. (`@mythrun/client-core` is added to `pnpm-workspace.yaml` as the first Wave-0 step — it currently lists only `frontend` + `frontend/ui`.)

```
@mythrun/client-core   ← born here. react-only, ZERO DOM, ZERO CSS.
   · the component CONTRACT — prop/variant types (ButtonProps, …), importing only `react`.
       exposed as a TYPE-ONLY subpath: @mythrun/client-core/contract
   · the TOKEN GENERATOR — generatePalette() + the raw token-scale DATA + the manifest (JS/JSON),
       relocated from @mythrun/ui (with its culori dep). NO .css here.
       exposed as a build-time subpath: @mythrun/client-core/tokens
        ▲
@mythrun/ui            ← the WEB design system. Implements the contract with DOM + Tailwind v4.
   · OWNS all web CSS: runs the generator at build time to emit src/styles/colors.generated.css,
     keeps theme.css / semantic.css / base.css and the `./styles.css` export. (Web @theme is a
     web-face concern; it must NOT live in the DOM-free client-core.)
   · each component typed `(props: ButtonProps)` against the client-core contract (via `import type`)
        ▲
@mythrun/web           ← the app. Composes ui + client-core. The `@source "../ui/src"` + the
                          `@import "@mythrun/ui/styles.css"` wiring is UNCHANGED.
```

**Token relocation, precisely (Griffin C1 / Phoenix I6):** only the platform-neutral **generator + raw scale data + manifest** (JS/JSON) move to `client-core` — never `.css`. The web `@theme` / `semantic.css` / `@theme inline` / `base.css` emission **stays in `@mythrun/ui`**, which imports the generator from client-core and runs it at build time to emit `colors.generated.css` into `frontend/ui/src/styles/`. The `@source "../ui/src"` directive and the `@import "@mythrun/ui/styles.css"` chain are untouched. `culori` (today a `@mythrun/ui` devDep) moves with the generator.

**The contract is a typed seam, enforced as a *pair* (Griffin C2 / Chimera I2):** each web component is typed `(props: ButtonProps)` against the client-core contract. `tsc` then checks *that impl's prop surface satisfies* the contract — so when the native impl is written and typed the same way, any prop-surface drift is a compile error. **tsc checks prop *shape*, not behavior, and does not by itself forbid a web-only excess prop** (a `className?` passthrough can satisfy `(props: ButtonProps)` structurally). The **API-purity lint** (§7) is the other half of conformance — it forbids DOM-only props on the public surface, including in the contract types themselves. So: *conformance = tsc (satisfies) + API-purity lint (does not exceed)*. Behavioral parity is documented in the contract + verified by each component's tests. (The phrase "tsc guarantees parity" is not used.)

**Dependency direction is one-way:** `client-core ← ui ← web`. `@mythrun/ui` imports the contract via `import type` (erased, no runtime coupling) and invokes the token generator only in its build script (not in shipped component code) — keeping the seam thin as MYT-83 grows client-core with stores/transport.

## 3. The design language (settled)

**Flat 1-bit** — the brand's "Parchment & Ink / Obra Dinn" register, taken seriously. Resolves the standing brand-vs-UX-spec tension in favor of the brand (per `feedback_brand_repo_overrides_ux_spec`); the UX spec's "light, airy, soft shadows, float" is **superseded** for visual identity.

- **Radius: 0px everywhere.** Sharp corners match the pixel-art icons. A single `--radius: 0` token.
- **Depth: borders + paper-tier surfaces, NOT shadows.** The MYT-81 `--shadow-soft/--shadow-float` tokens are **removed**. Because depth now rides on borders, **interactive control boundaries use `--border-strong` (≥3:1 contrast)**, and faint `--border` is reserved for decorative dividers (Kraken C2). Modals may use a dither scrim (the dither requires genuine two-color contrast; it is not a general cream-on-cream elevation tool).
- **Focus ring: 2px hard outline, square, 2px offset, no glow.** Color is **theme-aware** — `--focus-ring-color: var(--accent)` → ember-600 (light) / ember-400 (dark) — so it clears WCAG 3:1 on both themes (ember-600 fails 3:1 on dark surfaces; ember-400 passes). (Kraken C1.)
- **Interaction states: token-swap** (discrete steps), not translucent overlays.

## 4. Token foundation completion

MYT-81 shipped only colors, type sizes, 3 motion durations, and 2 shadows. MYT-82 completes the foundation before components consume it. The raw token DATA lives in the relocated generator (`@mythrun/client-core/tokens`); `@mythrun/ui` emits it to the web `@theme`. New tokens follow the shipped `@theme inline` + `:root`/`.dark` idiom in `semantic.css`. The `tokens.test.ts` alias list is updated in the same wave (the `--surface` family extends the existing shipped `--surface` alias — Griffin I1).

| Token group | Values |
|---|---|
| **Spacing** (4px base) | `--space-1..9` = 4, 8, 12, 16, 24, 32, 40, 48, 64px. Comfortable density (single density at launch; control-height tokens leave a clean future compact axis — Basilisk M2). |
| **Radius** | `--radius: 0`. |
| **Sizing** | `--control-sm/md/lg` = 32 / 40 / 48px (md default). **≥44px hit-target on ALL interactive controls** (visual size may be smaller; pad the interactive area) — incl. icon-only controls, not just "primary" (Kraken I5). |
| **Icon sizes** | `--icon-sm/md/lg` = 16 / 20 / 24px. NOTE (Phoenix I5 / Kraken I4): Pixelarticons are 24-grid **vector** SVGs — they render anti-aliased at any size (`image-rendering: pixelated` does nothing to vector). They are crispest at the 24 grid (and 2× = 48). 16/20 are supported sizes but not "pixel-perfect"; meaningful standalone icons use ≥24px. The "nearest-neighbor crisp" promise is dropped for the vector set. |
| **Borders** | `--border-width: 1px`; `--border` (paper-300 / paper-700 dark) = **decorative dividers only**. `--border-strong` (paper-500/600 light, paper-400/500 dark — chosen to clear 3:1 against bg/surface) = **interactive control boundaries** (Input, Select, Button, Card edges). 2px for selected/focus. |
| **Surface tiers** | `--surface` (extends the shipped alias: paper-50 / paper-800), `--surface-raised` (popover), `--surface-overlay` (modal). Depth via paper-step + `--border-strong`; stacked overlays (Select-in-Modal) separate via a scrim-opacity step, since there is no shadow (Basilisk M3). |
| **Focus** | `--focus-ring-width: 2px`, `--focus-ring-color: var(--accent)` (theme-aware, see §3), `--focus-ring-offset: 2px`. |
| **Interaction states** | token-swap: `--accent-hover` (ember-700, shipped), add `--accent-active`, `--surface-hover`; **disabled** = paper-200 bg + paper-500 text (2.81:1 — WCAG-exempt as inactive; documented as exempt so it isn't "fixed", paired with `disabled`/`aria-disabled` + a non-color cue so it doesn't rely on color alone — Kraken I1); **selected** = paper-200 / 2px ember border. |
| **Status-intent** (Basilisk C3 / Kraken I2) | for success/warning/danger/info: `--surface-{intent}`, `--border-{intent}`, `--text-{intent}` (light/dark, AA-verified via the generator's `wcagContrast` audit). **Body text in Banner/Toast uses `--ink`; the status color carries the icon + accent bar only** (status-500 on paper is ~3:1 — fine for icon/large, fails AA for body text). |
| **Z-index** (semantic) | `--z-base: 0`, `--z-nav: 10`, `--z-dropdown: 1000`, `--z-popover: 1100`, `--z-overlay: 1200`, `--z-modal: 1300`, `--z-toast: 1400`, `--z-tooltip: 1500`. |
| **Motion** | keep `--duration-fast/base/slow` = 120 / 200 / 360ms; add `--ease-out` (cubic-bezier(.2,0,0,1)) + `--ease-linear`. Only opacity/fades animate — nothing slides/bounces/shakes. `prefers-reduced-motion` reset shipped (transient state changes also fire a live-region announcement so motion is never the sole signal — Kraken M1). |
| **Typography roles** | `display` (serif 2.25rem/600), `heading` (serif 1.25rem/600), `title` (serif 1.125rem/600), `prose-body` (serif 1rem/400, lh 1.6), `ui-label` (mono 0.875rem/500, uppercase, +0.5px tracking), `ui-caption` (mono 0.75rem/500), `data` (mono 0.875rem/400). |
| **Weights / tracking / measure** | `--weight-normal/medium/semibold` = 400/500/600. `--tracking-normal: 0`, `--tracking-wide: 0.5px`. `--measure: 64ch` (serif prose column). |
| **Layout** | logical properties (`margin-inline`, etc.) so RTL is not foreclosed (Basilisk M1). Tailwind default breakpoints (640/768/1024/1280/1536). |
| **Contrast** | WCAG AA. Dark mode follows `prefers-color-scheme` + a manual toggle. |

## 5. Build stack

The widely-adopted "shadcn pattern," chosen also because it ports cleanly. Concrete deps (current as of 2026-06):

- **Styling: Tailwind v4 utilities, token-driven.** Components use semantic token classes (`bg-ember-600`); never raw hex (no-ad-hoc-color lint). Note the v4 CSS-var arbitrary-value syntax is `(--var)` not `[--var]` (Phoenix I4).
- **Class merging:** `tailwind-merge@^3` (v2 is Tailwind-v3-only) + `clsx`, via a `cn()` util in `@mythrun/ui` (Phoenix I3).
- **Variants: CVA** (`class-variance-authority`). Variant→class mapping is internal to the web impl; the *prop API* lives in the contract (CVA never crosses the contract — R2-pure). CVA is single-maintainer/quiet; `tailwind-variants` is the recorded swap target if it stalls (Phoenix I4).
- **Behavior & a11y: the unified `radix-ui` package** (NOT individual `@radix-ui/react-*` — shadcn migrated Feb 2026; individuals risk React-19 peer-dep skew that pnpm-strict hard-fails — Phoenix C1). Unstyled Radix for focus-trap, positioning, keyboard nav, ARIA; styled 100% with our tokens. Native mirror: `rn-primitives` (same API) — the seam the native impl swaps behind.
- **Icons: `pixelarticons`** per-icon component imports (cleanest tree-shaking + `currentColor`), behind a swappable `Icon` API. Upgrade path: Pixelarticons Pro / Nucleo Pixel — a glyph-source swap (Phoenix M8).
- **Dither:** a dedicated util implementing the brand's locked 4×4 Bayer formula — the only sanctioned gradient; for committed high-contrast transitions only.

## 6. The primitive set

Each lands in `@mythrun/ui` with a Storybook story and is typed against a contract type in `@mythrun/client-core`. Round-1 review added the primitives the app's own UX spec provably needs (Tabs is even referenced in §5's a11y list) — without them the §7 gates would *block* features with no in-system component to satisfy them (Basilisk I1). **This grows the set from ~18 to ~26 — flagged for sign-off at the user-review gate.**

| Group | Components |
|---|---|
| Layout | `Stack`, `Box`, `Grid`, `Divider` |
| Typography | `Text`, `Heading`, `Link` (router-aware, focus-ring, i18n) |
| Controls | `Button` (incl. `loading`), `IconButton` (requires accessible name), `Input`, `TextArea`, `Select`, `Checkbox`, `Radio`, `Switch` |
| Forms | `FormField` (label + helper + error + required/invalid), `Label` |
| Containers / overlays | `Card`, `Modal`, `Popover`, `Tooltip`, `Tabs`, `Menu`/`DropdownMenu` |
| Feedback | `Banner` (inline, persistent), `Toast` (transient, global subsystem), `Spinner` |
| Display | `Avatar` (+ `AvatarGroup` w/ initials fallback + overflow), `Badge`, `Icon` |
| a11y util | `VisuallyHidden` |
| Texture | `Dither` |

- **State matrix (Basilisk C2):** the canonical set every applicable component implements + documents in its story is **default, hover, active, focus-visible, disabled, loading, invalid/error, read-only, selected/indeterminate**. `Button` gains `loading` (the UX spec's async create/roll/DM-thinking buttons need it). The story-coverage/doc gate asserts the relevant subset per component.
- **FormField (Basilisk C1):** a shared field contract — `label`, `description`/helper, `error`, `required`, `invalid`, `disabled` — with the invalid border + error-text status tokens. The error string is an **i18n key** (incl. server/LLM-rejection messages routed inline), so the error-rendering contract is designed once, not improvised per field.
- **Toast (Basilisk I4):** a subsystem, not a leaf — an app-root provider/portal, a queue (max-visible + dedupe), `aria-live` politeness, auto-dismiss (respecting `prefers-reduced-motion`), and an imperative `toast()` API. **Banner** = inline/contextual/persistent; **Toast** = transient/global.

## 7. Enforcement (rules as CI gates — with their wiring)

Every agreed rule gets a gate **and an explicit place to run it**. The current `frontend-check.yml` + `.husky/pre-push` run a fixed list (`@mythrun/ui` typecheck, both lints, `@mythrun/web` test/coverage/build) that does **not** include the new gates — so Wave 0 wires them in (Chimera C1). Each new custom rule ships with a positive-AND-negative wiring test (per `reference_eslint_unknown_option_silent_noop` — the MYT-79 `ignoreAttribute` no-op), and each is registered in the correct package's config:

| Gate | What & where it runs |
|---|---|
| **`@mythrun/ui` test toolchain** | Wave 0 stands up Vitest + jsdom + RTL + `@vitest/coverage-v8` + `jest-axe` in `@mythrun/ui` (no test runner exists there today — Chimera C2); adds `test`/`test:coverage` scripts; wires both into `frontend-check.yml` + pre-push. |
| **Story-coverage** | directory-per-component convention (`Button/Button.tsx` + `Button/Button.stories.tsx`); the gate globs component *directories*, with type-only/util/hook exports explicitly exempt (Chimera I1). A CI script (+ a Storybook build step) fails if a component dir lacks a story. |
| **Contract conformance** | `tsc` (each impl `(props: ContractProps)`), as the *satisfies* half (§2). |
| **API-purity lint** | custom rule in **`@mythrun/ui`'s** eslint config (where components live; the `mythrun-ui` plugin is relocated/duplicated there from `@mythrun/web` — Griffin I2). Scoped to the **public exported prop surface** (exempts internal Radix `asChild`/className wiring — Phoenix M9). Decision: name-based AST for `className`/`style`/`onMouse*` props + a type-aware check for `CSSProperties`/`HTMLAttributes`-extension; blind spots enumerated. Wiring test asserts it FIRES on `interface XProps { className?: string }` / `style?: CSSProperties` and PASSES a clean contract. |
| **no-ad-hoc-color lint** | three mechanisms, named (Phoenix C2 / Chimera I4): (1) AST string-scan for `[#…]`/`[rgb(…)]` arbitrary utilities in `className` literals; (2) hex/`rgb()`/`hsl()` literal scan in `.tsx` **including inside `cva({...})` call args** (where the colors actually live — a `JSXAttribute`-only matcher misses them); (3) component `.css` is covered by a Stylelint pass over `frontend/ui/src/**/*.css` (excluding the generated `colors.generated.css`). Generator/manifest/test fixtures carved out. Wiring test: hex in a `cva()` block fails, `bg-ember-600` passes. |
| **Import boundary** | split (Chimera I5): land the `no-restricted-imports` path-ban now ("features import UI only from `@mythrun/ui` + react/client-core/i18n"); **defer** the cross-feature-component boundary to MYT-83 (named mechanism: `import/no-restricted-paths` zones or `eslint-plugin-boundaries`) since no feature dirs exist yet. |
| **`no-ad-hoc-ui`** | shipped (MYT-79); tightened so feature code composes mythrunUI only. |
| **a11y gate** | the **gate** is `jest-axe` assertions in `@mythrun/ui` component tests + explicit keyboard-interaction tests (Tab/Esc/Arrow/Enter/Space), a Modal focus-trap+return test, a Toast/Banner live-region test, and a **token-level contrast check** (the generator already computes `wcagContrast`) for the focus-ring/border 3:1 claims that axe does not verify (Kraken I3 / Chimera I6). The Storybook a11y addon is a dev-time authoring aid, not the gate. |
| **Methodology backstop** | the *mechanizable* half is the shipped `require-description` + `reportUnusedDisableDirectives` gates (a disable needs a reason); human sign-off before an out-of-system component is **process, not CI** (Chimera M2). |

Layout primitives (`Stack`/`Box`/`Grid`) expose a **token-typed style vocabulary** (`gap: SpaceToken`, etc.), which passes API-purity by construction — no carve-out needed (Chimera M3). Each new rule's wiring/integration test gets the `test:coverage --exclude` treatment + the rule logic is gated by its unit test (per the vitest-v8 double-load gotcha — Chimera M1).

## 8. Storybook & testing

- **Storybook 9** (Vite builder, React) + `@storybook/addon-a11y` + a light/warm-dark toggle. **Tailwind v4 needs explicit wiring** (Phoenix I7): `@tailwindcss/vite` added to Storybook's Vite via `viteFinal` in `.storybook/main.ts`, plus the Storybook-side CSS import + `@source` reach over `ui/src` — else stories render unstyled on day one.
- **Doc template (Basilisk I5):** the story-coverage gate asserts not just file existence but a minimum template — autodocs props table, the all-states matrix, a11y notes, do/don't, content/i18n guidance.
- **Testing:** Vitest + RTL + `jest-axe` per component (behavior + a11y), wired into CI (§7). Coverage follows the repo's tiered convention.

## 9. API conventions (the contract's cross-cutting rules)

So the native impl is a *mechanical* translation, the contract fixes these once (Basilisk I2):

- **Ref forwarding** required on every component (Radix needs it).
- **Controlled/uncontrolled** signature shape (`value`/`defaultValue`/`onChange`) standard across Input/Select/Checkbox/Radio/Switch/Tabs, mirroring Radix's convention platform-neutrally.
- **Polymorphism** expressed platform-neutrally: the contract exposes neutral `as`-style intent where needed (e.g. Button-as-Link via a `Link` primitive), **not** Radix's DOM-coupled `asChild` (which would violate API-purity and has no native analog) — `asChild`/`Slot` stays an internal web-impl detail.
- **Compound components / slots** (Card header/body/footer, Banner action) follow one stated slot pattern.
- **Versioning (Basilisk I3):** contract changes recorded in a `@mythrun/client-core` CHANGELOG; deprecations via JSDoc `@deprecated` (+ a lint); contract-breaking changes are a deliberate, reviewed event (a second consumer — `@mythrun/ui-native` — implements the same contract later).

## 10. Implementation waves

Subagent-driven, non-overlapping files. **Wave 0 is sequenced internally** so the high-blast-radius token move can't block low-risk contract work (Griffin M2):

- **Wave 0a — scaffold:** add `@mythrun/client-core` to `pnpm-workspace.yaml`; create the package (contract scaffolding, type-only `/contract` + build-time `/tokens` subpath exports); add the new token scales (§4) as additive tokens.
- **Wave 0b — relocate generator:** move `generatePalette()` + manifest + `culori` to client-core; `@mythrun/ui` imports + runs it at build to emit `colors.generated.css`; **a round-trip test asserts the relocated generator reproduces the committed CSS byte-for-byte** (the real idempotency check — Griffin I3); update the token tests' import paths + the `--surface` alias list.
- **Wave 0c — harness:** stand up the `@mythrun/ui` Vitest toolchain; Storybook 9 + Tailwind wiring; all §7 gates + their wiring tests + the CI/pre-push edits.
- **Wave 1 — layout + type:** `Stack`, `Box`, `Grid`, `Divider`, `Text`, `Heading`, `Link`, `VisuallyHidden`.
- **Wave 2 — controls + forms:** `Button`, `IconButton`, `Input`, `TextArea`, `Select`, `Checkbox`, `Radio`, `Switch`, `FormField`, `Label`.
- **Wave 3 — overlays / feedback / display:** `Card`, `Modal`, `Popover`, `Tooltip`, `Tabs`, `Menu`/`DropdownMenu`, `Banner`, `Toast`, `Spinner`, `Avatar`/`AvatarGroup`, `Badge`, `Icon`, `Dither`.

Each component (waves 1–3) ships: its contract type, web impl, a story (per the doc template), a Vitest+RTL+axe test, and passes all gates.

## 11. Decisions & rationale

- **0px radius** — matches the pixel-art icons; committal, on-brand (over 2px).
- **Depth via borders/surfaces, not shadows** — flat register; MYT-81 soft-shadow tokens removed; interactive borders use `--border-strong` for 3:1.
- **Theme-aware focus ring** — ember-600 fails 3:1 on dark; `var(--accent)` resolves to ember-400 there.
- **Unified `radix-ui` package** — current official; avoids React-19 peer-dep skew; `rn-primitives` mirror for the port.
- **Pixelarticons (free)** — quietest 1-bit, MIT, `currentColor`; vector (anti-aliased), crispest at 24/48; Pro/Nucleo later if needed.
- **Create client-core now** — R2/R3 put the contract + generator in the shared layer; avoids a later extraction. Only JS/JSON moves; web CSS stays in `@mythrun/ui`.
- **Conformance = tsc + API-purity** — tsc proves *satisfies*, the lint proves *does not exceed*.
- **Brand overrides UX spec** for visual identity; UX spec governs flows/IA/API.

## 12. Out of scope

- Feature-specific composite components (built with their flows).
- `@mythrun/native` / `@mythrun/ui-native` implementations (post-launch).
- MYT-83's growth of `@mythrun/client-core` (data/state/transport + the DOM-free boundary lint + the cross-feature import boundary).
- The app shell, routing, real screens (MYT-83+). Skeleton primitive (Basilisk I1) deferred unless a flow needs it.

## 13. Done when

- `@mythrun/client-core` exists (in the workspace) with the type-only contract subpath + the relocated, **round-trip-verified** generator (JS/JSON only, no CSS); `@mythrun/ui` depends on it and still emits identical web CSS.
- The token foundation (§4) is complete and consumed via Tailwind `@theme`; the focus ring + interactive borders clear WCAG 3:1 in **both** themes (verified by the token-contrast check).
- Storybook runs with the primitives documented (per the doc template, all relevant states) + foundation stories; light/dark toggle works; Tailwind styles apply in Storybook.
- Components pass `jest-axe` + the keyboard/focus-trap/live-region tests; icon-only controls have accessible names.
- **All gates run in CI/pre-push and are green:** `@mythrun/ui` test + coverage, story-coverage, tsc conformance, API-purity lint (+ wiring test), no-ad-hoc-color lint (+ wiring test), import path-ban, `no-ad-hoc-ui`, a11y + token-contrast.
- A feature file importing a raw styled `<div>` fails CI; a `@mythrun/ui` component without a story fails CI; a hex in a `cva()` block fails CI.
- `pnpm typecheck` + `pnpm lint` + `pnpm test` (+ frontend coverage) green.
