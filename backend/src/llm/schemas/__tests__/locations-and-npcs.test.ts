import { describe, it, expect } from 'vitest'
import { LocationsAndNpcsSchema, factSchema } from '../locations-and-npcs.js'

describe('LocationsAndNpcsSchema — myth-exac', () => {
  const goodFact = (tier: string) => ({
    topic: 't1',
    content: 'a'.repeat(25),
    access_level: tier,
  })

  const goodLocation = {
    name: 'L',
    access_level: 'known',
    prose: 'a'.repeat(50),
    facts: [goodFact('known'), goodFact('discoverable')],
    parent_location: null,
  }

  const goodNpc = {
    name: 'N',
    access_level: 'known',
    prose: 'a'.repeat(50),
    facts: [goodFact('known'), goodFact('discoverable')],
    home_location: null,
  }

  const goodTree = {
    locations: [goodLocation, goodLocation, goodLocation, goodLocation, goodLocation],
    npcs: [goodNpc, goodNpc, goodNpc, goodNpc, goodNpc],
  }

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

  it('accepts a well-formed tree with access_level on every entity and fact', () => {
    expect(() => LocationsAndNpcsSchema.parse(goodTree)).not.toThrow()
  })

  it('location requires access_level (no default)', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { access_level: _, ...locationNoAccess } = goodLocation
    expect(() =>
      LocationsAndNpcsSchema.parse({
        ...goodTree,
        locations: [
          locationNoAccess,
          goodLocation,
          goodLocation,
          goodLocation,
          goodLocation,
        ],
      }),
    ).toThrow()
  })

  it('npc requires access_level (no default)', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { access_level: _, ...npcNoAccess } = goodNpc
    expect(() =>
      LocationsAndNpcsSchema.parse({
        ...goodTree,
        npcs: [npcNoAccess, goodNpc, goodNpc, goodNpc, goodNpc],
      }),
    ).toThrow()
  })
})
