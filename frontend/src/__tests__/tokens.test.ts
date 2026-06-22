import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import manifest from '../../ui/src/styles/tokens.manifest.json'
import {
  SPACING, RADIUS, CONTROL, ICON, ZINDEX, MOTION,
  WEIGHTS, TRACKING, MEASURE, BREAKPOINTS,
} from '@mythrun/client-core/tokens/scales'

const stylesDir = resolve(__dirname, '../../ui/src/styles')
const themeCss = readFileSync(resolve(stylesDir, 'theme.css'), 'utf8')
const semanticCss = readFileSync(resolve(stylesDir, 'semantic.css'), 'utf8')
const css = ['colors.generated.css', 'theme.css', 'semantic.css']
  .map((f) => readFileSync(resolve(stylesDir, f), 'utf8'))
  .join('\n')

/** Pull `--name: value;` declarations from a CSS string into a map. */
function declMap(source: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = m
    if (name !== undefined && value !== undefined) out[name] = value.trim()
  }
  return out
}

describe('token presence (manifest-driven)', () => {
  it('declares every manifest color token in the source CSS', () => {
    for (const name of Object.keys(manifest.colors)) {
      expect(css).toContain(`${name}:`)
    }
  })
  it('every semantic alias has both a :root and a .dark value', () => {
    const aliases = ['--bg', '--surface', '--border', '--ink', '--ink-secondary', '--ink-tertiary',
      '--accent', '--accent-hover', '--success', '--warning', '--danger', '--info',
      // --surface family extends the shipped alias (theme-aware tiers, §4)
      '--surface-raised', '--surface-overlay', '--surface-hover',
      // modal scrim — the theme-aware dimming veil behind an overlay (§3/§4)
      '--scrim',
      // interactive control boundary + theme-aware focus ring color
      '--border-strong', '--focus-ring-color', '--accent-active',
      // status-intent triplets (theme-aware, AA-verified)
      '--surface-success', '--border-success', '--text-success',
      '--surface-warning', '--border-warning', '--text-warning',
      '--surface-danger', '--border-danger', '--text-danger',
      '--surface-info', '--border-info', '--text-info']
    const darkStart = css.indexOf('.dark {')
    const darkBlock = css.slice(darkStart, css.indexOf('}', darkStart))
    for (const a of aliases) {
      expect(css).toContain(`${a}:`)        // declared (in :root)
      expect(darkBlock).toContain(`${a}:`)  // overridden under .dark
    }
  })
})

describe('static scale tokens (emitted to web @theme, sourced from scales.ts)', () => {
  it('declares the representative static tokens', () => {
    for (const name of ['--space-4', '--radius', '--control-md', '--icon-md', '--z-modal',
      '--ease-out', '--tracking-wide', '--measure', '--weight-semibold', '--breakpoint-lg']) {
      expect(themeCss).toContain(`${name}:`)
    }
  })
})

describe('static scale drift guard (theme.css MUST equal scales.ts)', () => {
  const t = declMap(themeCss)

  it('spacing', () => {
    for (const [k, v] of Object.entries(SPACING)) expect(t[`--space-${k}`]).toBe(v)
  })
  it('radius', () => {
    expect(t['--radius']).toBe(RADIUS.DEFAULT)
  })
  it('control heights', () => {
    for (const [k, v] of Object.entries(CONTROL)) expect(t[`--control-${k}`]).toBe(v)
  })
  it('icon sizes', () => {
    for (const [k, v] of Object.entries(ICON)) expect(t[`--icon-${k}`]).toBe(v)
  })
  it('z-index', () => {
    for (const [k, v] of Object.entries(ZINDEX)) expect(t[`--z-${k}`]).toBe(String(v))
  })
  it('motion durations + easings', () => {
    for (const [k, v] of Object.entries(MOTION.duration)) expect(t[`--duration-${k}`]).toBe(v)
    for (const [k, v] of Object.entries(MOTION.easing)) expect(t[`--ease-${k}`]).toBe(v)
  })
  it('weights / tracking / measure / breakpoints', () => {
    for (const [k, v] of Object.entries(WEIGHTS)) expect(t[`--weight-${k}`]).toBe(String(v))
    for (const [k, v] of Object.entries(TRACKING)) expect(t[`--tracking-${k}`]).toBe(v)
    expect(t['--measure']).toBe(MEASURE.DEFAULT)
    for (const [k, v] of Object.entries(BREAKPOINTS)) expect(t[`--breakpoint-${k}`]).toBe(v)
  })
})

describe('flat 1-bit design language (§3): shadows removed', () => {
  it('no --shadow-* tokens survive', () => {
    expect(css).not.toContain('--shadow-soft')
    expect(css).not.toContain('--shadow-float')
  })
})

describe('theme-aware semantic tokens (§4/§5)', () => {
  it('focus ring is a hard square outline keyed to the accent', () => {
    expect(semanticCss).toContain('--focus-ring-width:')
    expect(semanticCss).toContain('--focus-ring-offset:')
    expect(semanticCss).toMatch(/--focus-ring-color:\s*var\(--accent\)/)
  })
  it('@theme inline surfaces the new theme-aware aliases as var-references', () => {
    for (const name of ['--color-border-strong', '--color-surface-raised', '--color-text-danger']) {
      expect(semanticCss).toContain(name)
    }
  })
})

describe('dark-flip mechanic is intact', () => {
  it('@theme inline surfaces each alias as a var-reference (so .dark cascades)', () => {
    // Structural proof of the load-bearing v4 pattern: the inline block must
    // map --color-bg → var(--bg), NOT inline the paper value. If someone
    // "simplifies" semantic.css to a plain @theme alias, this fails.
    expect(semanticCss).toMatch(/@theme inline/)
    expect(semanticCss).toMatch(/--color-bg:\s*var\(--bg\)/)
    expect(semanticCss).toMatch(/--color-ink:\s*var\(--ink\)/)
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
