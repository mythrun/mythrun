# MYT-80 — Frontend i18n Infrastructure — Design

> **Type**: Implementation design (superpowers brainstorm output)
> **Date**: 2026-06-19
> **Status**: Approved (pending written-spec review) — revised post blind-review round 1 (Rivers)
> **Linear**: MYT-80 (Frontend milestone, Day 2; depends only on MYT-79 — shipped)
> **Spec refs**: feedback memory "no hardcoded strings / i18n"; MYT-79 design spec (the workspace + lint rails this extends); brand `brief.md` (copy ownership); UX Design (the future consumers)

---

## 1. Goal

Stand up the i18n layer so **every user-facing string is a key from day one** — single-locale ship (`en`), multi-language-ready — and **finalize the no-hardcoded-strings lint** so no user-facing string (text or attribute, in any component shape, any literal kind) can ship un-keyed. MYT-80 is pure infrastructure: the scaffold renders `<Text>{null}</Text>`, so there is almost no existing string to convert. It ships the runtime + the key/namespace structure + typed keys + the finalized lint + a sample set that **proves the paths the first real consumer (MYT-86) will use** — static chrome, placeholder prose, interpolation, and `<Trans>` embedded markup.

> **Revised post-review:** the carried-over MYT-79 note framed the lint gap as "eslint-plugin-i18next allowlists JSX text in PascalCase arrow-const components." Verified against `eslint-plugin-i18next@6.1.4` source — that is **wrong**: the plugin's variable-declarator skip matches `[A-Z_-]+` (whole identifier all-caps), so `const App`/`const Hub`/`const LandingPage` ARE flagged; only degenerate all-caps consts (`const X`) escape (never real components). The **real** uncovered hole is **template-literal JSX children** (`<Text>{`hi`}</Text>`), which the plugin skips via its `should-validate-template: false` default. The custom rule's justification and scope are reframed around this verified behavior (§4.5).

## 2. The rule this enforces

No hardcoded user-facing strings, ever — every string is a key resolved through i18n. Ship single-locale (`en`); follow the segregation discipline from the start so adding a locale later is config, not a rewrite. Value policy:
- **Real prose** → the value is a literal `[placeholder for <purpose>]`. Miklos writes the real copy. Do NOT invent prose.
- **Truly generic chrome** (a "Back", a "Next", a nav label) → the real word.

Brand voice for any copy comes from the brand repo; the prose itself is Miklos's to write (`brand/brief.md`: copy ownership).

## 3. Locked decisions

1. **Library: `react-i18next` (+ `i18next` core).** Decisive on the dependency-selection rule + the "most widely-used / documented / supported" metric — 13.7M weekly downloads (~4× react-intl, ~16× Lingui), de-facto React standard, actively published (react-i18next 17.0.8; i18next 26.3.1). Pairs with the already-installed `eslint-plugin-i18next`.
2. **Key structure: per-feature namespaces** under `frontend/src/i18n/locales/en/`; default namespace `common`. Each future flow adds its own namespace file; keys nested by sub-area.
3. **Typed keys** via the **`i18next`** module's `CustomTypeOptions` augmentation — `t('bad.key')` is a compile error.
4. **Synchronous init** with bundled resources — no async load, no Suspense, no loading state.
5. **Lint = two cooperating rails** finalized against the *verified* plugin behavior; the custom rail owns the complete JSX-child-text surface (closing the real template-literal hole).

## 4. Architecture

### 4.1 Module layout

```
frontend/src/i18n/
  config.ts              # i18next.init(...) with bundled resources; exports `i18n`, `resources`, `defaultNS`
  i18next.d.ts           # `declare module 'i18next'` CustomTypeOptions augmentation → typed keys (sources types from config.ts)
  locales/en/common.json # the default namespace: static-chrome + placeholder-prose + interpolation + <Trans> sample keys
frontend/src/main.tsx     # (modify) import './i18n/config'; wrap <App> in <I18nextProvider i18n={i18n}> (explicit; see §4.2)
frontend/tsconfig.json    # (modify) add "resolveJsonModule": true   ← precondition for JSON imports
frontend/eslint-rules/
  no-untranslated-jsx-text.js        # custom rule (ESM, JSDoc-typed) — the complete JSX-child-text rail
  no-untranslated-jsx-text.test.ts   # Vitest-instrumented RuleTester
  config-wiring.test.ts              # (extend) register + fire-on-violation + the attribute-exempt assertion
frontend/eslint.config.js  # (modify) register the custom rule; correct the i18next rail config (the inherited no-op)
scripts/i18n-todo.mjs       # (optional) node walk reporting [placeholder for …] values
```

