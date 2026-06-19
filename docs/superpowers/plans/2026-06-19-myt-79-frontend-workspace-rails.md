# MYT-79 Frontend Workspace + CI Lint Rails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `frontend/` pnpm workspace (`@mythrun/web` + `@mythrun/ui`) and the CI lint rails (no-ad-hoc-UI custom rule + off-the-shelf i18n no-literal-string) so that, before any UI is built, a hardcoded JSX string or an ad-hoc UI element in feature code is a CI failure.

**Architecture:** Two new pnpm workspace packages in this monorepo, following the `backend/dev-tool` precedent: a Vite + React + TS-strict + Tailwind v4 app (`@mythrun/web`) consuming a source-only design-system shell (`@mythrun/ui`) via `workspace:*` + an `exports` map + `moduleResolution: Bundler`. Lint rails are per-package flat ESLint configs that extend the root config; the ad-hoc-UI rule is a custom ESM rule under a new `mythrun-ui` plugin namespace, instrumented by Vitest. Gates: an always-running `frontend-check.yml` required job + a diff-scoped pre-push section.

**Tech Stack:** pnpm 10 workspaces, Vite 6, React 19, TypeScript 5.6 (Bundler resolution), Tailwind v4 (`@tailwindcss/vite`, `@theme`), Vitest + React Testing Library (jsdom), ESLint 9 flat config, `eslint-plugin-i18next`, `eslint-plugin-react{,-hooks}`, `eslint-plugin-jsx-a11y`, `@eslint-community/eslint-plugin-eslint-comments`.

**Source spec:** `docs/superpowers/specs/2026-06-19-myt-79-frontend-workspace-rails-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `pnpm-workspace.yaml` (modify) | Register `frontend` + `frontend/ui` packages |
| `frontend/package.json` | `@mythrun/web` — app deps + scripts |
| `frontend/tsconfig.json` | App TS config (Bundler resolution, jsx) |
| `frontend/vite.config.ts` | Vite + React + Tailwind v4 plugins |
| `frontend/vitest.config.ts` | Vitest (jsdom) + tiered coverage |
| `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/app.tsx`, `frontend/src/index.css` | Minimal scaffold |
| `frontend/eslint.config.js` | App lint: extends root + React surface + the two rails + escape-hatch enforcement |
| `frontend/eslint-rules/no-ad-hoc-ui.js` | The custom rule (ESM) |
| `frontend/eslint-rules/no-ad-hoc-ui.test.ts` | RuleTester suite (Vitest-discovered → instrumented) |
| `frontend/eslint-rules/config-wiring.test.ts` | Registration/scoping + fires-on-violation tests |
| `frontend/ui/package.json` | `@mythrun/ui` — source-only lib (`exports`, no build) |
| `frontend/ui/tsconfig.json` | Lib TS config |
| `frontend/ui/eslint.config.js` | Lib lint: extends root, `no-ad-hoc-ui` OFF |
| `frontend/ui/src/index.ts`, `frontend/ui/src/text.tsx` | Barrel + the `<Text>` boundary anchor |
| `.github/workflows/frontend-check.yml` | Always-running CI gate |
| `.github/workflows/deploy.yml` (modify) | Add `frontend/**` to `paths-ignore` |
| `.husky/pre-push` (modify) | Diff-scoped frontend gate section |

**Conventions for the implementer (read once):**
- Root ESLint config is `eslint.config.js` (flat). It bans default exports repo-wide and registers a `mythrun` plugin (backend rules). The frontend rule therefore uses a **distinct** plugin namespace: **`mythrun-ui`** (re-defining `mythrun` errors). Vite/Vitest configs default-export, so they are added to each frontend config's `ignores`.
- Backend `.cjs` RuleTester scripts are excluded from Vitest and run by nothing — do **not** copy that pattern. Author the rule + tests as ESM/TS so Vitest runs and instruments them.
- Tests target the package's own Vitest; no Postgres/Redis. Run frontend commands from `frontend/` (or via `pnpm --filter @mythrun/web ...`).
- `.nvmrc` = `24`; pnpm = `10.30.3`; CI actions are SHA-pinned (copy the pins from `.github/workflows/dev-tool-check.yml`).

---

### Task 1: Workspace skeleton (`@mythrun/web` + `@mythrun/ui` packages)

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `frontend/package.json`, `frontend/tsconfig.json`
- Create: `frontend/ui/package.json`, `frontend/ui/tsconfig.json`

- [ ] **Step 1: Register the two packages in the workspace**

Modify `pnpm-workspace.yaml` to add the two entries (keep existing):

```yaml
packages:
  - 'backend'
  - 'backend/dev-tool'
  - 'docs/wiki'
  - 'frontend'
  - 'frontend/ui'
```

- [ ] **Step 2: Create `frontend/ui/package.json`** (source-only lib — `exports` to source, NO build script)

```json
{
  "name": "@mythrun/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --no-error-on-unmatched-pattern"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: Create `frontend/ui/tsconfig.json`** (mirror `backend/dev-tool/tsconfig.json` + add `jsx`)

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src/**/*", "eslint.config.js"]
}
```

- [ ] **Step 4: Create `frontend/package.json`** (`@mythrun/web` — app)

```json
{
  "name": "@mythrun/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --no-error-on-unmatched-pattern",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@mythrun/ui": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0",
    "jsdom": "^25.0.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "typescript": "^5.6.0",
    "eslint-plugin-react": "^7.37.0",
    "eslint-plugin-react-hooks": "^5.1.0",
    "eslint-plugin-jsx-a11y": "^6.10.0",
    "eslint-plugin-i18next": "^6.1.0",
    "@eslint-community/eslint-plugin-eslint-comments": "^4.4.0"
  }
}
```

- [ ] **Step 5: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*", "vite.config.ts", "vitest.config.ts", "eslint-rules/**/*"]
}
```

