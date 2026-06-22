import root from '../../eslint.config.js'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import eslintConfigPrettier from 'eslint-config-prettier'

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
  eslintConfigPrettier,
]
