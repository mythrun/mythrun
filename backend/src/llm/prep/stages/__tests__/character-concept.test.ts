// backend/src/llm/prep/stages/__tests__/character-concept.test.ts
//
// MYT-53 stage 2: Sonnet generateObject. Produces the narrative half of
// the character (name + race + class + background + traits + backstory).
// Persists NOTHING — stage 3 owns the characters INSERT.
//
// Mock target: `'ai'` (the Vercel SDK) — matches the proven pattern used
// by peer stage tests (vocabulary-intake, concept-intake, etc.). The
// canonical ai.ts wrapper's `Output.object` parsing populates `output`
// with the typed object, so asserting on `mockGenerateText.mock.calls`
// gives prompt-substitution coverage.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCharacterConceptStage } from '../character-concept.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const VALID_CONCEPT = {
  name: 'Bran of the Hollow',
  race: 'human',
  class: 'cleric',
  background: 'acolyte',
  level: 1,
  alignment: 'lawful neutral',
  age: 27,
  gender: 'man',
  physical_description:
    'A tall man, weather-worn from years on the road, with a shaved scalp and a faded sept-mark on the back of his left hand.',
  personality_traits: [
    'speaks in measured tones',
    'pauses before answering, as if listening to something else first',
  ],
  ideals: ['order serves the weak'],
  bonds: ['the temple that raised him'],
  flaws: ['quick to suspect deception'],
  backstory:
    'Bran was apprenticed at the Bone Sept in his twelfth year, when the priests took him in after a winter on the moors orphaned him. Twenty years later, when the Sept burned, he walked out with a tin ladle and a name he was no longer sure was his. He has been on the road since, doing temple work for coin, telling himself he is still a cleric of the Hollow, listening for the small voice that used to answer him at the altar.',
}

const ARGS = {
  campaignId: 'c-1',
  userId: 'u-1',
  worldId: 'w-1',
  worldName: 'Veil',
  tone: 'somber',
  themes: 'forgotten gods',
  era: 'late iron age',
  geographySummary: 'three duchies',
  politicalSummary: 'warring',
  keyTensions: 'the old gods stir',
  vocabularyRegistry: { entries: [], adjacent_franchises: [] },
  conceptText: 'a road-weary cleric who lost their faith',
  guidedChoices: {},
}

beforeEach(() => vi.clearAllMocks())