### 4.2 Runtime (`config.ts`)

```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import common from './locales/en/common.json'

export const defaultNS = 'common'
export const resources = { en: { common } } as const

// Synchronous init — load-bearing on TWO conditions: (1) NO init callback is
// passed (a callback re-triggers i18next's constructor setTimeout deferral),
// and (2) `resources` is inline (so init runs `load()` synchronously and sets
// isInitialized before returning). Together → useTranslation()'s `ready` is
// true on first render, so the useSuspense:true default never throws and there
// is no flash-of-keys. DO NOT add an init callback or an async backend without
// adding a <Suspense> boundary.
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS,
  resources,
  returnNull: false,
  returnEmptyString: false, // a blank value falls through to the key (visible), not silent ''
  interpolation: { escapeValue: false }, // React already escapes; i18next escaping would double-escape
})

export { i18n }
```

`main.tsx` imports `./i18n/config` (runs init) and wraps `<App>` in `<I18nextProvider i18n={i18n}>`. **Note:** the provider is *explicit, not strictly required* — `initReactI18next` registers the singleton as the global default, so `useTranslation()` resolves via `getI18n()` without it. We keep it for explicitness and to future-proof a possible second instance. (If a reviewer prefers, dropping the provider + `i18n` export and relying on the side-effect import is equally correct.)

### 4.3 Typed keys (`i18next.d.ts`)

Augment the **`i18next`** module (NOT `react-i18next` — `CustomTypeOptions` lives in `i18next`; react-i18next derives its `t()` key types from it). Source the types from `config.ts` so the `.d.ts` and the runtime can't drift:

```ts
import 'i18next'
import type { resources, defaultNS } from './config'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS
    resources: (typeof resources)['en'] // → { common: typeof common }
    returnNull: false // match the runtime so t() returns `string`, not `string | null`
  }
}
```

`t('…')` autocompletes and rejects unknown keys at compile time. Each new namespace (MYT-86+) is added to `config.ts`'s `resources` and is picked up here automatically via `(typeof resources)['en']` — single source of truth. **Preconditions** (both must be set in the plan, do not assume): `resolveJsonModule: true` in `frontend/tsconfig.json` (NOT implied by `moduleResolution: Bundler`); and the `.d.ts` lives under `src/**` so the existing tsconfig `include` picks it up (it must keep a top-level `import` to stay a module augmentation). `skipLibCheck: true` (already set) keeps the augmentation quiet.

### 4.4 Key & value conventions + the sample set

`common.json` ships **four** keys that demonstrate every path the first consumer needs (no invented prose — placeholders carry the brand-owner copy):

```json
{
  "back": "Back",
  "appGreeting": "[placeholder for app greeting] {{name}}",
  "richSample": "[placeholder for rich-text sample with a <1>link</1>]",
  "missingDemo": "[placeholder for a key the runtime test resolves]"
}
```
- `back` — generic chrome, real word (value policy: chrome gets the word).
- `appGreeting` — placeholder prose **with interpolation** (`{{name}}`); proves the interpolation path the UX needs everywhere ("5 sessions remaining", "Waiting for N players", "by {Creator}").
- `richSample` — placeholder prose **with embedded markup** (`<1>…</1>`); proves the `<Trans>` path the UX needs (invite banner with a campaign name, inline clickable entity names mid-sentence).

Future flows add their own namespace files. **Placeholder discoverability** (optional, kept unless dropped at review): `scripts/i18n-todo.mjs` — a tiny node script that `JSON.parse`-walks every locale file's values (NOT a line-grep — survives nested + `_one`/`_other` plural shapes) and lists those matching `[placeholder for …]`. A convenience report, not a gate.

### 4.5 The lint — complete no-hardcoded-strings coverage (rewritten against verified plugin behavior)

Two cooperating rails on `frontend/src/**` (both `error`):

