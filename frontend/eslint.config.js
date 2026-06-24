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
    //
    // The palette generator + nested-package config/build files are build-time
    // `.mjs`/`.ts` outside every tsconfig project, already eslint-ignored within
    // their own packages — but `@mythrun/web`'s `eslint .` (run from `frontend/`)
    // globs across the nested `ui/` and `client-core/` package dirs and would
    // otherwise hit them with the root config's type-aware projectService, the
    // same failure mode as `coverage/**`. Each nested package lints its own
    // `src/**`; web ignores only their out-of-project files here.
    // (The generator relocated to `client-core/src/tokens/` in MYT-82 F0b — the
    // former `ui/scripts/**` carve-out is gone with it.)
    ignores: [
      'dist/**',
      'coverage/**',
      'src/**/*.css',
      'index.html',
      'vite.config.ts',
      'vitest.config.ts',
      'scripts/**', // node tooling scripts (e.g. i18n-todo.mjs) — outside the TS project
      'client-core/vitest.config.ts',
      'client-core/src/tokens/generate-palette.mjs',
      // @mythrun/client-core's lint-tooling files (the api-purity rule + its
      // tests) live in `client-core/eslint-rules/**`. They are in client-core's
      // OWN TS project and carry client-core's `no-unsafe-*` relaxation (the
      // ESLint plugin API is inherently `any`-typed). web's `eslint .` globs
      // across the nested dir and would otherwise lint them under the root
      // config (no relaxation, and outside web's projectService) — same
      // out-of-project carve-out as the files above. client-core lints them.
      'client-core/eslint-rules/**',
      // @mythrun/ui's vitest config default-exports `defineConfig(...)` and is
      // outside web's TS project — same carve-out as client-core's. ui lints
      // it under its own package config. (`ui/.storybook/**` is a dot-dir,
      // auto-skipped by `eslint .`; its configs are linted within @mythrun/ui.)
      'ui/vitest.config.ts',
      'ui/storybook-static/**', // Storybook build output (gitignored artifact) — never lint it
      // @mythrun/ui's node tooling scripts (e.g. the story-coverage gate + its
      // vitest test) live in `ui/scripts/**`, outside web's TS project — same
      // out-of-project carve-out as web's own `scripts/**` above. ui lints them
      // under its own package config (where they are likewise eslint-ignored as
      // node tooling). Without this, web's `eslint .` globs across the nested
      // dir and the root config's type-aware projectService rejects them.
      'ui/scripts/**',
      // @mythrun/contract is a NodeNext-built package (W0a): its vitest config and
      // emitted `dist/**` are outside web's TS project, and the package lints itself.
      // Same out-of-project carve-out as client-core/ui above — without it, web's
      // `eslint .` globs the nested dir and the type-aware projectService rejects them.
      'contract/vitest.config.ts',
      'contract/dist/**',
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
    // R2/R5 (portability) — design-system import boundary, the enforceable-now
    // half (MYT-82 F0c4). The design system's internal building blocks
    // (radix-ui, CVA, tailwind-merge/clsx, the pixelarticons icon set) belong
    // INSIDE @mythrun/ui — they are how the library is built, not API for app /
    // feature code. App code composes the library's PUBLIC components; reaching
    // for these primitives in a feature means a one-off UI element that lives
    // outside the system (un-portable, R2). Deep imports into @mythrun/ui's
    // source (`@mythrun/ui/src/*`) bypass the package entry and couple app code
    // to the library's internal file layout, so they are banned too — import
    // from the package root `@mythrun/ui`.
    //
    // DEFERRED to MYT-83 (when feature directories + the component taxonomy
    // exist): the FULL "features may import UI only from an allowlist" rule and
    // the cross-feature-component boundary (no feature reaching into another
    // feature's components). Those need `eslint-plugin-import`'s
    // `no-restricted-paths` / `eslint-plugin-boundaries` keyed off the
    // not-yet-existing feature dir structure, so they can't be expressed today.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'radix-ui',
              message:
                "radix-ui is a design-system primitive. Build with it INSIDE @mythrun/ui; app/feature code imports the finished component from '@mythrun/ui'. (MYT-82 F0c4 import boundary.)",
            },
            {
              name: 'class-variance-authority',
              message:
                "class-variance-authority is a design-system internal. Variants live INSIDE @mythrun/ui; app/feature code imports the finished component from '@mythrun/ui'. (MYT-82 F0c4 import boundary.)",
            },
            {
              name: 'tailwind-merge',
              message:
                "tailwind-merge is a design-system internal. Class merging belongs INSIDE @mythrun/ui (cn()); app/feature code imports the finished component from '@mythrun/ui'. (MYT-82 F0c4 import boundary.)",
            },
            {
              name: 'clsx',
              message:
                "clsx is a design-system internal. Class composition belongs INSIDE @mythrun/ui (cn()); app/feature code imports the finished component from '@mythrun/ui'. (MYT-82 F0c4 import boundary.)",
            },
            {
              name: 'pixelarticons',
              message:
                "pixelarticons is the design-system's icon source. Icons are exposed as @mythrun/ui components; app/feature code imports those from '@mythrun/ui', not the raw icon set. (MYT-82 F0c4 import boundary.)",
            },
          ],
          patterns: [
            {
              group: ['@mythrun/ui/src/*', '@mythrun/ui/src/**'],
              message:
                "Deep imports into @mythrun/ui's source bypass the package entry and couple app code to the library's internal layout. Import from '@mythrun/ui'. (MYT-82 F0c4 import boundary.)",
            },
          ],
        },
      ],
    },
  },
  {
    // R1 (web side): `@mythrun/web` is the platform-agnostic app shell, with
    // ONE exception — `src/platform/web/**`, the place web-specific capability
    // impls live (storage, navigation, the live-event stream, …). Everywhere
    // else, a banned web global is a hard build break, not a style nit: the
    // brain and the routes must reach platform capability through a
    // `client-core` `platform/` interface (satisfied by an impl under
    // `platform/web/`), never a raw global. This mirrors client-core's own
    // `no-restricted-globals` (same 7 globals, same R1 messages). `fetch`/
    // `WebSocket` are deliberately NOT banned — they are universal (web + React
    // Native), so HTTP/socket transport may live anywhere. Carve-outs:
    // `src/platform/web/**` (the impls), `src/main.tsx` (the unavoidable
    // `document.getElementById` mount), and test files (jsdom render harnesses).
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/platform/web/**', 'src/main.tsx', 'src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'document',
          message:
            'DOM-free (R1): web app code may not touch the DOM. Reach platform capability through a client-core platform/ interface (impl under src/platform/web/).',
        },
        {
          name: 'window',
          message:
            'DOM-free (R1): web app code may not reference window. Reach platform capability through a client-core platform/ interface (impl under src/platform/web/).',
        },
        {
          name: 'localStorage',
          message:
            'DOM-free (R1): web app code may not use localStorage. Reach persistence through a client-core platform/ storage interface (impl under src/platform/web/).',
        },
        {
          name: 'sessionStorage',
          message:
            'DOM-free (R1): web app code may not use sessionStorage. Reach persistence through a client-core platform/ storage interface (impl under src/platform/web/).',
        },
        {
          name: 'location',
          message:
            'DOM-free (R1): web app code may not reference location. Reach navigation/URL state through a client-core platform/ interface (impl under src/platform/web/).',
        },
        {
          name: 'navigator',
          message:
            'DOM-free (R1): web app code may not reference navigator. Reach device/runtime capability through a client-core platform/ interface (impl under src/platform/web/).',
        },
        {
          name: 'EventSource',
          message:
            'DOM-free (R1): web app code may not use EventSource. Reach the live-event stream through a client-core platform/ interface (impl under src/platform/web/).',
        },
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
