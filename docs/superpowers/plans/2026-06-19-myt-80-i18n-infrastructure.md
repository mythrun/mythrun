# MYT-80 i18n Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up react-i18next so every user-facing string is a typed key, and finalize the no-hardcoded-strings lint (an i18next attribute rail + a custom rule that completely owns JSX-child text, closing the template-literal-child hole).

**Architecture:** A `frontend/src/i18n/` module (synchronous react-i18next init with bundled `en` resources, typed keys via the `i18next` `CustomTypeOptions` augmentation), a sample namespace proving static/placeholder/interpolation/`<Trans>` paths, and a second `mythrun-ui` ESLint rule (`no-untranslated-jsx-text`) that — together with the corrected `eslint-plugin-i18next` config — guarantees no React-rendered user-facing string ships un-keyed.

**Tech Stack:** react-i18next ^17, i18next ^26, TypeScript (Bundler resolution, `resolveJsonModule`), Vitest + React Testing Library, ESLint 9 flat config, `eslint-plugin-i18next@6.1.4`.

**Source spec:** `docs/superpowers/specs/2026-06-19-myt-80-i18n-infrastructure-design.md`

**Hold at ready-to-merge:** implement + verify + commit locally; do NOT push or merge. This runs in a fork; the controller merges with the MYT-81 fork (which also touches `frontend/package.json`, `pnpm-lock.yaml`, `main.tsx`) on the user's signal.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/package.json` (modify) | add `react-i18next` + `i18next` deps; `i18n:todo` script |
| `frontend/tsconfig.json` (modify) | add `resolveJsonModule: true` |
| `frontend/src/i18n/config.ts` | i18next init; exports `i18n`, `resources`, `defaultNS` |
| `frontend/src/i18n/i18next.d.ts` | `CustomTypeOptions` augmentation → typed keys |
| `frontend/src/i18n/locales/en/common.json` | default namespace; 3 sample keys |
| `frontend/src/i18n/typed-keys.guard.ts` | `@ts-expect-error` compile-time typed-keys guard |
| `frontend/src/i18n/config.test.tsx` | runtime tests (static / interpolation / `<Trans>` / missing key) |
| `frontend/src/main.tsx` (modify) | import config; wrap `<App>` in `<I18nextProvider>` |
| `frontend/eslint-rules/no-untranslated-jsx-text.js` | the custom rule |
| `frontend/eslint-rules/no-untranslated-jsx-text.test.ts` | RuleTester (Vitest-instrumented) |
| `frontend/eslint.config.js` (modify) | register the rule; correct the i18next rail |
| `frontend/eslint-rules/config-wiring.test.ts` (modify) | + registration + fire-on-violation + data-testid-exempt assertions |
| `frontend/scripts/i18n-todo.mjs` | placeholder-discoverability report |