**(a) `eslint-plugin-i18next/no-literal-string`** — keep `mode: 'jsx-only'`. The spec's earlier config claims were wrong; corrected to the real option schema (`callees`, `words`, `jsx-attributes`, `jsx-components` — each `{ include?, exclude? }`):
- `t(...)` and `<Trans>` are **already exempt by default** (`callees.exclude` includes `t`/`i18n`; `jsx-components.exclude` = `['Trans']`) — **no config needed** for them. (Remove the old "add callee allow-list / exempt Trans" bullets — they named non-existent options and asked for the default.)
- **Attribute exemptions use `jsx-attributes: { exclude: [...] }`** (full-match regex — `aria-.*`, not `aria-*`). Because the plugin **replaces** (not merges) the default exclude list, the plan must read the plugin's current `defaults.js` `jsx-attributes.exclude` and **re-list those defaults** (`className`, `style`, `type`, `key`, `id`, `width`, `height`, …) alongside the additions (`data-testid`, `aria-.*`, `role`). 
- **Fix the inherited MYT-79 silent no-op:** the live config's `ignoreAttribute: [...]` is not a real option (the schema ignores unknown keys), so `data-testid`/`aria-*`/`role` are NOT exempted today (`id` works only because it's a plugin default). Replace it with the correct `jsx-attributes.exclude`, and **fix the false MYT-79 inline comment** (`eslint.config.js`) about the PascalCase gap in the same pass.
- This rail owns **attribute** coverage (its strength); its JSX-text coverage is redundant with rail (b) below.

