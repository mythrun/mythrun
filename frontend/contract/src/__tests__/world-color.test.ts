import { describe, it, expect } from 'vitest'
import {
  WORLD_COLORS,
  WORLD_COLOR_PIGMENTS,
  WORLD_COLOR_RAMP_STEPS,
  WorldColorSchema,
  WorldColorPairSchema,
  worldColorCssVar,
} from '../rest/index.js'

describe('@mythrun/contract WorldColor', () => {
  describe('WORLD_COLORS — the curated cover-color set', () => {
    it('is exactly the 12 pigments + the 8 selected ramp steps (20 members)', () => {
      expect(WORLD_COLORS).toEqual([
        'ember', 'sienna', 'ochre', 'moss', 'pine', 'verdigris',
        'lapis', 'iris', 'heather', 'rose', 'umber', 'slate',
        'paper-50', 'paper-100', 'paper-200', 'paper-900',
        'ember-100', 'ember-200', 'ember-700', 'ember-900',
      ])
      expect(WORLD_COLORS).toHaveLength(20)
    })

    it('includes sienna + paper-100 + ember-900', () => {
      expect(WORLD_COLORS).toContain('sienna')
      expect(WORLD_COLORS).toContain('paper-100')
      expect(WORLD_COLORS).toContain('ember-900')
    })

    it('EXCLUDES the semantic ramps (a cover is decorative, never a UI-state signal)', () => {
      for (const semantic of ['success-500', 'warning-500', 'danger-500', 'info-500']) {
        expect(WORLD_COLORS).not.toContain(semantic)
      }
    })

    it('partitions cleanly into the pigment + ramp-step sub-sets', () => {
      expect([...WORLD_COLOR_PIGMENTS, ...WORLD_COLOR_RAMP_STEPS]).toEqual([...WORLD_COLORS])
      // No member belongs to both namespaces.
      for (const name of WORLD_COLOR_PIGMENTS) {
        expect(WORLD_COLOR_RAMP_STEPS).not.toContain(name)
      }
    })
  })

  describe('WorldColorSchema', () => {
    it('accepts every curated member', () => {
      for (const name of WORLD_COLORS) {
        expect(WorldColorSchema.parse(name)).toBe(name)
      }
    })

    it('rejects a semantic ramp step and an arbitrary string', () => {
      expect(() => WorldColorSchema.parse('danger-500')).toThrow()
      expect(() => WorldColorSchema.parse('not-a-color')).toThrow()
    })
  })

  describe('WorldColorPairSchema', () => {
    it('parses a valid { from, to } pair', () => {
      const parsed = WorldColorPairSchema.parse({ from: 'sienna', to: 'paper-100' })
      expect(parsed).toEqual({ from: 'sienna', to: 'paper-100' })
    })

    it('rejects a pair whose from is a semantic (excluded) color', () => {
      expect(() => WorldColorPairSchema.parse({ from: 'danger-500', to: 'paper-100' })).toThrow()
    })

    it('rejects a pair whose to is an unknown color', () => {
      expect(() => WorldColorPairSchema.parse({ from: 'sienna', to: 'chartreuse' })).toThrow()
    })
  })

  describe('worldColorCssVar — namespace resolution for the consumer', () => {
    it('resolves a pigment to the avatar namespace (--color-avatar-{name})', () => {
      expect(worldColorCssVar('sienna')).toBe('--color-avatar-sienna')
      expect(worldColorCssVar('ember')).toBe('--color-avatar-ember')
    })

    it('resolves a ramp step to the base palette namespace (--color-{name})', () => {
      expect(worldColorCssVar('paper-100')).toBe('--color-paper-100')
      expect(worldColorCssVar('ember-900')).toBe('--color-ember-900')
    })
  })
})
