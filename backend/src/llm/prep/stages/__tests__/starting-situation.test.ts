// backend/src/llm/prep/stages/__tests__/starting-situation.test.ts
//
// Per MYT-51 T6. Stage 4 contract: one Sonnet call via generateText +
// Output.object, persist the JSON-encoded `location_hooks` to
// `worlds.starting_situations`, return cost math.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runStartingSituationStage } from '../starting-situation.js'
import * as ai from 'ai'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'
import { makeFakeRepo, type FakeRepo } from './_helpers/fake-repo.js'
import type { Repo } from '../../../../repo/index.js'

const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

// Default fake repo whose location lookup returns rows matching the HOOKS
// fixture's location_name values so resolution succeeds. Tests that exercise
// the miss/retry path override `entities.listLocationsByWorld`.
function makeRepo(): FakeRepo {
  const repo = makeFakeRepo()
  repo.entities.listLocationsByWorld.mockResolvedValue([
    { id: 'loc-wharf', name: 'The Salt-Eaten Wharf' },
    { id: 'loc-hill', name: 'Lantern Hill' },
    { id: 'loc-causeway', name: 'The Drowned Causeway' },
  ])
  return repo
}

const HOOKS = {
  location_hooks: [
    {
      title: 'Fog on the Wharf',
      location_name: 'The Salt-Eaten Wharf',
      why_interesting:
        'A waterfront where the morning fog never quite lifts and the dock-hands speak in code.',
    },
    {
      title: 'The Silent House Above',
      location_name: 'Lantern Hill',
      why_interesting:
        'The silent house looms above the town; everyone has a theory, no one will say theirs out loud.',
    },
    {
      title: 'A Road Older Than Light',
      location_name: 'The Drowned Causeway',
      why_interesting:
        'A road exposed only at low tide, said to lead somewhere older than the lighthouses.',
    },
  ],
}

const baseArgs = {
  worldId: 'wld-1',
  worldName: 'Aelmoor',
  tone: 'misted, melancholy, watchful',
  themes: 'guardianship, secrets',
  keyTensions: 'spirits chafe in lanterns',
  locationsSummary: '- The Salt-Eaten Wharf\n- Lantern Hill\n- The Drowned Causeway',
  npcsSummary: '(stage not implemented yet)',
  factionsSummary: '(stage not implemented yet)',
  canonicalNames: '',
  vocabularyRegistry: EMPTY_REGISTRY,
}

