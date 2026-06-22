# MYT-82 — mythrunUI Component Library + Storybook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the mythrunUI design system — `@mythrun/client-core` (contract types + relocated token generator), `@mythrun/ui` (Flat-1-bit web components on Tailwind v4 + CVA + Radix), Storybook 9, the completed token foundation, ~26 primitives, and the enforcement gates wired into CI.

**Architecture:** One-way deps `client-core ← ui ← web`. The component **contract** (react-only prop types) lives in `@mythrun/client-core/contract`; each web component is typed against it (`tsc` = the *satisfies* half of conformance, the API-purity lint = the *doesn't-exceed* half). The **token generator** (JS/JSON, no CSS) lives in `@mythrun/client-core/tokens`; `@mythrun/ui` runs it at build to emit `colors.generated.css` (all web CSS stays in `@mythrun/ui`). Components: Tailwind v4 token classes + CVA variants + `radix-ui` (unstyled) behavior, Pixelarticons icons.

**Tech Stack:** pnpm workspace · React 19 · TS strict · Vite 6 · Tailwind v4 · `class-variance-authority` · `tailwind-merge@^3` + `clsx` · unified `radix-ui` · `pixelarticons` · Storybook 9 + `@storybook/addon-a11y` · Vitest 3 + RTL + `jest-axe`.

**Spec:** `docs/superpowers/specs/2026-06-22-myt-82-mythrun-ui-component-library-design.md` (§ references below point to it).

**Standing rules (controller):** TDD (failing test first). All subagents Opus. Implementer subagents do NOT `git add/commit/push` — the controller stages + commits each task serially after spec-compliance + code-quality review. After each wave: controller runs full `pnpm --filter @mythrun/ui lint` + scoped coverage on the wave's files + sweeps debt before the next wave. **HOLD ALL PUSHES** — when all waves are done + locally verified, STOP and check in with Miklos for a visual audit of Storybook (he'll have suggestions); incorporate; only then push → wiki → Linear (per `feedback_frontend_visual_audit_before_push`).

---

## File Structure

```
pnpm-workspace.yaml                      MODIFY — add `frontend/client-core`
frontend/client-core/                    NEW package @mythrun/client-core
  package.json                           exports: "./contract" (types), "./tokens" (generator)
  tsconfig.json · eslint.config.js · vitest.config.ts
  src/contract/index.ts                  barrel of all contract prop types
  src/contract/<name>.ts                 per-component prop/variant types (react-only)
  src/tokens/generate-palette.mjs        MOVED from frontend/ui/scripts/
  src/tokens/scales.ts                   raw token-scale DATA (spacing/radius/sizing/z/motion/type…)
  src/tokens/tokens.manifest.json        generated
  src/tokens/round-trip.test.ts          asserts generator reproduces committed ui CSS byte-for-byte
frontend/ui/                             EXISTING @mythrun/ui
  package.json                           MODIFY — deps + test/test:coverage scripts + build:tokens
  vitest.config.ts                       NEW (jsdom, setup, coverage v8, exclude wiring tests)
  vitest.setup.ts                        NEW (jest-axe matchers, RTL cleanup)
  .storybook/main.ts · preview.ts        NEW (Vite + viteFinal @tailwindcss/vite + a11y addon)
  eslint-rules/                          NEW — relocated `mythrun-ui` plugin + api-purity + no-ad-hoc-color
  eslint.config.js                       MODIFY — register the new rules (library zone)
  stylelint.config.js                    NEW — no-ad-hoc-color over src/**/*.css (exclude generated)
  src/lib/cn.ts                          NEW — clsx + tailwind-merge
  src/styles/colors.generated.css        now emitted by build:tokens (running client-core generator)
  src/styles/{theme,semantic,base}.css   MODIFY — add the new token scales (§4)
  src/components/<Name>/<Name>.tsx        per component
  src/components/<Name>/<Name>.stories.tsx
  src/components/<Name>/<Name>.test.tsx
  src/index.ts                           MODIFY — barrel re-exports each component
  scripts/story-coverage.mjs             NEW — fails if a component dir lacks a story
frontend/eslint.config.js                MODIFY — import path-ban (features → ui/client-core/i18n only)
.github/workflows/frontend-check.yml     MODIFY — add ui test/coverage, storybook build, story-coverage
.husky/pre-push                          MODIFY — mirror the new ui gates
```

