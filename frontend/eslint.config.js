import root from '../eslint.config.js'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import i18next from 'eslint-plugin-i18next'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments'
import eslintConfigPrettier from 'eslint-config-prettier'
import { noAdHocUi } from './eslint-rules/no-ad-hoc-ui.js'
import { noUntranslatedJsxText } from './eslint-rules/no-untranslated-jsx-text.js'

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
      'scripts/**', // node tooling scripts (e.g. i18n-todo.mjs) — outside the TS project
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
      'mythrun-ui': {
        rules: { 'no-ad-hoc-ui': noAdHocUi, 'no-untranslated-jsx-text': noUntranslatedJsxText },
      },
    },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: 'detect' } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
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
      '@eslint-community/eslint-comments/require-description': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // Test files legitimately render raw DOM probes: @testing-library tests
    // assert `textContent` of bare nodes addressed by `data-testid`, and they
    // exercise component-slot rendering (<Trans>) against real intrinsic
    // elements. `no-ad-hoc-ui` is a feature-code rule (already off in the
    // library zone); test harness markup is the same kind of exception, so we
    // carve test files out here — mirroring the root config's test-file
    // overrides — rather than peppering inline disables across every probe.
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'mythrun-ui/no-ad-hoc-ui': 'off',
    },
  },
  eslintConfigPrettier,
]
