# MYT-80 — Frontend i18n Infrastructure — Design

> **Type**: Implementation design (superpowers brainstorm output)
> **Date**: 2026-06-19
> **Status**: Approved (pending written-spec review)
> **Linear**: MYT-80 (Frontend milestone, Day 2; depends only on MYT-79 — shipped)
> **Spec refs**: feedback memory "no hardcoded strings / i18n"; MYT-79 design spec (the workspace + lint rails this extends); brand `brief.md` (copy ownership)

---

## 1. Goal

Stand up the i18n layer so **every user-facing string is a key from day one** — single-locale ship, multi-language-ready — and **finalize the no-hardcoded-strings lint** so no user-facing string (text or attribute, in any component shape) can ship un-keyed. MYT-80 is pure infrastructure: there is almost no existing string to convert (the scaffold renders `<Text>{null}</Text>`), so it ships the runtime + the key/namespace structure + typed keys + the finalized lint, proven with a sample key and the rule's tests. Real copy and the flows' strings arrive with MYT-86+.

This closes the limitation MYT-79 carried over: `eslint-plugin-i18next@6` allowlists bare JSX text inside PascalCase arrow-const components.

## 2. The rule this enforces

Per the standing frontend rule of the road: **no hardcoded user-facing strings, ever** — every string is a key resolved through i18n. Ship single-locale (`en`); the segregation discipline is followed from the start so adding a locale later is config, not a rewrite. Value policy:
- **Real prose** (descriptions, onboarding, substantive error copy) → the value is a literal `[placeholder for <purpose>]`. Miklos writes the real copy. Do NOT invent prose.
- **Truly generic chrome** (a "Back", a "Next", a nav label) → the real word.

Brand voice for any copy comes from the brand repo, but the prose itself is Miklos's to write (`brand/brief.md`: copy ownership).

## 3. Locked decisions

Settled during brainstorming; **not open**:

1. **Library: `react-i18next` (+ `i18next` core).** Decisive on the repo's dependency-selection rule + the user's "most widely-used / documented / supported" metric — 13.7M weekly downloads (~4× react-intl, ~16× Lingui), de-facto React standard, largest docs + plugin ecosystem, actively published (react-i18next 17.0.8 @ 2026-05-14; i18next 26.3.1). Bonus: pairs with the already-installed `eslint-plugin-i18next` (one fewer moving part).
2. **Key structure: per-feature namespaces.** One JSON file per namespace under `frontend/src/i18n/locales/en/`; default namespace `common`. Each future flow adds its own namespace file. Keys nested by sub-area (`hub.empty.title`).
3. **Typed keys** via `react-i18next` TS module augmentation — `t('bad.key')` is a compile error.
4. **Synchronous init** with bundled resources — no async load, no Suspense, no loading state.
5. **The JSX-text gap is closed by a custom rule**, not by accepting the plugin's blind spot.

## 4. Architecture

### 4.1 Module layout

```
frontend/src/i18n/
  config.ts              # i18next.init(...) with bundled resources (side-effect + named `i18n` export)
  react-i18next.d.ts     # CustomTypeOptions augmentation → typed keys
  locales/
    en/
      common.json        # the default namespace; ships one real-chrome key + one placeholder-prose key (sample)
frontend/src/main.tsx     # (modify) import './i18n/config'; wrap <App> in <I18nextProvider i18n={i18n}>
frontend/eslint-rules/
  no-untranslated-jsx-text.js        # the custom rule (ESM, JSDoc-typed) — closes the gap
  no-untranslated-jsx-text.test.ts   # Vitest-instrumented RuleTester
  (config-wiring.test.ts)            # extend MYT-79's wiring test with the new rule's registration + fire-on-violation
frontend/eslint.config.js  # (modify) register the rule in the `mythrun-ui` plugin; finalize the i18next rule config
```

### 4.2 Runtime (`config.ts`)

```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import common from './locales/en/common.json'

export const defaultNS = 'common'
export const resources = { en: { common } } as const

void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS,
  resources,
  returnNull: false,
  interpolation: { escapeValue: false }, // React already escapes
})

export { i18n }
```

`main.tsx` imports `./i18n/config` (runs init) and wraps `<App>` in `<I18nextProvider i18n={i18n}>`. Because resources are bundled and init is synchronous, `useTranslation()` resolves immediately — no Suspense boundary, no flash-of-keys.

### 4.3 Typed keys (`react-i18next.d.ts`)

```ts
import 'react-i18next'
import type common from './locales/en/common.json'

declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: { common: typeof common }
  }
}
```

`t('common:…')` / `t('…')` autocomplete and reject unknown keys at compile time. Each new namespace (MYT-86+) extends `resources` here. (`resolveJsonModule` is already on via the Vite/TS scaffold; JSON is imported as a typed object.)

### 4.4 Key & value conventions

