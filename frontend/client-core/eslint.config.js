import root from '../../eslint.config.js'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
  ...root,
  {
    // client-core is platform-neutral (ZERO DOM): no intrinsic JSX elements
    // live here, so the jsx-a11y rails that ride alongside frontend/ui are not
    // registered. The DOM-purity lint (no className/style/CSSProperties/DOM
    // events on the contract) arrives in a later MYT-82 bead.
    //
    // `vitest.config.ts` default-exports `defineConfig(...)` (banned repo-wide
    // via the root config's no-default-export rule, which only ignores
    // `**/*.config.js` — not the `.ts` config). It's also outside this
    // package's TS project, so the root's type-aware projectService would
    // reject it. Ignored here, mirroring the `@mythrun/web` precedent.
    ignores: ['dist/**', 'vitest.config.ts'],
  },
  eslintConfigPrettier,
]
