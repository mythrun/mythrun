# MYT-81 Design Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Worktree:** all work happens in `.worktrees/myt-81-tokens/` on branch `myt-81-tokens`. **Do NOT merge or push** — the human merges serially with the parallel MYT-80 fork.

**Goal:** Ship the brand's design-token layer — the 60-token OKLCH palette (paper/ember verbatim + 36 generated semantic steps), typography, spacing/radius/shadow, motion, and a true-warm-inversion dark mode — as Tailwind v4 `@theme` + CSS custom properties in `@mythrun/ui`, consumed by `@mythrun/web`.

**Architecture:** Tokens live in `@mythrun/ui` as Tailwind-v4-source CSS exported via `./styles.css`. Two layers: literal scale tokens in plain `@theme`; semantic aliases via `@theme inline` + `:root`/`.dark` remap vars (the only pattern where a `.dark` override actually cascades in v4). The 36 semantic steps are produced by a committed, self-validating `culori` OKLCH generator (anchor-preservation is the hard constraint), emitted to `colors.generated.css` + `tokens.manifest.json` + a `tokens.html` swatch/contrast audit.

**Tech Stack:** Tailwind v4 (`@theme inline`, `@custom-variant dark`, `@source`), `culori` (OKLCH + gamut mapping), `@fontsource` (self-hosted Source Serif 4 + IBM Plex Mono, loaded via JS import), Vitest (jsdom).

**Source spec:** `docs/superpowers/specs/2026-06-19-myt-81-design-tokens-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/ui/package.json` (modify) | add `@fontsource/*` deps + `culori` devDep; add `./styles.css` export |
| `frontend/ui/eslint.config.js` (modify) | ignore `scripts/**` (the generator is committed tooling, not lint surface) |
| `frontend/ui/scripts/generate-palette.mjs` (create) | OKLCH generator — exports `generatePalette()`, CLI emits the 3 artifacts |
| `frontend/ui/src/styles/colors.generated.css` (generated) | the 60 `--color-*` tokens in a plain `@theme` block |
| `frontend/ui/src/styles/tokens.manifest.json` (generated) | canonical token list (names→values) — single source for the §gate test |
| `frontend/ui/tokens.html` (generated) | swatch + measured-contrast audit (light+dark) — the sign-off surface |
| `frontend/ui/src/styles/theme.css` (create) | hand-authored `@theme`: type/weight/radius/shadow/motion/font scale tokens |
| `frontend/ui/src/styles/semantic.css` (create) | `:root`/`.dark` alias remap + `@theme inline` surface + `@custom-variant dark` |
| `frontend/ui/src/styles/base.css` (create) | `prefers-reduced-motion` reset + element base (`body` → bg/ink/serif) |
| `frontend/ui/src/styles/index.css` (create) | entry: `@import`s colors.generated/theme/semantic/base; the package's `./styles.css` |
| `frontend/src/index.css` (modify) | `@import "tailwindcss"; @import "@mythrun/ui/styles.css"; @source "../ui/src";` (drop the empty `@theme`) |
| `frontend/src/main.tsx` (modify) | JS-import the `@fontsource` weight CSS |
| `frontend/src/__tests__/tokens.test.ts` (create) | manifest-driven token-presence + rendered dark-flip assertions |
| `frontend/src/__tests__/generate-palette.test.ts` (create) | generator-invariant assertions (TDD) |
| `.prettierignore` (modify) | ignore the generated `tokens.html` + the generator `.mjs` |

**Brand inputs (verbatim, from `brand/palette/palette.html`):**
- paper: `50 #F8F4EA · 100 #EFE9DC · 200 #E1D9C6 · 300 #C9BFA8 · 400 #A89F8A · 500 #877F72 · 600 #66604F · 700 #3D3528 · 800 #2D2519 · 900 #231B12`
- ember: `50 #F5E4D3 · 100 #ECCDAB · 200 #DCAE7E · 300 #C99562 · 400 #B47B4E · 500 #9E6A44 · 600 #8A5A3C · 700 #714730 · 800 #573624 · 900 #3C2619`
- semantic anchors: `success-500 #6D7A3E · warning-500 #B07835 · danger-500 #B55A48 · info-600 #4A6B82`

