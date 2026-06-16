import { describe, it, expect } from 'vitest'
import { WorldDeltaSchema } from '../world-delta.js'

describe('WorldDeltaSchema', () => {
  it('accepts a valid delta', () => {
    const r = WorldDeltaSchema.safeParse({
      facts: [
        { subject: 'Elwyn', content: 'wears a silver pin', kind: 'fact' },
        { subject: 'The Rusty Anchor', content: 'a tavern by the docks', kind: 'entity' },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('accepts an empty facts array', () => {
    expect(WorldDeltaSchema.safeParse({ facts: [] }).success).toBe(true)
  })

  it('rejects an item missing content', () => {
    expect(WorldDeltaSchema.safeParse({ facts: [{ subject: 'x', kind: 'fact' }] }).success).toBe(false)
  })

  it('rejects an item with an unknown kind', () => {
    expect(
      WorldDeltaSchema.safeParse({ facts: [{ subject: 'x', content: 'y', kind: 'plot' }] }).success,
    ).toBe(false)
  })

  it('rejects an empty content string', () => {
    expect(
      WorldDeltaSchema.safeParse({ facts: [{ subject: 'x', content: '', kind: 'fact' }] }).success,
    ).toBe(false)
  })

  it('ignores a stray tier field (enforced ignorance: parser stamps the tier, not the model)', () => {
    const parsed = WorldDeltaSchema.parse({
      facts: [{ subject: 'x', content: 'y', kind: 'fact', tier: 'secret' }],
    })
    expect(parsed.facts).toHaveLength(1)
    const item = parsed.facts.at(0)
    expect(item).toBeDefined()
    expect(item && 'tier' in item).toBe(false)
  })
})