- **Namespacing:** `common` for shared chrome; future flows add `landing`, `hub`, … files. Nested keys by sub-area.
- **Sample content (MYT-80 only):** `common.json` ships exactly two keys to demonstrate both halves of the value policy — one generic-chrome real word and one `[placeholder for <purpose>]` prose value — plus whatever single key the demo/test references. No invented prose.
- **Placeholder discoverability (optional, kept unless you'd rather drop it):** a `pnpm i18n:todo` script (a tiny node/grep over `locales/**/*.json`) lists every value matching `[placeholder for …]` so unwritten copy is findable. Not a gate — a convenience report.

### 4.5 The lint — complete no-hardcoded-strings coverage

Two cooperating rails on `frontend/src/**` (both `error`):

**(a) `eslint-plugin-i18next/no-literal-string`** — keep at `mode: 'jsx-only'`, and finalize it:
- Add a **callee allow-list** so translated content + keys don't trip: `callees`/`words` config permitting `t(...)` (and `i18n.t`). The key string argument to `t` must not be flagged.
- Exempt `<Trans>` (its children are the translation mechanism, not literals).
- Keep the existing `ignoreAttribute: ['data-testid', 'aria-*', 'role', 'id']` baseline; extend only if a real non-user-facing attribute surfaces.
- This rail owns **attribute** literal coverage (its strength).

**(b) `mythrun-ui/no-untranslated-jsx-text`** — a new custom rule (same authoring discipline as MYT-79's `no-ad-hoc-ui`: ESM module in `frontend/eslint-rules/`, JSDoc `@type {import('eslint').Rule.RuleModule}`, registered in the `mythrun-ui` plugin, Vitest-instrumented RuleTester, config-wiring test, excluded from the coverage gate per the v8 double-load learning). It owns **JSX child text** coverage completely — no component-shape blind spot:
- Reports a **`JSXText` node** whose `.value.trim()` is non-empty (whitespace-only formatting text is ignored).
- Reports a **string `Literal` / `TemplateLiteral` inside a `JSXExpressionContainer` that is a JSX child** (`<Text>{'hi'}</Text>`), i.e. user-facing text smuggled through an expression container.
- **Exempts `<Trans>` children** (walk to the nearest enclosing `JSXElement`; if its name is `Trans`, skip).
- Message points the author to `t()` / `<Trans>`.

Where the two overlap (bare JSX text inside a *function-declaration* component is seen by both), both fire — harmless defense-in-depth: if either rail regresses, JSX text is still caught. The custom rule guarantees the arrow-const case the plugin misses. The escape hatch is the existing lint-enforced one (`// eslint-disable-next-line … -- <reason>` with `require-description` + `reportUnusedDisableDirectives`, from MYT-79).

> **Net contract:** no user-facing string — JSX text, expression-container text child, or attribute, in any component shape — can ship un-keyed without a reasoned, lint-enforced disable.

## 5. Testing

- **Runtime:** a test rendering a component that calls `t('<sample key>')` (via `renderHook`/RTL with the provider) resolves to the sample value; a missing-key path returns the key (not a throw), confirming `fallbackLng`/`returnNull:false`.
- **Typed keys:** a `tsc`-level guard — a `// @ts-expect-error` line on `t('definitely.not.a.key')` proves the augmentation rejects bad keys (compile-time, runs under `pnpm typecheck`).
- **The custom rule:** RuleTester — *invalid*: `<Text>hi</Text>` (JSXText), `<Text>{'hi'}</Text>` (expression-container literal), both in an arrow-const component; *valid*: `<Text>{t('k')}</Text>`, `<Trans>hi</Trans>`, whitespace-only text between elements, a numeric/expression child `<Text>{count}</Text>`. Full branch coverage → 100%.
- **Config-wiring (extend MYT-79's `config-wiring.test.ts`):** assert `mythrun-ui/no-untranslated-jsx-text` is `error` for `frontend/src/**`; assert (isolated `lintText`, non-type-aware parser) it fires on `<Text>hi</Text>` and is silent on `<Text>{t('k')}</Text>` and `<Trans>hi</Trans>`; assert the i18next callee allow-list lets `t('k')` pass.
- All green through `pnpm --filter @mythrun/web lint` / `typecheck` / `test` / `test:coverage`. The new rule is logic → 100%-gated (via its RuleTester unit test; the config-wiring test stays excluded from `test:coverage` per the v8 double-load learning).

## 6. Out of scope (explicit deferrals)

- Language-switcher UI, additional locales, locale detection (single-locale `en` only — structured for expansion).
- Namespace lazy-loading / code-splitting (resources are bundled now).
- ICU-heavy plural/date/number formatting (basic interpolation only; revisit when a flow needs it).
- The flows' real strings + the actual copy (MYT-86+; Miklos writes the prose).

## 7. Done when

1. `react-i18next` + `i18next` installed; `frontend/src/i18n/{config.ts, react-i18next.d.ts, locales/en/common.json}` exist; `main.tsx` provides `<I18nextProvider>`.
2. A component calling `t('<sample>')` renders the sample value; a missing key returns the key (no throw).
3. `t('not.a.key')` is a **compile error** (typed-keys guard passes under `pnpm typecheck`).
4. `common.json` demonstrates both value halves (one real-chrome word, one `[placeholder for …]`).
5. A bare `<Text>hi</Text>` (JSX text) AND a `<Text>{'hi'}</Text>` (expression-container literal) in a PascalCase arrow-const component both **fail** `pnpm lint`; `<Text>{t('k')}</Text>` and `<Trans>hi</Trans>` pass.
6. An attribute literal still fails (i18next rail intact); `t('k')` keys do not flag (callee allow-list).
7. The custom rule is Vitest-instrumented at 100%; the config-wiring test asserts registration + fire-on-violation; both `test` and `test:coverage` run in CI/pre-push (per MYT-79's gate).
8. `pnpm --filter @mythrun/web lint && typecheck && test && test:coverage` all green; `@mythrun/ui` unaffected.
9. (If kept) `pnpm i18n:todo` lists the placeholder values.

## 8. Open questions

None. Library, structure, typed-keys, sync-init, and the gap-closing strategy are all settled (§3). The optional `i18n:todo` script (§4.4) is kept unless dropped at review.
