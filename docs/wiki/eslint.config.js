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
  {
    // no-raw-db-access carve-out for the wiki schema-extractor build tooling.
    // schemaExtractor.ts / applyMigrations.ts connect to a throwaway Postgres
    // schema, apply the backend migrations, and introspect information_schema
    // / pg_catalog to generate the wiki's schema reference page. This is
    // build-time DDL introspection in the @mythrun/wiki package — it owns its
    // own short-lived pool by necessity and cannot (and must not) route through
    // the backend repo layer, which is a different package exposing application
    // data methods, not schema introspection. Analogous to the rule's existing
    // exemption for backend boot entrypoints (server.ts/worker.ts) that own a
    // pool. The rule (now at ERROR) firing here was an over-reach onto build
    // tooling, not a missed production migration — backend src/ is 0/0 clean.
    files: ['build/**/*.ts'],
    rules: {
      'mythrun/no-raw-db-access': 'off',
    },
  },
]
