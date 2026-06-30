import { describe, it, expect } from 'vitest'
import {
  WORLD_COLORS,
  WORLD_COLOR_PIGMENTS,
  WORLD_COLOR_RAMP_STEPS,
  worldColorCssVar,
} from '@mythrun/contract/rest'
import { AVATAR_COLORS } from '../../tokens/scales.ts'
import { generatePalette } from '../../tokens/generate-palette.mjs'

// Drift guard: the curated `WorldColor` set lives in the react-free
// `@mythrun/contract` (so the backend can validate it), but the actual color
// VALUES it names live in `@mythrun/client-core`'s design tokens — the 12 avatar
// pigments (`AVATAR_COLORS`) and the generated `paper`/`ember` ramps. Nothing at
// the type level couples the two: a `WorldColor` is just a string literal. This
// test is that coupling — every curated member must resolve to a token that
// really exists, so the set can't silently reference a deleted/renamed token.
describe('WorldColor drift guard — every curated cover color resolves to a real design token', () => {
  // The set of every `--color-{name}` ramp token the generator actually emits
  // for the `paper`/`ember` ramps (e.g. `'paper-100'`, `'ember-900'`) — built
  // from the generator's own output (not a hardcoded list) so a step that
  // disappears from a ramp would make the matching world color fail here. We key
  // off `Object.keys` (typed `string[]`) rather than `Object.entries` (whose
  // value is `any` for the generator's closed-key `Ramp` interface).
  const palette = generatePalette()
  const generatedRampTokens = new Set<string>()
  for (const ramp of ['paper', 'ember'] as const) {
    for (const step of Object.keys(palette[ramp])) {
      generatedRampTokens.add(`${ramp}-${step}`)
    }
  }

  it('every pigment is a real AVATAR_COLORS key (→ --color-avatar-{name})', () => {
    for (const name of WORLD_COLOR_PIGMENTS) {
      expect(AVATAR_COLORS, name).toHaveProperty(name)
      expect(worldColorCssVar(name)).toBe(`--color-avatar-${name}`)
    }
  })

  it('every ramp step is a real generated paper/ember token (→ --color-{name})', () => {
    for (const name of WORLD_COLOR_RAMP_STEPS) {
      expect(generatedRampTokens.has(name), `${name} is an emitted ramp token`).toBe(true)
      expect(worldColorCssVar(name)).toBe(`--color-${name}`)
    }
  })

  it('every WORLD_COLORS member resolves to a real token (pigment OR ramp step)', () => {
    for (const name of WORLD_COLORS) {
      const resolvesToAPigment = Object.prototype.hasOwnProperty.call(AVATAR_COLORS, name)
      const resolvesToARampStep = generatedRampTokens.has(name)
      expect(resolvesToAPigment || resolvesToARampStep, `${name} resolves to a real token`).toBe(true)
      // A world color is exactly one of the two — never both, never neither.
      expect(resolvesToAPigment && resolvesToARampStep, `${name} is single-namespace`).toBe(false)
    }
  })

  it('does NOT reference the semantic ramps (success/warning/danger/info)', () => {
    for (const name of WORLD_COLORS) {
      const ramp = name.includes('-') ? name.slice(0, name.indexOf('-')) : name
      expect(['success', 'warning', 'danger', 'info']).not.toContain(ramp)
    }
  })
})
