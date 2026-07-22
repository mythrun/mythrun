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
    // MYT-100: the rail rides in @mythrun/ui now, where DS components render their
    // text FROM PROPS. A member-expression child (`{props.label}`) is the canonical
    // library shape and must NOT be flagged — the rule is expression-agnostic (it
    // targets string literals + static templates only), not t()-whitelisting.
    { code: 'const A = (props) => <Text>{props.label}</Text>' }, // DS prop (member expr)
    { code: 'const A = () => <Text>{42}</Text>' }, // numeric literal child
    { code: 'const A = () => <Text>{`${x}`}</Text>' }, // interpolation-only template
    { code: 'const A = () => <Trans>hi</Trans>' }, // Trans owns JSXText
    { code: 'const A = () => <Trans><b>hi</b></Trans>' }, // Trans ancestor (nested)
    { code: 'const A = () => <Trans>{"hi"}</Trans>' }, // Trans ancestor, string container
    { code: 'const A = () => <Trans>{`hi`}</Trans>' }, // Trans ancestor, template container
    { code: 'const A = () => <Widget label={"hi"} />' }, // attribute literal — not a child
    { code: 'const A = () => <Stack>\n  {t("k")}\n</Stack>' }, // whitespace JSXText around t()
    { code: "const A = () => <Text>{' '}</Text>" }, // {' '} spacing idiom — whitespace, not copy
    // MYT-100 aria-hidden exemption: presentational glyphs (decorative
    // chevrons/arrows/separators) that AT never reads and copy never translates.
    { code: 'const A = () => <span aria-hidden="true">‹</span>' }, // string form
    { code: 'const A = () => <span aria-hidden={true}>→</span>' }, // boolean form
    { code: 'const A = () => <span aria-hidden>·</span>' }, // bare (React coerces to true)
    { code: 'const A = () => <span aria-hidden="true">{"→"}</span>' }, // literal child under aria-hidden
    { code: 'const A = () => <div aria-hidden="true"><b>hi</b></div>' }, // nested descendant of aria-hidden
  ],
  invalid: [
    { code: 'const A = () => <Text>hi</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <>hi</>', errors: [{ messageId: 'bareText' }] }, // fragment root
    { code: 'const A = () => <Text>{"hi"}</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <Text>{`hi`}</Text>', errors: [{ messageId: 'bareText' }] },
    { code: 'const A = () => <Text>{`hi ${x}`}</Text>', errors: [{ messageId: 'bareText' }] },
    // MYT-100: aria-hidden exemption checks the VALUE, not mere presence —
    // aria-hidden="false" is exposed content and stays flagged.
    { code: 'const A = () => <span aria-hidden="false">hi</span>', errors: [{ messageId: 'bareText' }] },
    // MYT-100: <VisuallyHidden> is the OPPOSITE of aria-hidden — its text IS read
    // by assistive tech (real screen-reader copy), so it stays a violation
    // (belongs in a prop/i18n key), not an exemption.
    { code: 'const A = () => <VisuallyHidden>(required)</VisuallyHidden>', errors: [{ messageId: 'bareText' }] },
  ],
})
