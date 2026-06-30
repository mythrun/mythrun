import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  WORLD_COLORS,
  WORLD_COLOR_PIGMENTS,
  WORLD_COLOR_RAMP_STEPS,
} from '@mythrun/contract'
import {
  WORLD_COLOR_HEX,
  relativeLuminance,
  contrastRatio,
  CONTRAST_FLOOR,
} from '../world-color-palette.js'

// The frontend palette is the source of truth for every hex this backend table
// hand-authors. Rather than import across the package boundary (the manifest is
// a sibling package's build asset; @mythrun/client-core pulls in react), the
// drift guard reads both source files as TEXT and regex-extracts the hexes —
// the same posture as frontend/src/__tests__/tokens.test.ts's CSS `declMap`.
const repoRoot = resolve(__dirname, '../../../../..')
const manifestText = readFileSync(
  resolve(repoRoot, 'frontend/ui/src/styles/tokens.manifest.json'),
  'utf8',
)
const scalesText = readFileSync(
  resolve(repoRoot, 'frontend/client-core/src/tokens/scales.ts'),
  'utf8',
)

/** `"--color-<name>": "#HEX"` pairs from the generated tokens manifest JSON. */
function manifestColors(json: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of json.matchAll(/"(--color-[\w-]+)":\s*"(#[0-9A-Fa-f]{6})"/g)) {
    const [, name, hex] = m
    if (name !== undefined && hex !== undefined) out[name] = hex
  }
  return out
}

/** `<name>: '#HEX'` pairs from the AVATAR_COLORS block in scales.ts. */
function avatarColors(ts: string): Record<string, string> {
  const block = /AVATAR_COLORS\s*=\s*\{([\s\S]*?)\}/.exec(ts)?.[1]
  if (block === undefined) throw new Error('AVATAR_COLORS block not found in scales.ts')
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)) {
    const [, name, hex] = m
    if (name !== undefined && hex !== undefined) out[name] = hex
  }
  return out
}

const MANIFEST = manifestColors(manifestText)
const PIGMENTS = avatarColors(scalesText)

describe('WORLD_COLOR_HEX drift guard (frontend palette is the source of truth)', () => {
  it('covers every WorldColor member exactly once', () => {
    expect(Object.keys(WORLD_COLOR_HEX).sort()).toEqual([...WORLD_COLORS].sort())
  })

  it('the 12 pigments equal scales.ts AVATAR_COLORS', () => {
    for (const name of WORLD_COLOR_PIGMENTS) {
      expect(PIGMENTS[name]).toBeDefined()
      expect(WORLD_COLOR_HEX[name].toLowerCase()).toBe(PIGMENTS[name]?.toLowerCase())
    }
  })

  it('the 8 ramp steps equal the tokens manifest', () => {
    for (const step of WORLD_COLOR_RAMP_STEPS) {
      const key = `--color-${step}`
      expect(MANIFEST[key]).toBeDefined()
      expect(WORLD_COLOR_HEX[step].toLowerCase()).toBe(MANIFEST[key]?.toLowerCase())
    }
  })
})

describe('relativeLuminance (sRGB → linear + Rec.709)', () => {
  it('is ~1 for white and ~0 for black', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
  })
})

describe('contrastRatio + CONTRAST_FLOOR (the world-cover legibility guard)', () => {
  it('passes a pale-paper ↔ dark-pigment pair', () => {
    expect(contrastRatio('paper-100', 'ember-900')).toBeGreaterThanOrEqual(CONTRAST_FLOOR)
  })

  it('fails a near-equiluminant pigment ↔ pigment pair', () => {
    // sienna 4.73:1 / ochre 4.82:1 on paper-50 — almost identical luminance, so
    // their mutual contrast (~1.0) is illegible. The review flagged this exact
    // failure mode; the floor must reject it.
    expect(contrastRatio('sienna', 'ochre')).toBeLessThan(CONTRAST_FLOOR)
  })
})
