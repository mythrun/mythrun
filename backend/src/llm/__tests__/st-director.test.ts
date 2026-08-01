// backend/src/llm/__tests__/st-director.test.ts
//
// MYT-69 §4 — the Opus ST evaluation call. Mocks the SDK boundary (`'ai'`),
// NOT the canonical ai.ts wrapper: the wrapper's generateObject drives the
// SDK's generateText (with Output.object) underneath, so mocking
// `ai.generateText` to resolve `{ output, usage }` is what the wrapper reads
// back. Mirrors dm-trigger-classifier.test.ts. The repairAttempted=true arm
// drives the wrapper's repair fallback (first call rejects with a structured
// error whose rawText parses but fails Zod → repair model call fires) per the
// ai.test.ts repair-path scaffold, then asserts runStDirector forwards the
// flag UNCHANGED (the worker discards the whole result on it — §4).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { runStDirector } from '../st-director.js'
import { LlmStructuredOutputError } from '../errors.js'
import { logger } from '../logger.js'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))

const mockGenerateText = vi.mocked(ai.generateText)

const okOutput = {
  reasoning: 'r',
  intervene: true,
  direction: 'd',
  standingDirective: { action: 'keep', text: null },
  summaryUpdate: 's',
}

function structuredError(rawText: string): LlmStructuredOutputError {
  return new LlmStructuredOutputError('llm returned unparseable structured output', {
    cause: { text: rawText, name: 'AI_NoObjectGeneratedError' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runStDirector', () => {
  it('returns the result, usage, and repairAttempted flag; threads context vars', async () => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    } as never)
    const r = await runStDirector({
      partyRoster: 'Arin (Rogue), Bryn (Cleric)',
      sdPlaybook: 'SECRET',
      runningSummary: 'SUM',
      currentStandingDirective: 'NONE',
      pendingOneShot: 'NONE',
      recentExchanges: 'EX',
      windDown: false,
      converge: false,
      sessionId: 'sess-st-1',
    })
    expect(r.result).toEqual(okOutput)
    expect(r.repairAttempted).toBe(false)
    expect(r.usage.inputTokens).toBe(100)
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      providerOptions?: unknown
    }
    expect(call.prompt).toContain('SECRET')
    expect(call.prompt).toContain('Arin (Rogue)')
    expect(call.providerOptions).toMatchObject({
      mythrun: { stage: 'st_eval', sessionId: 'sess-st-1' },
    })
  })

  it('surfaces repairAttempted=true (the worker discards on this)', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    // Primary call rejects with a structured error whose rawText parses as
    // JSON but fails the schema (empty reasoning) → the wrapper's repair tier
    // fires. Haiku repair (haiku-then-sonnet) returns a schema-valid tree.
    mockGenerateText.mockRejectedValueOnce(
      structuredError(JSON.stringify({ ...okOutput, reasoning: '' })),
    )
    mockGenerateText.mockResolvedValueOnce({
      output: okOutput,
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
    } as never)

    const r = await runStDirector({
      partyRoster: 'P',
      sdPlaybook: 'p',
      runningSummary: '',
      currentStandingDirective: 'NONE',
      pendingOneShot: 'NONE',
      recentExchanges: 'e',
      sessionId: 'sess-st-1',
      windDown: false,
      converge: false,
    })

    expect(r.repairAttempted).toBe(true)
    expect(r.result).toEqual(okOutput)
    // Primary (rejected) + one repair call.
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
  })

  it('injects the wind-down instruction only when windDown is true', async () => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    await runStDirector({
      partyRoster: 'P',
      sdPlaybook: 'p',
      runningSummary: '',
      currentStandingDirective: 'NONE',
      pendingOneShot: 'NONE',
      recentExchanges: 'e',
      sessionId: 'sess-st-1',
      windDown: true,
      converge: false,
    })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(call.prompt).toMatch(/WIND-DOWN MODE IS ACTIVE/i)
  })

  it('omits the wind-down instruction when windDown is false', async () => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    await runStDirector({
      partyRoster: 'P',
      sdPlaybook: 'p',
      runningSummary: '',
      currentStandingDirective: 'NONE',
      pendingOneShot: 'NONE',
      recentExchanges: 'e',
      sessionId: 'sess-st-1',
      windDown: false,
      converge: false,
    })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    // The static prompt prose mentions "wind-down mode is active (below)" in
    // direction-class G, so anchor the negative on the unique injected
    // instruction marker (the colon-suffixed all-caps banner) which only
    // appears when windDown is true.
    expect(call.prompt).not.toContain('WIND-DOWN MODE IS ACTIVE:')
  })
})

// myth-3jna1 — the convergence steer rides the SAME injected-instruction seam
// as wind-down: a boolean in, a banner appended, the ST authors the direction.
// The steer is never a code-written direction — that would put a
// budget-derived, arc-derived sentence into the FT's context with no author.
describe('runStDirector — convergence steer', () => {
  beforeEach(() => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
  })

  const baseInput = {
    partyRoster: 'P',
    sdPlaybook: 'p',
    runningSummary: '',
    currentStandingDirective: 'NONE',
    pendingOneShot: 'NONE',
    recentExchanges: 'e',
    sessionId: 'sess-st-1',
  } as const

  it('injects the convergence instruction only when converge is true', async () => {
    await runStDirector({ ...baseInput, windDown: false, converge: true })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(call.prompt).toContain('CONVERGENCE MODE IS ACTIVE:')
  })

  it('omits the convergence instruction when converge is false', async () => {
    await runStDirector({ ...baseInput, windDown: false, converge: false })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(call.prompt).not.toContain('CONVERGENCE MODE IS ACTIVE:')
  })

  it('carries NO arc position and NO numbers — the ST is told the mode, not the measurement', async () => {
    await runStDirector({ ...baseInput, windDown: false, converge: true })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    const banner = /CONVERGENCE MODE IS ACTIVE:[^\n]*/.exec(call.prompt)?.[0] ?? ''
    expect(banner).not.toMatch(/\d/)
  })

  it('instructs the ST to phrase the steer as craft, never as the reason for it', async () => {
    await runStDirector({ ...baseInput, windDown: false, converge: true })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    const banner = /CONVERGENCE MODE IS ACTIVE:[^\n]*/.exec(call.prompt)?.[0] ?? ''
    expect(banner).toMatch(/never learn/i)
  })
})
