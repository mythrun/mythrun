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

  it('rejects when the campaign is not found', async () => {
    const repo = stubRepo() as unknown as {
      campaigns: { getWorldAndSituationIndex: ReturnType<typeof vi.fn> }
    }
    repo.campaigns.getWorldAndSituationIndex = vi.fn(() => Promise.resolve(null))
    await expect(
      serializeWorldStateForPrep(repo as never, { campaignId: 'missing', sessionNumber: 1 }),
    ).rejects.toThrow(/campaign not found/)
  })

  it('rejects when the world is not found (campaign meta present)', async () => {
    const repo = stubRepo() as unknown as { worlds: { getById: ReturnType<typeof vi.fn> } }
    repo.worlds.getById = vi.fn(() => Promise.resolve(null))
    await expect(
      serializeWorldStateForPrep(repo as never, { campaignId: 'camp1', sessionNumber: 1 }),
    ).rejects.toThrow(/world not found/)
  })

  it('omits optional world-concept sections when their fields are null', async () => {
    const repo = stubRepo() as unknown as { worlds: { getById: ReturnType<typeof vi.fn> } }
    repo.worlds.getById = vi.fn(() =>
      Promise.resolve({
        id: 'w1',
        name: 'Barebones',
        tone: null,
        era: null,
        themes: null,
        keyTensions: null,
        worldOverview: null,
      }),
    )
    const out = await serializeWorldStateForPrep(repo as never, { campaignId: 'camp1', sessionNumber: 1 })
    expect(out).toContain('Barebones')
    expect(out).not.toContain('**Tone:**')
    expect(out).not.toContain('**Era:**')
    expect(out).not.toContain('**Themes:**')
    expect(out).not.toContain('**Key Tensions:**')
    expect(out).not.toContain('## World Overview')
  })

  it('renders a PC with a null entityId without a known-facts block', async () => {
    const repo = stubRepo() as unknown as {
      characters: { listForCampaign: ReturnType<typeof vi.fn> }
      facts: { listByEntities: ReturnType<typeof vi.fn> }
    }
    repo.characters.listForCampaign = vi.fn(() =>
      Promise.resolve([{ id: 'c9', name: 'Nameless', level: 1, class: 'fighter', entityId: null }]),
    )
    // No PC entity ids → the batched facts read short-circuits and is not called.
    repo.facts.listByEntities = vi.fn(() => Promise.resolve([]))
    const out = await serializeWorldStateForPrep(repo as never, { campaignId: 'camp1', sessionNumber: 1 })
    expect(out).toContain('Nameless')
    expect(out).not.toContain('Known at session start:')
    expect(repo.facts.listByEntities.mock.calls).toHaveLength(0)
  })

  it('handles an empty party (no PC entity ids → facts read short-circuits)', async () => {
    const repo = stubRepo() as unknown as {
      characters: { listForCampaign: ReturnType<typeof vi.fn> }
      facts: { listByEntities: ReturnType<typeof vi.fn> }
    }
    repo.characters.listForCampaign = vi.fn(() => Promise.resolve([]))
    repo.facts.listByEntities = vi.fn(() => Promise.resolve([]))
    const out = await serializeWorldStateForPrep(repo as never, { campaignId: 'camp1', sessionNumber: 1 })
    expect(out).toContain('## The Party')
    expect(repo.facts.listByEntities.mock.calls).toHaveLength(0)
  })

  it('omits the situation section when starting_situation_index is null', async () => {
    const repo = stubRepo() as unknown as {
      campaigns: { getWorldAndSituationIndex: ReturnType<typeof vi.fn> }
      worlds: { getStartingSituationEntries: ReturnType<typeof vi.fn> }
    }
    repo.campaigns.getWorldAndSituationIndex = vi.fn(() =>
      Promise.resolve({ world_id: 'w1', starting_situation_index: null }),
    )
    const out = await serializeWorldStateForPrep(repo as never, { campaignId: 'camp1', sessionNumber: 1 })
    expect(out).not.toContain('## The Situation')
    expect(repo.worlds.getStartingSituationEntries.mock.calls).toHaveLength(0)
  })

  it('omits the situation section when the chosen entry is out of range', async () => {
    const repo = stubRepo() as unknown as {
      campaigns: { getWorldAndSituationIndex: ReturnType<typeof vi.fn> }
    }
    // Index 5 with only two entries → entries[5] is undefined.
    repo.campaigns.getWorldAndSituationIndex = vi.fn(() =>
      Promise.resolve({ world_id: 'w1', starting_situation_index: 5 }),
    )
    const out = await serializeWorldStateForPrep(repo as never, { campaignId: 'camp1', sessionNumber: 1 })
    expect(out).not.toContain('## The Situation')
  })

  it('appends prior-session summaries when priorSessionContext is provided', async () => {
    const out = await serializeWorldStateForPrep(stubRepo(), {
      campaignId: 'camp1',
      sessionNumber: 2,
      priorSessionContext: { previousSummaries: ['Last time, the party torched the docks.'] },
    })
    expect(out).toContain('## Prior Sessions')
    expect(out).toContain('Last time, the party torched the docks.')
  })

  it('renders the "Where We Left Off" anchor (time, party positions, threads, NPC dispositions) when latestHandoff is set', async () => {
    const out = await serializeWorldStateForPrep(stubRepo(), {
      campaignId: 'camp1',
      sessionNumber: 2,
      priorSessionContext: {
        previousSummaries: [],
        latestHandoff: {
          party: [
            { characterName: 'Kael', location: 'the bilge', condition: 'bleeding' },
            { characterName: 'Mira', location: 'the deck', condition: 'unharmed' },
          ],
          timeOfDay: 'just before dawn',
          unresolvedThreads: ['the smuggled crate', 'Voss has gone missing'],
          npcs: [
            { name: 'Voss', state: 'hostile and cornered', voice: ['"You sold us out."'] },
            { name: 'Sela', state: 'grateful, owes the party a debt', voice: [] },
          ],
          keyLocations: [{ name: 'the bilge', atmosphere: '"Bilgewater laps at your boots."' }],
        },
      },
    })
    expect(out).toContain('## Where We Left Off')
    // Time of day.
    expect(out).toContain('just before dawn')
    // Each party member's location (and the per-member line shape).
    expect(out).toContain('- Kael: the bilge (bleeding)')
    expect(out).toContain('the deck')
    // Each unresolved thread.
    expect(out).toContain('the smuggled crate')
    expect(out).toContain('Voss has gone missing')
    // Each NPC name + state.
    expect(out).toContain('- Voss: hostile and cornered')
    expect(out).toContain('- Sela: grateful, owes the party a debt')
    // The verbatim voice / atmosphere are NOT rendered into the prompt (§6:
    // the processor appends them to ft_context deterministically).
    expect(out).not.toContain('You sold us out.')
    expect(out).not.toContain('Bilgewater laps at your boots.')
  })

  it('does NOT render the "Where We Left Off" anchor when no priorSessionContext is provided', async () => {
    const out = await serializeWorldStateForPrep(stubRepo(), { campaignId: 'camp1', sessionNumber: 1 })
    expect(out).not.toContain('## Where We Left Off')
  })
})