- [ ] **Step 6: Install**

Run: `pnpm install`
Expected: resolves and links both new packages; `frontend/node_modules/@mythrun/ui` is a symlink. Confirm with:
Run: `pnpm -r exec true && ls -la frontend/node_modules/@mythrun | cat`
Expected: `ui -> ../../ui` (symlink).

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml frontend/package.json frontend/tsconfig.json frontend/ui/package.json frontend/ui/tsconfig.json pnpm-lock.yaml
git commit -m "feat(MYT-79): scaffold frontend pnpm workspaces (@mythrun/web + @mythrun/ui)"
```

---

### Task 2: `@mythrun/ui` shell — the `<Text>` boundary anchor

**Files:**
- Create: `frontend/ui/src/text.tsx`, `frontend/ui/src/index.ts`

- [ ] **Step 1: Create the `<Text>` primitive** (`frontend/ui/src/text.tsx`)

This is the single anchor that lets feature code compose *something* and lets the boundary tests prove a component import passes. It deliberately owns the only raw element in scope.

```tsx
import type { ReactNode } from 'react'

export interface TextProps {
  readonly children: ReactNode
}

// The library zone is where raw elements legitimately live (no-ad-hoc-ui is
// OFF for frontend/ui/**). Real typography variants land in MYT-82.
export function Text({ children }: TextProps): React.JSX.Element {
  return <span>{children}</span>
}
```

- [ ] **Step 2: Create the barrel export** (`frontend/ui/src/index.ts`)

```ts
export { Text } from './text.tsx'
export type { TextProps } from './text.tsx'
```

- [ ] **Step 3: Typecheck the library**

Run: `pnpm --filter @mythrun/ui typecheck`
Expected: exits 0 (no type errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/ui/src/text.tsx frontend/ui/src/index.ts
git commit -m "feat(MYT-79): @mythrun/ui shell with the <Text> boundary anchor"
```

---

### Task 3: `@mythrun/web` scaffold + cross-package source resolution

**Files:**
- Create: `frontend/index.html`, `frontend/vite.config.ts`, `frontend/vitest.config.ts`, `frontend/src/main.tsx`, `frontend/src/app.tsx`, `frontend/src/index.css`

- [ ] **Step 1: Create `frontend/vite.config.ts`** (React + Tailwind v4 plugins)

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

- [ ] **Step 2: Create `frontend/index.css`** (Tailwind v4 entry — empty theme; MYT-81 fills it)

```css
@import "tailwindcss";

@theme {
  /* MYT-81 ports the 60 OKLCH brand tokens here. */
}
```

- [ ] **Step 3: Create `frontend/src/app.tsx`** (placeholder root — composes `@mythrun/ui`, proving the import resolves)

```tsx
import { Text } from '@mythrun/ui'

export function App(): React.JSX.Element {
  return <Text>{'mythrun'}</Text>
}
```

- [ ] **Step 4: Create `frontend/src/main.tsx`** (app entry — router arrives in MYT-83)

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'
import './index.css'

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
```

- [ ] **Step 5: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mythrun</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `frontend/vitest.config.ts`** (jsdom; coverage config lands in Task 6)

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
  },
})
```

