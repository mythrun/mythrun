import root from '../../eslint.config.js'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
  ...root,
  {
    ignores: ['dist/**', 'src/**/*.css'],
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