**(b) `mythrun-ui/no-untranslated-jsx-text`** — a new custom rule (same discipline as `no-ad-hoc-ui`: ESM in `frontend/eslint-rules/`, JSDoc `@type {import('eslint').Rule.RuleModule}`, registered in the `mythrun-ui` plugin, Vitest-instrumented RuleTester, config-wiring test, excluded from the coverage gate per the v8 double-load learning). It is the **authoritative, complete JSX-child-text rail** — no component-shape or literal-kind gap:
- Reports a non-whitespace **`JSXText`** node (whitespace-only formatting text is ignored).
- Reports a **string `Literal`** inside a `JSXExpressionContainer` that is a JSX child (`<Text>{'hi'}</Text>`).
- Reports a **`TemplateLiteral`** inside such a container **when it has static text** (`<Text>{`hi`}</Text>`, `<Text>{`hi ${x}`}</Text>`) — **this is the rule's unique value**: the plugin skips templates (`should-validate-template: false`, verified). Does NOT report an interpolation-only template with no static text (`<Text>{`${x}`}</Text>`).
- A "JSX child" container's parent is `JSXElement` **or `JSXFragment`** (cover the fragment-root case).
- Does NOT report numeric/expression children (`<Text>{count}</Text>`, `<Text>{t('k')}</Text>`).
- **Exempts `<Trans>` by walking ALL ancestors** (not the nearest element) — so `<Trans><b>hi</b></Trans>` passes (the text's nearest element is `<b>`, but a `<Trans>` ancestor exempts it).

**Overlap is intentional and accepted.** Rail (a) also flags `JSXText` / string-literal children in real components, so a real violation reports **twice** (plugin + custom). This is accepted: completeness is the priority for a foundation rail, both messages point to the same fix (`use t()` / `<Trans>`), and the custom rail guarantees the cases the plugin misses (template-literal children; the degenerate all-caps-const scope-skip). *(If the plan finds a clean way to narrow rail (a) to attributes-only, do it — but not at the cost of a coverage gap.)* The escape hatch is the existing lint-enforced one (`// eslint-disable-next-line … -- <reason>` with `require-description` + `reportUnusedDisableDirectives`, from MYT-79).

> **Net contract:** no user-facing string rendered by React — JSX text (any literal kind, any component shape) or attribute — can ship un-keyed without a reasoned, lint-enforced disable. (Document-level `<title>`/meta is outside React i18n and the rails — see §6.)

## 5. Testing

- **Runtime (RTL + the provider):** `t('back')` → "Back"; `t('appGreeting', { name: 'x' })` substitutes `{{name}}`; a `<Trans i18nKey="richSample" components={{ 1: <a href="#" /> }} />` renders the embedded markup; a missing key returns the key (no throw — proves `fallbackLng` + `returnNull/returnEmptyString:false`).
- **Typed keys:** a `.ts` guard with `// @ts-expect-error` over `t('definitely.not.a.key')`. With the augmentation correctly on `i18next`, the bad key IS an error → the directive is consumed → `pnpm typecheck` passes. If typed keys regress (keys widen to `string`), the call is valid → the directive is **unused** → `ts(2578)` → typecheck FAILS. So the guard fails loudly iff typed keys aren't engaged.
- **Custom rule (RuleTester):** *invalid* — `<Text>hi</Text>`, `<Text>{'hi'}</Text>`, `<Text>{`hi`}</Text>`, `<Text>{`hi ${x}`}</Text>`; *valid* — `<Text>{t('k')}</Text>`, `<Text>{count}</Text>`, `<Text>{`${x}`}</Text>`, `<Trans>hi</Trans>`, `<Trans><b>hi</b></Trans>`, whitespace-only text between elements, fragment-root `<>{t('k')}</>`. Full branch coverage → 100%.
- **Config-wiring (extend MYT-79's test):** assert `mythrun-ui/no-untranslated-jsx-text` is `error` for `frontend/src/**`; assert (isolated `lintText`, non-type-aware parser) it fires on `<Text>hi</Text>` + `<Text>{`hi`}</Text>` and is silent on `<Text>{t('k')}</Text>` + `<Trans>hi</Trans>`; **assert a `data-testid="literal"` attribute PASSES the i18next rail** (proves the `jsx-attributes.exclude` fix — would have caught the inherited no-op).
- All green through `pnpm --filter @mythrun/web lint` / `typecheck` / `test` / `test:coverage`; the new rule is logic → 100%-gated via its RuleTester unit test (config-wiring stays excluded from `test:coverage`). `@mythrun/ui` unaffected.

## 6. Out of scope (explicit deferrals)

- **Document-level `<title>` / `<meta>` i18n** — outside React i18n and the lint rails (`index.html`'s `<title>` is lint-ignored; the recap page's share-card title is real copy). Deferred to the routing consumer (MYT-83/86), intended mechanism: a `useDocumentTitle(t(...))` hook + a head manager. The §4.5 contract is bounded to React-rendered content — stated so it doesn't silently overclaim.
- Language-switcher UI, additional locales, locale detection (single-locale `en`, structured for expansion).
- Namespace lazy-loading / code-splitting (resources bundled now).
- ICU-heavy formatting and **typed interpolation values** (`as const` doesn't reach into JSON values; keys are typed, interpolation placeholders are not — revisit when a flow needs it). **Pluralization** uses i18next's `_one`/`_other` suffix convention; the augmentation already tolerates the suffixed keys via the JSON `typeof` — deferred until a flow pluralizes.
- The flows' real strings + the actual copy (MYT-86+; Miklos writes the prose).

## 7. Done when

1. `react-i18next` + `i18next` installed; `frontend/tsconfig.json` has `resolveJsonModule: true`; `frontend/src/i18n/{config.ts, i18next.d.ts, locales/en/common.json}` exist; `main.tsx` provides `<I18nextProvider>`.
2. `t('back')` renders "Back"; `t('appGreeting', { name })` interpolates; `<Trans>` renders the `richSample` markup; a missing key returns the key (no throw).
3. `t('not.a.key')` is a **compile error** (the `i18next`-module augmentation engages; the `@ts-expect-error` guard passes under `pnpm typecheck`).
4. `common.json` demonstrates all four paths (chrome word, placeholder prose, interpolation, `<Trans>` markup).
5. A bare `<Text>hi</Text>`, a `<Text>{'hi'}</Text>`, AND a `<Text>{`hi`}</Text>` (template literal) all **fail** `pnpm lint`; `<Text>{t('k')}</Text>`, `<Text>{count}</Text>`, `<Trans>hi</Trans>`, and `<Trans><b>hi</b></Trans>` pass.
6. An attribute literal still fails; an intended-exempt attribute (`data-testid`) passes (the `jsx-attributes.exclude` fix); the inherited MYT-79 `ignoreAttribute` no-op + the false gap comment are corrected.
7. The custom rule is Vitest-instrumented at 100%; the config-wiring test asserts registration + fire-on-violation + the attribute-exempt assertion; both `test` and `test:coverage` run in CI/pre-push.
8. `pnpm --filter @mythrun/web lint && typecheck && test && test:coverage` all green; `@mythrun/ui` unaffected.
9. (If kept) `scripts/i18n-todo.mjs` lists the placeholder values via a JSON walk.

## 8. Open questions

None. Library, structure, typed-keys (on `i18next`), sync-init, and the lint (corrected to verified plugin behavior — the real gap is template-literal children, not a PascalCase case) are settled. The optional `i18n:todo` script (§4.4) and keeping-vs-dropping the redundant `<I18nextProvider>` (§4.2) are kept unless dropped at review.