---

### Task 1: `@mythrun/ui` package setup

**Files:** Modify `frontend/ui/package.json`, `frontend/ui/eslint.config.js`, `.prettierignore` (create if absent).

- [ ] **Step 1: Add deps + the styles export to `frontend/ui/package.json`**

Add to `exports` (keep the `"."` entry): `"./styles.css": "./src/styles/index.css"`. Add `dependencies` `@fontsource/source-serif-4` + `@fontsource/ibm-plex-mono`; add `devDependencies` `culori`. Resulting file:

```json
{
  "name": "@mythrun/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./styles.css": "./src/styles/index.css"
  },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --no-error-on-unmatched-pattern",
    "generate:palette": "node scripts/generate-palette.mjs"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "dependencies": {
    "@fontsource/source-serif-4": "^5.0.0",
    "@fontsource/ibm-plex-mono": "^5.0.0"
  },
  "devDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.6.0",
    "culori": "^4.0.0"
  }
}
```
(Version floors are `^`; resolve to current stable if a floor is unsatisfiable, note any deviation.)

- [ ] **Step 2: Ignore `scripts/**` in `frontend/ui/eslint.config.js`**

The generator `.mjs` is committed tooling, not shipped source; without this it hits the root `strictTypeChecked` `projectService` ("file not found by the project") + `no-unsafe-*`. Add `scripts/**` to the existing `ignores` block:

```js
  {
    ignores: ['dist/**', 'src/**/*.css', 'scripts/**'],
  },
```
(Keep the rest of the file — the `...root` spread, the jsx-a11y block, `eslintConfigPrettier` last — unchanged.)

- [ ] **Step 3: Add the generated artifacts to `.prettierignore`** (repo root; create if it doesn't exist)

`lint-staged` runs `prettier --write` on `*.html`/`.mjs` at commit, which would fight the generator's output. Append:
```
frontend/ui/tokens.html
frontend/ui/scripts/generate-palette.mjs
frontend/ui/src/styles/colors.generated.css
frontend/ui/src/styles/tokens.manifest.json
```

- [ ] **Step 4: Install**

Run: `pnpm install`
Expected: resolves; `culori`, `@fontsource/*` present. Confirm: `pnpm --filter @mythrun/ui exec node -e "import('culori').then(c=>console.log(typeof c.oklch))"` → `function`.

- [ ] **Step 5: Commit** (on the branch; no push)
```bash
git add frontend/ui/package.json frontend/ui/eslint.config.js .prettierignore pnpm-lock.yaml
git commit -m "feat(MYT-81): @mythrun/ui token deps (@fontsource + culori) + styles export + scripts lint-ignore"
```

---

### Task 2: The OKLCH palette generator (TDD)

**Files:** Create `frontend/ui/scripts/generate-palette.mjs`, `frontend/src/__tests__/generate-palette.test.ts`. Generates `frontend/ui/src/styles/colors.generated.css`, `frontend/ui/src/styles/tokens.manifest.json`, `frontend/ui/tokens.html`.

- [ ] **Step 1: Write the failing invariant test** — `frontend/src/__tests__/generate-palette.test.ts`

`@mythrun/web`'s tsconfig has `allowJs` (from MYT-79), so importing the `.mjs` resolves. The test asserts the generation invariants the spec §4 demands.

```ts
import { describe, it, expect } from 'vitest'
import { oklch } from 'culori'
// Cross-package import into the lib's committed generator (test-only).
import { generatePalette, STEPS, SEMANTIC_ANCHORS } from '../../../ui/scripts/generate-palette.mjs'

const palette = generatePalette()

describe('generatePalette — brand fidelity', () => {
  it('reproduces every paper + ember step verbatim', () => {
    expect(palette.paper[100]).toBe('#EFE9DC')
    expect(palette.ember[600]).toBe('#8A5A3C')
    expect(palette.paper[900]).toBe('#231B12')
  })
  it('pins each semantic anchor to its exact brand hex', () => {
    expect(palette.success[500]).toBe('#6D7A3E')
    expect(palette.warning[500]).toBe('#B07835')
    expect(palette.danger[500]).toBe('#B55A48')
    expect(palette.info[600]).toBe('#4A6B82') // info anchors at 600
  })
})

describe('generatePalette — generation invariants', () => {
  for (const ramp of ['success', 'warning', 'danger', 'info'] as const) {
    it(`${ramp}: 10 steps, strictly monotonic lightness, hue held`, () => {
      const steps = STEPS.map((s) => palette[ramp][s])
      expect(steps).toHaveLength(10)
      const ls = steps.map((hex) => oklch(hex)!.l)
      // light → dark: lightness strictly decreasing
      for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeLessThan(ls[i - 1]!)
      // hue held at the anchor's hue (±2° tolerance for gamut-clipped top steps)
      const anchorHue = oklch(SEMANTIC_ANCHORS[ramp].hex)!.h!
      for (const hex of steps) {
        const h = oklch(hex)!.h
        if (h === undefined) continue // achromatic edge
        const d = Math.abs(((h - anchorHue + 540) % 360) - 180)
        expect(d).toBeLessThanOrEqual(2)
      }
    })
  }
})
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `pnpm --filter @mythrun/web exec vitest run src/__tests__/generate-palette.test.ts`
Expected: FAIL — `Cannot find module '../../../ui/scripts/generate-palette.mjs'`.

- [ ] **Step 3: Implement `frontend/ui/scripts/generate-palette.mjs`**

```js
// MYT-81 palette generator. Committed, deterministic, self-validating.
// Run: pnpm --filter @mythrun/ui generate:palette
import { oklch, formatHex, toGamut, wcagContrast } from 'culori'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]

