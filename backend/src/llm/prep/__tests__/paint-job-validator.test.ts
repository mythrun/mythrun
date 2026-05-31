import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { validateAndGenerateConcept, type PaintJobJudgement } from '../paint-job-validator.js'
import { LlmStructuredOutputError } from '../../errors.js'
import { OPUS, SONNET } from '../../models.js'
import { computeCostUsd } from '../../../billing/model-pricing.js'
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
      failureKind: 'none',
      adjacentFranchise: null,
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

  // ------------------------------------------------------------------
  // Mixed-model tiering (myth-rg09)
  //
  // The world-concept SYNTHESIS (the generator) runs on Opus for higher
  // foundational-synthesis quality; the IP-mirror JUDGE stays on Sonnet
  // (cheapest-capable guardrail per the tiered-inference principle). Cost
  // is therefore computed PER-TIER inside the validator — Opus rates for
  // generator usage, Sonnet rates for judge usage — and summed.
  // ------------------------------------------------------------------

  it('runs the generator on OPUS and the judge on SONNET', async () => {
    mockGenerator({ name: 'Aelmoor', concept: 'a windswept archipelago' })
    mockJudge({ flagged: false, confidence: 0.95 })

    await validateAndGenerateConcept({ basePrompt: 'Generate a world', schema: TestSchema })

    // Calls 0,2,4 are generators; 1,3,5 are judges.
    const genCall = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as {
      model: unknown
    }
    const judgeCall = vi.mocked(ai.generateText).mock.calls.at(1)?.[0] as unknown as {
      model: unknown
    }
    expect(genCall.model).toBe(OPUS)
    expect(judgeCall.model).toBe(SONNET)
  })

  it('computes costUsd per-tier (Opus generator + Sonnet judge) and sums them', async () => {
    const genUsage = { inputTokens: 800, outputTokens: 600, totalTokens: 1400 }
    const judgeUsage = { inputTokens: 200, outputTokens: 100, totalTokens: 300 }
    mockGenerator({ name: 'Aelmoor', concept: 'a windswept archipelago' }, genUsage)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        flagged: false,
        confidence: 0.95,
        mirroredWork: null,
        specificDriftAxes: [],
        failureKind: 'none',
        adjacentFranchise: null,
      },
      finishReason: 'stop',
      usage: judgeUsage,
    } as never)

    const result = await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })

    const expectedCost =
      computeCostUsd('claude-opus-4-7', genUsage) + computeCostUsd('claude-sonnet-4-6', judgeUsage)
    expect(result.costUsd).toBeCloseTo(expectedCost, 10)
    // Combined token TOTALS are still surfaced (counts, not prices) for the
    // pipeline_runs input/output token columns.
    expect(result.totalUsage.inputTokens).toBe(1000)
    expect(result.totalUsage.outputTokens).toBe(700)
  })

  it('accumulates per-tier cost across retries (two Opus generators + two Sonnet judges)', async () => {
    const gen1 = { inputTokens: 800, outputTokens: 600, totalTokens: 1400 }
    const judge1 = { inputTokens: 200, outputTokens: 100, totalTokens: 300 }
    const gen2 = { inputTokens: 900, outputTokens: 500, totalTokens: 1400 }
    const judge2 = { inputTokens: 220, outputTokens: 90, totalTokens: 310 }

    mockGenerator({ name: 'Burrowfolk', concept: 'magical school' }, gen1)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        flagged: true,
        confidence: 0.92,
        mirroredWork: 'Harry Potter',
        specificDriftAxes: ['plot'],
        failureKind: 'structural',
        adjacentFranchise: 'Harry Potter',
      },
      finishReason: 'stop',
      usage: judge1,
    } as never)
    mockGenerator({ name: 'Tidekeep', concept: 'storm-spirit world' }, gen2)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: {
        flagged: false,
        confidence: 0.95,
        mirroredWork: null,
        specificDriftAxes: [],
        failureKind: 'none',
        adjacentFranchise: null,
      },
      finishReason: 'stop',
      usage: judge2,
    } as never)

    const result = await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })

    const expectedCost =
      computeCostUsd('claude-opus-4-7', {
        inputTokens: gen1.inputTokens + gen2.inputTokens,
        outputTokens: gen1.outputTokens + gen2.outputTokens,
      }) +
      computeCostUsd('claude-sonnet-4-6', {
        inputTokens: judge1.inputTokens + judge2.inputTokens,
        outputTokens: judge1.outputTokens + judge2.outputTokens,
      })
    expect(result.attempts).toBe(2)
    expect(result.costUsd).toBeCloseTo(expectedCost, 10)
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

  // ------------------------------------------------------------------
  // Vocabulary-mirroring check (myth-3e4y)
  //
  // The judge now scores VOCABULARY mirroring on top of structural
  // mirroring: a concept can have structurally original bones yet invoke
  // a single franchise so directly that downstream stages will leak that
  // franchise's iconic neologisms (Veil & Chalk → "muggle"/"Statute of
  // Secrecy"/"Floo"). Such a concept is rejected even though the existing
  // structural axes (plot/characters/factions/setting) all clear.
  // ------------------------------------------------------------------

  it('rejects a vocabulary-mirroring concept that clears the structural check', async () => {
    // Veil & Chalk shape: structurally original (failureKind=vocabulary,
    // not structural), but so HP-shaped that downstream vocabulary leaks.
    mockGenerator({ name: 'Veil & Chalk', concept: 'wizarding academy + hidden mundane world' })
    mockJudge({
      flagged: true,
      confidence: 0.93,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['vocabulary: "muggle"/"Statute of Secrecy"/"Floo" will leak downstream'],
      failureKind: 'vocabulary',
      adjacentFranchise: 'Harry Potter',
    })
    // Three flagged attempts → terminal (the concept is fundamentally
    // franchise-shaped; re-running yields the same flag).
    mockGenerator({ name: 'Veil 2', concept: 'still a wizarding academy' })
    mockJudge({
      flagged: true,
      confidence: 0.93,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['vocabulary'],
      failureKind: 'vocabulary',
      adjacentFranchise: 'Harry Potter',
    })
    mockGenerator({ name: 'Veil 3', concept: 'still a wizarding academy' })
    mockJudge({
      flagged: true,
      confidence: 0.93,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['vocabulary'],
      failureKind: 'vocabulary',
      adjacentFranchise: 'Harry Potter',
    })

    await expect(
      validateAndGenerateConcept({ basePrompt: 'Generate a world', schema: TestSchema }),
    ).rejects.toThrow(/concept_intake_paint_job_loop_exhausted/)
  })

  it('passes a structurally-clean concept and surfaces adjacentFranchise=null on the result', async () => {
    // Sword-and-sorcery shape: borrows generic genre furniture but invokes
    // no single franchise — failureKind=none, adjacentFranchise=null.
    mockGenerator({ name: 'Saltmarch', concept: 'feuding coastal city-states' })
    mockJudge({
      flagged: false,
      confidence: 0.96,
      mirroredWork: null,
      specificDriftAxes: [],
      failureKind: 'none',
      adjacentFranchise: null,
    })

    const result = await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })
    expect(result.draft.name).toBe('Saltmarch')
    expect(result.attempts).toBe(1)
    expect(result.adjacentFranchise).toBeNull()
  })

  it('surfaces adjacentFranchise on the result when a passing concept is franchise-adjacent', async () => {
    // A concept can clear the flag (confidence at-or-below threshold) yet
    // still be adjacent to a franchise. The validator surfaces that soft
    // signal so downstream UI / world-snapshot can display it (myth-3e4y #4).
    mockGenerator({ name: 'Veil & Chalk', concept: 'wizarding academy, original bones' })
    mockJudge({
      flagged: true,
      confidence: 0.8, // <= FLAG_THRESHOLD (0.85) → not rejected
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['vocabulary'],
      failureKind: 'vocabulary',
      adjacentFranchise: 'Harry Potter',
    })

    const result = await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })
    expect(result.attempts).toBe(1)
    expect(result.adjacentFranchise).toBe('Harry Potter')
  })

  it('steers the retry off the franchise vocabulary when failureKind=vocabulary', async () => {
    mockGenerator({ name: 'Veil & Chalk', concept: 'wizarding academy + hidden mundane world' })
    mockJudge({
      flagged: true,
      confidence: 0.93,
      mirroredWork: 'Harry Potter',
      specificDriftAxes: ['Section-14-style mundane-intelligence framing'],
      failureKind: 'vocabulary',
      adjacentFranchise: 'Harry Potter',
    })
    mockGenerator({ name: 'Hollowfen', concept: 'bog-witch fenland with no academy' })
    mockJudge({ flagged: false, confidence: 0.95 })

    await validateAndGenerateConcept({ basePrompt: 'Generate a world', schema: TestSchema })

    const secondGenCall = vi.mocked(ai.generateText).mock.calls.at(2)?.[0] as unknown as Record<
      string,
      unknown
    >
    // The retry prompt must carry an explicit vocabulary-steer clause keyed
    // off failureKind — NOT merely echo the drift-axes string (here the axis
    // doesn't even contain the word "vocabulary"). Pins the failureKind-driven
    // branch in buildRetryPrompt.
    expect(secondGenCall.prompt).toContain('franchise-iconic')
    expect(secondGenCall.prompt).toContain('Harry Potter')
  })

  // ------------------------------------------------------------------
  // SDK structured-output failure → Sonnet repair fallback
  // ------------------------------------------------------------------

  // A synthetic AI_NoObjectGeneratedError-shaped error: the original SDK
  // error class carries `.text` (last attempted output) which the
  // middleware preserves on the wrapping LlmStructuredOutputError's
  // `.cause`. The fallback parses the text, runs safeParse, calls the
  // repair LLM (Sonnet) via repairStructuredOutput, and uses its output
  // if successful.
  function mockSdkSchemaFailure(rawText: string): void {
    const cause = Object.assign(new Error('AI_NoObjectGeneratedError'), {
      name: 'AI_NoObjectGeneratedError',
      text: rawText,
    })
    const err = new LlmStructuredOutputError('llm returned unparseable structured output', { cause })
    vi.mocked(ai.generateText).mockRejectedValueOnce(err)
  }

  it('falls back to Sonnet repair when SDK throws structured-output error with parseable text', async () => {
    // First gen call throws structured-output error; .cause.text is JSON
    // that JSON.parses but fails the schema (concept too short → mock the
    // shape that triggers safeParse failure). The repair call (also via
    // ai.generateText, queued next) returns a valid draft.
    const invalidText = JSON.stringify({ name: '', concept: '' }) // both empty → fails schema
    mockSdkSchemaFailure(invalidText)
    // repairStructuredOutput's inner generateText call:
    mockGenerator({ name: 'RepairedName', concept: 'repaired concept text' })
    // Judge call clears the repaired draft:
    mockJudge({ flagged: false, confidence: 0.95 })

    const TighterSchema = z.object({
      name: z.string().min(1),
      concept: z.string().min(1),
    })

    const result = await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TighterSchema,
    })

    expect(result.draft).toEqual({ name: 'RepairedName', concept: 'repaired concept text' })
    expect(result.attempts).toBe(1)
    // gen failure + repair gen + judge = 3 SDK calls total
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(3)
  })

  it('uses the rawText directly when SDK rejects valid JSON (defensive fallback)', async () => {
    // SDK throws but the text actually JSON-parses + passes Zod. The
    // fallback uses the parsed value directly without calling the
    // repair LLM. Tests the safe-parse-succeeds branch.
    const validText = JSON.stringify({ name: 'DirectName', concept: 'direct concept' })
    mockSdkSchemaFailure(validText)
    mockJudge({ flagged: false, confidence: 0.95 })

    const result = await validateAndGenerateConcept({
      basePrompt: 'Generate a world',
      schema: TestSchema,
    })

    expect(result.draft).toEqual({ name: 'DirectName', concept: 'direct concept' })
    // gen failure + judge (no repair call needed) = 2 SDK calls
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(2)
  })

  it('rethrows the original LlmStructuredOutputError when repair also fails', async () => {
    // First gen call throws structured-output error; repair call also
    // returns schema-invalid output → original error rethrows.
    const invalidText = JSON.stringify({ name: '', concept: '' })
    mockSdkSchemaFailure(invalidText)
    // Repair LLM also returns invalid output:
    mockGenerator({ name: '', concept: '' }) // still empty strings, still fails the tighter schema

    const TighterSchema = z.object({
      name: z.string().min(1),
      concept: z.string().min(1),
    })

    await expect(
      validateAndGenerateConcept({
        basePrompt: 'Generate a world',
        schema: TighterSchema,
      }),
    ).rejects.toThrow(/unparseable structured output/)
  })

  it('rethrows when SDK error has no .cause.text to repair', async () => {
    // Structurally invalid LlmStructuredOutputError — no underlying SDK
    // error, no rawText to feed the repair pass. Original error rethrows.
    vi.mocked(ai.generateText).mockRejectedValueOnce(
      new LlmStructuredOutputError('llm returned unparseable structured output'),
    )

    await expect(
      validateAndGenerateConcept({
        basePrompt: 'Generate a world',
        schema: TestSchema,
      }),
    ).rejects.toThrow(/unparseable structured output/)
  })

  it('rethrows when SDK rawText is not JSON-parseable', async () => {
    // SDK threw + .cause.text is present but not valid JSON. The fallback
    // can't feed it to the repair LLM, so the original error rethrows.
    mockSdkSchemaFailure('this is not json at all')

    await expect(
      validateAndGenerateConcept({
        basePrompt: 'Generate a world',
        schema: TestSchema,
      }),
    ).rejects.toThrow(/unparseable structured output/)
  })

  it('rethrows non-LlmStructuredOutputError errors verbatim (no fallback)', async () => {
    // Generic upstream error (e.g., LlmRateLimitedError) is NOT a
    // structured-output failure — the repair fallback shouldn't fire.
    vi.mocked(ai.generateText).mockRejectedValueOnce(new Error('rate limited'))

    await expect(
      validateAndGenerateConcept({
        basePrompt: 'Generate a world',
        schema: TestSchema,
      }),
    ).rejects.toThrow(/rate limited/)
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(1)
  })
})
