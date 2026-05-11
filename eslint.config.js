import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const noStripePriceMutations = require('./backend/eslint-rules/no-stripe-price-mutations.cjs')
const noStripeSubscriptionPriceMutation = require('./backend/eslint-rules/no-stripe-subscription-price-mutation.cjs')

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
    },
  },
  {
    // Test-file override: max-lines-per-function fires on describe/it
    // callbacks because ESLint can't distinguish framework scaffolding
    // from production functions. The describe-it-each-test idiom
    // naturally has many lines and breaking it up purely for lint
    // compliance adds indirection without improving readability.
    // The rule still applies to production code where it carries signal.
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.cjs', '**/*.test.mjs'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  eslintConfigPrettier,
)