const PAPER = {
  50: '#F8F4EA', 100: '#EFE9DC', 200: '#E1D9C6', 300: '#C9BFA8', 400: '#A89F8A',
  500: '#877F72', 600: '#66604F', 700: '#3D3528', 800: '#2D2519', 900: '#231B12',
}
const EMBER = {
  50: '#F5E4D3', 100: '#ECCDAB', 200: '#DCAE7E', 300: '#C99562', 400: '#B47B4E',
  500: '#9E6A44', 600: '#8A5A3C', 700: '#714730', 800: '#573624', 900: '#3C2619',
}
export const SEMANTIC_ANCHORS = {
  success: { hex: '#6D7A3E', anchorStep: 500 },
  warning: { hex: '#B07835', anchorStep: 500 },
  danger: { hex: '#B55A48', anchorStep: 500 },
  info: { hex: '#4A6B82', anchorStep: 600 },
}

const toRgb = toGamut('rgb', 'oklch') // CSS Color 4 gamut mapping
const emberOk = Object.fromEntries(STEPS.map((s) => [s, oklch(EMBER[s])]))

function generateRamp(hex, anchorStep) {
  const a = oklch(hex) // { mode:'oklch', l, c, h }
  const lShift = a.l - emberOk[anchorStep].l // re-anchor ember's L curve through the anchor
  const out = {}
  for (const s of STEPS) {
    if (s === anchorStep) {
      out[s] = hex // exact brand preservation — never recompute the anchor
      continue
    }
    const l = Math.min(1, Math.max(0, emberOk[s].l + lShift))
    const c = a.c * (emberOk[s].c / emberOk[anchorStep].c) // ember chroma-taper, scaled through the anchor
    out[s] = formatHex(toRgb({ mode: 'oklch', l, c, h: a.h }))
  }
  return out
}

