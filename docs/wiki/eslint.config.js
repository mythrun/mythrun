import rootConfig from '../../eslint.config.js'

export default [
  ...rootConfig,
  {
    ignores: [
      // Glob `site*` covers stale generated output (`site 2/`, `site 4/`,
      // etc.) — Docusaurus produces a numeric-suffixed copy when it can't
      // replace `site/` (e.g., a finder window holds it open).
      'site*/**',
      'content/**',
      'layout/**',
      'diagrams/**',
      'assets/**',
      'build/__tests__/fixtures/**',
    ],
  },
  {
    // describe(...) arrow functions naturally exceed the function-size cap
    // because every it(...) block nests inside them. Scope the waiver to tests.
    files: ['**/__tests__/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
]
