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
      'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'mythrun/no-stripe-price-mutations': 'error',
      'mythrun/no-stripe-subscription-price-mutation': 'error',
    },
  },
  eslintConfigPrettier,
)
