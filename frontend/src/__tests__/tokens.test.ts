import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import manifest from '../../ui/src/styles/tokens.manifest.json'

const stylesDir = resolve(__dirname, '../../ui/src/styles')
const css = ['colors.generated.css', 'theme.css', 'semantic.css']
  .map((f) => readFileSync(resolve(stylesDir, f), 'utf8'))
  .join('\n')

describe('token presence (manifest-driven)', () => {
  it('declares every manifest color token in the source CSS', () => {
    for (const name of Object.keys(manifest.colors)) {
      expect(css).toContain(`${name}:`)
    }
  })
  it('every semantic alias has both a :root and a .dark value', () => {
    const aliases = ['--bg', '--surface', '--border', '--ink', '--ink-secondary', '--ink-tertiary',
      '--accent', '--accent-hover', '--success', '--warning', '--danger', '--info']
    const darkStart = css.indexOf('.dark {')
    const darkBlock = css.slice(darkStart, css.indexOf('}', darkStart))
    for (const a of aliases) {
      expect(css).toContain(`${a}:`)        // declared (in :root)
      expect(darkBlock).toContain(`${a}:`)  // overridden under .dark
    }
  })
})

describe('dark-flip mechanic is intact', () => {
  it('@theme inline surfaces each alias as a var-reference (so .dark cascades)', () => {
    // Structural proof of the load-bearing v4 pattern: the inline block must
    // map --color-bg → var(--bg), NOT inline the paper value. If someone
    // "simplifies" semantic.css to a plain @theme alias, this fails.
    const semantic = readFileSync(resolve(stylesDir, 'semantic.css'), 'utf8')
    expect(semantic).toMatch(/@theme inline/)
    expect(semantic).toMatch(/--color-bg:\s*var\(--bg\)/)
    expect(semantic).toMatch(/--color-ink:\s*var\(--ink\)/)
  })
  // NOTE: a jsdom-runtime `it` was specified that asserts an element reading
  // var(--bg) flips when .dark sets --bg. jsdom 25.0.1's getComputedStyle does
  // NOT resolve even single-level var() — it returns the literal string
  // 'var(--bg)' for both light and dark, so the flip cannot be observed in
  // jsdom and the assertion is undecidable here. Per the T5 plan note it was
  // removed rather than weakened into an always-true assertion. The structural
  // `@theme inline` test above is the load-bearing regression guard; the real
  // dark-flip is verified in the actual Tailwind build (T1–T4).
})
