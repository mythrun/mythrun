import root from '../../eslint.config.js'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
  ...root,
  {
    // This is a BUILT package (real `tsc` emit to `dist/`), distinct from the
    // raw-`.ts`-export frontend packages. `dist/**` is generated output.
    //
    // `vitest.config.ts` default-exports `defineConfig(...)` (banned repo-wide
    // by the root config's no-default-export rule, which only ignores
    // `**/*.config.js` — not the `.ts` config), and is outside this package's
    // TS project (which excludes `*.test.ts` + config files), so the root's
    // type-aware projectService would reject it. Ignored here, mirroring the
    // @mythrun/client-core + @mythrun/ui precedent.
    //
    // This package has no UI / contract-prop concerns, so — unlike client-core
    // and ui — it registers no `mythrun-api` / `mythrun-ui` portability plugins.
    ignores: ['dist/**', 'vitest.config.ts'],
  },
  eslintConfigPrettier,
]
