import { describe, it, expect } from 'vitest'
import { WorldAndFactionsSchema, factSchema } from '../world-and-factions.js'

describe('WorldAndFactionsSchema — myth-exac', () => {
  it('fact rejects old access_level vocabulary', () => {
    expect(() =>
      factSchema.parse({ topic: 'xx', content: 'a'.repeat(25), access_level: 'public' }),
    ).toThrow()
    expect(() =>
      factSchema.parse({ topic: 'xx', content: 'a'.repeat(25), access_level: 'private' }),
    ).toThrow()
  })

  it('fact accepts new access_level vocabulary', () => {
    for (const tier of ['known', 'discoverable', 'secret']) {
      expect(() =>
        factSchema.parse({ topic: 'xx', content: 'a'.repeat(25), access_level: tier }),
      ).not.toThrow()
    }
  })

  it('region requires access_level (no default)', () => {
    const goodRegion = {
      name: 'X',
      access_level: 'known',
      prose: 'a'.repeat(50),
      facts: [
        { topic: 't1', content: 'a'.repeat(25), access_level: 'known' },
        { topic: 't2', content: 'a'.repeat(25), access_level: 'discoverable' },
      ],
    }
    expect(() =>
      WorldAndFactionsSchema.parse({
        world_overview: 'a'.repeat(80),
        regions: [goodRegion, goodRegion, goodRegion],
        factions: [goodRegion, goodRegion, goodRegion],
      }),
    ).not.toThrow()

    // Missing access_level on region → fails
    const { access_level: _, ...regionNoAccess } = goodRegion
    expect(() =>
      WorldAndFactionsSchema.parse({
        world_overview: 'a'.repeat(80),
        regions: [regionNoAccess, goodRegion, goodRegion],
        factions: [goodRegion, goodRegion, goodRegion],
      }),
    ).toThrow()
  })
})