- [ ] **Step 7: Verify the app typechecks (resolving the `@mythrun/ui` source import) and builds**

Run: `pnpm --filter @mythrun/web typecheck`
Expected: exits 0 — proves `import { Text } from '@mythrun/ui'` resolves to source under `moduleResolution: Bundler` + the `exports` map. (If it errors with "Cannot find module '@mythrun/ui'", the `exports`/`types` in `frontend/ui/package.json` or the Bundler resolution is wrong — fix before proceeding.)

Run: `pnpm --filter @mythrun/web build`
Expected: Vite build succeeds, emits `frontend/dist/`.

- [ ] **Step 8: Commit**

```bash
git add frontend/index.html frontend/vite.config.ts frontend/vitest.config.ts frontend/src/main.tsx frontend/src/app.tsx frontend/src/index.css
git commit -m "feat(MYT-79): @mythrun/web Vite+React+Tailwind v4 scaffold; verify @mythrun/ui source resolution"
```

---

### Task 4: The `mythrun-ui/no-ad-hoc-ui` custom rule (TDD)

**Files:**
- Create: `frontend/eslint-rules/no-ad-hoc-ui.test.ts` (write first)
- Create: `frontend/eslint-rules/no-ad-hoc-ui.js`

- [ ] **Step 1: Write the failing RuleTester suite** (`frontend/eslint-rules/no-ad-hoc-ui.test.ts`)

The valid/invalid cases cover every branch (lowercase vs component element, member-expression element, namespaced attribute, `style`/`className`/other attribute) so the rule reaches 100% coverage.

```ts
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'
import { noAdHocUi } from './no-ad-hoc-ui.js'

// Wire ESLint's RuleTester to Vitest's runner so each case is a real test
// AND the rule module is instrumented for coverage.
RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

ruleTester.run('no-ad-hoc-ui', noAdHocUi, {
  valid: [
    { code: 'const A = () => <Text>hi</Text>' },          // component element
    { code: 'const A = () => <><Text>hi</Text></>' },      // fragment
    { code: 'const A = () => <Ns.Comp />' },               // member-expression element
    { code: 'const A = () => <Text id="x">hi</Text>' },    // non-style/className attr
    { code: 'const A = () => <Text xml:lang="en">hi</Text>' }, // namespaced attr (guard branch)
  ],
  invalid: [
    { code: 'const A = () => <div>hi</div>', errors: [{ messageId: 'rawElement' }] },
    { code: 'const A = () => <Text style={{}}>hi</Text>', errors: [{ messageId: 'styleAttr' }] },
    { code: 'const A = () => <Text className="x">hi</Text>', errors: [{ messageId: 'classNameAttr' }] },
  ],
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/no-ad-hoc-ui.test.ts`
Expected: FAIL — `Cannot find module './no-ad-hoc-ui.js'` (rule not implemented yet).

- [ ] **Step 3: Implement the rule** (`frontend/eslint-rules/no-ad-hoc-ui.js`)

```js
/**
 * ESLint rule: no-ad-hoc-ui
 *
 * Feature code composes @mythrun/ui components (and fragments) only. Raw DOM
 * markup, inline styles, and raw Tailwind classes are ad-hoc UI. This rule is
 * OFF in the library zone (frontend/ui/**), where those legitimately live.
 *
 * Detection (pure AST shape — no type info):
 *  - intrinsic lowercase JSX elements (<div>, <button>, ...)   → rawElement
 *  - `style` attribute                                          → styleAttr
 *  - `className` attribute                                      → classNameAttr
 * Allowed: fragments (no opening identifier), component elements
 * (capitalized identifier or member expression).
 */
export const noAdHocUi = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow ad-hoc UI (raw DOM elements, inline styles, className) in feature code; compose @mythrun/ui.',
    },
    schema: [],
    messages: {
      rawElement:
        'Raw DOM element <{{name}}> is ad-hoc UI. Compose a @mythrun/ui component instead. (True one-off: `// eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- <reason>`.)',
      styleAttr: 'Inline `style` is ad-hoc UI. Use @mythrun/ui component props instead.',
      classNameAttr:
        '`className` (raw Tailwind) is banned in feature code. Use @mythrun/ui component props instead.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === 'JSXIdentifier' && /^[a-z]/.test(node.name.name)) {
          context.report({ node, messageId: 'rawElement', data: { name: node.name.name } })
        }
      },
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier') return
        if (node.name.name === 'style') {
          context.report({ node, messageId: 'styleAttr' })
        } else if (node.name.name === 'className') {
          context.report({ node, messageId: 'classNameAttr' })
        }
      },
    }
  },
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/no-ad-hoc-ui.test.ts`
Expected: PASS — all 8 cases green.

- [ ] **Step 5: Commit**

```bash
git add frontend/eslint-rules/no-ad-hoc-ui.js frontend/eslint-rules/no-ad-hoc-ui.test.ts
git commit -m "feat(MYT-79): mythrun-ui/no-ad-hoc-ui custom rule + RuleTester suite (TDD)"
```

---

### Task 5: Frontend ESLint configs + wiring/fires tests (TDD)

**Files:**
- Create: `frontend/eslint-rules/config-wiring.test.ts` (write first)
- Create: `frontend/eslint.config.js`, `frontend/ui/eslint.config.js`

- [ ] **Step 1: Write the failing wiring + fires tests** (`frontend/eslint-rules/config-wiring.test.ts`)

```ts
import { ESLint } from 'eslint'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import i18next from 'eslint-plugin-i18next'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(here, '..')
const uiDir = resolve(frontendDir, 'ui')

