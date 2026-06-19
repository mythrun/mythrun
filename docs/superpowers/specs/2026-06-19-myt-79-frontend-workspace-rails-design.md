# MYT-79 — Frontend Workspace + CI Lint Rails — Design

> **Type**: Implementation design (superpowers brainstorm output)
> **Date**: 2026-06-19
> **Status**: Approved (pending written-spec review) — revised post blind-review round 1 (Mountains)
> **Linear**: MYT-79 (Frontend milestone, issue #1 — the only unblocked issue; unlocks the whole tree)
> **Spec refs**: UX Design §1/§14; brand repo `../../Design/mythrun-design`; the three frontend rules of the road

---

## 1. Goal

Stand up the `frontend/` pnpm workspace and the CI lint rails that enforce the three frontend rules of the road **before any UI is built**. The deliverable is an *empty-but-enforced* skeleton: a workspace that builds, two lint rails that fail CI on violation, and the gates (CI workflow + pre-push) wired to run them.

Rails go down before track. No feature flow, no real component, and no real design token lands in this issue — those are MYT-80/81/82/83. After MYT-79, shipping a hardcoded JSX string or an ad-hoc UI element in feature code is **a CI failure**. (Scope nuance: the no-hardcoded-strings baseline catches JSX text + JSX attribute strings — see §5.2; the broader callee/`t()`-aware coverage is completed in MYT-80.)

## 2. The three rules, and how each becomes a lint

| Rule of the road | Enforcement in MYT-79 |
|---|---|
| **Rule 1** — no hardcoded user-facing strings (i18n) | `i18next/no-literal-string` (off-the-shelf) in `mode: 'jsx-only'`, scoped to feature code. Catches JSX text + attribute string literals now; MYT-80 wires the typed `t()` runtime + key files + the callee allow-list. |
| **Rule 2** — no ad-hoc UI; everything composes mythrunUI | `mythrun-ui/no-ad-hoc-ui` (custom rule; distinct plugin namespace — root reserves `mythrun`). Feature code may not use raw DOM elements, `style`, or `className`. |
| **Rule 3** — rules are CI lints, not conventions | Both rails wired into a `frontend-check.yml` CI workflow (an always-running required check) + a diff-scoped pre-push section, with a config-wiring test (rule registered+scoped) and a fires-on-violation test. The escape hatch is itself lint-enforced (§5.1). |

## 3. Locked decisions

Settled during brainstorming; **not open**:

1. **Two workspace packages** — `@mythrun/web` (the app) + `@mythrun/ui` (mythrunUI), both in this repo (§4.1).
2. **The ad-hoc-UI boundary is strict** — feature code composes mythrunUI components (incl. layout primitives) and fragments **only**; no raw elements, no `style`, no `className` (§5.1).
3. **Tailwind v4** — CSS-first `@theme`, OKLCH-native; no `tailwind.config.js`. Maps onto the 60 OKLCH brand tokens MYT-81 ports.
4. **`no-hardcoded-strings` is off-the-shelf** (`eslint-plugin-i18next`), not a 3rd custom rule.
5. **Tiered coverage** — 100% threshold on *logic*; presentational components exempt from the % (§6.3).
6. **Brand repo is the source of truth for visual identity** — but MYT-79 ships no real visual values; tokens are MYT-81.

> **Revised post-review:** an earlier draft said "extend the single root ESLint config" and "mirror backend's tsconfig." Both were wrong against the repo (see §5.3, §4.2): `backend/dev-tool/eslint.config.js` is already a **per-package** config (it must be — Vite configs default-export, which the root config bans), and dev-tool uses `moduleResolution: Bundler`, not backend's `NodeNext`. The frontend follows the **dev-tool** precedent, not the backend one.

## 4. Architecture

### 4.1 Workspace topology

Two new pnpm workspace packages, following the existing `backend` / `backend/dev-tool` split. Both are plain folders with their own `package.json`, listed in `pnpm-workspace.yaml` (`- 'frontend'`, `- 'frontend/ui'`). Nothing is published to npm.

```
frontend/                # @mythrun/web — the React app (routes, features, flows)
  package.json           # type:module; scripts: dev/build/typecheck/lint/test/test:coverage
  tsconfig.json          # moduleResolution:Bundler (mirrors dev-tool, NOT backend)
  vite.config.ts         # default-export (exempted from the no-default-export ban — §5.3)
  vitest.config.ts       # default-export (same exemption)
  eslint.config.js       # per-package: imports + extends root; adds React surface + the two rails
  index.html
  src/
    main.tsx             # app entry (scaffold only; router is MYT-83)
    app.tsx              # placeholder root (composes @mythrun/ui)
    lib/                 # logic zone — authored in .ts (never .tsx); covered at 100% (§6.3)
  eslint-rules/
    no-ad-hoc-ui.js      # the custom rule (ESM; imported by eslint.config.js AND by its Vitest test)
    no-ad-hoc-ui.test.ts # RuleTester (Vitest-discovered → instrumented → counts toward 100%)
    config-wiring.test.ts# registration + path-scoping + fires-on-violation (§6.4)

frontend/ui/             # @mythrun/ui — the mythrunUI design system (SHELL ONLY here)
  package.json           # name "@mythrun/ui"; exports { ".": "./src/index.ts" }; NO build script
  tsconfig.json          # moduleResolution:Bundler
  eslint.config.js       # per-package: imports + extends root; no-ad-hoc-ui OFF (library zone)
  src/
    index.ts             # barrel export
    text.tsx             # ONE trivial <Text> primitive — the boundary anchor
```

- `@mythrun/web` declares `"@mythrun/ui": "workspace:*"`; pnpm symlinks the package dir. The import `import { Text } from '@mythrun/ui'` resolves to **source** because `@mythrun/ui`'s `package.json` sets `"exports": { ".": "./src/index.ts" }` (+ matching `"types"`), and the consumer's `moduleResolution: "Bundler"` permits importing `.ts`/`.tsx` source. **No build/publish step** for `@mythrun/ui`; it has **no `build` script**, so root `pnpm -r build` runs `@mythrun/web`'s build and skips `@mythrun/ui` (intentional — it is source-consumed).
- The single trivial `<Text>` primitive exists so the boundary is *real and testable on day 1*: the fires-on-violation test (§6.4) asserts a `<div>` snippet fails and a `<Text>`-composing snippet passes. MYT-82 fills `@mythrun/ui` with the full primitive set + Storybook; MYT-79 adds **no** Storybook.

> **Scope hand-off to MYT-82 (layout primitives).** Because the boundary is strict, the first real feature cannot lay anything out with only `<Text>` + fragments. This is already enforced by the dependency graph: **MYT-83 (app shell — the first feature to need layout) is `blockedBy` MYT-82 (the component library)**, so the layout primitives (Stack/Box/Grid) exist before any `frontend/src/**` feature code is authored. MYT-79 records the constraint explicitly: **no feature code is written in `frontend/src/**` until MYT-82 ships layout primitives.** MYT-79 itself ships only the `<Text>` anchor.

### 4.2 Scaffold

- **Vite + React + TypeScript**, `strict`. The frontend `tsconfig.json` mirrors **dev-tool** (`backend/dev-tool/tsconfig.json`), not backend: `module: ESNext`, `moduleResolution: Bundler`, `jsx: react-jsx`, `lib: [DOM, DOM.Iterable, ESNext]`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. The root config's existing rules (`no-explicit-any` → error, `no-non-null-assertion` → error, default-exports forbidden, named-exports-only) apply via the per-package config that extends root (§5.3).
- **Tailwind v4** via `@tailwindcss/vite`. A single `src/index.css` with `@import "tailwindcss"` and an empty `@theme {}` block — MYT-81 populates the theme with OKLCH tokens. No design values are committed in MYT-79.
- **Vitest + React Testing Library** (jsdom). New dev deps — `@vitejs/plugin-react`, `@testing-library/react`, `@testing-library/jest-dom`, `eslint-plugin-i18next`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `@eslint-community/eslint-plugin-eslint-comments`, `@tailwindcss/vite`, `tailwindcss` — each passes the repo's four-point dependency-selection bar (reputable, actively developed, documented, industry-standard); `jsdom` is already vendored.
- Each package exposes `lint` / `typecheck` / `test` / `test:coverage` / `build` (except `@mythrun/ui` has no `build`) so root `pnpm -r` aggregates pick them up.

## 5. The lint rails

### 5.1 `mythrun-ui/no-ad-hoc-ui` (custom)

Authored as `frontend/eslint-rules/no-ad-hoc-ui.js` (ESM module — imported by both `frontend/eslint.config.js` and its Vitest test, so it is **instrumented by Vitest and counts toward the 100% logic threshold**; this deliberately departs from the backend's `.cjs` rules, which are excluded from Vitest and run by nothing — see §6.3).

**What it forbids** (in feature/route code — scoping in §5.3):

| Reports on | AST shape | Rationale |
|---|---|---|
| Intrinsic lowercase JSX elements (`<div>`, `<button>`, …) | `JSXOpeningElement` whose `name` is a `JSXIdentifier` matching `/^[a-z]/` | Raw DOM markup is ad-hoc UI. |
| `style` JSX attribute | `JSXAttribute` `name.name === 'style'` | Inline styling is ad-hoc visual design. |
| `className` JSX attribute | `JSXAttribute` `name.name === 'className'` | Raw Tailwind utilities are banned in features. |

**Explicitly NOT reported:** JSX fragments (`<>…</>` is a `JSXFragment` with no opening identifier; `<React.Fragment>` is a `JSXMemberExpression`, not a lowercase identifier) — fragments carry no DOM/styling and are allowed. Component elements (capitalized identifiers / member expressions) are allowed.

**Escape hatch (lint-enforced, not convention):** a true one-off uses `// eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- <reason>`. To make this *enforced* (Rule 3) rather than a bare-disable free-for-all, the frontend config adds:
- `linterOptions: { reportUnusedDisableDirectives: 'error' }` (a disable that no longer suppresses anything is a CI error), and
- `@eslint-community/eslint-comments/require-description: 'error'` (a disable directive without a trailing `-- reason` is a CI error).

> Corrects a prior-draft error: ESLint does **not** natively require a `-- reason`, and the root config does **not** currently set `reportUnusedDisableDirectives` at error severity. MYT-79 *adds* this enforcement in the frontend config; it is not inherited.

### 5.2 `i18next/no-literal-string` (off-the-shelf)

- `eslint-plugin-i18next` dev dependency; rule `i18next/no-literal-string` set to `error` for feature code.
- **Mode is explicit: `jsx-only`** — flags string literals in JSX text **and** JSX attributes (mythrunUI props will carry most user-facing text, so attribute coverage matters). The plugin's **default `jsx-text-only` is too weak** for Rule 1 and would let `<Text label="Save" />` through — do not rely on the default.
- **Minimal structural baseline now:** `ignoreAttribute: ['data-testid', 'aria-*', 'role', 'id']` so non-user-facing attributes don't trip it. The **callee / `t()`-aware allow-list** (which function calls may take literals) is **deferred to MYT-80**, which also adds the runtime.
- Scoped to **feature code** (`frontend/src/**`), not `frontend/**`, so `vite.config.ts` / `vitest.config.ts` / build-config literals don't trip it.

### 5.3 ESLint config topology — per-package configs extending root

**Each frontend package ships its own `eslint.config.js` that imports and spreads the root, then adds local blocks — mirroring `backend/dev-tool/eslint.config.js`.** (A single root config is *not* viable: Vite/Vitest configs default-export, which the root's `no-restricted-syntax` ban forbids; dev-tool already solved this with a per-package config + an `ignores` for `vite.config.ts`.)

`frontend/eslint.config.js` (`@mythrun/web`):
```
import root from '../eslint.config.js'
// + react, react-hooks, jsx-a11y, i18next, eslint-comments plugins
export default [
  ...root,                                  // inherits strict/stylistic type-checked + mythrun bans
  { ignores: ['src/**/*.css','index.html','vite.config.ts','vitest.config.ts','dist/**'] },
  { files: ['src/**/*.{ts,tsx}'], /* React surface + the two rails @ error + escape-hatch enforcement */
    rules: { 'mythrun-ui/no-ad-hoc-ui':'error', 'i18next/no-literal-string':['error',{mode:'jsx-only', ignoreAttribute:[...]}],
             '@typescript-eslint/no-misused-promises':['error',{checksVoidReturn:{attributes:false}}], ... },
    linterOptions: { reportUnusedDisableDirectives: 'error' } },
  eslintConfigPrettier,                     // re-applied LAST so React stylistic rules don't fight prettier
]
```
- The custom rule is registered **in the frontend config** (local to where it's scoped), not the root `mythrun` plugin.
- `@typescript-eslint/no-misused-promises` is tuned with `checksVoidReturn.attributes: false` — without it, the universal React idiom `onClick={async () => …}` errors under `strictTypeChecked`. (Forward-looking; the empty scaffold won't trip it, but the baseline is set now so MYT-82/83 don't fight it.)
- `eslint-config-prettier` is re-appended last in the frontend config so the React stylistic rules added after the root spread don't conflict with Prettier.

`frontend/ui/eslint.config.js` (`@mythrun/ui`): same import-and-extend shape, but `mythrun-ui/no-ad-hoc-ui` is **off** (the library zone — where raw elements + Tailwind + `className` legitimately live). `jsx-a11y` rules *do* apply here (and effectively only here, since intrinsic elements only exist in the library) — accessible-element authoring is a library responsibility by design.

- Lint scripts: `eslint . --no-error-on-unmatched-pattern` run from each package dir (mirrors dev-tool — ESLint resolves the nearest `eslint.config.js`). Root `pnpm -r lint` runs each.

## 6. Gates

### 6.1 CI workflow — `frontend-check.yml`

New GitHub Actions workflow. **Runs unconditionally on every PR/push (no `paths:` filter)** so it can be a clean *required* status check: a path-filtered required check is left **Pending** by GitHub when skipped, which blocks merges on backend-only PRs. Frontend checks are fast and have no infra deps (no Postgres/Redis/secrets), so always-running is cheap. Steps mirror the existing per-concern workflows (`dev-tool-check.yml`): SHA-pinned actions, `node-version-file: .nvmrc`, `pnpm install --frozen-lockfile --filter @mythrun/web... --filter @mythrun/ui...`, then frontend `typecheck` → `lint` → `test:coverage` → `build`.

Additionally: add `frontend/**` to **`deploy.yml`'s `paths-ignore`**, so a frontend-only push does not trigger the full backend Docker build + ECS staging deploy. (Adding the two packages also touches `pnpm-lock.yaml`, which `deploy.yml`'s `--frozen-lockfile` validates on the next backend deploy — expected.)

### 6.2 Pre-push hook

Add a frontend section to `.husky/pre-push`, **diff-scoped on `git diff --name-only origin/main...HEAD`** (three-dot merge-base — the commits actually being pushed). Runs frontend `typecheck` + `lint` + `test:coverage` only when those commits touch `frontend/**` or the frontend eslint config; otherwise skips.

> Deliberately does **not** copy the existing dev-tool step's `git diff --cached --name-only origin/main` idiom, which no-ops on a normal `git push` (nothing is staged post-commit), silently skipping the gate. (The dev-tool step has the same latent bug; reconciling it is out of scope here but noted.)

### 6.3 Tiered coverage

Frontend Vitest enforces **100% lines/branches/functions/statements on the logic surface**, presentational code excluded from the percentage:

- **`coverage.include` (100%):** `src/lib/**`, `src/hooks/**` (when they exist), **`eslint-rules/**`** (the custom rule — the most important logic in this issue), and the future `api/` + `transport/` clients. Globs cover `.ts` **and** `.tsx` so logic in either is measured.
- **`coverage.exclude` from %:** `**/*.tsx` components/routes, `**/*.stories.tsx`, `src/main.tsx`, config files, `@mythrun/ui` presentational components.
- **Convention (lint-aligned):** logic lives in `.ts`, never `.tsx`, so the `.tsx` exclusion can't launder untested logic.
- The custom rule reaches 100% via its **Vitest-discovered** RuleTester test (`no-ad-hoc-ui.test.ts`), which instruments the rule source — unlike the backend's `.cjs` RuleTester scripts, which Vitest excludes and nothing runs. The frontend `vitest.config.ts` does **not** carry over backend's `**/eslint-rules/**/*.test.cjs` exclusion.

### 6.4 Config-wiring + fires-on-violation tests

Two Vitest tests (`frontend/eslint-rules/config-wiring.test.ts`), each asserting a distinct guarantee, both fast (no type-aware program build):

1. **Registration + path-scoping** — mirror the *actual* `backend/eslint-rules/__tests__/config-wiring.test.mjs` pattern: `new ESLint().calculateConfigForFile(path)` and assert `mythrun-ui/no-ad-hoc-ui` + `i18next/no-literal-string` are `error` for a `frontend/src/**` path and `no-ad-hoc-ui` is `off` for a `frontend/ui/**` path. (This is config resolution — it lints nothing, so it avoids the slow/flaky `projectService` build the backend test was rewritten to avoid.)
2. **Fires on violation** — assert the rules actually report:
   - `no-ad-hoc-ui`: covered by the RuleTester suite (`no-ad-hoc-ui.test.ts`) with **inline code-string** cases (invalid: `<div>`, `style=`, `className=`; valid: `<Text/>`, `<>…</>`), using a JSX-capable **non-type-aware** parser (`languageOptions.parserOptions.ecmaFeatures.jsx: true`) — the rule is pure AST shape and needs no type info.
   - `i18next/no-literal-string`: a small `new ESLint({ overrideConfigFile: true, overrideConfig: {…jsx-only…} }).lintText('<Text>Hello</Text>')` assertion over an **inline string** with a non-type-aware JSX parser — asserts the JSX-text literal is reported.

Using **inline string fixtures** (not on-disk fixture files) means there are no physical fixtures to add to the root `ignores` list or to `allowDefaultProject`, and no risk of the type-aware parser rejecting an out-of-project fixture. This is the issue's primary acceptance evidence: the rails are registered, correctly scoped, **and** bite.

## 7. Out of scope (explicit deferrals)

| Deferred to | What |
|---|---|
| MYT-80 | i18n runtime, typed keys, `t()` provider, `no-literal-string` callee allow-list |
| MYT-81 | Real design tokens — the OKLCH palette, type, motion in the Tailwind `@theme` |
| MYT-82 | The real mythrunUI primitive set (incl. **layout primitives** — see §4.1 hand-off) + Storybook |
| MYT-83 | React Router, app shell, the typed API/data layer |

MYT-79 ships: the two workspace packages, the scaffold, the two rails, the gates, and the tests — nothing visual, nothing user-facing.

## 8. Done when

1. `pnpm install` succeeds with the two new workspace packages; `@mythrun/web` builds (`vite build`); `@mythrun/ui` typechecks (it has no `build`); `import { Text } from '@mythrun/ui'` resolves under `moduleResolution: Bundler`.
2. Root `pnpm -r typecheck/lint/test` include the frontend packages; `pnpm -r build` includes `@mythrun/web` and intentionally skips `@mythrun/ui`.
3. An intentional raw `<div style={…}>` / `className` in feature code **fails** `pnpm lint`.
4. An intentional inline **JSX user-facing string** in feature code **fails** `pnpm lint` — for all **attribute** literals (the load-bearing case) and JSX **text** in function-declaration components. **Known limitation (carry to MYT-80):** `eslint-plugin-i18next@6` allowlists bare JSX text inside *PascalCase arrow-const* components (`const X = () => <Text>hi</Text>` is not flagged — it treats the uppercase const like a constant). Raw elements there still fail via `mythrun-ui/no-ad-hoc-ui`; closing the component-text gap is MYT-80's job, alongside the typed `t()` runtime + callee allow-list.
5. A feature file composing `<Text>` from `@mythrun/ui` with no raw markup **passes**.
6. A bare `// eslint-disable-next-line mythrun-ui/no-ad-hoc-ui` (no `-- reason`) **fails** lint; a `-- reason` form passes; an unused disable directive **fails**.
7. The config-wiring + fires-on-violation tests (§6.4) pass.
8. `frontend-check.yml` runs the four steps unconditionally in CI (a required check that never blocks-pending on backend-only PRs); the pre-push hook runs them diff-scoped on `origin/main...HEAD`; `deploy.yml` ignores `frontend/**`.
9. The custom rule is Vitest-instrumented and hits the 100% logic threshold via its RuleTester suite.

## 9. Open questions

None. All forks resolved during brainstorming (§3); all blind-review-round-1 (Mountains) findings folded in (config topology, coverage/runner, smoke-test mechanism, source-resolution, escape-hatch enforcement, CI/pre-push correctness, type-aware React surface, i18n baseline).
