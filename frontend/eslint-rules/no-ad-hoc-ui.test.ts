import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import { noAdHocUi } from './no-ad-hoc-ui.js'

// Wire ESLint's RuleTester to Vitest's runner so each case is a real test
// AND the rule module is instrumented for coverage.
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

ruleTester.run('no-ad-hoc-ui', noAdHocUi, {
  valid: [
    { code: 'const A = () => <Text>hi</Text>' }, // component element
    { code: 'const A = () => <><Text>hi</Text></>' }, // fragment
    { code: 'const A = () => <Ns.Comp />' }, // member-expression element
    { code: 'const A = () => <Text id="x">hi</Text>' }, // non-style/className attr
    { code: 'const A = () => <Text xml:lang="en">hi</Text>' }, // namespaced attr (guard branch)
  ],
  invalid: [
    { code: 'const A = () => <div>hi</div>', errors: [{ messageId: 'rawElement' }] },
    { code: 'const A = () => <Text style={{}}>hi</Text>', errors: [{ messageId: 'styleAttr' }] },
    {
      code: 'const A = () => <Text className="x">hi</Text>',
      errors: [{ messageId: 'classNameAttr' }],
    },
  ],
})
