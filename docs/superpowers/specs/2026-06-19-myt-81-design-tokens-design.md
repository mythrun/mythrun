# MYT-81 — Design Tokens — Design

> **Type**: Implementation design (superpowers brainstorm output)
> **Date**: 2026-06-19
> **Status**: Approved (design); revised post blind-review round 1 (Pigments). Semantic-ramp VALUES still pending visual sign-off during implementation.
> **Linear**: MYT-81 (Frontend milestone, Day 2). Depends only on MYT-79 (done). Forked sibling of MYT-80 (i18n) — parallel; **the human merges serially**.
> **Spec refs**: brand repo `../../Design/mythrun-design/brand/{palette/palette.md,palette/palette.html,guidelines.md,decisions.md}`; UX Design §1; the brand-repo-is-source-of-truth rule.

---

## 1. Goal

Encode the brand's design language as the token foundation every component and flow consumes — the 60-token OKLCH palette, typography, spacing/radius/shadow, motion, and a true-warm-inversion dark mode — as Tailwind v4 `@theme` + CSS custom properties living in the `@mythrun/ui` package. After MYT-81, MYT-82 (the component library) and every flow style against semantic tokens, never raw values.

This issue ships **no components** — only the token layer + an audit artifact.

## 2. Brand grounding (mandated vs. defined here)

| Surface | Brand mandates | MYT-81 defines |
|---|---|---|
| Color | paper (10) + ember (10) full ramps as exact hexes; success/warning/danger/info **anchors only** (success/warning/danger at -500, **info at -600**) | **generate** the 36 missing semantic steps (§4) → full 60 |
| Type | the 3 typefaces (Source Serif 4 body / IBM Plex Mono UI / Tyma Garamont wordmark-only), serif=narrative / mono=machine split; "a solid first concept, not final" | the **type scale** (sizes/weights/leading) — kept conventional + revisable |
| Spacing / radius / shadow | — (brand-silent) | Tailwind v4 defaults + a couple soft/quiet shadows |
| Motion | — (brand-silent); UX spec mandates `prefers-reduced-motion` | duration + easing tokens + the reduced-motion reset |
| Dark mode | "true inversion — warm dark grays, muted accents; not a separate design language"; a user **toggle** (UX §1) | the **token inversion layer** (toggle UI is MYT-83) |

**Source-of-truth rule:** the brand repo wins on visual identity. paper/ember/anchor hexes are reproduced **verbatim** (§4 makes anchor-preservation the *hard* constraint). The 36 generated values are new brand-adjacent values and get the human's visual sign-off (§4) before baking. The design repo is NOT edited from this session.

> **Note — a brand-doc accessibility claim is wrong; do not copy it.** `palette.md` asserts "paper-500 on paper-100 = 4.7:1 (meets AA for normal text)." Measured, it is **3.27:1** — AA-large only, **fails** 4.5:1 for body. MYT-81 defines `--color-ink-tertiary`, so this is resolved here (§3.3), not deferred. (The other two brand claims err safe: paper-700/100 ≈ 9.99:1, paper-900/100 ≈ 14.03:1.)

## 3. Architecture

### 3.1 Token home — `@mythrun/ui`

Tokens are the design system's foundation, so they live in `@mythrun/ui` (the lib), not `@mythrun/web` (the app). The app and MYT-82's Storybook both consume the same exported CSS.

```
frontend/ui/
  src/styles/
    index.css        # entry: @imports the below; exported via package "exports" as "./styles.css"
    tokens.manifest.json  # GENERATED: the canonical token list (names → values) — single source for theme.css AND the §8 test
    fonts.css        # (see §5 — fonts load via JS import; this file holds only @font-face fallbacks if any)
    theme.css        # plain `@theme` — the 60 colors + type/space/radius/shadow/motion SCALE tokens (literal values)
    semantic.css     # the `:root`/`.dark` alias remap vars + a `@theme inline` block surfacing them as utilities + `@custom-variant dark`
    base.css         # the `prefers-reduced-motion` reset + minimal element base
  scripts/
    generate-palette.mjs   # deterministic OKLCH generator (culori) → emits theme.css color block, tokens.manifest.json, tokens.html
  tokens.html        # GENERATED swatch audit (all ramps + aliases, light + dark, WITH contrast columns) — the sign-off surface
```

