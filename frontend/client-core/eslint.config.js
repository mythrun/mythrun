import root from '../../eslint.config.js'
import eslintConfigPrettier from 'eslint-config-prettier'
import { apiPurity } from './eslint-rules/api-purity.js'

export default [
  ...root,
  {
    // client-core is platform-neutral (ZERO DOM): no intrinsic JSX elements
    // live here, so the jsx-a11y rails that ride alongside frontend/ui are not
    // registered. The DOM-purity lint (no className/style/CSSProperties/DOM
    // events on the contract) is `mythrun-api/api-purity`, registered below.
    //
    // `vitest.config.ts` default-exports `defineConfig(...)` (banned repo-wide
    // via the root config's no-default-export rule, which only ignores
    // `**/*.config.js` — not the `.ts` config). It's also outside this
    // package's TS project, so the root's type-aware projectService would
    // reject it. Ignored here, mirroring the `@mythrun/web` precedent.
    //
    // `src/tokens/generate-palette.mjs` is a build-time Node script (relocated
    // from @mythrun/ui's `scripts/`, which was itself lint-ignored via
    // `scripts/**`). With no `allowJs`, `.mjs` falls outside this package's TS
    // `include`, so the type-aware projectService rejects it. Same carve-out.
    ignores: ['dist/**', 'vitest.config.ts', 'src/tokens/generate-palette.mjs'],
  },
  {
    // The ESLint tooling files (custom rule module + its wiring test) interface
    // with ESLint's deliberately-`any`-typed surfaces: `create(context)` rule
    // callbacks receive `any` AST nodes, and `ESLint.lintText` results are typed
    // loosely upstream. The root config's strictTypeChecked `no-unsafe-*` family
    // therefore fires on every member access here. This is an inherent property
    // of the ESLint plugin API, not unsafe app code — scope the relaxation to
    // this tooling directory, mirroring the @mythrun/web precedent.
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
    // R2 (portability): the public *Props contract surface must stay
    // platform-neutral — no className/style/CSSProperties/DOM-event props, no
    // HTMLAttributes inheritance. `@mythrun/ui` registers the SAME rule on its
    // `src/components/**` prop-widening (importing it from here, the base layer,
    // so the `client-core ← ui` dependency direction is preserved).
    files: ['src/contract/**/*.ts'],
    plugins: { 'mythrun-api': { rules: { 'api-purity': apiPurity } } },
    rules: { 'mythrun-api/api-purity': 'error' },
  },
  eslintConfigPrettier,
]