describe('frontend lint rails — registration & scoping', () => {
  it('rails are error for feature code; no-ad-hoc-ui off in the library', async () => {
    const web = new ESLint({ cwd: frontendDir })
    const cfg = await web.calculateConfigForFile(resolve(frontendDir, 'src/app.tsx'))
    expect(cfg.rules['mythrun-ui/no-ad-hoc-ui']?.[0]).toBe(2)
    expect(cfg.rules['i18next/no-literal-string']?.[0]).toBe(2)
    expect(cfg.rules['@eslint-community/eslint-comments/require-description']?.[0]).toBe(2)
    expect(cfg.linterOptions?.reportUnusedDisableDirectives).toBe('error')

    const ui = new ESLint({ cwd: uiDir })
    const libCfg = await ui.calculateConfigForFile(resolve(uiDir, 'src/text.tsx'))
    expect(libCfg.rules['mythrun-ui/no-ad-hoc-ui']?.[0] ?? 0).toBe(0)
  })
})

describe('frontend lint rails — fire on violation (isolated, no type-aware build)', () => {
  it('i18next/no-literal-string (jsx-only) reports a JSX string literal', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        plugins: { i18next },
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { 'i18next/no-literal-string': ['error', { mode: 'jsx-only' }] },
      },
    })
    const [res] = await eslint.lintText('export const A = () => <p>Hello world</p>\n', {
      filePath: 'fixture.jsx',
    })
    expect(res.messages.map((m) => m.ruleId)).toContain('i18next/no-literal-string')
  })

  it('eslint-comments/require-description reports a reason-less disable directive', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        plugins: { '@eslint-community/eslint-comments': eslintComments },
        rules: { '@eslint-community/eslint-comments/require-description': 'error' },
      },
    })
    const [res] = await eslint.lintText('// eslint-disable-line no-console\nconsole.log(1)\n', {
      filePath: 'fixture.js',
    })
    expect(res.messages.map((m) => m.ruleId)).toContain(
      '@eslint-community/eslint-comments/require-description',
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/config-wiring.test.ts`
Expected: FAIL — `frontend/eslint.config.js` doesn't exist yet, so `calculateConfigForFile` resolves only the root config and the `mythrun-ui/*` / `i18next/*` assertions fail (undefined `?.[0]`).

- [ ] **Step 3: Create the app ESLint config** (`frontend/eslint.config.js`)

Note: a distinct `mythrun-ui` plugin namespace (the root already defines `mythrun`). Vite/Vitest configs are ignored (they default-export). `eslintConfigPrettier` is re-applied last.

```js
import root from '../eslint.config.js'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import i18next from 'eslint-plugin-i18next'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments'
import eslintConfigPrettier from 'eslint-config-prettier'
import { noAdHocUi } from './eslint-rules/no-ad-hoc-ui.js'

export default [
  ...root,
  {
    // Vite/Vitest configs default-export (banned repo-wide); CSS/build output.
    ignores: ['dist/**', 'src/**/*.css', 'index.html', 'vite.config.ts', 'vitest.config.ts'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
      i18next,
      '@eslint-community/eslint-comments': eslintComments,
      'mythrun-ui': { rules: { 'no-ad-hoc-ui': noAdHocUi } },
    },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: 'detect' } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'mythrun-ui/no-ad-hoc-ui': 'error',
      'i18next/no-literal-string': [
        'error',
        { mode: 'jsx-only', ignoreAttribute: ['data-testid', 'aria-*', 'role', 'id'] },
      ],
      '@eslint-community/eslint-comments/require-description': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  eslintConfigPrettier,
]
```

- [ ] **Step 4: Create the library ESLint config** (`frontend/ui/eslint.config.js`)

```js
import root from '../../eslint.config.js'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
  ...root,
  {
    // The library zone: raw elements + Tailwind + className legitimately live
    // here, so no-ad-hoc-ui never applies. (It is not registered here at all.)
    ignores: ['dist/**', 'src/**/*.css'],
  },
  eslintConfigPrettier,
]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/config-wiring.test.ts`
Expected: PASS — rails are `error` on `src/app.tsx`, `no-ad-hoc-ui` is absent/off for `frontend/ui/src/text.tsx`, and both fire-on-violation cases report.

> If `cfg.linterOptions?.reportUnusedDisableDirectives` comes back as a number rather than `'error'`, adjust the assertion to `expect([2, 'error']).toContain(...)` — ESLint may normalize it.

- [ ] **Step 6: Smoke the real lint end-to-end** (proves the rails bite through the actual `pnpm lint`, including the no-ad-hoc-ui rule on a real file)

Create a temporary violating file, lint it, confirm failure, delete it:

```bash
cd frontend
printf 'export const Bad = () => <div className="flex">Hello world</div>\n' > src/__smoke__.tsx
pnpm lint; echo "exit=$?"   # expect non-zero: rawElement + classNameAttr + i18next/no-literal-string
rm src/__smoke__.tsx
cd ..
```
Expected: `pnpm lint` exits non-zero and reports `mythrun-ui/no-ad-hoc-ui` (rawElement + classNameAttr) and `i18next/no-literal-string`. After `rm`, `pnpm --filter @mythrun/web lint` exits 0 on the clean scaffold.

- [ ] **Step 7: Confirm the clean scaffold lints green**

Run: `pnpm --filter @mythrun/web lint && pnpm --filter @mythrun/ui lint`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/eslint.config.js frontend/ui/eslint.config.js frontend/eslint-rules/config-wiring.test.ts
git commit -m "feat(MYT-79): per-package frontend ESLint configs (rails + escape-hatch enforcement) + wiring tests (TDD)"
```

