// backend/src/llm/__tests__/post-session-analysis.test.ts
//
// MYT-74b — the Opus post-session analysis call. Unlike the reconciler test
// (which mocks the SDK `'ai'` boundary), this mocks the canonical ai.ts wrapper
// module directly: `generateObject` is replaced with a `vi.fn()` so we assert
// the OPTIONS the analysis call hands the wrapper (model, redactRawText,
// callSite, the substituted prompt, the abortSignal spread idiom) and that it
// faithfully maps the wrapper's `{ output, usage, repairAttempted }` back into
// `{ result, usage, repairAttempted }`.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateObject } from '../ai.js'
import { OPUS } from '../models.js'
import { runPostSessionAnalysis } from '../post-session-analysis.js'

vi.mock('../ai.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai.js')>()),
  generateObject: vi.fn(),
}))

const mockGenerateObject = vi.mocked(generateObject)

const sampleResult = {
  summary: 'The party broke the siege at the river gate and limped back to the Lantern.',
  emergingThreads: ['Who paid the sappers?', 'The bridge tolls are unpaid.'],
  handoff: {
    party: [{ characterName: 'Vael', location: 'the Lantern common room', condition: 'wounded, 4 hp' }],
    timeOfDay: 'past midnight',
    unresolvedThreads: ['The sapper foreman is still loose.'],
    npcs: [
      {
        name: 'Old Mar',
        state: 'wary of the party but grudgingly indebted after they saved the gate',
        voice: ['"You did right by the gate. I do not forget that."', '"Sit. The fire is yours tonight."'],
      },
    ],
    keyLocations: [{ name: 'the Lantern', atmosphere: 'low beams, wet wool steaming by the hearth' }],
  },
}

const baseInput = {
  transcript: '[TURN-1] Vael: "Hold the line." Old Mar: "You did right by the gate."',
  runningSummary: 'ST summary: the sappers were hired by SECRET-the-magistrate.',
  sdPlaybook: 'PLAYBOOK: SECRET — the magistrate funds the sappers to seize the tolls.',
  participants: 'Vael (rogue), Brina (cleric)',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runPostSessionAnalysis', () => {
  it('maps the wrapper output into { result, usage, repairAttempted }', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      output: sampleResult,
      usage: { inputTokens: 100, outputTokens: 60, totalTokens: 160 },
      repairAttempted: false,
    } as never)

    const r = await runPostSessionAnalysis(baseInput)

    expect(r.result).toEqual(sampleResult)
    expect(r.usage.inputTokens).toBe(100)
    expect(r.usage.outputTokens).toBe(60)
    expect(r.repairAttempted).toBe(false)
  })

  it('propagates repairAttempted: true from the wrapper', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      output: sampleResult,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      repairAttempted: true,
    } as never)

    const r = await runPostSessionAnalysis(baseInput)

    expect(r.repairAttempted).toBe(true)
  })

  it('calls generateObject with OPUS, redactRawText, callSite, and a substituted prompt', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      output: sampleResult,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      repairAttempted: false,
    } as never)

    await runPostSessionAnalysis(baseInput)

    const opts = mockGenerateObject.mock.calls[0]?.[0]
    expect(opts?.model).toBe(OPUS)
    expect(opts?.redactRawText).toBe(true)
    expect(opts?.callSite).toBe('post-session-analysis')
    expect(opts?.repairStrategy).toBe('sonnet')
    expect(typeof opts?.prompt).toBe('string')
    // Proves loadPrompt actually substituted the {{...}} placeholders.
    expect(opts?.prompt).toContain(baseInput.transcript)
    expect(opts?.prompt).toContain(baseInput.runningSummary)
    expect(opts?.prompt).toContain(baseInput.sdPlaybook)
    expect(opts?.prompt).toContain(baseInput.participants)
  })

  it('forwards a caller abortSignal when provided', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      output: sampleResult,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      repairAttempted: false,
    } as never)
    const controller = new AbortController()

    await runPostSessionAnalysis({ ...baseInput, abortSignal: controller.signal })

    const opts = mockGenerateObject.mock.calls[0]?.[0]
    expect(opts?.abortSignal).toBe(controller.signal)
  })

  it('omits abortSignal when none is provided', async () => {
    mockGenerateObject.mockResolvedValueOnce({
      output: sampleResult,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      repairAttempted: false,
    } as never)

    await runPostSessionAnalysis(baseInput)

    const opts = mockGenerateObject.mock.calls[0]?.[0]
    expect(opts && 'abortSignal' in opts).toBe(false)
  })
})