Each component is **one directory, three files** (`<Name>.tsx`, `<Name>.stories.tsx`, `<Name>.test.tsx`) — this is the discriminator the story-coverage gate globs.

---

# WAVE 0 — Foundation

## Task 0a.1: Add `@mythrun/client-core` to the workspace

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `frontend/client-core/package.json`, `frontend/client-core/tsconfig.json`

- [ ] **Step 1: Add the package to the workspace globs**

`pnpm-workspace.yaml` currently lists `frontend` + `frontend/ui` under `packages:`. Add:
```yaml
  - frontend/client-core
```

- [ ] **Step 2: Create the package manifest**

`frontend/client-core/package.json`:
```json
{
  "name": "@mythrun/client-core",
  "private": true,
  "type": "module",
  "exports": {
    "./contract": "./src/contract/index.ts",
    "./tokens": "./src/tokens/generate-palette.mjs"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": { "culori": "^4.0.0" },
  "devDependencies": { "react": "^19.0.0", "@types/react": "^19.0.0", "typescript": "^5.6.0", "vitest": "^3.0.0", "@vitest/coverage-v8": "^3.0.0" }
}
```
(Pin exact versions to match the existing `frontend/ui/package.json` at implementation time — read it first.)

- [ ] **Step 3: tsconfig** — copy `frontend/ui/tsconfig.json` (strict, `moduleResolution: Bundler`, `jsx: react-jsx`, `resolveJsonModule: true`).

- [ ] **Step 4: `pnpm install`** — Expected: workspace links `@mythrun/client-core`, no errors.

- [ ] **Step 5: Commit** — `chore(MYT-82): scaffold @mythrun/client-core package`

## Task 0a.2: The contract barrel (empty, typed)

**Files:** Create `frontend/client-core/src/contract/index.ts`, `frontend/client-core/src/contract/contract.test.ts`

- [ ] **Step 1: Failing test** — `contract.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import * as contract from './index.ts'
describe('contract barrel', () => {
  it('is importable and has no runtime value exports (types only)', () => {
    expect(Object.keys(contract)).toHaveLength(0)
  })
})
```
- [ ] **Step 2: Run → FAIL** (`./index.ts` missing).
- [ ] **Step 3: Implement** — `index.ts`: `export type {} from './_placeholder.ts'` is invalid; instead create `index.ts` with a comment + a single shared type used by all components:
```ts
import type { ReactNode, Ref } from 'react'

/** Every mythrunUI component forwards a ref and may take children + an i18n testid. */
export interface BaseProps {
  ref?: Ref<unknown>
  children?: ReactNode
  'data-testid'?: string
}
```
- [ ] **Step 4: Run → PASS** (barrel exports only types → 0 runtime keys).
- [ ] **Step 5: Commit** — `feat(MYT-82): client-core contract barrel + BaseProps`

## Task 0b.1: Relocate the token generator + raw scales

**Files:**
- Move: `frontend/ui/scripts/generate-palette.mjs` → `frontend/client-core/src/tokens/generate-palette.mjs`
- Create: `frontend/client-core/src/tokens/scales.ts`
- Modify: `frontend/ui/package.json` (drop culori devDep + `generate:palette` script; add `build:tokens`)

- [ ] **Step 1:** `git mv frontend/ui/scripts/generate-palette.mjs frontend/client-core/src/tokens/generate-palette.mjs`. Update its `writeFileSync` target paths to write **into `frontend/ui/src/styles/`** via an env var or an argument (the generator stays the source; `@mythrun/ui` invokes it pointing at its own styles dir). Read the current generator first — it currently resolves `../src/styles` relative to `frontend/ui/scripts/`; change to accept an output dir argument.
- [ ] **Step 2:** `scales.ts` — export the raw token scale data as plain JS objects (the §4 values): `SPACING`, `RADIUS`, `CONTROL`, `ICON`, `BORDER`, `SURFACE`, `FOCUS`, `STATE`, `STATUS`, `ZINDEX`, `MOTION`, `TYPE_ROLES`, `WEIGHTS`, `TRACKING`, `MEASURE`, `BREAKPOINTS`. (Platform-neutral data; `@mythrun/ui` emits these to `@theme`, native later emits to NativeWind.)
- [ ] **Step 3:** `frontend/ui/package.json` — add `"build:tokens": "node ../client-core/src/tokens/generate-palette.mjs ./src/styles"`; make `pnpm --filter @mythrun/ui build` run `build:tokens` first.
- [ ] **Step 4: Run `pnpm --filter @mythrun/ui build:tokens`** — Expected: regenerates `colors.generated.css` identically.
- [ ] **Step 5: Commit** — `refactor(MYT-82): relocate token generator to client-core`

