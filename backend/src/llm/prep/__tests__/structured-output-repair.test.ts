// backend/src/llm/prep/__tests__/structured-output-repair.test.ts
//
// Tests the Haiku/Sonnet structured-output repair helper. We mock the `ai`
// module so no real Anthropic calls happen; the mock returns the `output` +
// `usage` shape that `generateText` produces when invoked with
// `Output.object({ schema })`. The helper then re-validates with the same
// Zod schema and returns `{ ok: true | false, ..., usage }`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { HAIKU, SONNET } from '../../models.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

import { generateText } from 'ai'
import { repairStructuredOutput } from '../structured-output-repair.js'

const mockGenerateText = vi.mocked(generateText)

const TestSchema = z.object({
  name: z.string().min(1).max(50),
  age: z.number().int().min(0),
})

// safeParse-as-error helper: every test passes a known-invalid object
// here, so .success is always false; the throw branch documents the
// invariant without needing a non-null assertion.
function zodErrorFor(value: unknown): z.ZodError {
  const parsed = TestSchema.safeParse(value)
  if (parsed.success) {
    throw new Error('test fixture: expected an invalid value to produce a ZodError')
  }
  return parsed.error
}

describe('repairStructuredOutput', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
  })

  it('returns { ok: true, tree } when repair output validates', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Alice', age: 30 },
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await repairStructuredOutput({
      tree: { name: 'Alice', age: 'thirty' },
      schema: TestSchema,
      zodErrors: zodErrorFor({ name: 'Alice', age: 'thirty' }),
      model: HAIKU,
      stage: 'world_and_factions',
      providerOptions: { mythrun: { stage: 'world_and_factions' } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tree).toEqual({ name: 'Alice', age: 30 })
    }
  })

  it('returns { ok: false } when repair output still fails validation', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: '', age: -5 },
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await repairStructuredOutput({
      tree: { name: 'Alice', age: 'thirty' },
      schema: TestSchema,
      zodErrors: zodErrorFor({ name: 'Alice', age: 'thirty' }),
      model: HAIKU,
      stage: 'world_and_factions',
      providerOptions: { mythrun: { stage: 'world_and_factions' } },
    })
    expect(result.ok).toBe(false)
  })

  it('returns usage from the underlying generateText call', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Bob', age: 25 },
      usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await repairStructuredOutput({
      tree: { name: 'Bob', age: 'unknown' },
      schema: TestSchema,
      zodErrors: zodErrorFor({ name: 'Bob', age: 'unknown' }),
      model: SONNET,
      stage: 'locations_and_npcs',
      providerOptions: { mythrun: { stage: 'locations_and_npcs' } },
    })
    expect(result.usage.inputTokens).toBe(200)
    expect(result.usage.outputTokens).toBe(80)
  })
})
