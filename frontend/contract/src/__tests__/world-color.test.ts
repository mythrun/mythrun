import { describe, it, expect } from 'vitest'
import {
  WORLD_COLORS,
  WORLD_COLOR_RAMPS,
  WORLD_COLOR_STEPS,
  WorldColorSchema,
  WorldColorPairSchema,
  worldColorCssVar,
  worldColorStep,
  worldColorHue,
  rungsApart,
  reInkPair,
} from '../rest/index.js'

describe('@mythrun/contract WorldColor', () => {
  describe('WORLD_COLORS — the widened per-hue ramp cover set', () => {
    it('is the full 13 ramps × 10 steps grid (130 members)', () => {
      expect(WORLD_COLORS).toHaveLength(130)
      expect(WORLD_COLOR_RAMPS).toHaveLength(13)
      expect(WORLD_COLOR_STEPS).toHaveLength(10)
    })

    it('includes chromatic ramp tokens (verdigris-200, rose-800)', () => {
      expect(WORLD_COLORS).toContain('verdigris-200')
      expect(WORLD_COLORS).toContain('rose-800')
    })

    it('EXCLUDES the semantic ramps (a cover is decorative, never a UI-state signal)', () => {
      for (const semantic of ['success-500', 'warning-500', 'danger-500', 'info-500']) {
        expect(WORLD_COLORS).not.toContain(semantic)
      }
    })

    it('has one member per (ramp, step) cell — no duplicates, no gaps', () => {
      const expected = WORLD_COLOR_RAMPS.flatMap((ramp) =>
        WORLD_COLOR_STEPS.map((step) => `${ramp}-${String(step)}`),
      )
      expect([...WORLD_COLORS]).toEqual(expected)
      expect(new Set(WORLD_COLORS).size).toBe(130)
    })
  })

  describe('WorldColorSchema', () => {
    it('accepts every member of the widened set', () => {
      for (const name of WORLD_COLORS) {
        expect(WorldColorSchema.parse(name)).toBe(name)
      }
    })

    it('rejects a semantic ramp step, a bare pigment, and an arbitrary string', () => {
      expect(() => WorldColorSchema.parse('success-500')).toThrow()
      // A bare pigment (`sienna`) is no longer a member — every token is `hue-step`.
      expect(() => WorldColorSchema.parse('sienna')).toThrow()
      expect(() => WorldColorSchema.parse('not-a-color')).toThrow()
    })
  })

  describe('WorldColorPairSchema', () => {
    it('parses a valid { from, to } pair', () => {
      const parsed = WorldColorPairSchema.parse({ from: 'sienna-100', to: 'pine-800' })
      expect(parsed).toEqual({ from: 'sienna-100', to: 'pine-800' })
    })

    it('rejects a pair whose end is off-enum', () => {
      expect(() => WorldColorPairSchema.parse({ from: 'danger-500', to: 'pine-800' })).toThrow()
      expect(() => WorldColorPairSchema.parse({ from: 'sienna-100', to: 'chartreuse' })).toThrow()
    })
  })

  describe('worldColorCssVar — every member is a standard ramp token', () => {
    it('resolves to var(--color-{name}) for all members', () => {
      expect(worldColorCssVar('verdigris-200')).toBe('var(--color-verdigris-200)')
      expect(worldColorCssVar('paper-50')).toBe('var(--color-paper-50)')
      expect(worldColorCssVar('ember-900')).toBe('var(--color-ember-900)')
    })
  })

  describe('worldColorStep / worldColorHue', () => {
    it('worldColorStep reads the trailing step', () => {
      expect(worldColorStep('verdigris-200')).toBe(200)
      expect(worldColorStep('paper-50')).toBe(50)
      expect(worldColorStep('rose-900')).toBe(900)
    })

    it('worldColorHue reads the ramp', () => {
      expect(worldColorHue('verdigris-200')).toBe('verdigris')
      expect(worldColorHue('paper-50')).toBe('paper')
      expect(worldColorHue('rose-900')).toBe('rose')
    })
  })

  describe('rungsApart — ladder distance', () => {
    it('counts index distance on the 10-rung ladder', () => {
      expect(rungsApart('verdigris-200', 'moss-800')).toBe(6)
      expect(rungsApart('lapis-400', 'lapis-500')).toBe(1)
      expect(rungsApart('paper-50', 'slate-900')).toBe(9)
    })

    it('is symmetric and zero for equal steps', () => {
      expect(rungsApart('moss-800', 'verdigris-200')).toBe(6)
      expect(rungsApart('iris-300', 'rose-300')).toBe(0)
    })
  })

  describe('reInkPair — dark-mode re-ink', () => {
    it('lighter end → hue-400, darker end → hue-900 (from lighter)', () => {
      expect(reInkPair({ from: 'sienna-100', to: 'pine-800' })).toEqual({
        from: 'sienna-400',
        to: 'pine-900',
      })
    })

    it('handles from being the darker end', () => {
      expect(reInkPair({ from: 'pine-800', to: 'sienna-100' })).toEqual({
        from: 'pine-900',
        to: 'sienna-400',
      })
    })

    it('a monochromatic pick keeps the single hue on both ends', () => {
      expect(reInkPair({ from: 'lapis-200', to: 'lapis-800' })).toEqual({
        from: 'lapis-400',
        to: 'lapis-900',
      })
    })

    it('equal steps resolve deterministically (from treated as the lighter end)', () => {
      expect(reInkPair({ from: 'iris-300', to: 'rose-300' })).toEqual({
        from: 'iris-400',
        to: 'rose-900',
      })
    })
  })
})