export function generatePalette() {
  const palette = { paper: { ...PAPER }, ember: { ...EMBER } }
  for (const [name, { hex, anchorStep }] of Object.entries(SEMANTIC_ANCHORS)) {
    palette[name] = generateRamp(hex, anchorStep)
  }
  // self-validate: strictly monotonic L per generated ramp
  for (const name of Object.keys(SEMANTIC_ANCHORS)) {
    const ls = STEPS.map((s) => oklch(palette[name][s]).l)
    for (let i = 1; i < ls.length; i++) {
      if (!(ls[i] < ls[i - 1])) throw new Error(`${name}: non-monotonic L at step ${STEPS[i]}`)
    }
  }
  return palette
}

const RAMPS = ['paper', 'ember', 'success', 'warning', 'danger', 'info']

function toThemeCss(palette) {
  const lines = RAMPS.flatMap((r) =>
    STEPS.map((s) => `  --color-${r}-${s}: ${palette[r][s]};`),
  )
  return `/* GENERATED by scripts/generate-palette.mjs — do not edit by hand. */\n@theme {\n${lines.join('\n')}\n}\n`
}

function toManifest(palette) {
  const colors = {}
  for (const r of RAMPS) for (const s of STEPS) colors[`--color-${r}-${s}`] = palette[r][s]
  return { colors }
}

function toAuditHtml(palette) {
  const ramp = (r) =>
    `<h2>${r}</h2><div class="ramp">` +
    STEPS.map((s) => {
      const hex = palette[r][s]
      const onLight = wcagContrast(hex, palette.paper[100]).toFixed(2)
      const onDark = wcagContrast(hex, palette.paper[900]).toFixed(2)
      return `<div class="sw" style="background:${hex}"><b>${s}</b><span>${hex}</span><span class="cc">L ${onLight} · D ${onDark}</span></div>`
    }).join('') +
    `</div>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mythrun tokens</title><style>
    body{font-family:ui-monospace,monospace;background:${palette.paper[100]};color:${palette.paper[900]};padding:32px}
    .ramp{display:grid;grid-template-columns:repeat(10,1fr);gap:0;margin-bottom:8px;border-radius:6px;overflow:hidden}
    .sw{aspect-ratio:1;padding:8px;font-size:9px;display:flex;flex-direction:column;justify-content:space-between;color:#0007}
    .sw b{font-size:11px}.cc{opacity:.7}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;margin:24px 0 6px}
  </style></head><body><h1>Mythrun design tokens — light (contrast: L=on paper-100, D=on paper-900)</h1>
  ${RAMPS.map(ramp).join('')}</body></html>`
}

// CLI: emit the three artifacts (skipped when imported for tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url))
  const palette = generatePalette()
  writeFileSync(resolve(here, '../src/styles/colors.generated.css'), toThemeCss(palette))
  writeFileSync(resolve(here, '../src/styles/tokens.manifest.json'), JSON.stringify(toManifest(palette), null, 2) + '\n')
  writeFileSync(resolve(here, '../tokens.html'), toAuditHtml(palette))
  console.log('generated colors.generated.css, tokens.manifest.json, tokens.html')
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `pnpm --filter @mythrun/web exec vitest run src/__tests__/generate-palette.test.ts`
Expected: PASS (brand fidelity + 4 ramp-invariant tests). If a ramp is non-monotonic, the generator throws at import — tune the `lShift`/chroma formula.

- [ ] **Step 5: Run the generator — emit the artifacts**

Run: `pnpm --filter @mythrun/ui generate:palette`
Expected: writes `colors.generated.css` (66 `--color-*` lines), `tokens.manifest.json`, `tokens.html`. Confirm `grep -c -- '--color-' frontend/ui/src/styles/colors.generated.css` → `60`.

- [ ] **Step 6: Commit**
```bash
git add frontend/ui/scripts/generate-palette.mjs frontend/src/__tests__/generate-palette.test.ts frontend/ui/src/styles/colors.generated.css frontend/ui/src/styles/tokens.manifest.json frontend/ui/tokens.html
git commit -m "feat(MYT-81): OKLCH palette generator + 36 generated semantic steps (TDD; anchor-preserving)"
```