## Task 0b.2: Round-trip idempotency test (the real safety net)

**Files:** Create `frontend/client-core/src/tokens/round-trip.test.ts`

- [ ] **Step 1: Failing test** — run the generator into a temp dir, read both the temp output and the committed `frontend/ui/src/styles/colors.generated.css`, assert byte-equal:
```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
describe('token generator round-trip', () => {
  it('reproduces the committed colors.generated.css byte-for-byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tok-'))
    execFileSync('node', ['./generate-palette.mjs', dir], { cwd: join(import.meta.dirname) })
    const fresh = readFileSync(join(dir, 'colors.generated.css'), 'utf8')
    const committed = readFileSync(join(import.meta.dirname, '../../../ui/src/styles/colors.generated.css'), 'utf8')
    expect(fresh).toBe(committed)
  })
})
```
- [ ] **Step 2: Run → PASS** (generator is deterministic). If FAIL, the relocation changed output — fix the generator path/format until byte-equal.
- [ ] **Step 3: Commit** — `test(MYT-82): token generator round-trip idempotency`

## Task 0b.3: Add the new token scales to the web `@theme`

**Files:** Modify `frontend/ui/src/styles/theme.css`, `semantic.css`; Modify `frontend/ui/src/styles/tokens.manifest.json` (via generator); Modify the token test (`frontend/src/__tests__/tokens.test.ts` — move/extend per §2)

- [ ] **Step 1: Failing test** — extend the token test to assert the new tokens exist (`--space-4`, `--radius`, `--control-md`, `--border-strong`, `--focus-ring-color`, `--surface-raised`, `--z-modal`, `--text-danger`, `--ease-out`, etc.) AND that `--shadow-soft`/`--shadow-float` are GONE, AND `--focus-ring-color` resolves to `var(--accent)`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add the §4 token blocks to `theme.css` (`@theme` for static scales) + `semantic.css` (`@theme inline` + `:root`/`.dark` for theme-aware ones: `--border-strong`, `--focus-ring-color: var(--accent)`, `--surface-raised/overlay`, status-intent `--surface/border/text-{intent}`, `--accent-active`, `--surface-hover`). Remove `--shadow-soft`/`--shadow-float`. Follow the existing `@theme inline` idiom (read `semantic.css` first). Verify status/focus/border values clear 3:1/AA using the generator's `wcagContrast` (extend the audit if needed).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(MYT-82): complete token foundation (spacing/sizing/focus/status/z-index)`

## Task 0c.1: `cn()` util + `@mythrun/ui` dependencies

**Files:** Create `frontend/ui/src/lib/cn.ts`, `frontend/ui/src/lib/cn.test.ts`; Modify `frontend/ui/package.json`

- [ ] **Step 1:** Add deps: `class-variance-authority`, `tailwind-merge@^3`, `clsx`, `radix-ui`, `pixelarticons`, and devDeps: `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@vitest/coverage-v8`, `jest-axe`, `@types/jest-axe`, `storybook`, `@storybook/react-vite`, `@storybook/addon-a11y`, `@tailwindcss/vite`, `stylelint`. `pnpm install`.
- [ ] **Step 2: Failing test** — `cn.test.ts`: `expect(cn('p-2', 'p-4')).toBe('p-4')` (merge wins) + `expect(cn('a', false && 'b', 'c')).toBe('a c')`.
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** — `cn.ts`: `import { clsx, type ClassValue } from 'clsx'; import { twMerge } from 'tailwind-merge'; export const cn = (...i: ClassValue[]) => twMerge(clsx(i))`.
- [ ] **Step 5: Run → PASS. Commit** — `feat(MYT-82): cn() util + design-system deps`

## Task 0c.2: `@mythrun/ui` Vitest toolchain

