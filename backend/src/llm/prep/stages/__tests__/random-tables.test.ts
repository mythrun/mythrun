// backend/src/llm/prep/stages/__tests__/random-tables.test.ts
//
// Per MYT-51 T6. Stage 5 contract: one Haiku call via generateText +
// Output.object; idempotent DELETE of prior random_tables for this world;
// INSERT one row per table + one row per entry; return Haiku-priced cost.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runRandomTablesStage } from '../random-tables.js'
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

    const client = makeClient()
    const result = await runRandomTablesStage(client as never, baseArgs)

    // 1 DELETE + 2 random_tables INSERTs + 40 random_table_entries INSERTs = 43
    expect(client.query).toHaveBeenCalledTimes(43)

    const [deleteSql, deleteParams] = client.query.mock.calls[0] as [string, unknown[]]
    expect(deleteSql).toContain('DELETE FROM random_tables WHERE world_id')
    expect(deleteParams[0]).toBe('wld-1')

    // First table insert (call index 1):
    const [firstTableSql, firstTableParams] = client.query.mock.calls[1] as [string, unknown[]]
    expect(firstTableSql).toContain('INSERT INTO random_tables')
    expect(firstTableParams[1]).toBe('wld-1')
    expect(firstTableParams[2]).toBe('Regional NPC Quirks of the Salted Reach')
    expect(firstTableParams[3]).toBe('regional_npc_quirks')

    // First entry insert (call index 2):
    const [firstEntrySql, firstEntryParams] = client.query.mock.calls[2] as [string, unknown[]]
    expect(firstEntrySql).toContain('INSERT INTO random_table_entries')
    // table_id at $2 equals the first random_tables insert's $1 (uuidv7)
    expect(firstEntryParams[1]).toBe(firstTableParams[0])
    expect(firstEntryParams[2]).toBe(1)
    expect(firstEntryParams[3]).toBe(1)
    expect(firstEntryParams[4]).toBe('quirk entry 1')

    // Haiku pricing: 2000/1M * 1 + 1500/1M * 5 = 0.002 + 0.0075 = 0.0095
    expect(result.costUsd).toBeCloseTo(0.0095, 4)
    expect(result.inputTokens).toBe(2000)
    expect(result.outputTokens).toBe(1500)
  })

  it('renders all template placeholders into the Haiku prompt', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: TABLES,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 1500, totalTokens: 3500 },
    } as never)

    const client = makeClient()
    await runRandomTablesStage(client as never, baseArgs)

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
})