**Conventions (read once):**
- `@mythrun/web` is `"type": "module"`; the rule + config are ESM. The tsconfig uses Bundler resolution + `allowImportingTsExtensions`, so intra-`src` imports use the explicit extension (`./config.ts`, `./app.tsx`) — match the existing `main.tsx` / `@mythrun/ui` style.
- The custom rule mirrors `frontend/eslint-rules/no-ad-hoc-ui.js`: ESM, JSDoc `@type {import('eslint').Rule.RuleModule}`, registered in the `mythrun-ui` plugin, Vitest-instrumented RuleTester. It is logic → 100%-coverage-gated; the `config-wiring.test.ts` stays excluded from `test:coverage` (the v8 double-load learning — already wired in `frontend/package.json`'s `test:coverage` script).
- `eslint-plugin-i18next@6.1.4` facts (verified in `node_modules/.pnpm/eslint-plugin-i18next@6.1.4/.../lib/options/defaults.js`): `t` + `i18n` are in `callees.exclude` (default-exempt); `Trans` is in `jsx-components.exclude` (default-exempt); `jsx-attributes.exclude` default = `['className','styleName','style','type','key','id','width','height']`; `should-validate-template: false` (template-literal JSX children are NOT validated — the gap the custom rule closes). There is no `ignoreAttribute` option; the current config's `ignoreAttribute` is a silent no-op being fixed here.

---

### Task 1: Dependencies + `resolveJsonModule`

**Files:**
- Modify: `frontend/package.json`, `frontend/tsconfig.json`

- [ ] **Step 1: Install react-i18next + i18next into `@mythrun/web`**

Run: `pnpm --filter @mythrun/web add react-i18next i18next`
Expected: resolves `react-i18next@^17` + `i18next@^26` (react-i18next 17 peer-requires i18next >= 26.2). If a floor can't resolve, use the current stable majors (do NOT pin below those) and note the resolved versions.

- [ ] **Step 2: Add `resolveJsonModule` to `frontend/tsconfig.json`**

In `compilerOptions`, add the line (it is NOT implied by `moduleResolution: Bundler`):

```json
    "resolveJsonModule": true,
```

- [ ] **Step 3: Verify nothing broke**

Run: `pnpm --filter @mythrun/web typecheck`
Expected: exits 0 (no JSON imports yet; just the flag + the new deps' types).

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/tsconfig.json pnpm-lock.yaml
git commit -m "feat(MYT-80): add react-i18next + i18next; enable resolveJsonModule"
```

---

### Task 2: i18n runtime + typed keys + tests (TDD)

**Files:**
- Create: `frontend/src/i18n/locales/en/common.json`, `frontend/src/i18n/config.ts`, `frontend/src/i18n/i18next.d.ts`, `frontend/src/i18n/typed-keys.guard.ts`, `frontend/src/i18n/config.test.tsx`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Write the failing runtime test** (`frontend/src/i18n/config.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react'
import { I18nextProvider, Trans, useTranslation } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { i18n } from './config.ts'

function Probe(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <span data-testid="static">{t('back')}</span>
      <span data-testid="interp">{t('appGreeting', { name: 'Mara' })}</span>
      <span data-testid="missing">{t('does.not.exist')}</span>
    </>
  )
}

describe('i18n runtime', () => {
  it('resolves static, interpolated, and missing keys', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    )
    expect(screen.getByTestId('static').textContent).toBe('Back')
    expect(screen.getByTestId('interp').textContent).toContain('Mara')
    expect(screen.getByTestId('missing').textContent).toBe('does.not.exist')
  })

  it('<Trans> renders the embedded-markup slot', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Trans i18nKey="richSample" components={{ 1: <a href="#" /> }} />
      </I18nextProvider>,
    )
    expect(document.querySelector('a')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `pnpm --filter @mythrun/web exec vitest run src/i18n/config.test.tsx`
Expected: FAIL — `Cannot find module './config.ts'`.

- [ ] **Step 3: Create the locale file** (`frontend/src/i18n/locales/en/common.json`)

```json
{
  "back": "Back",
  "appGreeting": "[placeholder for app greeting] {{name}}",
  "richSample": "[placeholder for rich-text sample with a <1>link</1>]"
}
```

- [ ] **Step 4: Create the runtime config** (`frontend/src/i18n/config.ts`)

```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import common from './locales/en/common.json'

export const defaultNS = 'common'
export const resources = { en: { common } } as const

// Synchronous init — load-bearing on TWO conditions: NO init callback (a
// callback re-triggers i18next's constructor setTimeout deferral) and inline
// `resources` (so init runs load() synchronously and sets isInitialized before
// returning). Together → useTranslation()'s `ready` is true on first render, so
// the useSuspense:true default never throws and there is no flash-of-keys. DO
// NOT add an init callback or an async backend without a <Suspense> boundary.
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS,
  resources,
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
})

export { i18n }
```

- [ ] **Step 5: Create the typed-keys augmentation** (`frontend/src/i18n/i18next.d.ts`)

```ts
import 'i18next'
import type { defaultNS, resources } from './config.ts'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS
    resources: (typeof resources)['en']
    returnNull: false
  }
}
```

- [ ] **Step 6: Create the compile-time typed-keys guard** (`frontend/src/i18n/typed-keys.guard.ts`)

```ts
import { i18n } from './config.ts'

// Compile-time typed-keys guard. With the i18next CustomTypeOptions
// augmentation engaged, an unknown key is a type error, so @ts-expect-error
// consumes it and `pnpm typecheck` passes. If typed keys regress (keys widen to
// `string`), the call is valid → the directive is UNUSED → ts(2578) →
// typecheck FAILS loudly. This file is typechecked (it is under src/**) but
// never imported, so it has no runtime effect.
// @ts-expect-error -- unknown i18n key must be rejected by the typed-keys augmentation
void i18n.t('definitely.not.a.key')
void i18n.t('back')
```

- [ ] **Step 7: Wire the provider in `main.tsx`** (replace the file)

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { App } from './app.tsx'
import { i18n } from './i18n/config.ts'
import './index.css'

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </StrictMode>,
  )
}
```

- [ ] **Step 8: Run the runtime test — verify it PASSES**

Run: `pnpm --filter @mythrun/web exec vitest run src/i18n/config.test.tsx`
Expected: PASS — both tests green (static "Back", interpolation contains "Mara", missing key returns the key, `<Trans>` renders an `<a>`).

- [ ] **Step 9: Verify typecheck (typed keys + guard engage)**

Run: `pnpm --filter @mythrun/web typecheck`
Expected: exits 0. (The `@ts-expect-error` in the guard is consumed because `t('definitely.not.a.key')` IS a type error → typed keys are engaged. If typecheck fails with `ts(2578) unused '@ts-expect-error'`, the augmentation is not engaging — confirm `i18next.d.ts` augments `i18next` (not `react-i18next`) and that `resolveJsonModule` is set.)

- [ ] **Step 10: Verify the app still builds**

Run: `pnpm --filter @mythrun/web build`
Expected: Vite build succeeds.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/i18n frontend/src/main.tsx
git commit -m "feat(MYT-80): react-i18next runtime + typed keys + sample namespace (TDD)"
```

