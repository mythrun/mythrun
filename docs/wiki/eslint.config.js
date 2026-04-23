import rootConfig from '../../eslint.config.js'

export default [
  ...rootConfig,
  {
    ignores: ['site/**', 'content/**', 'layout/**', 'diagrams/**', 'assets/**'],
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