**Files:** Create `frontend/ui/vitest.config.ts`, `frontend/ui/vitest.setup.ts`; Modify `frontend/ui/package.json` (scripts)

- [ ] **Step 1:** `vitest.config.ts` — `environment: 'jsdom'`, `setupFiles: ['./vitest.setup.ts']`, coverage v8 with `--no-file-parallelism`-equivalent if needed, and `coverage.exclude` listing the `*.wiring.test.ts` files (per the vitest-v8 double-load gotcha, `reference_vitest_v8_coverage_double_load`).
- [ ] **Step 2:** `vitest.setup.ts` — `import 'jest-axe/extend-expect'` (or `expect.extend(toHaveNoViolations)`); RTL `afterEach(cleanup)`.
- [ ] **Step 3:** `package.json` scripts: `"test": "vitest run"`, `"test:coverage": "vitest run --coverage"`.
- [ ] **Step 4:** Add a trivial smoke test (`src/lib/cn.test.ts` already exists) and run `pnpm --filter @mythrun/ui test` → PASS.
- [ ] **Step 5: Commit** — `chore(MYT-82): @mythrun/ui vitest + jest-axe toolchain`

## Task 0c.3: Storybook 9 + Tailwind v4 wiring

**Files:** Create `frontend/ui/.storybook/main.ts`, `frontend/ui/.storybook/preview.ts`, `frontend/ui/.storybook/storybook.css`