---

### Task 3: The `mythrun-ui/no-untranslated-jsx-text` custom rule (TDD)

**Files:**
- Create: `frontend/eslint-rules/no-untranslated-jsx-text.test.ts` (write first), `frontend/eslint-rules/no-untranslated-jsx-text.js`

- [ ] **Step 1: Write the failing RuleTester suite** (`frontend/eslint-rules/no-untranslated-jsx-text.test.ts`)

Cases target every branch (JSXText whitespace vs text vs Trans-ancestor; expression-container child vs attribute; string literal vs numeric literal vs template-with-static vs interpolation-only template; Trans ancestor in each arm; fragment root).

```ts
import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import { noUntranslatedJsxText } from './no-untranslated-jsx-text.js'

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

ruleTester.run('no-untranslated-jsx-text', noUntranslatedJsxText, {
  valid: [
    { code: 'const A = () => <Text>{t("k")}</Text>' }, // expr call child
    { code: 'const A = () => <Text>{count}</Text>' }, // identifier expr child
    { code: 'const A = () => <Text>{42}</Text>' }, // numeric literal child
    { code: 'const A = () => <Text>{`${x}`}</Text>' }, // interpolation-only template
    { code: 'const A = () => <Trans>hi</Trans>' }, // JSXText under Trans
    { code: 'const A = () => <Trans><b>hi</b></Trans>' }, // nested JSXText under Trans
    { code: 'const A = () => <Trans>{"hi"}</Trans>' }, // literal child under Trans
    { code: 'const A = () => <Trans>{`hi`}</Trans>' }, // template child under Trans
    { code: 'const A = () => <Widget label={"hi"} />' }, // attribute container (not a child)
    { code: 'const A = () => <Stack>\n  {t("k")}\n</Stack>' }, // whitespace JSXText around a child
  ],
  invalid: [
    { code: 'const A = () => <Text>hi</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <>hi</>', errors: [{ messageId: 'bareText' }] }, // fragment root
    { code: 'const A = () => <Text>{"hi"}</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <Text>{`hi`}</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <Text>{`hi ${x}`}</Text>', errors: [{ messageId: 'bareText' }] },
  ],
})
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/no-untranslated-jsx-text.test.ts`
Expected: FAIL — `Cannot find module './no-untranslated-jsx-text.js'`.

