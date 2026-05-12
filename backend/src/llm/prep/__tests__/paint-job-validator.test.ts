import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  validateAndGenerateConcept,
  type PaintJobJudgement,
} from '../paint-job-validator.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const TestSchema = z.object({ name: z.string(), concept: z.string() })
type TestDraft = z.infer<typeof TestSchema>

function mockGenerator(
  draft: TestDraft,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } = {
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
  },
): void {
  vi.mocked(ai.generateText).mockResolvedValueOnce({
    output: draft,
    finishReason: 'stop',
    usage,
  } as never)
}

function mockJudge(judgement: Partial<PaintJobJudgement>): void {
  vi.mocked(ai.generateText).mockResolvedValueOnce({
    output: {
      flagged: false,
      confidence: 0.95,
      mirroredWork: null,
      specificDriftAxes: [],
      ...judgement,
    },
    finishReason: 'stop',
    usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
  } as never)
}

describe('validateAndGenerateConcept', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the draft when first judge call clears it', async () => {
    mockGenerator({ name: 'Aelmoor', concept: 'a windswept archipelago' })
    mockJudge({ flagged: false, confidence: 0.95 })
    const result = await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })
    expect(result.draft.name).toBe('Aelmoor')
    expect(result.attempts).toBe(1)
    expect(result.totalUsage.totalTokens).toBe(300) // 200 gen + 100 judge
  })

  it('retries with fresh context when judge flags (≤2 retries, 3 total)', async () => {
    mockGenerator({ name: 'Burrowfolk', concept: 'magical school' })
    mockJudge({
      flagged: true,
      confidence: 0.92,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['plot', 'characters'],
    })
    mockGenerator({ name: 'Pigmoles', concept: 'magical school still' })
    mockJudge({
      flagged: true,
      confidence: 0.9,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['plot'],
    })
    mockGenerator({
      name: 'Tidekeep',
      concept: 'lighthouse-and-storm-spirit world',
    })
    mockJudge({ flagged: false, confidence: 0.95 })

    const result = await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })
    expect(result.draft.name).toBe('Tidekeep')
    expect(result.attempts).toBe(3)
    // Verify that the retry's prompt amends with mirroredWork + drift axes.
    // Call index 2 is the 2nd generator call (calls 0,2,4 are generators; 1,3,5 are judges).
    const secondGenCall = vi.mocked(ai.generateText).mock.calls.at(2)?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(secondGenCall.prompt).toContain('Harry Potter')
    expect(secondGenCall.prompt).toContain('plot')
  })

  it('throws PaintJobLoopExhaustedError after 3 attempts all flagged', async () => {
    mockGenerator({ name: 'A', concept: '1' })
    mockJudge({
      flagged: true,
      confidence: 0.95,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['plot'],
    })
    mockGenerator({ name: 'B', concept: '2' })
    mockJudge({
      flagged: true,
      confidence: 0.95,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['plot'],
    })
    mockGenerator({ name: 'C', concept: '3' })
    mockJudge({
      flagged: true,
      confidence: 0.95,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['plot'],
    })

    await expect(
      validateAndGenerateConcept({
        basePrompt: 'Generate a world',
        schema: TestSchema,
      }),
    ).rejects.toThrow(/concept_intake_paint_job_loop_exhausted/)
  })

  it('does NOT include the rejected draft in the retry prompt (fresh context)', async () => {
    mockGenerator({
      name: 'Burrowfolk',
      concept: 'UNIQUE_FAILING_DRAFT_TEXT',
    })
    mockJudge({
      flagged: true,
      confidence: 0.92,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['plot'],
    })
    mockGenerator({ name: 'OK', concept: 'good' })
    mockJudge({ flagged: false, confidence: 0.95 })

    await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })

    // Second generator call (index 2) prompt should NOT contain the failing draft text.
    const secondGenCall = vi.mocked(ai.generateText).mock.calls.at(2)?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(secondGenCall.prompt).not.toContain('UNIQUE_FAILING_DRAFT_TEXT')
  })

  it('raises temperature on retry attempts for divergence', async () => {
    mockGenerator({ name: 'Burrowfolk', concept: 'magical school' })
    mockJudge({
      flagged: true,
      confidence: 0.92,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['plot'],
    })
    mockGenerator({ name: 'OK', concept: 'good' })
    mockJudge({ flagged: false, confidence: 0.95 })

    await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })

    const firstGenCall = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as Record<
      string,
      unknown
    >
    const secondGenCall = vi.mocked(ai.generateText).mock.calls.at(2)?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(firstGenCall.temperature).toBeCloseTo(0.9)
    expect(secondGenCall.temperature).toBeCloseTo(1.0)
  })
})