---

### Task 3: Scale tokens + fonts + wire into the app

**Files:** Create `frontend/ui/src/styles/{theme.css,base.css,index.css}`. Modify `frontend/src/index.css`, `frontend/src/main.tsx`.

- [ ] **Step 1: `frontend/ui/src/styles/theme.css`** — hand-authored scale tokens (NO `--*: initial` — extend v4 defaults)

```css
@theme {
  /* Typography — the brand's narrative-serif / machine-mono split. */
  --font-body: "Source Serif 4", ui-serif, Georgia, serif;
  --font-ui: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --text-xs: 0.75rem;   --text-xs--line-height: 1.5;
  --text-sm: 0.875rem;  --text-sm--line-height: 1.5;
  --text-base: 1rem;    --text-base--line-height: 1.6;
  --text-lg: 1.125rem;  --text-lg--line-height: 1.6;
  --text-xl: 1.375rem;  --text-xl--line-height: 1.4;
  --text-2xl: 1.75rem;  --text-2xl--line-height: 1.3;
  --text-3xl: 2.25rem;  --text-3xl--line-height: 1.2;

  /* Motion (brand-silent; conventional). */
  --duration-fast: 120ms;
  --duration-base: 200ms;
  --duration-slow: 360ms;

  /* Soft, quiet shadows (UX "things float", brand-restrained). */
  --shadow-soft: 0 1px 2px rgb(35 27 18 / 0.06), 0 4px 12px rgb(35 27 18 / 0.06);
  --shadow-float: 0 2px 4px rgb(35 27 18 / 0.07), 0 8px 24px rgb(35 27 18 / 0.08);
}
```

- [ ] **Step 2: `frontend/ui/src/styles/base.css`** — reduced-motion reset + element base

```css
body {
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: var(--font-body);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 3: `frontend/ui/src/styles/index.css`** — the `./styles.css` entry (semantic.css added in Task 4)

```css
@import "./colors.generated.css";
@import "./theme.css";
@import "./semantic.css";
@import "./base.css";
```

- [ ] **Step 4: Rewrite `frontend/src/index.css`** (drop the empty `@theme`)

```css
@import "tailwindcss";
@import "@mythrun/ui/styles.css";

/* @mythrun/ui is a workspace package; v4 does NOT auto-scan node_modules, so
   register the lib's own source for class detection (no-op until MYT-82 adds
   styled components, but it's the seam that makes them emit CSS). */
@source "../ui/src";
```

- [ ] **Step 5: Load fonts via JS import in `frontend/src/main.tsx`** (add at the top, after the existing imports)

```tsx
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
```
(Vite bundles these deterministically — sidesteps the CSS `@import`-ordering rule.)

- [ ] **Step 6: Verify the app builds with tokens** (semantic.css doesn't exist yet → expect a build error referencing it; that's fine, Task 4 adds it. For now verify the scale-token CSS parses by temporarily commenting the `@import "./semantic.css"` line, building, then restoring — OR just proceed; Task 4's build is the real gate.)

Run (after Task 4 lands, this is re-checked): `pnpm --filter @mythrun/web build`
Expected (post-Task-4): succeeds.

- [ ] **Step 7: Commit**
```bash
git add frontend/ui/src/styles/theme.css frontend/ui/src/styles/base.css frontend/ui/src/styles/index.css frontend/src/index.css frontend/src/main.tsx
git commit -m "feat(MYT-81): scale tokens (type/motion/shadow) + fonts + wire @mythrun/ui styles into the app"
```

---

### Task 4: Semantic aliases + dark-mode inversion

**Files:** Create `frontend/ui/src/styles/semantic.css`.

- [ ] **Step 1: `frontend/ui/src/styles/semantic.css`** — the `@theme inline` + `:root`/`.dark` remap (the load-bearing dark-mode-correct pattern)

```css
/* Semantic aliases. The remap vars live in :root/.dark (plain CSS, so the
   .dark override CASCADES); `@theme inline` surfaces them as bg-bg/text-ink
   utilities that reference the var at runtime. A plain @theme alias would
   resolve at :root and never flip — that is the v4 gotcha this avoids. */