---

### Task 6: Tiered coverage config

**Files:**
- Modify: `frontend/vitest.config.ts`

- [ ] **Step 1: Add the tiered coverage config** (replace `frontend/vitest.config.ts` from Task 3)

100% on the logic surface (the custom rule today; `src/lib/**` + `src/hooks/**` as they land); presentational `.tsx` excluded.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // Logic only. Extend with 'src/lib/**', 'src/hooks/**', 'src/api/**',
      // 'src/transport/**' in later issues as those land.
      include: ['eslint-rules/**/*.js'],
      exclude: ['**/*.test.ts', '**/*.test.tsx'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
})
```

- [ ] **Step 2: Run coverage to verify 100% on the rule**

Run: `pnpm --filter @mythrun/web test:coverage`
Expected: all tests pass; coverage summary shows `eslint-rules/no-ad-hoc-ui.js` at 100% lines/branches/functions/statements; run exits 0 (thresholds met).

> If the rule shows < 100% branches, a branch in `no-ad-hoc-ui.js` isn't exercised — add the missing valid/invalid case to `no-ad-hoc-ui.test.ts` (the namespaced-attr and member-expression cases cover the guard branches).

- [ ] **Step 3: Commit**

```bash
git add frontend/vitest.config.ts
git commit -m "feat(MYT-79): tiered Vitest coverage — 100% on the lint-rule logic"
```

---

### Task 7: Gates — `frontend-check.yml`, `deploy.yml` paths-ignore, pre-push section

**Files:**
- Create: `.github/workflows/frontend-check.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `.husky/pre-push`

- [ ] **Step 1: Create the always-running CI gate** (`.github/workflows/frontend-check.yml`)

Runs unconditionally (no `paths:` filter) so it can be a *required* status check without GitHub leaving it Pending on backend-only PRs. SHA pins copied from `dev-tool-check.yml`.

```yaml
name: Frontend check

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - uses: pnpm/action-setup@903f9c1a6ebcba6cf41d87230be49611ac97822e # v6.0.3

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - run: pnpm install --frozen-lockfile --filter @mythrun/web... --filter @mythrun/ui...

      - run: pnpm --filter @mythrun/ui typecheck
      - run: pnpm --filter @mythrun/web typecheck
      - run: pnpm --filter @mythrun/ui lint
      - run: pnpm --filter @mythrun/web lint
      - run: pnpm --filter @mythrun/web test:coverage
      - run: pnpm --filter @mythrun/web build
```

