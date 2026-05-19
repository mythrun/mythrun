// backend/src/llm/prep/stages/__tests__/starting-situation.test.ts
//
// Per MYT-51 T6. Stage 4 contract: one Sonnet call via generateText +
// Output.object, persist the JSON-encoded `location_hooks` to
// `worlds.starting_situations`, return cost math.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runStartingSituationStage } from '../starting-situation.js'
import * as ai from 'ai'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'

const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

interface QuerySpy {
  query: ReturnType<typeof vi.fn>
}

function makeClient(): QuerySpy {
  // Default: the entities lookup returns rows matching the HOOKS fixture's
  // location_name values so resolution succeeds. Tests that exercise the
  // miss/retry path override via `query.mockImplementation` after construction.
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (/SELECT.*FROM entities.*entity_type = 'location'/i.test(sql)) {
        return Promise.resolve({
          rows: [
            { id: 'loc-wharf', name: 'The Salt-Eaten Wharf' },
            { id: 'loc-hill', name: 'Lantern Hill' },
            { id: 'loc-causeway', name: 'The Drowned Causeway' },
          ],
        })
      }
      return Promise.resolve({ rows: [] })
    }),
  }
}

const HOOKS = {
  location_hooks: [
    {
      location_name: 'The Salt-Eaten Wharf',
      why_interesting:
        'A waterfront where the morning fog never quite lifts and the dock-hands speak in code.',
    },
    {
      location_name: 'Lantern Hill',
      why_interesting:
        'The silent house looms above the town; everyone has a theory, no one will say theirs out loud.',
    },
    {
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

    const client = makeClient()
    const result = await runStartingSituationStage(client as never, baseArgs)

    const proseUpdate = client.query.mock.calls.find((c: unknown[]) =>
      /UPDATE worlds SET starting_situations\b/i.test(String(c[0])),
    ) as [string, unknown[]] | undefined
    expect(proseUpdate).toBeDefined()
    if (proseUpdate === undefined) throw new Error('unreachable')
    expect(proseUpdate[1][0]).toBe('wld-1')
    expect(JSON.parse(proseUpdate[1][1] as string)).toEqual(HOOKS)

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

    const client = makeClient()
    await runStartingSituationStage(client as never, baseArgs)

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
    const client = makeClient()
    client.query.mockImplementation((sql: string) => {
      if (/SELECT.*FROM entities.*entity_type = 'location'/i.test(sql)) {
        return Promise.resolve({
          rows: [
            { id: 'loc-1', name: 'The Whispering Well' },
            { id: 'loc-2', name: 'Ashen Market' },
            { id: 'loc-3', name: 'Iron Sept' },
          ],
        })
      }
      return Promise.resolve({ rows: [] })
    })

    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        location_hooks: [
          { location_name: 'The Whispering Well', why_interesting: 'short note about the well' },
          { location_name: 'Ashen Market', why_interesting: 'a market story' },
          { location_name: 'Iron Sept', why_interesting: 'a temple ruin' },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 600, totalTokens: 1600 },
    } as never)

    await runStartingSituationStage(client as never, baseArgs)

    const updateCalls = client.query.mock.calls.filter((c: unknown[]) =>
      /UPDATE worlds/i.test(String(c[0])),
    )
    const entriesUpdate = updateCalls.find((c: unknown[]) =>
      /starting_situation_entries/i.test(String(c[0])),
    ) as [string, unknown[]] | undefined
    expect(entriesUpdate).toBeDefined()
    if (entriesUpdate === undefined) throw new Error('unreachable')
    const params = entriesUpdate[1]
    const payload = JSON.parse(params[1] as string) as {
      index: number
      locationEntityId: string
      prose: string
    }[]
    expect(payload.map((p) => p.locationEntityId)).toEqual(['loc-1', 'loc-2', 'loc-3'])
  })

  it('throws LlmStructuredOutputError after one retry when a location_name does not match', async () => {
    const client = makeClient()
    client.query.mockImplementation((sql: string) => {
      if (/SELECT.*FROM entities.*entity_type = 'location'/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'loc-1', name: 'The Real Place' }] })
      }
      return Promise.resolve({ rows: [] })
    })
    vi.mocked(ai.generateText).mockResolvedValue({
      output: {
        location_hooks: [
          { location_name: 'Not A Real Place', why_interesting: 'fictional' },
          { location_name: 'Also Not Real', why_interesting: 'fictional' },
          { location_name: 'Likewise', why_interesting: 'fictional' },
        ],
      },
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 600, totalTokens: 1600 },
    } as never)

    await expect(runStartingSituationStage(client as never, baseArgs)).rejects.toThrow(
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

    const client = makeClient()
    await runStartingSituationStage(client as never, {
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