:root {
  --bg: var(--color-paper-100);
  --surface: var(--color-paper-50);
  --border: var(--color-paper-300);
  --ink: var(--color-paper-900);
  --ink-secondary: var(--color-paper-700);
  --ink-tertiary: var(--color-paper-600); /* paper-600 = AA body; brand doc's paper-500 is only 3.27:1 */
  --accent: var(--color-ember-600);
  --accent-hover: var(--color-ember-700);
  --success: var(--color-success-500);
  --warning: var(--color-warning-500);
  --danger: var(--color-danger-500);
  --info: var(--color-info-600);
}

.dark {
  --bg: var(--color-paper-900);
  --surface: var(--color-paper-800);
  --border: var(--color-paper-700);
  --ink: var(--color-paper-100);
  --ink-secondary: var(--color-paper-300);
  --ink-tertiary: var(--color-paper-400);
  --accent: var(--color-ember-400);
  --accent-hover: var(--color-ember-300);
  --success: var(--color-success-400);
  --warning: var(--color-warning-400);
  --danger: var(--color-danger-400);
  --info: var(--color-info-400);
}

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-border: var(--border);
  --color-ink: var(--ink);
  --color-ink-secondary: var(--ink-secondary);
  --color-ink-tertiary: var(--ink-tertiary);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-danger: var(--danger);
  --color-info: var(--info);
}

@custom-variant dark (&:where(.dark, .dark *));
```

- [ ] **Step 2: Verify the full build + a manual dark-flip**

Run: `pnpm --filter @mythrun/web build`
Expected: succeeds (all `@import`s resolve, `@theme inline` + `@custom-variant` compile).

Manual probe: temporarily add to `frontend/src/app.tsx` (in the LIBRARY-legal way — actually app.tsx is feature code; instead verify via the Vitest dark-flip test in Task 5, which is the real gate). For now just confirm the build is green.

- [ ] **Step 3: Commit**
```bash
git add frontend/ui/src/styles/semantic.css
git commit -m "feat(MYT-81): semantic aliases + warm-inversion dark mode (@theme inline + :root/.dark remap)"
```

---

### Task 5: The token gate (manifest-presence + rendered dark-flip)

**Files:** Create `frontend/src/__tests__/tokens.test.ts`.

- [ ] **Step 1: Write the gate test** — `frontend/src/__tests__/tokens.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import manifest from '../../../ui/src/styles/tokens.manifest.json'

const stylesDir = resolve(__dirname, '../../../ui/src/styles')
const css = ['colors.generated.css', 'theme.css', 'semantic.css']
  .map((f) => readFileSync(resolve(stylesDir, f), 'utf8'))
  .join('\n')

describe('token presence (manifest-driven)', () => {
  it('declares every manifest color token', () => {
    for (const name of Object.keys(manifest.colors)) {
      expect(css).toContain(`${name}:`)
    }
  })
  it('every semantic alias has a .dark counterpart', () => {
    const aliases = ['--bg', '--surface', '--border', '--ink', '--ink-secondary', '--ink-tertiary',
      '--accent', '--accent-hover', '--success', '--warning', '--danger', '--info']
    const darkBlock = css.slice(css.indexOf('.dark {'), css.indexOf('}', css.indexOf('.dark {')))
    for (const a of aliases) expect(darkBlock).toContain(`${a}:`)
  })
})

