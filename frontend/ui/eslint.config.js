import root from '../../eslint.config.js'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import eslintConfigPrettier from 'eslint-config-prettier'
// R2 (portability): the api-purity rule lives in client-core (the base layer)
// so BOTH packages can register it without inverting the `client-core ← ui`
// dependency direction. ui applies it to component prop-WIDENING.
import { apiPurity } from '../client-core/eslint-rules/api-purity.js'
// R3 (portability): component colors come from design tokens, never raw values.
// Lives in client-core's lint plugin (the design-system rule home); ui registers
// it on its component source only — color is a ui concern (the contract has no
// colors), so client-core's own config does not register it.
import { noAdHocColor } from '../client-core/eslint-rules/no-ad-hoc-color.js'
// MYT-100 root cause: the no-hardcoded-strings TEXT rail. Lives in @mythrun/web's
// `eslint-rules/` (the app package authored it); the library registers it below so
// DS-owned text surfaces are no longer BELOW the app-layer rail floor. Same
// cross-package import shape as no-ad-hoc-color above (imported from a sibling
// package's eslint-rules dir).
import { noUntranslatedJsxText } from '../eslint-rules/no-untranslated-jsx-text.js'

// One SHARED `mythrun-ui` plugin object reused by both the no-ad-hoc-color block
// (src/components/**) and the no-untranslated-jsx-text block (src/**). Flat config
// throws "Cannot redefine plugin" when the same namespace is declared with two
// DIFFERENT objects across config blocks that BOTH match a file — and a component
// source file (src/components/**) matches both blocks. Sharing one object
// reference satisfies the merge's identity check, so both rules coexist. (MYT-100.)
const mythrunUiPlugin = {
  rules: { 'no-ad-hoc-color': noAdHocColor, 'no-untranslated-jsx-text': noUntranslatedJsxText },
}

