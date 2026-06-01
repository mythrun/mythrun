// In-memory stub-repo unit test for the session-prep world-state serializer.
// No DB: the serializer is pure composition over repo reads, so a hand-rolled
// stub repo exercises the composition contract (omniscient dump, party with
// known-tier facts only, the CHOSEN starting situation) without a round-trip.
//
// Stubs use the `() => Promise.resolve(...)` form (not `async () =>`) to stay
// clean under @typescript-eslint/require-await — same Promise<T> shape, no
// internal await. Mirrors the codebase stub idiom in __tests__/helpers/stub-deps.ts.
import { describe, it, expect, vi } from 'vitest'
import type { WorldInventory } from '../../../repo/world-inventory.js'
import { serializeWorldStateForPrep } from '../serialize-world-state-for-prep.js'

function stubRepo() {
  return {
    campaigns: {
      getWorldAndSituationIndex: vi.fn(() =>
        Promise.resolve({ world_id: 'w1', starting_situation_index: 1 }),
      ),
    },
    worlds: {
      getById: vi.fn(() =>
        Promise.resolve({
          id: 'w1',
          name: 'Saltmere',
          tone: 'grim',
          era: 'age of tides',
          themes: 'debt, tides',
          keyTensions: 'the guild vs the drowned',
          worldOverview: 'A sinking port city.',
        }),
      ),
      getStartingSituationEntries: vi.fn(() =>
        Promise.resolve([
          { index: 0, locationEntityId: 'l0', prose: 'WRONG situation' },
          { index: 1, locationEntityId: 'l1', prose: 'The tide-bell tolls at dusk.' },
        ]),
      ),
    },
    worldInventory: {
      load: vi.fn(() =>
        Promise.resolve({
          entitiesById: new Map([
            ['e1', { id: 'e1', name: 'Voss', entityType: 'npc', accessLevel: 'known' }],
          ]),
          proseByEntityId: new Map([['e1', 'Tavern-keeper.']]),
          factsById: new Map([
            [
              'f1',
              { id: 'f1', entityId: 'e1', content: 'Voss was a quartermaster.', topic: 'past', accessLevel: 'secret' },
            ],
          ]),
          relationshipsById: new Map(),
        }),
      ),
    },
    characters: {
      listForCampaign: vi.fn(() =>
        Promise.resolve([
          { id: 'c1', name: 'Kael', level: 3, class: 'rogue', entityId: 'pc1' },
          { id: 'c2', name: 'Mira', level: 3, class: 'cleric', entityId: 'pc2' },
        ]),
      ),
    },
    facts: {
      listByEntities: vi.fn((ids: readonly string[], opts: { accessLevels: readonly string[] }) => {
        expect(opts.accessLevels).toEqual(['known'])
        return Promise.resolve([
          { id: 'kf1', entityId: 'pc1', topic: 'goal', accessLevel: 'known', content: 'Kael owes the guild.' },
        ])
      }),
    },
  } as never
}

describe('serializeWorldStateForPrep', () => {
  it('composes world concept, omniscient dump, party (known facts only), and the CHOSEN situation', async () => {
    const out = await serializeWorldStateForPrep(stubRepo(), { campaignId: 'camp1', sessionNumber: 1 })
    expect(out).toContain('Saltmere')
    expect(out).toContain('A sinking port city.')
    expect(out).toContain('Voss was a quartermaster.') // omniscient input includes secret facts
    expect(out).toContain('Kael')
    expect(out).toContain('Kael owes the guild.') // PC known fact
    expect(out).toContain('The tide-bell tolls at dusk.') // chosen situation (index 1)
    expect(out).not.toContain('WRONG situation')
  })

  it('uses an injected world-state source when provided (session-N seam)', async () => {
    const repo = stubRepo()
    const emptyInv: WorldInventory = {
      entitiesById: new Map(),
      proseByEntityId: new Map(),
      factsById: new Map(),
      relationshipsById: new Map(),
    }
    const customLoad = vi.fn(() => Promise.resolve(emptyInv))
    await serializeWorldStateForPrep(repo, {
      campaignId: 'camp1',
      sessionNumber: 2,
      loadInventory: customLoad,
    })
    expect(customLoad).toHaveBeenCalledWith('w1')
    expect(
      (repo as { worldInventory: { load: { mock: { calls: unknown[] } } } }).worldInventory.load.mock.calls,
    ).toHaveLength(0)
  })
})