- [ ] **Step 3: Implement the rule** (`frontend/eslint-rules/no-untranslated-jsx-text.js`)

```js
/**
 * ESLint rule: no-untranslated-jsx-text
 *
 * The authoritative, complete JSX-child-text rail: no bare user-facing text in
 * JSX children — use t() or <Trans>. Closes the template-literal-child hole the
 * eslint-plugin-i18next rail skips (should-validate-template:false), and covers
 * every component shape (no all-caps-const scope-skip blind spot).
 *
 * Reports (in a JSXElement/JSXFragment child position, with no <Trans> ancestor):
 *   - a non-whitespace JSXText node
 *   - a string Literal inside a child JSXExpressionContainer
 *   - a TemplateLiteral inside a child JSXExpressionContainer that has static text
 * Allows: whitespace-only text, numeric/expression children (`{count}`,
 *   `{t('k')}`), interpolation-only templates (`{`${x}`}`), and any descendant
 *   of <Trans>. Attribute literals belong to the eslint-plugin-i18next rail.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const noUntranslatedJsxText = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow bare user-facing text in JSX children; use t() or <Trans>.',
    },
    schema: [],
    messages: {
      bareText:
        'Bare JSX text is un-keyed user-facing copy. Use t(\'key\') or <Trans>. (True one-off: `// eslint-disable-next-line mythrun-ui/no-untranslated-jsx-text -- <reason>`.)',
    },
  },
  create(context) {
    const isTransEl = (el) =>
      el.type === 'JSXElement' && el.openingElement.name.name === 'Trans'

    const hasTransAncestor = (node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (isTransEl(p)) return true
      }
      return false
    }

    const isChildContainer = (node) =>
      node.parent.type === 'JSXElement' || node.parent.type === 'JSXFragment'

    const hasStaticText = (tpl) =>
      tpl.quasis.some((q) => (q.value.cooked ?? '').trim() !== '')

    return {
      JSXText(node) {
        if (node.value.trim() === '') return
        if (hasTransAncestor(node)) return
        context.report({ node, messageId: 'bareText' })
      },
      JSXExpressionContainer(node) {
        if (!isChildContainer(node)) return
        if (hasTransAncestor(node)) return
        const expr = node.expression
        if (expr.type === 'Literal' && typeof expr.value === 'string') {
          context.report({ node, messageId: 'bareText' })
        } else if (expr.type === 'TemplateLiteral' && hasStaticText(expr)) {
          context.report({ node, messageId: 'bareText' })
        }
      },
    }
  },
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/no-untranslated-jsx-text.test.ts`
Expected: PASS — all valid/invalid cases green.

- [ ] **Step 5: Verify 100% coverage on the rule**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/no-untranslated-jsx-text.test.ts --coverage --coverage.include='eslint-rules/no-untranslated-jsx-text.js'`
Expected: 100% lines/branches/functions/statements. If a branch is uncovered, add the matching valid/invalid case (e.g. a numeric `{42}` for the `typeof === 'string'` false arm; the `<Trans>{...}</Trans>` cases for the Trans-ancestor arms) until 100%.

- [ ] **Step 6: Commit**

```bash
git add frontend/eslint-rules/no-untranslated-jsx-text.js frontend/eslint-rules/no-untranslated-jsx-text.test.ts
git commit -m "feat(MYT-80): mythrun-ui/no-untranslated-jsx-text rule + RuleTester (TDD)"
```

---

