import assert from 'node:assert'
import { ESLint } from 'eslint'
import { describe, it, expect } from 'vitest'
import tseslint from 'typescript-eslint'
import { noAdHocColor } from './no-ad-hoc-color.js'

// ----------------------------------------------------------------------------
// Anti-silent-no-op guard (the MYT-79 `ignoreAttribute` lesson): an isolated
// ESLint run that PROVES the rule fires on real violations and PASSES clean
// inputs — driving it through ESLint's full lint pipeline the way the package
// configs do (not via RuleTester's direct-visitor path).
//
// THE HEADLINE CASE: a color literal lives inside a `cva({...})` config call,
// NOT in a JSX `className` attribute. A `JSXAttribute`-only matcher would
// silently miss the shadcn/CVA pattern (the exact gap this rule closes). The
// invalid `cva` case below fails iff the rule scans every string literal, not
// just JSX attributes.
//
// This file loads the rule through ESLint's own config loader, which corrupts
// the v8 coverage map for the rule file (the vitest-v8 double-load gotcha), so
// `test:coverage` RUN-excludes `*.wiring.test.ts`. The rule's coverage is
// measured by the sibling `no-ad-hoc-color.test.ts` (RuleTester) instead; this
// file still runs (and is gated) under the plain `test` script in CI.
// ----------------------------------------------------------------------------
describe('no-ad-hoc-color — fire on violation (isolated, no type-aware build)', () => {
  function isolated(): ESLint {
    return new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.tsx'],
        plugins: { 'mythrun-ui': { rules: { 'no-ad-hoc-color': noAdHocColor } } },
        languageOptions: {
          parser: tseslint.parser,
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { 'mythrun-ui/no-ad-hoc-color': 'error' },
      },
    })
  }
  async function ids(code: string): Promise<(string | null)[]> {
    const [res] = await isolated().lintText(code, { filePath: 'fixture.tsx' })
    if (!res) throw new Error('no lint result')
    return res.messages.map((m) => m.ruleId)
  }

  it('fires on raw color in className, INSIDE cva(), and inline style; silent on token classes', async () => {
    // INVALID — arbitrary-value color utility in a JSX className attribute.
    expect(
      await ids('export const A = () => <div className="bg-[#abc]" />\n'),
    ).toContain('mythrun-ui/no-ad-hoc-color')

    // INVALID — THE HEADLINE: a hex color literal nested inside a cva() config.
    // A JSXAttribute-only rule would miss this entirely.
    expect(
      await ids(
        "export const v = cva({ variants: { tone: { x: 'text-[#fff]' } } })\n",
      ),
    ).toContain('mythrun-ui/no-ad-hoc-color')

    // INVALID — a raw rgb()/hex function-call literal inside a cva() config.
    expect(
      await ids(
        "export const v = cva({ variants: { tone: { x: 'rgb(0,0,0)' } } })\n",
      ),
    ).toContain('mythrun-ui/no-ad-hoc-color')

    // INVALID — inline style with a hex color string.
    expect(
      await ids("export const C = () => <div style={{ color: '#abc' }} />\n"),
    ).toContain('mythrun-ui/no-ad-hoc-color')

    // VALID — token utility class in className.
    expect(
      await ids('export const A = () => <div className="bg-ember-600" />\n'),
    ).not.toContain('mythrun-ui/no-ad-hoc-color')

    // VALID — token utilities INSIDE a cva() config (the supported pattern).
    expect(
      await ids(
        "export const v = cva({ variants: { tone: { x: 'bg-ember-600 text-ink' } } })\n",
      ),
    ).not.toContain('mythrun-ui/no-ad-hoc-color')

    // VALID — a non-color arbitrary value (must NOT be flagged as a color).
    expect(
      await ids('export const A = () => <div className="w-[32px]" />\n'),
    ).not.toContain('mythrun-ui/no-ad-hoc-color')

    // VALID — a CSS var() token reference in inline style is a TOKEN, not raw.
    expect(
      await ids("export const C = () => <div style={{ color: 'var(--color-ink)' }} />\n"),
    ).not.toContain('mythrun-ui/no-ad-hoc-color')
  })

  it('parses TSX syntax (smoke: the JSX parser is wired)', async () => {
    const [res] = await isolated().lintText(
      'export const A = () => <div className="bg-[#abc]" />\n',
      { filePath: 'fixture.tsx' },
    )
    assert(res)
    expect(res.messages.length).toBeGreaterThan(0)
  })
})
