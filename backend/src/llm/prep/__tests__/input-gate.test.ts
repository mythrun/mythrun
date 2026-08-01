import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInputGate } from '../input-gate.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

function mockGateReturn(
  result: Partial<{
    srd_compat: { fits: boolean; confidence: number; reasoning: string }
    clone_intent: { flagged: boolean; confidence: number; reasoning: string }
    inappropriate: { flagged: boolean; reasoning: string }
    rejectionMessage: string | null
  }>,
): void {
  vi.mocked(ai.generateText).mockResolvedValueOnce({
    output: {
      srd_compat: { fits: true, confidence: 0.95, reasoning: 'fits' },
      clone_intent: { flagged: false, confidence: 0.95, reasoning: 'clean' },
      inappropriate: { flagged: false, reasoning: 'n/a' },
      rejectionMessage: null,
      ...result,
    },
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  } as never)
}

describe('runInputGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows a clean concept', async () => {
    mockGateReturn({})
    const v = await runInputGate({
      concept: 'A windswept archipelago...',
      intentSummary: null,
      sessionId: 'sess-ig-1',
    })
    expect(v.verdict).toBe('allow')
    expect(v.reason).toBeNull()
    const callOpts = vi.mocked(ai.generateText).mock.calls[0]?.[0] as unknown as {
      providerOptions?: unknown
    }
    expect(callOpts.providerOptions).toMatchObject({
      mythrun: { stage: 'input_gate', sessionId: 'sess-ig-1' },
    })
  })

  it('rejects SRD-incompatible concept above 0.85 confidence', async () => {
    mockGateReturn({
      srd_compat: {
        fits: false,
        confidence: 0.92,
        reasoning: 'gritty civil war drama, no supernatural element',
      },
      rejectionMessage:
        'Mythrun needs room for spells, monsters, or class-fantasy. A grounded historical drama has nowhere for the mechanics to do anything — try reframing with a supernatural angle.',
    })
    const v = await runInputGate({ concept: 'a civil war drama', intentSummary: null })
    expect(v.verdict).toBe('reject')
    expect(v.reason).toBe('srd_incompat')
    expect(v.rejectionMessage).toContain('supernatural')
  })

  it('rejects clone intent above 0.85 confidence', async () => {
    mockGateReturn({
      clone_intent: {
        flagged: true,
        confidence: 0.93,
        reasoning: 'requests Hogwarts setting verbatim',
      },
      rejectionMessage:
        'This concept names a specific copyrighted setting. Mythrun can build a magical-academy world with original names — try renaming and resubmitting.',
    })
    const v = await runInputGate({ concept: 'I want a world set at Hogwarts', intentSummary: null })
    expect(v.verdict).toBe('reject')
    expect(v.reason).toBe('clone_intent')
  })

  it('rejects inappropriate flag (binary, no confidence)', async () => {
    mockGateReturn({
      inappropriate: { flagged: true, reasoning: 'content I would not engage with' },
      rejectionMessage: "I can't develop this concept further. Try a different framing.",
    })
    const v = await runInputGate({ concept: '...', intentSummary: null })
    expect(v.verdict).toBe('reject')
    expect(v.reason).toBe('inappropriate')
  })

  it('aggregate rule: two axes at 0.70+ confidence trigger reject', async () => {
    mockGateReturn({
      srd_compat: { fits: false, confidence: 0.72, reasoning: 'borderline non-fitting' },
      clone_intent: { flagged: true, confidence: 0.74, reasoning: 'borderline clone' },
      rejectionMessage:
        'Both the setting and IP-framing here drift toward problems. Try a fresh framing in your own words.',
    })
    const v = await runInputGate({ concept: '...', intentSummary: null })
    expect(v.verdict).toBe('reject')
    // First-flagged axis wins as the primary reason:
    expect(v.reason).toBe('srd_incompat')
  })

  it('borderline single-axis (0.83 < 0.85) without aggregate fallback → allow', async () => {
    mockGateReturn({
      srd_compat: { fits: false, confidence: 0.83, reasoning: 'borderline' },
      // clone_intent stays clean, so no aggregate
    })
    const v = await runInputGate({ concept: '...', intentSummary: null })
    expect(v.verdict).toBe('allow')
  })

  it('reject verdict with null rejectionMessage threads null through', async () => {
    // Exercises the branch where `axes.rejectionMessage` is null on a
    // reject. The Zod schema allows it (z.string().nullable()), and the
    // verdict computation honors it without crashing.
    mockGateReturn({
      inappropriate: { flagged: true, reasoning: 'reason' },
      rejectionMessage: null,
    })
    const v = await runInputGate({ concept: '...', intentSummary: null })
    expect(v.verdict).toBe('reject')
    expect(v.rejectionMessage).toBeNull()
    expect(v.reason).toBe('inappropriate')
  })

  // Regression (myth-8rtvl): a user-supplied concept containing `$&`/`$'`-style
  // sequences must land in the prompt verbatim. Plain String.replace treats
  // those as special replacement patterns, so the substitution goes through a
  // function replacer.
  it('inserts a concept containing $-replacement sequences verbatim', async () => {
    mockGateReturn({})
    await runInputGate({
      concept: "a bazaar where $& buys $' and $$ is a curse and $1 a blessing",
      intentSummary: null,
    })
    const callArgs = vi.mocked(ai.generateText).mock.calls.at(-1)?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(callArgs.prompt).toContain(
      "a bazaar where $& buys $' and $$ is a curse and $1 a blessing",
    )
  })

  it('passes intentSummary into the prompt', async () => {
    mockGateReturn({})
    await runInputGate({
      concept: 'a concept',
      intentSummary: {
        aesthetics: ['x'],
        themes: ['y'],
        sourcesInternal: ['UNIQUE_SOURCE_Z (description)'],
      },
    })
    const callArgs = vi.mocked(ai.generateText).mock.calls.at(-1)?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(callArgs.prompt).toContain('UNIQUE_SOURCE_Z')
  })

  it('threads an external abortSignal through to the LLM call (SSE disconnect cancels the gate)', async () => {
    mockGateReturn({})
    const external = new AbortController()
    await runInputGate({ concept: 'a concept', intentSummary: null, abortSignal: external.signal })
    // The wrapper combines external + timeout via AbortSignal.any, so the
    // SDK-received signal must FOLLOW the external one.
    const sdkSignal = (
      vi.mocked(ai.generateText).mock.calls.at(-1)?.[0] as unknown as { abortSignal: AbortSignal }
    ).abortSignal
    expect(sdkSignal.aborted).toBe(false)
    external.abort()
    expect(sdkSignal.aborted).toBe(true)
  })
})
