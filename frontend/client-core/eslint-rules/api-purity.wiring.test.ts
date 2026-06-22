import assert from 'node:assert'
import { ESLint } from 'eslint'
import { describe, it, expect } from 'vitest'
import tseslint from 'typescript-eslint'
import { apiPurity } from './api-purity.js'

// ----------------------------------------------------------------------------
// Anti-silent-no-op guard (the MYT-79 `ignoreAttribute` lesson): an isolated
// ESLint run that PROVES the rule fires on a real violation and PASSES a clean
// input — driving it through ESLint's full lint pipeline the way the package
// configs do (not via RuleTester's direct-visitor path).
//
// This file loads the rule through ESLint's own config loader, which corrupts
// the v8 coverage map for the rule file (the vitest-v8 double-load gotcha), so
// `test:coverage` RUN-excludes `*.wiring.test.ts`. The rule's coverage is
// measured by the sibling `api-purity.test.ts` (RuleTester) instead; this file
// still runs (and is gated) under the plain `test` script in CI.
// ----------------------------------------------------------------------------
describe('api-purity — fire on violation (isolated, no type-aware build)', () => {
  function isolated(): ESLint {
    return new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        plugins: { 'mythrun-api': { rules: { 'api-purity': apiPurity } } },
        languageOptions: {
          parser: tseslint.parser,
          ecmaVersion: 2024,
          sourceType: 'module',
        },
        rules: { 'mythrun-api/api-purity': 'error' },
      },
    })
  }
  async function ids(code: string): Promise<(string | null)[]> {
    const [res] = await isolated().lintText(code, { filePath: 'fixture.ts' })
    if (!res) throw new Error('no lint result')
    return res.messages.map((m) => m.ruleId)
  }

  it('fires on className/CSSProperties/DOM-event/DOM-extends; silent on a clean prop surface', async () => {
    expect(await ids('export interface XProps { className?: string }\n')).toContain(
      'mythrun-api/api-purity',
    )
    expect(await ids('export interface XProps { style?: CSSProperties }\n')).toContain(
      'mythrun-api/api-purity',
    )
    expect(await ids('export interface XProps { onMouseEnter?: () => void }\n')).toContain(
      'mythrun-api/api-purity',
    )
    expect(
      await ids('export interface YProps extends HTMLAttributes<HTMLDivElement> {}\n'),
    ).toContain('mythrun-api/api-purity')
    expect(
      await ids(
        "export interface ZProps { variant?: 'a' | 'b'; onPress?: () => void; 'data-testid'?: string }\n",
      ),
    ).not.toContain('mythrun-api/api-purity')
    // The internal-helper exemption holds through the full pipeline too.
    expect(await ids('interface Internal { className?: string }\n')).not.toContain(
      'mythrun-api/api-purity',
    )
  })

  it('parses TS interface syntax (smoke: the parser is wired)', async () => {
    const [res] = await isolated().lintText('export interface XProps { className?: string }\n', {
      filePath: 'fixture.ts',
    })
    assert(res)
    expect(res.messages.length).toBeGreaterThan(0)
  })
})