describe('dark-mode remap actually flips (rendered)', () => {
  it('a var-referencing element resolves differently under .dark', () => {
    // jsdom can't run Tailwind, so assert the CASCADE mechanic directly: an
    // element reading var(--bg) flips when .dark sets --bg. This is exactly
    // what the @theme inline utility does at runtime.
    document.head.innerHTML = `<style>
      :root{--color-paper-100:#EFE9DC;--color-paper-900:#231B12;--bg:var(--color-paper-100)}
      .dark{--bg:var(--color-paper-900)}
      .probe{background:var(--bg)}
    </style>`
    document.body.innerHTML = `<div class="probe"></div>`
    const probe = document.querySelector('.probe')!
    const light = getComputedStyle(probe).backgroundColor
    document.documentElement.classList.add('dark')
    const dark = getComputedStyle(probe).backgroundColor
    expect(dark).not.toBe(light)
    document.documentElement.classList.remove('dark')
  })
})
```
> Note: if jsdom's `getComputedStyle` doesn't resolve nested `var()` (it's limited), assert instead that `semantic.css` pairs `@theme inline { --color-bg: var(--bg) }` with a `.dark { --bg: … }` override (structural proof of the cascade). The implementer picks whichever jsdom supports — the goal is a regression guard on the `@theme inline` mechanic.

- [ ] **Step 2: Run — verify it passes**

Run: `pnpm --filter @mythrun/web exec vitest run src/__tests__/tokens.test.ts`
Expected: PASS. (If the dark-flip jsdom assertion is unsupported, fall back to the structural assertion per the note.)

- [ ] **Step 3: Commit**
```bash
git add frontend/src/__tests__/tokens.test.ts
git commit -m "feat(MYT-81): manifest-driven token-presence + dark-flip gate"
```

---

### Task 6: Sign-off artifact + full verification + close-out (no merge/push)

**Files:** none (verification + the human sign-off).

- [ ] **Step 1: Surface `tokens.html` for the human's value sign-off** — the controller sends the file to the user (it shows all 60 swatches + measured contrast, light/dark). This is a non-blocking surface: proceed, but flag that any "off" ramp is a one-line `lShift`/chroma tweak + regenerate.

- [ ] **Step 2: Full verification (both packages)**

Run each; all must be green:
```
pnpm --filter @mythrun/ui typecheck
pnpm --filter @mythrun/ui lint           # the generator .mjs is eslint-ignored
pnpm --filter @mythrun/web typecheck
pnpm --filter @mythrun/web lint
pnpm --filter @mythrun/web test           # all tests incl the 2 new suites
pnpm --filter @mythrun/web test:coverage  # still 100% on the rule (no new logic added to the gate)
pnpm --filter @mythrun/web build          # tokens applied
```
Expected: all exit 0. Confirm the build CSS contains the brand cream — `grep -ri "efe9dc\|231b12" frontend/dist/assets/*.css | head` shows the paper tokens emitted.

- [ ] **Step 3: Idempotence check** — re-run `pnpm --filter @mythrun/ui generate:palette` and confirm `git status` shows NO changes to the generated files (the generator is reproducible; prettier doesn't touch them — they're in `.prettierignore`).

- [ ] **Step 4: Close-out — commit any remainder, do NOT merge or push**
```bash
git add -A && git status         # confirm only MYT-81 files
git commit -m "chore(MYT-81): final verification" --allow-empty
git log --oneline origin/main..HEAD   # the MYT-81 commit stack on the branch
```
Then STOP and hand the branch (`myt-81-tokens`) back to the human for the serial merge. Report: the commit stack, that all gates are green, that `tokens.html` awaits sign-off, and the MYT-80 merge note (lockfile-only conflict). **Do not `git push`, do not `git merge`, do not flip Linear** — the human owns the merge.

---

## Done-when → task map (spec §11)

| Spec done-when | Task |
|---|---|
| #1 exports + app import + @source + build | T1, T3, T4 |
| #2 60 tokens + aliases via @theme inline + manifest | T2, T3, T4 |
| #3 36 generated values + tokens.html contrast + sign-off | T2, T6 |
| #4 .dark inverts + AA tertiary ink | T4, T5 |
| #5 fonts via JS import; Tyma not a web font | T1, T3 |
| #6 reduced-motion + motion tokens | T3 |
| #7 manifest-presence + dark-flip gate | T5 |
| #8 both packages green; rails hold | T6 |
