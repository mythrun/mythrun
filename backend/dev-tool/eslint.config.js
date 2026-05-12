import root from '../../eslint.config.js'

export default [
  ...root,
  {
    // vite.config.ts requires a default export by framework convention;
    // exclude it from the root config's no-default-export rule.
    ignores: ['src/**/*.css', 'index.html', 'node_modules/**', 'vite.config.ts'],
  },
]