> Marking `frontend-check / check` a **required** status check is a branch-protection setting (GitHub UI / repo admin), not a repo file — flag it to the user as the one manual follow-up so Rule 3 actually gates merges.

- [ ] **Step 2: Exclude `frontend/**` from the backend deploy** (modify `.github/workflows/deploy.yml`)

In the `on.push.paths-ignore` list, add `- 'frontend/**'` so a frontend-only push doesn't trigger the backend Docker build + ECS staging deploy:

```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '.beads/**'
      - '**/*.md'
      - 'wiki/**'
      - '.github/wiki/**'
      - 'frontend/**'
  workflow_dispatch:
```

- [ ] **Step 3: Add the diff-scoped frontend section to `.husky/pre-push`**

Insert before the final line. Uses the three-dot merge-base range (the commits being pushed) — NOT the dev-tool step's `--cached` idiom, which no-ops on a normal committed push.

```sh
echo "→ pre-push gate (frontend): lint rails + coverage (diff-scoped)"
# Three-dot range = commits being pushed vs the merge-base with origin/main.
fe_files=$(git diff --name-only origin/main...HEAD 2>/dev/null || true)
if echo "$fe_files" | grep -qE '^(frontend/|\.github/workflows/frontend-check\.yml)'; then
  pnpm --filter @mythrun/ui typecheck
  pnpm --filter @mythrun/web typecheck
  pnpm --filter @mythrun/ui lint
  pnpm --filter @mythrun/web lint
  pnpm --filter @mythrun/web test:coverage
else
  echo "  (diff doesn't touch frontend; skipping)"
fi
```

- [ ] **Step 4: Validate the workflow YAML + dry-run the pre-push predicate**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/frontend-check.yml','utf8'); if(!/name: Frontend check/.test(y)) throw new Error('bad'); console.log('frontend-check.yml ok')"`
Expected: `frontend-check.yml ok`.

Run: `sh -n .husky/pre-push && echo "pre-push syntax ok"`
Expected: `pre-push syntax ok` (POSIX-sh parse check).

Run: `grep -q "frontend/\*\*" .github/workflows/deploy.yml && echo "deploy paths-ignore ok"`
Expected: `deploy paths-ignore ok`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/frontend-check.yml .github/workflows/deploy.yml .husky/pre-push
git commit -m "ci(MYT-79): frontend-check gate + deploy paths-ignore + diff-scoped pre-push section"
```

---

## Final verification (run before closing the issue)

- [ ] `pnpm install` — clean.
- [ ] `pnpm -r typecheck` — backend + frontend packages all green.
- [ ] `pnpm -r lint` — all green on the clean scaffold.
- [ ] `pnpm --filter @mythrun/web test:coverage` — 100% on `eslint-rules/no-ad-hoc-ui.js`.
- [ ] `pnpm --filter @mythrun/web build` — succeeds.
- [ ] Smoke (Task 5 Step 6): a raw `<div className=…>Hello</div>` file fails `pnpm lint` with `mythrun-ui/no-ad-hoc-ui` (×2) + `i18next/no-literal-string`; removing it returns lint to green.
- [ ] Bare `// eslint-disable-next-line mythrun-ui/no-ad-hoc-ui` (no `-- reason`) fails; `-- reason` form passes (Task 5 fires-test covers `require-description`).
- [ ] `git status` clean (no stray `__smoke__`/`dist` artifacts; `frontend/dist` should be gitignored — confirm root `.gitignore` covers `**/dist/` or add `frontend/dist/`).

## Done-when → task map (spec §8)

| Spec done-when | Task |
|---|---|
| #1 install + build + `@mythrun/ui` resolves | T1, T2, T3 |
| #2 `pnpm -r` includes frontend; ui skipped by build | T1, T3, Final |
| #3 raw `<div style/className>` fails lint | T4, T5 |
| #4 inline JSX string fails lint | T5 |
| #5 `<Text>`-composing file passes | T3, T5 |
| #6 bare disable fails; `-- reason` passes; unused disable fails | T5 |
| #7 wiring + fires tests pass | T4, T5 |
| #8 `frontend-check.yml` always-runs; pre-push diff-scoped; deploy ignores frontend | T7 |
| #9 custom rule Vitest-instrumented at 100% | T4, T6 |
```

