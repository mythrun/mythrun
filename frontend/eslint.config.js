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
    // Vite/Vitest configs default-export (banned repo-wide); CSS/build output;
    // `coverage/**` is the generated Vitest coverage report (HTML + helper .js
    // emitted by `test:coverage`) — build artifacts, not source. Without this
    // those `coverage/*.js` files hit the root config's type-aware projectService
    // and fail with "not found by the project service".
    ignores: [
      'dist/**',
      'coverage/**',
      'src/**/*.css',
      'index.html',
      'vite.config.ts',
      'vitest.config.ts',
    ],
  },
  {
    // The ESLint tooling files (custom rule module + its wiring test) interface
    // with ESLint's deliberately-`any`-typed surfaces: `create(context)` rule
    // callbacks receive `any` AST nodes, and `ESLint.calculateConfigForFile`
    // is typed `Promise<any>` upstream. The root config's strictTypeChecked
    // `no-unsafe-*` family therefore fires on every member access here. This is
    // an inherent property of the ESLint plugin API, not unsafe app code — the
    // backend sidesteps the identical issue by keeping its rule files as `.cjs`
    // (outside the TS project). Frontend rule files are `.js`/`.ts` inside the
    // TS project (so they typecheck + the wiring test runs under Vitest), so we
    // scope the `no-unsafe-*` relaxation to this tooling directory instead.
    files: ['eslint-rules/**/*.{js,ts}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
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
      // `jsx-only` is the strongest mode this plugin offers (catches JSX text +
      // attribute literals; attributes are the load-bearing case since mythrunUI
      // props carry most user text). KNOWN LIMITATION (eslint-plugin-i18next@6):
      // it allowlists bare JSX *text* inside PascalCase arrow-const components
      // (`const X = () => <Text>hi</Text>` is NOT flagged — it treats the
      // uppercase const like a constant). It DOES catch all attribute literals
      // and JSX text in `function Comp() {}` declarations. Closing the
      // arrow-const component-text gap is MYT-80's job, with the typed t()
      // runtime + a callee allow-list (and possibly a complementary rule).
      'i18next/no-literal-string': [
        'error',
        { mode: 'jsx-only', ignoreAttribute: ['data-testid', 'aria-*', 'role', 'id'] },
      ],
      '@eslint-community/eslint-comments/require-description': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  eslintConfigPrettier,
]
