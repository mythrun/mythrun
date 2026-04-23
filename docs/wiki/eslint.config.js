import rootConfig from '../../eslint.config.js'

export default [
  ...rootConfig,
  {
    ignores: ['site/**', 'content/**', 'layout/**', 'diagrams/**', 'assets/**'],
  },
]
