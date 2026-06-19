import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import { noUntranslatedJsxText } from './no-untranslated-jsx-text.js'

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

ruleTester.run('no-untranslated-jsx-text', noUntranslatedJsxText, {
  valid: [
    { code: 'const A = () => <Text>{t("k")}</Text>' }, // t() call
    { code: 'const A = () => <Text>{count}</Text>' }, // expression child
    { code: 'const A = () => <Text>{42}</Text>' }, // numeric literal child
    { code: 'const A = () => <Text>{`${x}`}</Text>' }, // interpolation-only template
    { code: 'const A = () => <Trans>hi</Trans>' }, // Trans owns JSXText
    { code: 'const A = () => <Trans><b>hi</b></Trans>' }, // Trans ancestor (nested)
    { code: 'const A = () => <Trans>{"hi"}</Trans>' }, // Trans ancestor, string container
    { code: 'const A = () => <Trans>{`hi`}</Trans>' }, // Trans ancestor, template container
    { code: 'const A = () => <Widget label={"hi"} />' }, // attribute literal — not a child
    { code: 'const A = () => <Stack>\n  {t("k")}\n</Stack>' }, // whitespace JSXText around t()
  ],
  invalid: [
    { code: 'const A = () => <Text>hi</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <>hi</>', errors: [{ messageId: 'bareText' }] }, // fragment root
    { code: 'const A = () => <Text>{"hi"}</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <Text>{`hi`}</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <Text>{`hi ${x}`}</Text>', errors: [{ messageId: 'bareText' }] },
  ],
})
