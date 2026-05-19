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
  })

  it('rethrows LLM errors', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('rate limit'))
    await expect(runCharacterConceptStage(ARGS)).rejects.toThrow(/rate limit/)
  })
})
