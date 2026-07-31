// backend/src/llm/__tests__/dm-trigger-classifier.test.ts
//
// MYT-67 T8: the real Haiku DM-trigger classifier (spec §4.4, §9). A single
// Haiku generateObject call through the canonical ai.ts wrapper, with a
// public-by-construction context serialized to plain text. The empty-batch
// short-circuit returns a deterministic "no turn" result WITHOUT touching the
// LLM; a non-empty batch returns the model's structured classification
// verbatim. Terminal failures propagate (fail-closed is the caller's job).
//
// Mock target: `'ai'` (the Vercel SDK), NOT the canonical wrapper file
// `'../ai.js'`. The wrapper's generateObject internally calls the SDK's
// `generateText` with `Output.object`, which populates `result.output` with
// the typed object — so mocking `ai.generateText` to resolve `{ output, usage }`
// is what the wrapper reads back. Mirrors the proven pattern in
// src/llm/prep/stages/__tests__/vocabulary-intake.test.ts; wrapper-direct
// mocks don't intercept in this vitest+ESM config.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { classifyDmTrigger, type DmTriggerContext } from '../dm-trigger-classifier.js'
import { HAIKU } from '../models.js'
import type { DmTriggerClassification } from '../schemas/dm-trigger-classification.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const HAIKU_USAGE = { inputTokens: 800, outputTokens: 60, totalTokens: 860 }

const MODEL_CLASSIFICATION: DmTriggerClassification = {
  shouldRespond: true,
  intent: 'reactive',
  complexity: 'low',
  confidence: 0.92,
  reason: 'A player directly addressed the barkeep; the world should answer.',
}

const NON_EMPTY_CTX: DmTriggerContext = {
  messages: [
    { characterName: 'Vire', text: 'I ask the barkeep about the missing caravan.' },
  ],
  lastDmOutput: 'The tavern hushes as you push the door open.',
  turnsSinceLastDmBeat: 2,
  secondsSinceLastDmBeat: 45,
  sceneGrounding: 'The Gilded Sparrow tavern, late evening.',
}

describe('classifyDmTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('short-circuits on an empty batch without calling the LLM', async () => {
    const ctx: DmTriggerContext = {
      messages: [],
      lastDmOutput: null,
      turnsSinceLastDmBeat: 0,
      secondsSinceLastDmBeat: 0,
      sceneGrounding: null,
    }

    const result = await classifyDmTrigger(ctx)

    expect(result).toEqual({
      shouldRespond: false,
      intent: 'reactive',
      complexity: 'low',
      confidence: 1,
      reason: 'empty batch',
    })
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('returns the model classification for a non-empty batch', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: MODEL_CLASSIFICATION,
      finishReason: 'stop',
      usage: HAIKU_USAGE,
    } as never)

    const result = await classifyDmTrigger(NON_EMPTY_CTX)

    expect(result).toEqual(MODEL_CLASSIFICATION)
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })

  it('routes the call through the HAIKU model with the classification schema', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: MODEL_CLASSIFICATION,
      finishReason: 'stop',
      usage: HAIKU_USAGE,
    } as never)

    await classifyDmTrigger(NON_EMPTY_CTX)

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      model: unknown
      output: unknown
      prompt: string
      system: string
      providerOptions?: unknown
    }
    // The wrapper forwards the model + an Output.object wrapper to the SDK.
    expect(callOpts.model).toBe(HAIKU)
    expect(callOpts.providerOptions).toMatchObject({ mythrun: { stage: 'dm_trigger' } })
    expect(callOpts.output).toBeDefined()
    // The serialized context (public fields only) lands in the prompt.
    expect(callOpts.prompt).toContain('Vire')
    expect(callOpts.prompt).toContain('I ask the barkeep about the missing caravan.')
    expect(callOpts.prompt).toContain('The tavern hushes as you push the door open.')
    expect(callOpts.prompt).toContain('The Gilded Sparrow tavern, late evening.')
    // The pacing signal is rendered from the public counters.
    expect(callOpts.prompt).toContain('45')
    expect(callOpts.prompt).toContain('2')
    // The system prompt is the loaded classifier template.
    expect(callOpts.system).toContain('Dungeon Master')
  })

  it('renders a "no prior DM turn" marker when lastDmOutput is null', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: MODEL_CLASSIFICATION,
      finishReason: 'stop',
      usage: HAIKU_USAGE,
    } as never)

    await classifyDmTrigger({
      messages: [{ characterName: 'Wren', text: 'I look around the room.' }],
      lastDmOutput: null,
      turnsSinceLastDmBeat: 0,
      secondsSinceLastDmBeat: 0,
      sceneGrounding: null,
    })

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('no prior DM turn')
  })

  it('propagates LLM call errors (fail-closed is the caller’s job)', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('haiku rate limit'))

    await expect(classifyDmTrigger(NON_EMPTY_CTX)).rejects.toThrow(/haiku rate limit/)
  })
})