describe('runCharacterConceptStage', () => {
  it('calls Sonnet, returns the narrative payload + cost', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 },
    } as never)

    const result = await runCharacterConceptStage(ARGS)

    expect(result.concept.name).toBe('Bran of the Hollow')
    expect(result.concept.class).toBe('cleric')
    expect(result.costUsd).toBeCloseTo(
      (2000 / 1_000_000) * 3 + (1000 / 1_000_000) * 15,
      6,
    )
  })

  it('substitutes prompt placeholders', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    await runCharacterConceptStage(ARGS)
    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
    }
    expect(callOpts.prompt).toContain('Veil')
    expect(callOpts.prompt).toContain('a road-weary cleric')
    expect(callOpts.prompt).not.toContain('{{worldName}}')
    expect(callOpts.prompt).not.toContain('{{conceptText}}')
    expect(callOpts.prompt).not.toContain('{{guidedChoices}}')
    // Freeform (empty guidedChoices): the prompt says so explicitly.
    expect(callOpts.prompt).toContain('(none — the player wrote a freeform concept)')
  })

  // myth-4jhrk: guided-builder picks travel structurally and are framed as
  // committed choices in the prompt.
  it('renders present guided picks as field lines in the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    await runCharacterConceptStage({
      ...ARGS,
      guidedChoices: {
        class: 'Cleric',
        subclass: 'Life Domain',
        species: 'Human',
        background: 'Hermit',
      },
    })
    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('class: Cleric')
    expect(callOpts.prompt).toContain('subclass: Life Domain')
    expect(callOpts.prompt).toContain('species: Human')
    expect(callOpts.prompt).toContain('background: Hermit')
    expect(callOpts.prompt).not.toContain('(none — the player wrote a freeform concept)')
  })

  it('pins the guided subclass over the model echo (deterministic override, ZFC)', async () => {
    // The model dropped the pick (the run-2 failure mode): no subclass emitted.
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const dropped = await runCharacterConceptStage({
      ...ARGS,
      guidedChoices: { subclass: 'Life Domain' },
    })
    expect(dropped.concept.subclass).toBe('Life Domain')

    // The model substituted a DIFFERENT subclass: the pick still wins.
    mockGenerateText.mockResolvedValueOnce({
      output: { ...VALID_CONCEPT, subclass: 'Grave Domain' },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const substituted = await runCharacterConceptStage({
      ...ARGS,
      guidedChoices: { subclass: 'Life Domain' },
    })
    expect(substituted.concept.subclass).toBe('Life Domain')
  })

  it('freeform: a model-emitted subclass passes through, and no pick means none is invented', async () => {
    // Player stated a subclass in freeform prose; the model echoed it.
    mockGenerateText.mockResolvedValueOnce({
      output: { ...VALID_CONCEPT, subclass: 'Life Domain' },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const echoed = await runCharacterConceptStage(ARGS)
    expect(echoed.concept.subclass).toBe('Life Domain')

    // No pick, no echo: the field stays absent.
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const bare = await runCharacterConceptStage(ARGS)
    expect(bare.concept.subclass).toBeUndefined()
  })

  it('treats a malformed legacy guided_choices row as freeform (no picks)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const result = await runCharacterConceptStage({
      ...ARGS,
      guidedChoices: { class: 42, unknown_key: true },
    })
    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('(none — the player wrote a freeform concept)')
    expect(result.concept.subclass).toBeUndefined()
  })

  // myth-gdycq — the pronoun ask travels the SAME structured channel the
  // subclass does, and is pinned the same way. Run 3 wrote "he/his" for a
  // character whose description never specified a gender; a player who says how
  // they want to be referred to must not depend on prompt compliance.
  it('renders the pronoun pick as a written instruction, not a bare token', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await runCharacterConceptStage({ ...ARGS, guidedChoices: { pronouns: 'she_her' } })

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('pronouns: she/her')
    // The model has to WRITE in these terms, not just copy a field.
    expect(callOpts.prompt).toContain('use these in every sentence')
  })

  it('renders name-only as its own instruction (never use a pronoun)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await runCharacterConceptStage({ ...ARGS, guidedChoices: { pronouns: 'name_only' } })

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('never use a pronoun for this character')
  })

  it('pins the pronoun pick over the model echo (deterministic override, ZFC)', async () => {
    // The model dropped the field entirely.
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const dropped = await runCharacterConceptStage({
      ...ARGS,
      guidedChoices: { pronouns: 'they_them' },
    })
    expect(dropped.concept.pronouns).toBe('they/them')

    // The run-3 failure verbatim: the model answered with a different set. The
    // player's pick still wins.
    mockGenerateText.mockResolvedValueOnce({
      output: { ...VALID_CONCEPT, pronouns: 'he/him' },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const substituted = await runCharacterConceptStage({
      ...ARGS,
      guidedChoices: { pronouns: 'they_them' },
    })
    expect(substituted.concept.pronouns).toBe('they/them')
  })

  it('leaves the model value standing when no pronoun was picked', async () => {
    // No pick: the prompt's own resolution order governs (the description, then
    // they/them) and whatever it resolved passes through untouched.
    mockGenerateText.mockResolvedValueOnce({
      output: { ...VALID_CONCEPT, pronouns: 'they/them' },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const resolved = await runCharacterConceptStage(ARGS)
    expect(resolved.concept.pronouns).toBe('they/them')

    // Nothing was committed, so the choices block says so — the pronoun line is
    // only ever the player's own answer.
    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('(none — the player wrote a freeform concept)')
    expect(callOpts.prompt).not.toContain('use these in every sentence')
  })

  it('rethrows LLM errors', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('rate limit'))
    await expect(runCharacterConceptStage(ARGS)).rejects.toThrow(/rate limit/)
  })
})