### Task 4: Lint wiring + i18next rail correction + config-wiring test

**Files:**
- Modify: `frontend/eslint.config.js`, `frontend/eslint-rules/config-wiring.test.ts`

- [ ] **Step 1: Extend the failing config-wiring test** (`frontend/eslint-rules/config-wiring.test.ts`)

Add these to the existing file: import the new rule + plugin; a registration assertion; fire-on-violation; and the data-testid-exempt assertions (the latter two as isolated `lintText`, non-type-aware, mirroring the existing fires-tests).

```ts
// --- add to the imports at the top ---
import i18nextPlugin from 'eslint-plugin-i18next'
import { noUntranslatedJsxText } from './no-untranslated-jsx-text.js'

// --- add inside the existing 'registration & scoping' describe ---
it('no-untranslated-jsx-text is error for feature code', async () => {
  const web = new ESLint({ cwd: frontendDir })
  const cfg = await web.calculateConfigForFile(resolve(frontendDir, 'src/app.tsx'))
  expect(cfg.rules['mythrun-ui/no-untranslated-jsx-text']?.[0]).toBe(2)
  // the i18next rail's attribute exemptions are real (jsx-attributes.exclude),
  // not the old silent-no-op `ignoreAttribute`:
  const i18nextOpts = cfg.rules['i18next/no-literal-string']?.[1]
  expect(i18nextOpts?.['jsx-attributes']?.exclude).toContain('data-testid')
})

// --- add a new describe for the custom rule firing ---
describe('no-untranslated-jsx-text — fire on violation', () => {
  function isolated() {
    return new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        plugins: { 'mythrun-ui': { rules: { 'no-untranslated-jsx-text': noUntranslatedJsxText } } },
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { 'mythrun-ui/no-untranslated-jsx-text': 'error' },
      },
    })
  }
  async function ids(code: string): Promise<Array<string | null>> {
    const [res] = await isolated().lintText(code, { filePath: 'fixture.jsx' })
    if (!res) throw new Error('no lint result')
    return res.messages.map((m) => m.ruleId)
  }
  it('fires on bare text and template-literal children; silent on t()/<Trans>', async () => {
    expect(await ids('export const A = () => <Text>hi</Text>\n')).toContain(
      'mythrun-ui/no-untranslated-jsx-text',
    )
    expect(await ids('export const A = () => <Text>{`hi`}</Text>\n')).toContain(
      'mythrun-ui/no-untranslated-jsx-text',
    )
    expect(await ids('export const A = () => <Text>{t("k")}</Text>\n')).not.toContain(
      'mythrun-ui/no-untranslated-jsx-text',
    )
    expect(await ids('export const A = () => <Trans>hi</Trans>\n')).not.toContain(
      'mythrun-ui/no-untranslated-jsx-text',
    )
  })
})

// --- add to the existing 'fire on violation' describe (i18next attribute exemption is honored) ---
it('i18next rail exempts data-testid via jsx-attributes.exclude', async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      plugins: { i18next: i18nextPlugin },
      languageOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: {
        'i18next/no-literal-string': [
          'error',
          {
            mode: 'jsx-only',
            'jsx-attributes': {
              exclude: ['className', 'styleName', 'style', 'type', 'key', 'id', 'width', 'height', 'data-testid', 'aria-.*', 'role'],
            },
          },
        ],
      },
    },
  })
  const [res] = await eslint.lintText('export const A = () => <Widget data-testid="x" />\n', {
    filePath: 'fixture.jsx',
  })
  if (!res) throw new Error('no lint result')
  expect(res.messages.map((m) => m.ruleId)).not.toContain('i18next/no-literal-string')
})
```

