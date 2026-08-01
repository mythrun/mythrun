// Pure-unit LLM primitive test (no DB) — mirrors synthesize-concept.test.ts.
// The `ai` package's `generateText` is mocked so the wrapper's generateObject
// returns canned output without a real Anthropic call. This test asserts the
// prompt threads both the prior concept and the change note, and that the
// returned tree is validated against SynthesizerOutput.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviseConcept } from '../revise-concept.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateText: vi.fn(),
  }
})

describe('reviseConcept', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('revises the prior concept per the change note and returns the parsed output', async () => {
    const mockResult = {
      output: {
        title: 'The Dry Canals',
        concept:
          'A drought-stricken city of dry canals where memory-keepers trade forgotten names for water rights, and every well runs on borrowed recollection rather than rain.',
        intentSummary: {
          aesthetics: ['sun-bleached stone', 'dust-veiled light'],
          themes: ['forgetting as currency', 'scarcity under a dead sky'],
          sourcesInternal: ['prior concept + change note (water down, forgetting up)'],
        },
      },
      finishReason: 'stop',
      usage: { inputTokens: 420, outputTokens: 310, totalTokens: 730 },
    } as never
    vi.mocked(ai.generateText).mockResolvedValueOnce(mockResult)

    const result = await reviseConcept(
      {
        title: 'The Black Canals',
        concept: 'a drowned city of black canals where the rain never stops',
      },
      'less water, more forgetting',
    )

    expect(result.concept).toContain('memory-keepers')
    expect(result.intentSummary.themes).toContain('forgetting as currency')
    expect(result.title).toBe('The Dry Canals')

    const callArgs = vi.mocked(ai.generateText).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(callArgs.prompt).toContain('a drowned city of black canals')
    expect(callArgs.prompt).toContain('less water, more forgetting')
    expect(callArgs.providerOptions).toMatchObject({ mythrun: { stage: 'concept_intake' } })
    // myth-z3icr: the prior TITLE is in the prompt too — a revision cannot keep
    // a name it was never shown.
    expect(callArgs.prompt).toContain('The Black Canals')
  })

  it('throws when the model output violates the concept schema (under-length)', async () => {
    const mockResult = {
      output: {
        title: 'The Short One',
        concept: 'too short', // below SynthesizerOutput concept min(50)
        intentSummary: {
          aesthetics: ['a'],
          themes: ['b'],
          sourcesInternal: ['c'],
        },
      },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    } as never
    vi.mocked(ai.generateText).mockResolvedValueOnce(mockResult)

    await expect(
      reviseConcept({ title: 'A Prior Title', concept: 'a prior concept' }, 'a change note'),
    ).rejects.toThrow()
  })

  // Standing rule: no .max() on LLM prose. A revised concept over the old 4000
  // ceiling must pass through, not terminal-fail.
  it('returns a revised concept far longer than 4000 chars', async () => {
    const longConcept = 'y'.repeat(6000)
    const mockResult = {
      output: {
        title: 'The Long Coast',
        concept: longConcept,
        intentSummary: { aesthetics: ['a'], themes: ['b'], sourcesInternal: ['c'] },
      },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    } as never
    vi.mocked(ai.generateText).mockResolvedValueOnce(mockResult)

    const result = await reviseConcept(
      { title: 'A Prior Title', concept: 'a prior concept' },
      'a change note',
    )
    expect(result.concept).toBe(longConcept)
  })
})
