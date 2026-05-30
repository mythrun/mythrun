// backend/src/llm/prep/stages/__tests__/random-tables.test.ts
//
// Per MYT-51 T6. Stage 5 contract: one Haiku call via generateText +
// Output.object; idempotent DELETE of prior random_tables for this world;
// INSERT one row per table + one row per entry; return Haiku-priced cost.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runRandomTablesStage } from '../random-tables.js'
import * as ai from 'ai'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'
import { makeFakeRepo } from './_helpers/fake-repo.js'
import type { Repo } from '../../../../repo/index.js'

const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

function makeEntries(prefix: string): { roll_min: number; roll_max: number; content: string }[] {
  return Array.from({ length: 20 }, (_, i) => ({
    roll_min: i + 1,
    roll_max: i + 1,
    content: `${prefix} entry ${String(i + 1)}`,
  }))
}

const TABLES = {
  tables: [
    {
      name: 'Regional NPC Quirks of the Salted Reach',
      category: 'regional_npc_quirks',
      entries: makeEntries('quirk'),
    },
    {
      name: 'Travel Encounters in the Lantern Highlands',
      category: 'travel_encounters',
      entries: makeEntries('encounter'),
    },
  ],
}

const baseArgs = {
  worldId: 'wld-1',
  worldName: 'Aelmoor',
  tone: 'misted, melancholy',
  themes: 'guardianship, secrets',
  era: 'a lantern-age',
  geographySummary: 'A windswept highland archipelago.',
  seedTablesBlock: '### Generic Travel Encounters\n  1. A merchant\n  2. A bandit',
  vocabularyRegistry: EMPTY_REGISTRY,
}

describe('runRandomTablesStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists 2 tables × 20 entries; idempotent DELETE then INSERTs; Haiku-priced cost', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: TABLES,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 1500, totalTokens: 3500 },
    } as never)

    const repo = makeFakeRepo()
    // insertTable returns a distinct id per call so the entries are keyed to
    // the right table (mirrors the binder's per-table uuidv7).
    repo.randomTables.insertTable
      .mockResolvedValueOnce('table-0')
      .mockResolvedValueOnce('table-1')
    const result = await runRandomTablesStage(repo as unknown as Repo, baseArgs)

    // Post data-layer-unification: the DELETE + per-table INSERTs run inside
    // one repo.transaction via the randomTables binder (the binder SQL is
    // covered by random-tables.test in src/repo/__tests__). Assert the
    // persistence contract at the binder-call level: idempotency DELETE first,
    // then one insertTable + one insertEntries per table, with entries keyed
    // to the returned table id.
    expect(repo.transaction).toHaveBeenCalledTimes(1)
    expect(repo.randomTables.deleteByWorld).toHaveBeenCalledTimes(1)
    expect(repo.randomTables.deleteByWorld).toHaveBeenCalledWith('wld-1')

    // deleteByWorld runs BEFORE the first insertTable (retry idempotency).
    const deleteOrder = repo.randomTables.deleteByWorld.mock.invocationCallOrder[0] ?? 0
    const firstInsertOrder = repo.randomTables.insertTable.mock.invocationCallOrder[0] ?? 0
    expect(deleteOrder).toBeLessThan(firstInsertOrder)

    expect(repo.randomTables.insertTable).toHaveBeenCalledTimes(2)
    expect(repo.randomTables.insertTable).toHaveBeenNthCalledWith(1, {
      worldId: 'wld-1',
      name: 'Regional NPC Quirks of the Salted Reach',
      category: 'regional_npc_quirks',
    })

    // Entries for table 0: keyed to 'table-0', 20 rows, first entry verbatim.
    expect(repo.randomTables.insertEntries).toHaveBeenCalledTimes(2)
    const firstEntriesCall = repo.randomTables.insertEntries.mock.calls[0] as [
      string,
      { roll_min: number; roll_max: number; content: string }[],
    ]
    expect(firstEntriesCall[0]).toBe('table-0')
    expect(firstEntriesCall[1]).toHaveLength(20)
    expect(firstEntriesCall[1][0]).toEqual({ roll_min: 1, roll_max: 1, content: 'quirk entry 1' })

    // Haiku pricing: 2000/1M * 1 + 1500/1M * 5 = 0.002 + 0.0075 = 0.0095
    expect(result.costUsd).toBeCloseTo(0.0095, 4)
    expect(result.inputTokens).toBe(2000)
    expect(result.outputTokens).toBe(1500)
  })

  it('treats undefined usage tokens as 0 (cost = 0, both counters = 0)', async () => {
    // Exercises the `usage.inputTokens ?? 0` + `usage.outputTokens ?? 0`
    // fallbacks at random-tables.ts:123-127. The AI SDK v6 usage shape
    // allows undefined when the provider doesn't report counts; the
    // stage should NOT NaN-out the cost when that happens.
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: TABLES,
      finishReason: 'stop',
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
    } as never)

        const result = await runRandomTablesStage(makeFakeRepo() as unknown as Repo, baseArgs)

    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
  })

  it('renders all template placeholders into the Haiku prompt', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: TABLES,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 1500, totalTokens: 3500 },
    } as never)

        await runRandomTablesStage(makeFakeRepo() as unknown as Repo, baseArgs)

    const call = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as Record<
      string,
      unknown
    >
    const prompt = call.prompt as string
    expect(prompt).toContain('Aelmoor')
    expect(prompt).toContain('a lantern-age')
    expect(prompt).toContain('A windswept highland archipelago.')
    expect(prompt).toContain('Generic Travel Encounters')
    expect(prompt).not.toContain('{{name}}')
    expect(prompt).not.toContain('{{seed_tables}}')
  })

  // myth-pfke task 9e: vocabulary registry placeholder substitution.
  it('substitutes {{vocabularyRegistry}} with the rendered registry prose', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: TABLES,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 1500, totalTokens: 3500 },
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

        await runRandomTablesStage(makeFakeRepo() as unknown as Repo, {
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