export default [
  ...root,
  {
    // `vitest.config.ts` default-exports `defineConfig(...)` (banned repo-wide
    // by the root config's no-default-export rule, which only ignores
    // `**/*.config.js` — not the `.ts` config), and is outside this package's
    // TS project, so the root's type-aware projectService would reject it.
    // Ignored here, mirroring the @mythrun/web + client-core precedent.
    // (`.storybook/main.ts` + `.storybook/preview.tsx` ALSO default-export, but
    // they ARE inside the TS project — included in tsconfig.json so they
    // typecheck — so they carry an inline `no-restricted-syntax` disable
    // instead of a blanket ignore here, keeping the rest of the rule active.)
    ignores: ['dist/**', 'storybook-static/**', 'src/**/*.css', 'scripts/**', 'vitest.config.ts'],
  },
  {
    // a11y enforcement is a LIBRARY responsibility (spec §5.3): intrinsic DOM
    // elements live only in frontend/ui/**, so the accessibility rails ride
    // alongside them here. (no-ad-hoc-ui is deliberately NOT registered in the
    // library — raw elements are legitimate here.)
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      // Text/Heading expose a TYPOGRAPHIC `role` prop (ui-label, prose-body, …),
      // NOT an ARIA role; aria-role's default flags `<Text role="ui-label">` as an
      // invalid ARIA role. ignoreNonDOM scopes the rule to intrinsic DOM elements
      // (where `role` IS aria), so the design-system `role` prop is allowed.
      'jsx-a11y/aria-role': ['error', { ignoreNonDOM: true }],
    },
  },
  {
    // R2 (portability): catch a component that WIDENS its public *Props with a
    // DOM prop — e.g. `(props: ButtonProps & { className?: string })` — which
    // would smuggle a DOM-only prop past the platform-neutral contract. Same
    // rule the contract layer uses, scoped here to the component prop surface.
    files: ['src/components/**/*.{ts,tsx}'],
    plugins: { 'mythrun-api': { rules: { 'api-purity': apiPurity } } },
    rules: { 'mythrun-api/api-purity': 'error' },
  },
  {
    // R3 (portability): component color must come from design TOKEN utilities
    // (bg-ember-600 / text-ink), never raw hex/rgb/hsl values or arbitrary-value
    // color utilities (bg-[#abc]). Scoped to component source only — the color
    // classes also live as string literals inside `cva({...})`/`cn(...)` call
    // args here (the shadcn/CVA pattern), which a JSXAttribute-only rule would
    // miss, so the rule scans every string literal in this zone. (Stories, the
    // foundation specimen, and the token CSS legitimately hold raw values and
    // are outside `src/components/**`.)
    files: ['src/components/**/*.{ts,tsx}'],
    plugins: { 'mythrun-ui': mythrunUiPlugin },
    rules: { 'mythrun-ui/no-ad-hoc-color': 'error' },
  },
  {
    // MYT-100 ROOT-CAUSE FIX — the no-hardcoded-strings TEXT rail now rides in the
    // library. It was registered ONLY in the app package (@mythrun/web, under
    // `files: ['src/**']`), and @mythrun/ui had NO text rail (no-ad-hoc-ui was
    // deliberately excluded from this config — raw elements are legitimate in the
    // library — and the text rail silently fell out alongside it). So DS-owned
    // text surfaces sat BELOW the app-layer rail floor: hardcoded user-facing
    // copy inside @mythrun/ui components was never linted and shipped as literal
    // strings. Registering it here closes that floor gap.
    //
    // What it flags: a bare JSX text child (literal copy) — e.g. `<span>Level</span>`.
    // What it ALLOWS: text rendered from PROPS (any expression child, e.g.
    // `<Text>{props.label}</Text>`, `{labels.confirm}`) — the correct DS pattern,
    // so a properly-parameterized component passes clean. Attribute literals are
    // the eslint-plugin-i18next rail's job (registered in the app; not needed here
    // because the library takes its copy through props, not attributes).
    //
    // Stories + tests are excluded: they render literal fixture text by design
    // (mirrors the app config's carve-out of its own test files from the rails).
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.stories.tsx', 'src/**/*.test.tsx'],
    plugins: { 'mythrun-ui': mythrunUiPlugin },
    rules: { 'mythrun-ui/no-untranslated-jsx-text': 'error' },
  },
  {
    // MYT-100 placeholder ban: `[ph:` / `[ph_` is interim placeholder copy. After
    // the copy pass any surviving marker is a BUG, so it is a hard build break
    // across ALL library source — tests and stories INCLUDED. Implemented via
    // no-restricted-syntax so it catches both plain string literals and template
    // literals (the two shapes placeholder copy takes). Flat config REPLACES
    // no-restricted-syntax options (it does not merge them), so the repo-wide
    // default-export ban inherited from the root config is RE-LISTED here —
    // otherwise this block would silently drop it for src/**. (The root's
    // test-only DROP SCHEMA selectors are backend Postgres test-isolation policy
    // with no meaning in a frontend package, so they are intentionally not
    // carried over — see the LINT-agent report for that seam.)
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Default exports are forbidden. Use named exports only.',
        },
        {
          selector: 'Literal[value=/\\[ph[:_]/]',
          message:
            'Placeholder copy ([ph:… / [ph_…) must not ship. Replace it with a real i18n key + value. (MYT-100.)',
        },
        {
          selector: 'TemplateElement[value.raw=/\\[ph[:_]/]',
          message:
            'Placeholder copy ([ph:… / [ph_…) must not ship. Replace it with a real i18n key + value. (MYT-100.)',
        },
        {
          // Bare JSX text (`<span>[ph: …]</span>`, as in FullBleedStage.stories)
          // is neither a Literal nor a TemplateElement. Story/test files sit OFF
          // the text rail, so without this a placeholder in bare JSX text would
          // slip BOTH rails; §6 wants ZERO [ph anywhere, so catch it here too.
          selector: 'JSXText[value=/\\[ph[:_]/]',
          message:
            'Placeholder copy ([ph:… / [ph_…) must not ship. Replace it with a real i18n key + value. (MYT-100.)',
        },
      ],
    },
  },
  eslintConfigPrettier,
]
