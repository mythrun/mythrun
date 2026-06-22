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
    rules: { ...jsxA11y.configs.recommended.rules },
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
    plugins: { 'mythrun-ui': { rules: { 'no-ad-hoc-color': noAdHocColor } } },
    rules: { 'mythrun-ui/no-ad-hoc-color': 'error' },
  },
  eslintConfigPrettier,
]
