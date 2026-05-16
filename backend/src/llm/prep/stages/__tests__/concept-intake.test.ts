// backend/src/llm/prep/stages/__tests__/concept-intake.test.ts
//
// Per MYT-51 T6: stage handler integrates the paint-job-validator loop
// (generator + judge) and persists the validated draft. The validator's
// internals are covered by paint-job-validator.test.ts — here we only
// assert the stage's contract: generator + judge get called, the UPDATE
// SQL fires with the right bindings, and the returned StageCostResult
// reflects the summed Sonnet usage from both calls.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runConceptIntakeStage } from '../concept-intake.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

interface QuerySpy {
  query: ReturnType<typeof vi.fn>
}

function makeClient(): QuerySpy {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

const DRAFT = {
  name: 'Aelmoor',
  tone: 'misted, melancholy, watchful',
  themes: 'guardianship, secrets, weather over still water',
  geography_summary:
    'A windswept highland archipelago on the edge of an older, drowned power — long causeways between black islands.',
  political_summary:
    'Three rival lighthouse-houses, each binding storm-spirits into their lamps; the queen rules from a fourth that has gone dark.',
  era: 'a lantern-age before steam, after the last great storm-pact failed',
  key_tensions:
    'The spirits chafe in the lanterns. One house has gone silent for a year. The drowned power below has begun to dream again, and its dreams smell of salt and copper.',
  follow_up_questions:
    'Who lit the silent house? Why is the queen no longer in residence? What watches from the cliffs at the spring tides?',
}

describe('runConceptIntakeStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the validator, persists to worlds columns, and returns aggregated cost', async () => {
    // Generator call:
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: DRAFT,
      finishReason: 'stop',
      usage: { inputTokens: 800, outputTokens: 600, totalTokens: 1400 },
    } as never)
    // Judge call — clean:
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: { flagged: false, confidence: 0.95, mirroredWork: null, specificDriftAxes: [] },
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    } as never)

    const client = makeClient()
    const result = await runConceptIntakeStage(client as never, {
      worldId: 'wld-1',
      conceptText: 'lighthouse-keepers tending storm spirits',
      intentSummary: null,
    })

    // myth-4lhr: concept_intake now issues TWO updates — worlds first
    // (the existing path), then campaigns (the new name propagation so
    // campaigns.name stops being 'Untitled').
    expect(client.query).toHaveBeenCalledTimes(2)
    const [worldsSql, worldsParams] = client.query.mock.calls[0] as [string, unknown[]]
    expect(worldsSql).toContain('UPDATE worlds SET')
    expect(worldsSql).toContain('name = $2')
    expect(worldsParams[0]).toBe('wld-1')
    expect(worldsParams[1]).toBe('Aelmoor')
    expect(worldsParams[2]).toBe(DRAFT.tone)
    const [campSql, campParams] = client.query.mock.calls[1] as [string, unknown[]]
    expect(campSql).toContain('UPDATE campaigns SET name')
    expect(campSql).toContain("name = 'Untitled'")
    expect(campParams).toEqual(['wld-1', 'Aelmoor'])

    // (800+200)/1M * 3 + (600+100)/1M * 15 = 0.003 + 0.0105 = 0.0135
    expect(result.costUsd).toBeCloseTo(0.0135, 4)
    expect(result.inputTokens).toBe(1000)
    expect(result.outputTokens).toBe(700)
  })

  it('renders intentSummary into the generator prompt when present (guided mode)', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: DRAFT,
      finishReason: 'stop',
      usage: { inputTokens: 800, outputTokens: 600, totalTokens: 1400 },
    } as never)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: { flagged: false, confidence: 0.95, mirroredWork: null, specificDriftAxes: [] },
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    } as never)

    const client = makeClient()
    await runConceptIntakeStage(client as never, {
      worldId: 'wld-2',
      conceptText: 'storm-pact world',
      intentSummary: {
        aesthetics: ['salt-stained', 'lantern-lit'],
        themes: ['guardianship', 'inheritance'],
        sourcesInternal: ['private'],
      },
    })

    const genCall = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(genCall.prompt).toContain('salt-stained')
    expect(genCall.prompt).toContain('inheritance')
  })
})
