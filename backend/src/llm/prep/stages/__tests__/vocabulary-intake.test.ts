// backend/src/llm/prep/stages/__tests__/vocabulary-intake.test.ts
//
// myth-pfke T5: stage 1.5 handler integrates a single Sonnet generateObject
// call through the canonical ai.ts wrapper, stamps source='stage_1_5' +
// access_level='known' on each model-emitted entry, persists the registry
// jsonb to worlds, returns aggregated cost.
//
// Mock target: `'ai'` (the Vercel SDK) — matches the proven pattern used by
// every peer stage test in this directory (concept-intake, coherence-pass,
// world-and-factions, locations-and-npcs, random-tables, starting-situation).
// Mocking the canonical wrapper file `'../../ai.js'` directly does not
// intercept the handler's import in this codebase's vitest+ESM config;
// upstream-mocking `'ai'` works because the wrapper's internal call to
// `sdkGenerateText` is what produces the response. The wrapper's
// `Output.object` parsing populates the SDK result's `output` field with
// the typed object, so asserting on `mockGenerateText.mock.calls[0]?.[0]`
// (the SDK call args) still gives us prompt-substitution coverage.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runVocabularyIntakeStage } from '../vocabulary-intake.js'
import * as ai from 'ai'
import { makeFakeRepo } from './_helpers/fake-repo.js'
import type { Repo } from '../../../../repo/index.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

// The registry JSON the stage hands to repo.worlds.setVocabularyRegistry —
// pulled from the binder call's second arg (the serialized payload).
function persistedRegistry(repo: ReturnType<typeof makeFakeRepo>): unknown {
  const call = repo.worlds.setVocabularyRegistry.mock.calls[0] as [string, string] | undefined
  if (call === undefined) throw new Error('setVocabularyRegistry was not called')
  return JSON.parse(call[1])
}

const ARGS = {
  worldId: 'w1',
  worldName: 'Veil & Chalk',
  concept: 'A magical world focused on a wizarding academy...',
  tone: 'contemporary coming-of-age drama',
  themes: 'the burden of secret knowledge',
  era: 'Contemporary 2026',
  geographySummary: 'Britain, magical and mundane overlapping',
  politicalSummary: 'A magical ministry, pure-blood houses, rural traditionalists',
  keyTensions: 'The veil is cracking',
}

// Per myth-pfke's design pivot: stage 1.5 model output is entries-only
// (no adjacent_franchises, no avoids). Handler stamps source + access_level
// on each entry and stamps adjacent_franchises: [] on the registry.
const MODEL_OUTPUT = {
  entries: [
    {
      term: 'the unwitched',
      definition: "non-magical people; this world's term for those without arcane sight.",
    },
    {
      term: 'the Concordat of Concealment',
      definition: 'the law forbidding magical revelation to the unwitched.',
    },
  ],
}

const SONNET_USAGE = { inputTokens: 5000, outputTokens: 2000, totalTokens: 7000 }

describe('runVocabularyIntakeStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls Sonnet, stamps source + access_level, persists registry, returns cost', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: MODEL_OUTPUT,
      finishReason: 'stop',
      usage: SONNET_USAGE,
    } as never)

    const repo = makeFakeRepo()
    const result = await runVocabularyIntakeStage(repo as unknown as Repo, ARGS)

    // Persistence: single repo.worlds.setVocabularyRegistry write inside one
    // repo.transaction (the binder's SQL is covered by the worlds repo
    // integration test). Assert the serialized registry payload it received.
    expect(repo.transaction).toHaveBeenCalledTimes(1)
    expect(repo.worlds.setVocabularyRegistry).toHaveBeenCalledTimes(1)
    expect(repo.worlds.setVocabularyRegistry).toHaveBeenCalledWith('w1', expect.any(String))
    const payload = persistedRegistry(repo) as {
      adjacent_franchises: string[]
      entries: { term: string; source: string; access_level: string }[]
    }
    // Stage 1.5 always stamps adjacent_franchises empty per the design
    // pivot (IP-mirror detection lives in paint-job-validator).
    expect(payload.adjacent_franchises).toEqual([])
    expect(payload.entries).toHaveLength(2)
    expect(payload.entries[0]).toMatchObject({
      term: 'the unwitched',
      source: 'stage_1_5',
      access_level: 'known',
    })
    expect(payload.entries[1]?.source).toBe('stage_1_5')
    expect(payload.entries[1]?.access_level).toBe('known')

    // Cost: Sonnet pricing ($3/MTok input, $15/MTok output)
    expect(result.costUsd).toBeCloseTo((5000 / 1_000_000) * 3 + (2000 / 1_000_000) * 15, 6)
    expect(result.inputTokens).toBe(5000)
    expect(result.outputTokens).toBe(2000)
  })

  it('accepts empty entries (degenerate world)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { entries: [] },
      finishReason: 'stop',
      usage: SONNET_USAGE,
    } as never)

    const repo = makeFakeRepo()
    await runVocabularyIntakeStage(repo as unknown as Repo, ARGS)

    const payload = persistedRegistry(repo) as {
      entries: unknown[]
      adjacent_franchises: unknown[]
    }
    expect(payload.entries).toEqual([])
    expect(payload.adjacent_franchises).toEqual([])
  })

  it('rethrows LLM call errors so retry classification fires', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('rate limit'))

    const repo = makeFakeRepo()
    await expect(runVocabularyIntakeStage(repo as unknown as Repo, ARGS)).rejects.toThrow(
      /rate limit/,
    )
  })

  it('treats undefined usage tokens as 0 (cost = 0, both counters = 0)', async () => {
    // Exercises the `usage.inputTokens ?? 0` + `usage.outputTokens ?? 0`
    // fallbacks at vocabulary-intake.ts:99-100. The AI SDK v6 usage shape
    // allows undefined when the provider doesn't report counts; the stage
    // should NOT NaN-out the cost when that happens. Mirrors the peer
    // pattern at random-tables.test.ts:101.
    mockGenerateText.mockResolvedValueOnce({
      output: { entries: [] },
      finishReason: 'stop',
      usage: {},
    } as never)

    const repo = makeFakeRepo()
    const result = await runVocabularyIntakeStage(repo as unknown as Repo, ARGS)

    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
  })

  it('substitutes all template placeholders into the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { entries: [] },
      finishReason: 'stop',
      usage: SONNET_USAGE,
    } as never)

    const repo = makeFakeRepo()
    await runVocabularyIntakeStage(repo as unknown as Repo, ARGS)

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('Veil & Chalk')
    expect(callOpts.prompt).toContain('A magical world focused on a wizarding academy')
    expect(callOpts.prompt).toContain('contemporary coming-of-age drama')
    expect(callOpts.prompt).toContain('Contemporary 2026')
    expect(callOpts.prompt).toContain('Britain, magical and mundane overlapping')
    expect(callOpts.prompt).not.toContain('{{worldName}}')
    expect(callOpts.prompt).not.toContain('{{concept}}')
  })
})