- `@mythrun/ui` `package.json` `exports` gains `"./styles.css": "./src/styles/index.css"` (+ keeps the existing `"."` JS entry).
- **`@mythrun/ui/styles.css` is Tailwind-v4-*source* CSS, not standalone CSS** — it contains `@theme`/`@custom-variant` directives that only compile inside a Tailwind v4 consumer. No Tailwind dependency is added to `@mythrun/ui` (the app's `@tailwindcss/vite` pipeline compiles it). **Constraint carried to MYT-82:** the Storybook host must also run Tailwind v4 and register `@mythrun/ui` as a `@source` (below).
- `frontend/src/index.css` (app) becomes:
  ```css
  @import "tailwindcss";
  @import "@mythrun/ui/styles.css";
  @source "../ui/src";   /* scan @mythrun/ui's own .tsx for class names — node_modules/workspace pkgs are NOT auto-scanned in v4 */
  ```
  (`@source` is a no-op for MYT-81 since `@mythrun/ui` has no styled components yet, but it's the foundational seam that makes "components styled in isolation" emit CSS once MYT-82 lands; include it now.)
- Tailwind v4 **supports `@theme` in an `@import`-ed file** (verified against v4 docs — the `@import "../brand/theme.css"` sharing pattern); the only hard constraint is `@theme` must be top-level, not nested. The empty `@theme {}` MYT-79 left in `frontend/src/index.css` is removed.

### 3.2 Two token layers — scale (`@theme`) + semantic aliases (`@theme inline` + `:root`/`.dark`)

1. **Scale tokens** (`theme.css`, plain `@theme`): the raw palette + scales with **literal** values — `--color-paper-100: #EFE9DC`, `--color-ember-600: #8A5A3C`, `--text-base`, `--font-body`, `--radius-md`, `--ease-out`, `--duration-base`. v4 emits these to `:root` and utilities reference them (`bg-paper-100` → `var(--color-paper-100)`). Confirmed v4 behavior.

2. **Semantic aliases** (`semantic.css`) — **the dark-mode-correct pattern** (this is the load-bearing fix from round 1; a plain `@theme` alias whose value is `var(--color-paper-*)` does NOT cascade a `.dark` override, because v4 resolves it at `:root`). Author it as plain remap vars + a `@theme inline` surface:
   ```css
   :root {
     --bg: var(--color-paper-100); --surface: var(--color-paper-50);
     --border: var(--color-paper-300); --ink: var(--color-paper-900);
     --ink-secondary: var(--color-paper-700); --ink-tertiary: var(--color-paper-600); /* paper-600 for AA body — NOT paper-500 */
     --accent: var(--color-ember-600); --accent-hover: var(--color-ember-700);
     --success: var(--color-success-500); --warning: var(--color-warning-500);
     --danger: var(--color-danger-500); --info: var(--color-info-600);
   }
   .dark { /* §7 remap table */ }
   @theme inline {       /* `inline` → the utility emits `background-color: var(--bg)`, so the .dark override cascades */
     --color-bg: var(--bg); --color-surface: var(--surface); --color-border: var(--border);
     --color-ink: var(--ink); --color-ink-secondary: var(--ink-secondary); --color-ink-tertiary: var(--ink-tertiary);
     --color-accent: var(--accent); --color-accent-hover: var(--accent-hover);
     --color-success: var(--success); --color-warning: var(--warning); --color-danger: var(--danger); --color-info: var(--info);
   }
   @custom-variant dark (&:where(.dark, .dark *));
   ```
   **Components consume the semantic aliases (`bg-bg`, `text-ink`, …), never raw scale steps.** Two independent dark mechanisms (do not conflate): (a) the `:root`/`.dark` **alias remap** drives the whole palette inversion automatically — no `dark:` prefix needed; (b) `@custom-variant dark` exists only for occasional ad-hoc `dark:`-prefixed overrides. Verify the `@theme inline` cascade against a real build during implementation (a rendered `.dark`-toggle computed-style assertion — §8 — proves it).

## 4. Generating the 36 semantic steps (§ visual sign-off)

A deterministic Node script (`generate-palette.mjs`, run once, committed; `culori` devDependency) produces the four semantic ramps. **Exact recipe** (round 1 surfaced that "anchor-preserving" and "L-aligned-to-ember" are mutually exclusive — so anchor-preservation is the HARD constraint and L-alignment is soft, applied only to non-anchor steps):

- **Per ramp,** convert the brand anchor to OKLCH → `(L_a, C_a, H_a)`. The anchor step is pinned **exactly** to the brand value (success/warning/danger at step 500; **info at step 600** — info-600 is info's canonical step, propagated to §7 and the `--info` alias).
- **Hue:** constant `H_a` across all 10 steps.
- **Lightness:** the non-anchor steps take the **ember ramp's L curve**, but the curve is *re-anchored to pass through `L_a` at the anchor step* (two L sub-curves — one for steps lighter than the anchor, one darker — blended through `L_a`). This keeps the anchor exact while aligning the rest to the palette-wide L progression; **strictly monotonic** (verified). One consequence to accept: L-spacing is slightly uneven immediately around the anchor — the documented cost of exact brand reproduction.
- **Chroma:** `C[step] = C_a × (emberC[step] / emberC[anchorStep])` — scales the ember chroma-taper shape so it passes through `C_a` at the anchor. (ember's own chroma peaks at ember-400, not -500; this formula reproduces that taper without hardcoding a peak step.)
- **Gamut:** high-chroma light steps (notably danger-50/100) fall outside sRGB. Map with **`culori.toGamut('rgb','oklch')`** (CSS Color 4 algorithm — NOT naive `clampChroma`, which over-desaturates). Accept a ≤~1.3° hue drift at the clipped top-end steps (document it; "hue-held" holds for all in-gamut steps).
- **Output:** hex (gamut-mapped), matching the brand's format + exact paper/ember/anchor preservation. Derived interactive states use `color-mix(in oklch, <step> N%, <next-darker step>)` at use-site — mixing toward the **next ramp step** (not pure black, which flattens near -900); not new tokens.

The script emits `theme.css`'s color block, `tokens.manifest.json`, and `tokens.html`. **`tokens.html` includes a measured-contrast column** for every semantic-on-background pairing (light and dark). **Before the values are committed**, the implementer opens `tokens.html` and the human signs off on the ramps against the *measured* ratios — not eyeballed swatches. Tune the script's L/C curve + regenerate if a ramp reads wrong; the script is the reproducible source, the committed hexes are the artifact.

## 5. Typography

- **Self-host** Source Serif 4 + IBM Plex Mono via `@fontsource/source-serif-4` + `@fontsource/ibm-plex-mono` (dependencies of `@mythrun/ui`). **Load them via JS import in the app entry** (`import "@fontsource/source-serif-4/400.css"` etc. in `frontend/src/main.tsx`) — Vite bundles these deterministically and sidesteps the CSS-`@import`-must-precede-all-rules constraint (a CSS `@import` of `@fontsource` *after* `@import "tailwindcss"` is invalid/fragile). A minimal weight set (serif 400 + 600; mono 400 + 500), revisable. **Tyma Garamont is wordmark-images-only** — the brand's SVG/PNG exports, never a web font.
- **Font tokens** (`@theme`): `--font-body: "Source Serif 4", <serif fallback>` and `--font-ui: "IBM Plex Mono", <mono fallback>` → `font-body` / `font-ui` utilities. The brand's narrative-serif / machine-mono split.
- **Type scale** (`@theme`, `--text-*` size+line-height pairs + weight tokens): conventional, brand-silent, revisable — no bespoke over-fitting.

## 6. Non-color scales

- **Spacing / radius / shadow:** rely on Tailwind v4 defaults (brand-silent). **Do NOT emit `--*: initial`** in any `@theme` block (that wipes v4's defaults — we extend, not replace). Override only a small set of **soft, quiet shadows** (UX spec's "soft shadows, things float," kept restrained).
- **Motion** (`@theme`): `--duration-fast/base/slow` + `--ease-*` tokens. Plus a global `prefers-reduced-motion: reduce` reset in `base.css` collapsing transition/animation durations to ~0 (UX §1 baseline).

## 7. Dark mode

- Class-based `.dark` on `<html>` (toggle-ready; toggle UI is MYT-83). The `:root`/`.dark` alias remap (§3.2) is what inverts the palette.
- **Inversion = remap the semantic aliases** under `.dark` — a true warm inversion. The neutral remaps below are **contrast-verified** (round 1, against AA); the *semantic-state* dark steps are tuned + measured during implementation (the `tokens.html` contrast column gates them):

  | Alias | Light | Dark | Dark contrast (verified / to-measure) |
  |---|---|---|---|
  | `--bg` | paper-100 | paper-900 | — |
  | `--surface` | paper-50 | paper-800 | — |
  | `--border` | paper-300 | paper-700 | — |
  | `--ink` | paper-900 | paper-100 | 14.03:1 on `--bg` ✓ |
  | `--ink-secondary` | paper-700 | paper-300 | 9.30:1 ✓ |
  | `--ink-tertiary` | **paper-600** *(AA body)* | paper-400 | 6.46:1 ✓ |
  | `--accent` | ember-600 | ember-400 | 4.76:1 ✓ (AA) |
  | `--accent-hover` | ember-700 | ember-300 | 6.43:1 ✓ |
  | `--success/warning/danger/info` | -500 / -500 / -500 / **-600** | a lighter generated step | **measure in tokens.html** |

- **Contract for semantic colors:** they are UI-state fills, **not body text**. As text on light paper-100 the generated anchors are large-text-only (e.g. warning-500 ≈ 3.11:1). Where a semantic color carries text (alerts, badges), the pairing must be one of the measured AA-passing combinations in `tokens.html`; the component layer (MYT-82) is responsible for choosing a passing pairing.

## 8. Audit "story" + the gate

The done-when "renders all ramps" without Storybook (MYT-82):

- **Generated `tokens.html`** (by `generate-palette.mjs`): every scale ramp + every semantic alias, in **light and dark**, in the brand's `palette.html` style, **with a measured-contrast column** — the §4 sign-off surface + the seed for MYT-82's Storybook token page.
- **Vitest token-presence + dark-flip assertions** (run in the existing `@mythrun/web` suite — `@mythrun/ui` stays vitest-free):
  1. **Manifest-driven presence:** import `tokens.manifest.json` (the single source the generator emits *and* `theme.css` is built from); assert every manifest entry has a matching `--<name>:` declaration in the concatenated `theme.css` + `semantic.css` source, and that **every semantic alias has a `.dark` counterpart**. (A substring match alone is too weak — the manifest-as-single-source is what makes "fails on a dropped token" true.)
  2. **Rendered dark-flip:** mount a probe element using the alias utilities, read `getComputedStyle().backgroundColor`, toggle `.dark` on the root, assert the resolved color changes. This is the only assertion that catches the §3.2 `@theme inline` mistake (source text looks identical either way).
  Both are plain assertions, no logic module → no coverage-gate impact.

## 9. Tooling / rails interaction (round-1 findings)

- **The `.mjs` generator vs. MYT-79's strict lint** (guaranteed failure otherwise): `@mythrun/ui`'s `eslint . ` runs the root `strictTypeChecked` config, and `frontend/ui/tsconfig.json` has no `allowJs` + doesn't `include` `scripts/**` → `generate-palette.mjs` would both error in `projectService` ("file not found by the project") and trip `no-unsafe-*`. The generator is **committed build-tooling, not shipped source**, so **add `scripts/**` to `frontend/ui/eslint.config.js`'s `ignores`** (and leave it out of the tsconfig `include`). This is cleaner than MYT-79's in-project `allowJs` + `no-unsafe-off` carve-out because the script isn't part of the library's typecheck surface.
- **lint-staged reformats generated output:** `lint-staged` runs `prettier --write` on `*.html` (+ the `.mjs`) at commit, which would fight the generator's own formatting and break "re-running the generator reproduces the committed bytes." **Add `frontend/ui/tokens.html` + `frontend/ui/scripts/generate-palette.mjs` to `.prettierignore`** (or have the generator emit prettier-formatted output and the test assert idempotence).
- **The `tokens.html`/CSS files trip none of the MYT-79 rails** (verified: `no-literal-string` + `no-ad-hoc-ui` are `.tsx`-scoped in `@mythrun/web` only; `src/**/*.css` is eslint-ignored). No defensive work needed.
- **MYT-80 merge:** MYT-81's new deps are confined to `frontend/ui/package.json` (`@fontsource/*` deps + `culori` devDep); MYT-80's i18n deps land in `frontend/package.json`. The only expected conflict at the human's serial merge is **`pnpm-lock.yaml` — regenerate with `pnpm install` post-merge, do not hand-resolve.**

## 10. Out of scope (later issues)

| Deferred to | What |
|---|---|
| MYT-82 | the dithered-gradient utility; real components; Storybook token page; the `@source` registration in the Storybook host |
| MYT-83 | the dark-mode toggle UI + persistence (`.dark` class management) |

## 11. Done when

1. `@mythrun/ui` exports `./styles.css`; the app's `index.css` imports it + registers `@source`; `pnpm --filter @mythrun/web build` succeeds with tokens applied (a **throwaway, non-committed** probe — or one living in `@mythrun/ui` where `className` is legal — styled `bg-bg text-ink font-body` renders cream/ink/serif; it is NOT a committed feature-code component, which would trip `no-ad-hoc-ui`).
2. The 60 color tokens, semantic aliases (via `@theme inline`), and font/type/motion tokens are declared; paper/ember/anchor hexes match the brand **verbatim**; `tokens.manifest.json` is the single source.
3. The 36 generated semantic values are produced by the committed script, shown in `tokens.html` **with measured-contrast columns**, and **signed off by the human** against the ratios (gates §11.4).
4. Toggling `.dark` on `<html>` inverts to a coherent warm dark (rendered dark-flip test passes — §8.2); `--color-ink-tertiary` meets AA body in both modes.
5. Self-hosted Source Serif 4 + IBM Plex Mono load via JS import (no CDN); `--font-body`/`--font-ui` resolve; Tyma is not a web font.
6. The `prefers-reduced-motion` reset zeroes motion; motion tokens resolve.
7. The manifest-driven token-presence + the rendered dark-flip Vitest assertions pass and would fail on a dropped token / a broken remap.
8. `pnpm --filter @mythrun/web lint && typecheck && test:coverage` and `pnpm --filter @mythrun/ui lint && typecheck` all green (the generator `.mjs` is eslint-ignored per §9); the MYT-79 rails still hold.

## 12. Open questions

None. Forks resolved in brainstorming (full 60; token home `@mythrun/ui`; dark inversion now; static `tokens.html` audit). Round-1 corrections folded in (the `@theme inline` dark mechanism, the anchor-preservation-hard generation recipe + info-600, gamut mapping, the AA tertiary-ink fix, the `.mjs` lint-ignore, JS font loading, the manifest-driven + dark-flip gate). Pending: the human's visual sign-off on the 36 generated values (§4), during implementation.
