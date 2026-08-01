import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  synthesizeConcept,
  synthesizeFromConcept,
  SynthesizerOutput,
} from '../synthesize-concept.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateText: vi.fn(),
  }
})

describe('synthesizeConcept', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('produces a concept + intentSummary from three picks', async () => {
    const mockResult = {
      output: {
        title: 'The Signal Isles',
        concept:
          'A windswept archipelago where rival lighthouse-keepers tend signal-fires fueled by trapped storm-spirits…',
        intentSummary: {
          aesthetics: ['weathered coastline', 'storm-glass refraction', 'oil-lamp warmth'],
          themes: ['guardianship under pressure', 'communion with bound spirits'],
          sourcesInternal: [
            'Pick A (lighthouse atmosphere)',
            'Pick B (spirit-binding aesthetic)',
            'Pick C (rival-house politics)',
          ],
        },
      },
      finishReason: 'stop',
      usage: { inputTokens: 850, outputTokens: 620, totalTokens: 1470 },
    } as never
    vi.mocked(ai.generateText).mockResolvedValueOnce(mockResult)

    const result = await synthesizeConcept([
      { title: 'Pick A', whyILikeIt: 'reason A' },
      { title: 'Pick B', whyILikeIt: 'reason B' },
      { title: 'Pick C', whyILikeIt: 'reason C' },
    ])

    expect(result.title).toBe('The Signal Isles')
    expect(result.concept).toContain('archipelago')
    expect(result.intentSummary.aesthetics).toHaveLength(3)
    expect(result.intentSummary.sourcesInternal).toHaveLength(3)
    expect(result.usage.totalTokens).toBe(1470)
  })

  it('passes pick data into the prompt template', async () => {
    const mockResult = {
      output: {
        title: 'A Placeholder Name',
        concept: 'x'.repeat(200),
        intentSummary: { aesthetics: [], themes: [], sourcesInternal: [] },
      },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    } as never
    vi.mocked(ai.generateText).mockResolvedValueOnce(mockResult)

    await synthesizeConcept([
      { title: 'UNIQUE_TITLE_X', whyILikeIt: 'UNIQUE_REASON_Y' },
      { title: 'B', whyILikeIt: 'b' },
      { title: 'C', whyILikeIt: 'c' },
    ])

    const callArgs = vi.mocked(ai.generateText).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(callArgs.prompt).toContain('UNIQUE_TITLE_X')
    expect(callArgs.prompt).toContain('UNIQUE_REASON_Y')
    expect(callArgs.providerOptions).toMatchObject({ mythrun: { stage: 'concept_intake' } })
  })

  // Standing rule: no .max() on LLM prose fields — an over-length generation
  // must succeed long, not terminal-fail. The concept floor (.min) stays.
  it('accepts a concept far longer than 4000 chars (no max ceiling on prose)', () => {
    const parsed = SynthesizerOutput.safeParse({
      title: 'The Long Coast',
      concept: 'x'.repeat(6000),
      intentSummary: { aesthetics: ['a'], themes: ['b'], sourcesInternal: ['c'] },
    })
    expect(parsed.success).toBe(true)
  })

  it('still floors the concept at its minimum length', () => {
    const parsed = SynthesizerOutput.safeParse({
      title: 'The Short One',
      concept: 'too short to be a concept',
      intentSummary: { aesthetics: ['a'], themes: ['b'], sourcesInternal: ['c'] },
    })
    expect(parsed.success).toBe(false)
  })

  // Regression (myth-8rtvl): a `$&`-style sequence in a pick survives into the
  // built prompt verbatim. String.prototype.replace treats `$&`/`$1`/`$'` as
  // special in a STRING replacement — the picks block is spliced via a regex
  // replace, so it must go through a function replacer to insert literally.
  it('inserts a pick containing $-replacement sequences verbatim', async () => {
    const mockResult = {
      output: {
        title: 'A Placeholder Name',
        concept: 'x'.repeat(200),
        intentSummary: { aesthetics: [], themes: [], sourcesInternal: [] },
      },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    } as never
    vi.mocked(ai.generateText).mockResolvedValueOnce(mockResult)

    await synthesizeConcept([
      { title: 'a city worth $& everything', whyILikeIt: "the $' before $1 and $$ signs" },
      { title: 'B', whyILikeIt: 'b' },
      { title: 'C', whyILikeIt: 'c' },
    ])

    const callArgs = vi.mocked(ai.generateText).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(callArgs.prompt).toContain('a city worth $& everything')
    expect(callArgs.prompt).toContain("the $' before $1 and $$ signs")
  })
  // myth-z3icr: the proposal page headlines the world's NAME, so the stage has
  // to emit one — extracting it from the prose client-side would be a ZFC
  // violation, and there is nowhere else in the wire it could come from.
  it('rejects an output with no title', () => {
    const parsed = SynthesizerOutput.safeParse({
      concept: 'x'.repeat(200),
      intentSummary: { aesthetics: ['a'], themes: ['b'], sourcesInternal: ['c'] },
    })
    expect(parsed.success).toBe(false)
  })

  // The title is a short LABEL, not prose — the one place a `.max()` is legal
  // under the no-max-on-prose rule. The ceiling exists to catch a model that
  // answers the "name this world" instruction with a sentence.
  it('rejects a title that is a paragraph rather than a name', () => {
    const parsed = SynthesizerOutput.safeParse({
      title: 'T'.repeat(121),
      concept: 'x'.repeat(200),
      intentSummary: { aesthetics: ['a'], themes: ['b'], sourcesInternal: ['c'] },
    })
    expect(parsed.success).toBe(false)
  })
})

// myth-6t06f: the FREEFORM twin. The player's own concept text is the input;
// the output contract is identical, which is what lets the proposal checkpoint
// serve both funnel paths with one screen and one wire.
describe('synthesizeFromConcept', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('threads the player concept into the freeform prompt and returns the proposal', async () => {
    const mockResult = {
      output: {
        title: 'The Ninth Tide',
        concept: 'x'.repeat(200),
        intentSummary: {
          aesthetics: ['brine'],
          themes: ['salvage'],
          sourcesInternal: ["the player's own description (drowned harbour town)"],
        },
      },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    } as never
    vi.mocked(ai.generateText).mockResolvedValueOnce(mockResult)

    const result = await synthesizeFromConcept('UNIQUE_PLAYER_CONCEPT_Z')

    expect(result.title).toBe('The Ninth Tide')
    const callArgs = vi.mocked(ai.generateText).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(callArgs.prompt).toContain('UNIQUE_PLAYER_CONCEPT_Z')
    // The FREEFORM template, not the picks one: the player's premise is fixed,
    // it is not one of three inspirations to blend.
    expect(callArgs.prompt).toContain("PLAYER'S DESCRIPTION")
    expect(callArgs.prompt).not.toContain('USER PICKS')
  })

  // Same replacer discipline as the picks path (myth-8rtvl): the concept is raw
  // user text, so a `$&` sequence must splice in literally.
  it('inserts a concept containing $-replacement sequences verbatim', async () => {
    const mockResult = {
      output: {
        title: 'A Placeholder Name',
        concept: 'x'.repeat(200),
        intentSummary: { aesthetics: ['a'], themes: ['b'], sourcesInternal: ['c'] },
      },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    } as never
    vi.mocked(ai.generateText).mockResolvedValueOnce(mockResult)

    await synthesizeFromConcept("a city worth $& everything, the $' before $1 and $$ signs")

    const callArgs = vi.mocked(ai.generateText).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(callArgs.prompt).toContain("a city worth $& everything, the $' before $1 and $$ signs")
  })
})