describe('runStartingSituationStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generates 3 hooks, persists JSON to worlds.starting_situations, returns cost', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: HOOKS,
      finishReason: 'stop',
      usage: { inputTokens: 1200, outputTokens: 500, totalTokens: 1700 },
    } as never)

    const repo = makeRepo()
    const result = await runStartingSituationStage(repo as unknown as Repo, baseArgs)

    // Post data-layer-unification: the prose blob is persisted via
    // repo.worlds.setStartingSituations (the binder SQL is covered by the
    // worlds repo integration test). Assert the serialized payload it received.
    expect(repo.transaction).toHaveBeenCalledTimes(1)
    expect(repo.worlds.setStartingSituations).toHaveBeenCalledTimes(1)
    const proseCall = repo.worlds.setStartingSituations.mock.calls[0] as [string, string]
    expect(proseCall[0]).toBe('wld-1')
    expect(JSON.parse(proseCall[1])).toEqual(HOOKS)

    // 1200/1M * 3 + 500/1M * 15 = 0.0036 + 0.0075 = 0.0111
    expect(result.costUsd).toBeCloseTo(0.0111, 4)
    expect(result.inputTokens).toBe(1200)
    expect(result.outputTokens).toBe(500)
  })

  it('renders all template placeholders into the prompt', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: HOOKS,
      finishReason: 'stop',
      usage: { inputTokens: 1200, outputTokens: 500, totalTokens: 1700 },
    } as never)

    await runStartingSituationStage(makeRepo() as unknown as Repo, baseArgs)

    const call = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as Record<
      string,
      unknown
    >
    const prompt = call.prompt as string
    expect(prompt).toContain('Aelmoor')
    expect(prompt).toContain('misted, melancholy, watchful')
    expect(prompt).toContain('The Salt-Eaten Wharf')
    expect(prompt).toContain('(stage not implemented yet)')
    expect(prompt).not.toContain('{{name}}')
    expect(prompt).not.toContain('{{npcs_summary}}')
  })

  // myth-xg6p T3: structured-entries persistence + name→id resolution.
  it('resolves location_name to locationEntityId via entities lookup and persists structured array', async () => {
    const repo = makeRepo()
    repo.entities.listLocationsByWorld.mockResolvedValue([
      { id: 'loc-1', name: 'The Whispering Well' },
      { id: 'loc-2', name: 'Ashen Market' },
      { id: 'loc-3', name: 'Iron Sept' },
    ])

    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        location_hooks: [
          {
            title: 'The Well at Dusk',
            location_name: 'The Whispering Well',
            why_interesting: 'short note about the well',
          },
          {
            title: 'Ash and Coin',
            location_name: 'Ashen Market',
            why_interesting: 'a market story',
          },
          {
            title: 'Where Iron Sleeps',
            location_name: 'Iron Sept',
            why_interesting: 'a temple ruin',
          },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 600, totalTokens: 1600 },
    } as never)

    await runStartingSituationStage(repo as unknown as Repo, baseArgs)

    // Structured entries persisted via repo.worlds.setStartingSituationEntries.
    expect(repo.worlds.setStartingSituationEntries).toHaveBeenCalledTimes(1)
    const entriesCall = repo.worlds.setStartingSituationEntries.mock.calls[0] as [string, string]
    expect(entriesCall[0]).toBe('wld-1')
    const payload = JSON.parse(entriesCall[1]) as {
      index: number
      title: string
      locationEntityId: string
      locationName: string
      prose: string
    }[]
    expect(payload.map((p) => p.locationEntityId)).toEqual(['loc-1', 'loc-2', 'loc-3'])
    // myth-k1ee: title is LLM-emitted verbatim; locationName is the
    // canonical entities.name resolved from locationEntityId.
    expect(payload.map((p) => p.title)).toEqual([
      'The Well at Dusk',
      'Ash and Coin',
      'Where Iron Sleeps',
    ])
    expect(payload.map((p) => p.locationName)).toEqual([
      'The Whispering Well',
      'Ashen Market',
      'Iron Sept',
    ])
  })

  // MYT-90 A6: each hook carries a generated 2nd-person `invitation` whisper
  // (the character-creation grounding prompt). The stage must thread it into
  // the persisted situation entries (starting_situation_entries JSONB) and the
  // raw output blob (worlds.starting_situations), grounded in that hook.
  it('threads each hook invitation into the persisted situation entries (MYT-90 A6)', async () => {
    const repo = makeRepo()
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        location_hooks: [
          {
            title: 'Fog on the Wharf',
            location_name: 'The Salt-Eaten Wharf',
            why_interesting:
              'A waterfront where the fog never lifts and the dock-hands speak in code.',
            invitation:
              "The dock-hands' code changed the night you arrived, and one nodded at you like an accomplice. What are they mistaking you for?",
          },
          {
            title: 'The Silent House Above',
            location_name: 'Lantern Hill',
            why_interesting: 'The silent house looms; everyone has a theory, no one says theirs.',
            invitation:
              'You already have a theory about the silent house on Lantern Hill. Who told it to you, and why did you believe them?',
          },
          {
            title: 'A Road Older Than Light',
            location_name: 'The Drowned Causeway',
            why_interesting: 'A road exposed only at low tide, said to lead somewhere older.',
            invitation:
              'You have walked the Drowned Causeway at low tide before. What did you go looking for, and did you find it?',
          },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 600, totalTokens: 1600 },
    } as never)

    await runStartingSituationStage(repo as unknown as Repo, baseArgs)

    // Structured entries JSONB carries the invitation per hook (this is the
    // column GET /starting-situations serves verbatim to the client).
    expect(repo.worlds.setStartingSituationEntries).toHaveBeenCalledTimes(1)
    const entriesCall = repo.worlds.setStartingSituationEntries.mock.calls[0] as [string, string]
    const payload = JSON.parse(entriesCall[1]) as { invitation: string }[]
    expect(payload.map((p) => p.invitation)).toEqual([
      expect.stringContaining("dock-hands' code"),
      expect.stringContaining('silent house'),
      expect.stringContaining('Drowned Causeway'),
    ])

    // The raw output blob persisted to worlds.starting_situations also carries it.
    const proseCall = repo.worlds.setStartingSituations.mock.calls[0] as [string, string]
    const rawHooks = JSON.parse(proseCall[1]) as { location_hooks: { invitation: string }[] }
    expect(rawHooks.location_hooks.every((h) => typeof h.invitation === 'string')).toBe(true)
  })

  it('throws LlmStructuredOutputError after one retry when a location_name does not match', async () => {
    const repo = makeRepo()
    repo.entities.listLocationsByWorld.mockResolvedValue([{ id: 'loc-1', name: 'The Real Place' }])
    vi.mocked(ai.generateText).mockResolvedValue({
      output: {
        location_hooks: [
          { title: 'A Fake Title', location_name: 'Not A Real Place', why_interesting: 'fictional' },
          { title: 'Also Fake', location_name: 'Also Not Real', why_interesting: 'fictional' },
          { title: 'Likewise Fake', location_name: 'Likewise', why_interesting: 'fictional' },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 600, totalTokens: 1600 },
    } as never)

    await expect(runStartingSituationStage(repo as unknown as Repo, baseArgs)).rejects.toThrow(
      /location_name.*not.*found|cannot resolve|cannot be resolved/i,
    )
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(2) // initial + one retry
  })

  // myth-pfke task 9d: vocabulary registry placeholder substitution.
  it('substitutes {{vocabularyRegistry}} with the rendered registry prose', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: HOOKS,
      finishReason: 'stop',
      usage: { inputTokens: 1200, outputTokens: 500, totalTokens: 1700 },
    } as never)

    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'the unwitched',
          definition:
            "non-magical people; this world's term for those without arcane sight.",
          avoids: 'muggle',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: ['Harry Potter'],
    }

    await runStartingSituationStage(makeRepo() as unknown as Repo, {
      ...baseArgs,
      vocabularyRegistry: registry,
    })

    const captured = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as
      | { prompt: string }
      | undefined
    const prompt = captured?.prompt ?? ''
    expect(prompt).toContain("This world's distinctive vocabulary:")
    expect(prompt).toContain('the unwitched')
    expect(prompt).not.toContain('{{vocabularyRegistry}}')
  })
})
