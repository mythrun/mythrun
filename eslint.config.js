import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const noStripePriceMutations = require('./backend/eslint-rules/no-stripe-price-mutations.cjs')
const noStripeSubscriptionPriceMutation = require('./backend/eslint-rules/no-stripe-subscription-price-mutation.cjs')
const noRawDbAccess = require('./backend/eslint-rules/no-raw-db-access.cjs')

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'docs/wiki/site/**',
      'docs/superpowers/**',
      'docs/specs/**',
      '.beads/**',
      '**/*.config.js',
      // The banned-pattern fixture is the *only* file that should fail
      // the no-stripe-price-mutations rule. The config-wiring smoke test
      // (eslint-rules/__tests__/config-wiring.test.cjs) lints it
      // explicitly with --no-ignore. Excluding it here keeps `pnpm lint`
      // clean.
      'backend/eslint-rules/__tests__/fixtures/**',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: {
      mythrun: {
        rules: {
          'no-stripe-price-mutations': noStripePriceMutations,
          'no-stripe-subscription-price-mutation': noStripeSubscriptionPriceMutation,
          'no-raw-db-access': noRawDbAccess,
        },
      },
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          // Files outside the TS project (banned-pattern fixtures used by
          // the config-wiring smoke test) get the default fallback project
          // so the parser doesn't reject them outright. The mythrun rules
          // fire on AST shape and don't need type info.
          allowDefaultProject: ['backend/eslint-rules/__tests__/fixtures/banned.fixture.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Default exports are forbidden. Use named exports only.',
        },
      ],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      // Threshold bumped from the eslint default of 50 to 100 — the
      // 50-line default is unrealistic for this codebase's idioms
      // (transaction scripts, Fastify plugin registration bodies, ECS
      // event handlers, repo namespace factories with N methods).
      // 100 still flags genuine "this function is doing too much"
      // (multi-branch handlers, long async procedures); below 100 the
      // signal-to-noise drops too low to act on warnings.
      'max-lines-per-function': ['warn', { max: 100, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'mythrun/no-stripe-price-mutations': 'error',
      'mythrun/no-stripe-subscription-price-mutation': 'error',
      // Data-layer repository unification: ban raw DB access outside the
      // repo/db layer. The migration is complete — every production consumer
      // goes through `repo.X` / `repo.transaction`, so the rule is now an
      // ERROR (a raw-DB site outside the repo/db layer is a BUILD FAILURE,
      // the refactor's enforcement guarantee). The allowlist lives INSIDE the
      // rule (reads context.filename) to exempt the repo/db layer + boot
      // entrypoints; test files are carved out via the per-file override
      // below (legitimate seed/probe SQL).
      'mythrun/no-raw-db-access': 'error',
      // myth-t1qz: direct 'ai' SDK imports are banned across the repo.
      // The canonical entry point is `backend/src/llm/ai.ts` — its
      // `generateObject` / `streamObject` wrap the SDK with repair-fallback
      // and structured diagnostic logging on schema-mismatch failures.
      // Allowed importers (whitelisted via per-file override below):
      //   - backend/src/llm/ai.ts (the wrapper itself)
      //   - backend/src/llm/models.ts (constructs the LanguageModel; needs
      //     `wrapLanguageModel` and would cycle through the wrapper)
      //   - backend/src/llm/prep/structured-output-repair.ts (the repair
      //     helper the wrapper CALLS; cannot route back through the wrapper)
      // Test files may keep direct `vi.mock('ai', ...)` for SDK mocking.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'ai',
              message:
                "Direct 'ai' imports are banned. Use backend/src/llm/ai.ts (the canonical wrapper). See myth-t1qz.",
            },
          ],
        },
      ],
    },
  },
  {
    // Whitelist the three files that must import 'ai' directly.
    // The wrapper itself + the repair helper it depends on + the model
    // constructor (wrapLanguageModel callsite). Adding new entries here
    // requires a strong justification — the wrapper subsumes every other
    // schema-validated call pattern.
    files: [
      'backend/src/llm/ai.ts',
      'backend/src/llm/models.ts',
      'backend/src/llm/prep/structured-output-repair.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Test-file override: max-lines-per-function fires on describe/it
    // callbacks because ESLint can't distinguish framework scaffolding
    // from production functions. The describe-it-each-test idiom
    // naturally has many lines and breaking it up purely for lint
    // compliance adds indirection without improving readability.
    // The rule still applies to production code where it carries signal.
    //
    // Tests may also `vi.mock('ai', ...)` and import SDK types directly
    // for mock factories. Disable no-restricted-imports for test files.
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.cjs', '**/*.test.mjs'],
    rules: {
      'max-lines-per-function': 'off',
      'no-restricted-imports': 'off',
      // no-raw-db-access carve-out for test files: integration tests
      // legitimately seed prerequisite rows via raw `pool.query` (and use
      // `redis.connect`); forcing repo.X there would be circular — the repo
      // layer is the thing under test, and seed/probe SQL sets up state that
      // doesn't map to a public repo method. The ~606 test-file raw-DB
      // warnings were all verified during the data-layer refactor to be
      // legitimate seed/probe SQL (zero production false-positives). This
      // per-file carve-out matches the T4-review recommendation.
      'mythrun/no-raw-db-access': 'off',
    },
  },
  {
    // myth-oehx Phase 5: test-isolation invariants.
    //
    // - with-tx and reset-data are deleted; importing them is a stale ref.
    // - DROP SCHEMA SQL in test files races against parallel workers
    //   sharing one mythrun_test DB. globalSetup runs migrations once per
    //   worker process; per-file beforeAll blocks are obsolete.
    //
    // The bans here override the broad no-restricted-imports disable
    // above by re-enabling the rule with targeted patterns.
    files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/_helpers/with-tx', '**/_helpers/with-tx.js'],
              message:
                'with-tx was deleted in myth-oehx. Use scoped fixtures (cleanupTestScope) instead. See backend/src/__tests__/CONVENTIONS.md.',
            },
            {
              group: ['**/_helpers/reset-data', '**/_helpers/reset-data.js'],
              message:
                'reset-data was deleted in myth-oehx. Schema bootstrap is in globalSetup; data isolation via scoped fixtures. See backend/src/__tests__/CONVENTIONS.md.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Default exports are forbidden. Use named exports only.',
        },
        {
          selector: "Literal[value=/DROP\\s+SCHEMA/i]",
          message:
            'DROP SCHEMA in tests is forbidden — globalSetup handles schema bootstrap. See backend/src/__tests__/CONVENTIONS.md.',
        },
        {
          selector: "TemplateElement[value.raw=/DROP\\s+SCHEMA/i]",
          message:
            'DROP SCHEMA in tests is forbidden — globalSetup handles schema bootstrap.',
        },
      ],
    },
  },
  eslintConfigPrettier,
)
