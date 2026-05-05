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
        projectService: true,
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