- [ ] **Step 1:** `main.ts` — framework `@storybook/react-vite`, addons `['@storybook/addon-a11y']`, `stories: ['../src/**/*.stories.tsx']`, and a `viteFinal` that adds `@tailwindcss/vite` to the Storybook Vite plugins (else Tailwind v4 styles don't apply — Phoenix I7).
- [ ] **Step 2:** `preview.ts` — import `storybook.css` (which `@import "tailwindcss"; @import "@mythrun/ui/styles.css"; @source "../src";`), add a global light/dark toolbar that toggles `.dark` on the story root, set a11y addon config.
- [ ] **Step 3:** Add scripts `"storybook": "storybook dev -p 6006"`, `"build-storybook": "storybook build"`.
- [ ] **Step 4: Run `pnpm --filter @mythrun/ui build-storybook`** → Expected: builds with 0 stories (or the Text story if migrated) and no Tailwind errors.
- [ ] **Step 5: Commit** — `chore(MYT-82): Storybook 9 + Tailwind v4 viteFinal wiring`

## Task 0c.4: Relocate the `mythrun-ui` ESLint plugin into `@mythrun/ui`

**Files:** Create `frontend/ui/eslint-rules/index.js` (the `mythrun-ui` plugin); Modify `frontend/ui/eslint.config.js`

- [ ] **Step 1:** Create the `mythrun-ui` plugin definition in `frontend/ui/eslint-rules/` (mirror the existing `frontend/eslint-rules/` structure — read it first). It will host the new `api-purity` + `no-ad-hoc-color` rules. (The existing web rules `no-ad-hoc-ui`/`no-untranslated-jsx-text` stay in `frontend/eslint-rules/` for feature code.)
- [ ] **Step 2:** Wire the plugin into `frontend/ui/eslint.config.js` (currently it deliberately leaves `no-ad-hoc-ui` off — keep that; add the new rules scoped to `src/components/**`).
- [ ] **Step 3:** `pnpm --filter @mythrun/ui lint` → PASS (no rules active yet).
- [ ] **Step 4: Commit** — `chore(MYT-82): mythrun-ui eslint plugin in @mythrun/ui`

## Task 0c.5: `api-purity` ESLint rule (+ wiring test)

**Files:** Create `frontend/ui/eslint-rules/api-purity.js`, `frontend/ui/eslint-rules/api-purity.wiring.test.ts`

- [ ] **Step 1: Failing test (RuleTester)** — invalid: a component prop interface with `className?: string`, `style?: CSSProperties`, or `onMouseEnter`; valid: a clean contract (`variant`, `onPress`-neutral, `children`). Use `@typescript-eslint/rule-tester` for the type-aware `CSSProperties` case; AST-only for the name-based cases. Assert FIRES on each violation and PASSES the clean case (this positive+negative assertion is the MYT-79 no-op lesson — `reference_eslint_unknown_option_silent_noop`).
- [ ] **Step 2: Run → FAIL** (rule missing).
- [ ] **Step 3: Implement** — the rule: flag exported component prop types whose members are named `className`/`style`/`on[Mouse|Pointer|Drag]*` or typed `CSSProperties`/extend `HTMLAttributes`. Scope to the public exported prop surface; ignore internal Radix wiring (Phoenix M9). JSDoc `@type {import('eslint').Rule.RuleModule}`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(MYT-82): api-purity lint (no DOM-only props on contract surface)`

## Task 0c.6: `no-ad-hoc-color` ESLint rule + Stylelint (+ wiring tests)

**Files:** Create `frontend/ui/eslint-rules/no-ad-hoc-color.js`, `frontend/ui/eslint-rules/no-ad-hoc-color.wiring.test.ts`, `frontend/ui/stylelint.config.js`

- [ ] **Step 1: Failing test** — invalid: `className="bg-[#abc]"`, a `#abc`/`rgb(...)` literal inside a `cva({...})` call arg, an inline `style={{ color: '#abc' }}`; valid: `className="bg-ember-600"`, `cva({ variants: { tone: { primary: 'bg-ember-600' } } })`. Assert the cva-arg case specifically (a JSXAttribute-only matcher misses it — Phoenix C2/Chimera I4).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — scan `Literal`/`TemplateLiteral` nodes for hex/`rgb()`/`hsl()` and `[#…]`/`[rgb(…)]` arbitrary utilities, including inside `cva()`/`cn()` call args, within `src/components/**`. Carve out the generator/manifest. Add `stylelint.config.js` (`color-no-hex` etc.) over `src/**/*.css` excluding `colors.generated.css`; add a `lint:css` script.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(MYT-82): no-ad-hoc-color lint (tsx + cva + css)`

## Task 0c.7: `story-coverage` gate

**Files:** Create `frontend/ui/scripts/story-coverage.mjs`, `frontend/ui/scripts/story-coverage.test.ts`

- [ ] **Step 1: Failing test** — given a fixture tree, the script exits non-zero when a `src/components/<Name>/<Name>.tsx` lacks a sibling `<Name>.stories.tsx`, and exits 0 when all have stories. Type-only/util/hook files exempt (glob *component directories*, not exports — Chimera I1).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `story-coverage.mjs`: glob `src/components/*/`, for each require a `*.stories.tsx`; print the missing ones; exit 1 if any. Add `"story-coverage": "node scripts/story-coverage.mjs"` script.
- [ ] **Step 4: Run → PASS** (0 component dirs yet → passes).
- [ ] **Step 5: Commit** — `feat(MYT-82): story-coverage gate`

## Task 0c.8: Import path-ban (web) + CI/pre-push wiring

**Files:** Modify `frontend/eslint.config.js`, `.github/workflows/frontend-check.yml`, `.husky/pre-push`

- [ ] **Step 1:** `frontend/eslint.config.js` — add `no-restricted-imports` banning feature code (`src/features/**` once it exists; harmless now) from importing anything but `@mythrun/ui`, `@mythrun/client-core`, `react*`, the i18n modules. (Cross-feature boundary deferred to MYT-83 — note it.)
- [ ] **Step 2:** `frontend-check.yml` — add steps: `pnpm --filter @mythrun/ui test`, `pnpm --filter @mythrun/ui test:coverage`, `pnpm --filter @mythrun/ui lint:css`, `pnpm --filter @mythrun/ui story-coverage`, `pnpm --filter @mythrun/ui build-storybook`, `pnpm --filter @mythrun/client-core test` + `typecheck`. Mirror in `.husky/pre-push`.
- [ ] **Step 3:** Run the full `frontend-check` steps locally → all PASS.
- [ ] **Step 4: Commit** — `ci(MYT-82): wire @mythrun/ui + client-core gates into CI + pre-push`

**Wave 0 exit:** controller runs `pnpm --filter @mythrun/ui lint && lint:css && test:coverage && build-storybook`, `pnpm --filter @mythrun/client-core test`, `pnpm --filter @mythrun/web typecheck`, full `pnpm lint`. All green before Wave 1.

---

# The canonical component pattern (every Wave 1–3 component follows this)

Worked example: **Button** (`src/components/Button/`). Every component is the same five-step TDD shape; later tasks state only the per-component **delta** (contract, variants, states, Radix base, notes).

**1. Contract** (`frontend/client-core/src/contract/button.ts`, re-exported from `contract/index.ts`):
```ts
import type { BaseProps } from './index.ts'
export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'
export interface ButtonProps extends BaseProps {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  disabled?: boolean
  onPress?: () => void         // neutral name — NOT onClick (DOM); web impl maps to onClick
  label?: string               // i18n key for icon-only usage (a11y name)
}
```

**2. Test first** (`Button.test.tsx`): renders, fires `onPress`, shows a `Spinner` + sets `aria-busy` when `loading`, is not pressable when `disabled`/`loading`, has an accessible name, `toHaveNoViolations()` (jest-axe), and a keyboard test (Enter/Space fires `onPress`).

**3. Implement** (`Button.tsx`): `forwardRef`, typed `(props: ButtonProps)`, CVA for variant/size classes using token utilities (`bg-ember-600 hover:bg-ember-700`, `border-strong`, `focus-visible:outline-[var(--focus-ring-color)]`…), `cn()` to merge, maps `onPress`→`onClick`, renders `<Spinner/>` when loading. No `className`/`style` prop (api-purity).

**4. Story** (`Button.stories.tsx`): autodocs + a story per state in the §6 matrix (default/hover via interaction/active/focus/disabled/loading), all variants × sizes, a11y notes, do/don't (per the doc template, Basilisk I5).

**5. Barrel + commit:** add `export { Button } from './components/Button/Button.tsx'` to `src/index.ts`; controller commits.

Every component task = `[ ] contract · [ ] failing test · [ ] impl · [ ] story · [ ] gates green · [ ] barrel+commit`.

---

# WAVE 1 — Layout + Type (8 components)

One task each, following the pattern. Deltas:

### Task 1.1 `Stack` · 1.2 `Box` · 1.3 `Grid` (layout)
Token-typed style vocab only (Chimera M3): `gap?: SpaceToken`, `padding?: SpaceToken`, `align`/`justify` enums, `direction` (Stack). No raw style. Grid adds `columns?: number | 'auto-fit'`. No Radix.

### Task 1.4 `Divider`
`orientation?: 'horizontal'|'vertical'`, decorative `--border` (not `--border-strong`), `role="separator"`.

### Task 1.5 `Text` · 1.6 `Heading` (typography)
`role` prop = the §4 type roles (`prose-body`/`ui-label`/`data`/… for Text; `display`/`heading`/`title` for Heading). Replaces the placeholder `src/text.tsx` (move into `src/components/Text/`; update barrel + the existing `TextProps` export). Heading `level?: 1-6` for semantics.

### Task 1.7 `Link`
Router-aware (accepts an `href` + a neutral `onPress`; web impl renders `<a>`; the contract stays neutral so native maps to its nav). Focus ring, i18n children. No `asChild` in the contract (§9).

### Task 1.8 `VisuallyHidden`
Wraps Radix `VisuallyHidden` (from `radix-ui`); a11y util for SR-only labels.

**Wave 1 exit:** controller lint + scoped coverage + story-coverage + axe all green.

---

# WAVE 2 — Controls + Forms (10 components)

### Task 2.1 `Button` (the worked example above) · 2.2 `IconButton`
IconButton: icon-only; **requires** `label` (i18n key) → `aria-label` (Kraken I4); ≥44px hit target.

### Task 2.3 `Input` · 2.4 `TextArea`
`value`/`defaultValue`/`onChange` (controlled/uncontrolled per §9), `invalid?`, `disabled?`, `readOnly?`, `--border-strong` boundary, focus ring. No Radix (native inputs).

### Task 2.5 `Select` · 2.6 `Checkbox` · 2.7 `Radio` · 2.8 `Switch`
On `radix-ui` (Select/Checkbox/RadioGroup/Switch). Controlled/uncontrolled per §9. Checkbox `indeterminate`. Keyboard tests required (Arrow/Space/Enter). Radio is a group (`RadioGroup` + `Radio`).

### Task 2.9 `FormField` · 2.10 `Label`
FormField composes `Label` + control slot + helper text + error text; props `label`, `description`, `error` (all i18n keys), `required`, `invalid`; wires `aria-describedby`/`aria-invalid`; error text uses `--text-danger`. The field contract (Basilisk C1).

**Wave 2 exit:** controller lint + scoped coverage + keyboard/axe tests green.

---

# WAVE 3 — Overlays / Feedback / Display (13 components)

### Task 3.1 `Card`
Slots (header/body/footer per §9), `--surface` + `--border-strong`. No Radix.

### Task 3.2 `Modal` · 3.3 `Popover` · 3.4 `Tooltip` · 3.5 `Tabs` · 3.6 `Menu`/`DropdownMenu`
On `radix-ui` (Dialog/Popover/Tooltip/Tabs/DropdownMenu). Modal: focus-trap + focus-return test (Kraken I3), `--surface-overlay` + scrim. Tooltip: supplementary only, never sole label (Kraken M2). Tabs/Menu: keyboard tests. `--z-*` tokens for layering.

### Task 3.7 `Banner` · 3.8 `Toast` · 3.9 `Spinner`
Banner: inline/persistent, 4 severities binding status-intent tokens (body text = `--ink`, color = icon/bar). Toast: the subsystem (Basilisk I4) — app-root provider/portal on `radix-ui` Toast, queue + dedupe + `aria-live`, imperative `toast()` API, auto-dismiss respecting reduced-motion; live-region test. Spinner: opacity-only animation, `role="status"` + SR label.

### Task 3.10 `Avatar`/`AvatarGroup` · 3.11 `Badge` · 3.12 `Icon` · 3.13 `Dither`
Avatar: `radix-ui` Avatar + initials fallback; AvatarGroup max-N + overflow ("+2"). Icon: `pixelarticons` per-icon imports behind `Icon({ name, size, label?, decorative? })` — `decorative` → `aria-hidden`, else `label` (i18n) required; sizes from `--icon-*`. Dither: the locked 4×4 Bayer util (read brand `guidelines.md` §"dither formula"); CSS-based, only sanctioned gradient.

**Wave 3 exit:** controller full `pnpm --filter @mythrun/ui lint && lint:css && test:coverage && story-coverage && build-storybook`, `pnpm --filter @mythrun/client-core test`, full `pnpm typecheck && pnpm lint`. All green.

---

# Close-out (HOLD THE PUSH)

- [ ] All waves committed locally; full verification green (typecheck/lint/lint:css/test/coverage/story-coverage/build-storybook across `@mythrun/ui` + `@mythrun/client-core` + `@mythrun/web`).
- [ ] **STOP — visual audit checkpoint.** Run `pnpm --filter @mythrun/ui storybook`, hand Miklos the URL, and have him visually audit every primitive (light + dark). Collect suggestions; implement them (each as a small TDD task, committed locally). Re-verify. (Per `feedback_frontend_visual_audit_before_push`.)
- [ ] Only after sign-off: dispatch the wiki-update subagent (AUTHORING.md, MYT-82), commit wiki locally.
- [ ] `git push origin main` (single push: code + wiki).
- [ ] Flip MYT-82 → Done.

---

## Self-Review

**Spec coverage:** §2 architecture → 0a/0b. §3 design language → 0b.3 (tokens). §4 token foundation → 0b.3. §5 build stack → 0c.1 (deps). §6 primitives + state matrix + FormField + Toast subsystem → Waves 1–3. §7 gates (all 8) → 0c.4–0c.8 + each component's gate step. §8 Storybook + doc template → 0c.3 + the pattern's story step. §9 API conventions → the contract pattern (forwardRef, controlled/uncontrolled, neutral `onPress`, slots, no `asChild`) + versioning (note: add a CHANGELOG stub in 0a.1). §10 waves → the wave structure. §13 done-when → Close-out. **Gap found + fixed:** added a CHANGELOG.md stub to Task 0a.1's scope (versioning, Basilisk I3); added the `--shadow` removal assertion to 0b.3.

**Placeholder scan:** no TBD/TODO; component deltas reference the fully-worked Button pattern (not "similar to") — the pattern IS the shared code, each delta is the genuine difference, which is the DRY-correct form for 26 isomorphic components.

**Type consistency:** `ButtonProps`/`BaseProps`/`onPress`/`label`/token-typed props are consistent across the contract pattern and the component deltas; `cn()` signature consistent; gate script + test names consistent.