- [ ] **Step 2: Run it — verify the new assertions FAIL**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/config-wiring.test.ts`
Expected: FAIL — `mythrun-ui/no-untranslated-jsx-text` is undefined in the resolved config; `jsx-attributes.exclude` is undefined (still the old `ignoreAttribute`).

- [ ] **Step 3: Register the rule + correct the i18next rail in `frontend/eslint.config.js`**

Add the import (next to the existing `noAdHocUi` import):

```js
import { noUntranslatedJsxText } from './eslint-rules/no-untranslated-jsx-text.js'
```

Register the rule in the `mythrun-ui` plugin object (the `plugins:` map) — change:

```js
      'mythrun-ui': { rules: { 'no-ad-hoc-ui': noAdHocUi } },
```
to:
```js
      'mythrun-ui': {
        rules: { 'no-ad-hoc-ui': noAdHocUi, 'no-untranslated-jsx-text': noUntranslatedJsxText },
      },
```

In the `rules:` block, add the new rule and REPLACE the old i18next block (drop the false PascalCase comment + the `ignoreAttribute` no-op):

```js
      'mythrun-ui/no-ad-hoc-ui': 'error',
      'mythrun-ui/no-untranslated-jsx-text': 'error',
      // Two cooperating no-hardcoded-strings rails. mythrun-ui/no-untranslated-jsx-text
      // is the complete JSX-child-text rail (and closes the template-literal-child
      // case the plugin skips via should-validate-template:false). eslint-plugin-i18next
      // owns ATTRIBUTE coverage; `t()` and `<Trans>` are exempt by the plugin's own
      // defaults. `jsx-attributes.exclude` REPLACES the plugin defaults, so the defaults
      // are re-listed + the additions (data-testid, aria-.*, role); patterns are
      // full-match regex. (This replaces the prior `ignoreAttribute`, which was a silent
      // no-op — not a real option.)
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          'jsx-attributes': {
            exclude: [
              'className', 'styleName', 'style', 'type', 'key', 'id', 'width', 'height',
              'data-testid', 'aria-.*', 'role',
            ],
          },
        },
      ],
```

- [ ] **Step 4: Run the config-wiring test — verify it PASSES**

Run: `pnpm --filter @mythrun/web exec vitest run eslint-rules/config-wiring.test.ts`
Expected: PASS — registration asserts both `mythrun-ui` rules + the `jsx-attributes.exclude` containing `data-testid`; the fire-tests confirm the custom rule bites on bare/template text and is silent on `t()`/`<Trans>`; the i18next rail exempts `data-testid`.

- [ ] **Step 5: Smoke the real lint end-to-end**

```bash
cd frontend
printf 'export const Bad = () => <Text>Hello world</Text>\n' > src/__smoke__.tsx
pnpm lint; echo "exit=$?"   # expect non-zero: mythrun-ui/no-untranslated-jsx-text (and i18next on the same text)
rm src/__smoke__.tsx
cd ..
```
Expected: non-zero, reporting `mythrun-ui/no-untranslated-jsx-text`. After `rm`, the next step confirms green.

- [ ] **Step 6: Confirm the clean scaffold lints green + typechecks**

Run: `pnpm --filter @mythrun/web lint && pnpm --filter @mythrun/web typecheck && pnpm --filter @mythrun/ui lint`
Expected: all exit 0. (The scaffold `app.tsx` renders `<Text>{null}</Text>` — no bare text; `config.test.tsx`/`typed-keys.guard.ts` use `t()` / non-JSX, so the new rail doesn't fire on them.)

- [ ] **Step 7: Commit**

```bash
git add frontend/eslint.config.js frontend/eslint-rules/config-wiring.test.ts
git commit -m "feat(MYT-80): wire no-untranslated-jsx-text + correct the i18next attribute rail (fix MYT-79 ignoreAttribute no-op)"
```

---

### Task 5: Placeholder report + final verification

**Files:**
- Create: `frontend/scripts/i18n-todo.mjs`
- Modify: `frontend/package.json`

- [ ] **Step 1: Create the placeholder report** (`frontend/scripts/i18n-todo.mjs`)

```js
// Lists every locale value still holding a `[placeholder for …]` so unwritten
// copy is findable. JSON-walks values (not a line-grep) so it survives nested +
// `_one`/`_other` plural key shapes.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../src/i18n/locales/', import.meta.url).pathname

function* jsonFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* jsonFiles(p)
    else if (name.endsWith('.json')) yield p
  }
}

function* placeholders(value, path) {
  if (typeof value === 'string') {
    if (value.startsWith('[placeholder for')) yield `${path} = ${value}`
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* placeholders(v, `${path}.${k}`)
  }
}

let count = 0
for (const file of jsonFiles(ROOT)) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  for (const line of placeholders(data, file.replace(ROOT, ''))) {
    console.log(line)
    count++
  }
}
console.log(`\n${count} placeholder value(s) awaiting copy.`)
```

- [ ] **Step 2: Add the script to `frontend/package.json`** (in `scripts`)

```json
    "i18n:todo": "node scripts/i18n-todo.mjs",
```

- [ ] **Step 3: Run it**

Run: `pnpm --filter @mythrun/web i18n:todo`
Expected: lists `common.json` `appGreeting` + `richSample` (the two placeholder values) and a count of 2.

- [ ] **Step 4: Final full verification**

Run: `pnpm --filter @mythrun/web lint && pnpm --filter @mythrun/web typecheck && pnpm --filter @mythrun/web test && pnpm --filter @mythrun/web test:coverage && pnpm --filter @mythrun/ui lint && pnpm --filter @mythrun/ui typecheck && pnpm --filter @mythrun/web build`
Expected: all green; `test:coverage` shows the custom rule at 100% (and the existing `no-ad-hoc-ui` still 100%); `@mythrun/ui` unaffected.

- [ ] **Step 5: Commit**

```bash
git add frontend/scripts/i18n-todo.mjs frontend/package.json
git commit -m "feat(MYT-80): i18n:todo placeholder report; final verification"
```

---

## Final verification (before HOLDING at ready-to-merge)

- [ ] `pnpm -r typecheck` — backend + frontend all green.
- [ ] `pnpm -r lint` — all green on the clean scaffold.
- [ ] `pnpm --filter @mythrun/web test:coverage` — `no-ad-hoc-ui.js` + `no-untranslated-jsx-text.js` both 100%.
- [ ] Runtime: `t('back')`→"Back", interpolation substitutes, `<Trans>` renders markup, missing key returns the key.
- [ ] Typed keys: `pnpm --filter @mythrun/web typecheck` green (the `@ts-expect-error` guard is consumed → typed keys engaged).
- [ ] Smoke: a `<Text>Hello world</Text>` file fails `pnpm lint` with `mythrun-ui/no-untranslated-jsx-text`; a `<Text>{`hi`}</Text>` file fails too; `<Text>{t('k')}</Text>` passes.
- [ ] `git status` clean (no `__smoke__`; `dist`/`coverage` gitignored).
- [ ] **DO NOT push or merge.** Report ready-to-merge + the commit range; wait for the user's signal that the MYT-81 fork is done, then perform the merge (reconcile `frontend/package.json` + `pnpm-lock.yaml` + `main.tsx`, re-verify on merged HEAD, single push).

## Done-when → task map (spec §7)

| Spec done-when | Task |
|---|---|
| #1 deps + resolveJsonModule + i18n module + provider | T1, T2 |
| #2 static / interpolation / `<Trans>` / missing-key resolve | T2 |
| #3 `t('not.a.key')` compile error (i18next-module augmentation) | T2 |
| #4 common.json shows all four value paths | T2 |
| #5 bare text + string-literal + template-literal children fail lint; t()/Trans pass | T3, T4 |
| #6 attribute literal fails; data-testid exempt; MYT-79 no-op + false comment fixed | T4 |
| #7 custom rule 100% Vitest-instrumented; config-wiring asserts registration + fire + attr-exempt | T3, T4 |
| #8 web lint/typecheck/test/test:coverage green; ui unaffected | T5, Final |
| #9 i18n:todo lists placeholders | T5 |
