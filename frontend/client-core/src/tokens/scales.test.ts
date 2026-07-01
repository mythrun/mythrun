import { describe, it, expect } from 'vitest'
import { wcagContrast } from 'culori'
import {
  SPACING, RADIUS, CONTROL, ICON, ZINDEX, MOTION,
  TYPE_ROLES, WEIGHTS, TRACKING, MEASURE, BREAKPOINTS, AVATAR_COLORS,
} from './scales.ts'

describe('token scale data (single source for web @theme + future native)', () => {
  it('spacing is the 4px-base 4..64 ramp', () => {
    expect(Object.values(SPACING)).toEqual(['4px', '8px', '12px', '16px', '24px', '32px', '40px', '48px', '64px'])
  })
  it('radius is flat 0px', () => {
    expect(RADIUS.DEFAULT).toBe('0px')
  })
  it('control heights are 32/40/48', () => {
    expect(CONTROL).toEqual({ sm: '32px', md: '40px', lg: '48px' })
  })
  it('icon sizes are 16/20/24', () => {
    expect(ICON).toEqual({ sm: '16px', md: '20px', lg: '24px' })
  })
  it('z-index is the semantic stacking scale', () => {
    expect(ZINDEX).toEqual({
      base: 0, nav: 10, dropdown: 1000, popover: 1100,
      overlay: 1200, modal: 1300, toast: 1400, tooltip: 1500,
    })
  })
  it('motion carries durations + easings', () => {
    expect(MOTION.duration).toEqual({ fast: '120ms', base: '200ms', slow: '360ms' })
    expect(MOTION.easing.out).toBe('cubic-bezier(0.2, 0, 0, 1)')
    expect(MOTION.easing.linear).toBe('linear')
  })
  it('exposes the nine typography roles', () => {
    expect(Object.keys(TYPE_ROLES)).toEqual([
      'display', 'heading', 'title', 'prose-body', 'subtitle',
      'ui-label', 'ui-caption', 'data', 'meta',
    ])
  })
  it('weights / tracking / measure / breakpoints are present', () => {
    expect(WEIGHTS).toEqual({ normal: 400, medium: 500, semibold: 600 })
    expect(TRACKING).toEqual({ normal: '0', wide: '0.5px' })
    expect(MEASURE.DEFAULT).toBe('64ch')
    expect(BREAKPOINTS.sm).toBe('640px')
    expect(BREAKPOINTS['2xl']).toBe('1536px')
  })
})

describe('avatar pigments — the curated "scribe\'s pigments" (single token source)', () => {
  const PAPER_50 = '#F8F4EA'
  const NAMES = [
    'ember', 'sienna', 'ochre', 'moss', 'pine', 'verdigris',
    'lapis', 'iris', 'heather', 'rose', 'umber', 'slate',
  ] as const

  it('carries exactly the 12 curated pigment names', () => {
    expect(Object.keys(AVATAR_COLORS)).toEqual([...NAMES])
  })

  it('every pigment is a 6-digit hex', () => {
    for (const hex of Object.values(AVATAR_COLORS)) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it('carries paper-50 (#F8F4EA) initials at ≥4.5:1 (WCAG AA, 16px-bold)', () => {
    for (const [name, hex] of Object.entries(AVATAR_COLORS)) {
      const ratio = wcagContrast(PAPER_50, hex)
      expect(ratio, `${name} (${hex}) on paper-50`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
