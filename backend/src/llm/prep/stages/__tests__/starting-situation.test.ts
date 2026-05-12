// backend/src/llm/prep/stages/__tests__/starting-situation.test.ts
//
// Per MYT-51 T6. Stage 4 contract: one Sonnet call via generateText +
// Output.object, persist the JSON-encoded `location_hooks` to
// `worlds.starting_situations`, return cost math.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runStartingSituationStage } from '../starting-situation.js'
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

    expect(client.query).toHaveBeenCalledTimes(1)
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('UPDATE worlds SET starting_situations')
    expect(params[0]).toBe('wld-1')
    expect(JSON.parse(params[1] as string)).toEqual(HOOKS)

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
})
