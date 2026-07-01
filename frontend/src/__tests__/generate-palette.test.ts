import { describe, it, expect } from 'vitest'
import manifest from '../../ui/src/styles/tokens.manifest.json'

const c = manifest.colors as Record<string, string>

describe('generated palette — brand fidelity + shape', () => {
  it('declares exactly 170 color tokens (paper + ember + 4 semantic + 11 pigment ramps)', () => {
    expect(Object.keys(c)).toHaveLength(170)
  })
  it('emits a full per-hue ramp for every brand pigment (MYT-87 widened cover palette)', () => {
    // Each of the 11 non-hero pigments rides the same ladder; its authored mid-tone
    // lands on its nearest rung (verdigris-500 = the avatar pigment #3D6B60).
    expect(c['--color-verdigris-500']).toBe('#3D6B60')
    for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      expect(c[`--color-verdigris-${String(step)}`]).toBeDefined()
      expect(c[`--color-slate-${String(step)}`]).toBeDefined()
      expect(c[`--color-rose-${String(step)}`]).toBeDefined()
    }
  })
  it('reproduces paper verbatim + pins the recentered ember hero at step 500', () => {
    expect(c['--color-paper-100']).toBe('#EFE9DC')
    expect(c['--color-ember-500']).toBe('#8A5A3C')
    expect(c['--color-paper-900']).toBe('#231B12')
  })
  it('pins each semantic anchor to its exact brand hex (info anchors at 600)', () => {
    expect(c['--color-success-500']).toBe('#6D7A3E')
    expect(c['--color-warning-500']).toBe('#B07835')
    expect(c['--color-danger-500']).toBe('#c34c43')
    expect(c['--color-info-600']).toBe('#4A6B82')
  })
})
