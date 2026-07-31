// backend/src/llm/__tests__/session-reconciler.test.ts
//
// MYT-74a — the Opus end-of-session reconciler. Mocks the SDK boundary (`'ai'`),
// NOT the canonical ai.ts wrapper: the wrapper's generateObject drives the SDK's
// generateText (with Output.object) underneath, so mocking `ai.generateText`
// to resolve `{ output, usage }` is what the wrapper reads back. Mirrors
// secret-tripwire.test.ts / retcon-author.test.ts.
//
// `redactRawText: true` is asserted on the terminal-failure path: the reconciler
// reasons over secret-tier working-set items, so a malformed output must keep a
// secret out of BOTH the rethrown error's `.diagnostic` and every WARN-log arg.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { runSessionReconciler } from '../session-reconciler.js'
import { LlmStructuredOutputError } from '../errors.js'
import type { LlmCallDiagnostic } from '../ai.js'
import { logger } from '../logger.js'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))

const mockGenerateText = vi.mocked(ai.generateText)

const emptyPlan = {
  entities: [] as never[],
  facts: [] as never[],
  relationships: [] as never[],
}

const richPlan = {
  entities: [
    {
      op: 'mint' as const,
      subjectName: 'the cellar smuggler',
      canonEntityId: null as string | null,
      name: 'Brann the Cellar Smuggler',
      entityType: 'npc' as const,
      accessLevel: 'secret' as const,
    },
  ],
  facts: [
    {
      subjectName: 'the cellar smuggler',
      topic: 'allegiance',
      content: 'Brann claims he answers to no one.',
      accessLevel: 'secret' as const,
      claimedBy: 'Brann' as string | null,
      supersedesFactId: null as string | null,
    },
  ],
  relationships: [],
}

const baseInput = {
  workingSet: '[WS-1] the cellar smuggler (tier: secret) — improvised this session.',
  candidates: '[CAND-1] Brann (npc, id=ent-abc) — live fact f-1: "loyal to the guild".',
  worldTone: 'grim and rain-soaked',
}

function structuredError(rawText: string): LlmStructuredOutputError {
  return new LlmStructuredOutputError('llm returned unparseable structured output', {
    cause: { text: rawText, name: 'AI_NoObjectGeneratedError' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runSessionReconciler', () => {
  it('returns the validated plan + usage + repairAttempted', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: emptyPlan,
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as never)

    const r = await runSessionReconciler({ workingSet: 'WS', candidates: 'C', worldTone: 'grim' })

    expect(r.result).toEqual({ entities: [], facts: [], relationships: [] })
    expect(r.repairAttempted).toBe(false)
    expect(r.usage.inputTokens).toBe(10)
    expect(r.usage.outputTokens).toBe(5)
  })

  it('threads {{workingSet}} + {{candidates}} + {{worldTone}} into the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: emptyPlan,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await runSessionReconciler(baseInput)

    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      providerOptions?: unknown
    }
    expect(call.providerOptions).toMatchObject({ mythrun: { stage: 'session_reconcile' } })
    expect(call.prompt).toContain(baseInput.workingSet)
    expect(call.prompt).toContain(baseInput.candidates)
    expect(call.prompt).toContain(baseInput.worldTone)
  })

  it('threads {{closingNarration}} (the farewell end-state) into the prompt (myth-8mom0)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: emptyPlan,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const closing = 'Renn set down the finished bracket and left; his bench sat empty.'

    await runSessionReconciler({ ...baseInput, closingNarration: closing })

    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(call.prompt).toContain(closing)
    // The slot is never left un-substituted.
    expect(call.prompt).not.toContain('{{closingNarration}}')
  })

  it('omitted closingNarration renders the slot empty (no leftover placeholder)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: emptyPlan,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await runSessionReconciler(baseInput)

    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(call.prompt).not.toContain('{{closingNarration}}')
  })

  it('round-trips a rich plan (mint entity + attributed secret fact)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: richPlan,
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 40, totalTokens: 90 },
    } as never)

    const r = await runSessionReconciler(baseInput)

    expect(r.result).toEqual(richPlan)
    expect(r.result.entities[0]?.accessLevel).toBe('secret')
    expect(r.result.facts[0]?.claimedBy).toBe('Brann')
    expect(r.result.facts[0]?.accessLevel).toBe('secret')
  })

  it('threads a caller abortSignal through to the model call', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: emptyPlan,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const controller = new AbortController()

    const r = await runSessionReconciler({ ...baseInput, abortSignal: controller.signal })

    expect(r.result).toEqual(emptyPlan)
    // ai.ts combines the caller signal with its internal timeout via
    // AbortSignal.any, so the wire signal is a derived one — assert it threaded
    // through as an AbortSignal (the truthy spread arm), not object identity.
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { abortSignal?: AbortSignal }
    expect(call.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('redactRawText: true — secret never reaches diagnostic or the WARN log on terminal failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    // rawText parses but fails Zod (op out of enum), and the value embeds a
    // secret token that must never surface.
    const invalidTree = {
      entities: [
        {
          op: 'not-a-real-op',
          subjectName: 'SECRET-the-prince',
          canonEntityId: null,
          name: 'SECRET-the-prince',
          entityType: 'npc',
          accessLevel: 'secret',
        },
      ],
      facts: [],
      relationships: [],
    }
    const originalErr = structuredError(JSON.stringify(invalidTree))
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Sonnet repair (default repairStrategy='sonnet'): still Zod-invalid → terminal.
    mockGenerateText.mockResolvedValueOnce({
      output: invalidTree,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    let caught: unknown
    try {
      await runSessionReconciler(baseInput)
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('session-reconciler')
    // Raw snippet + Zod issues redacted to null — the secret is not in the diagnostic.
    expect(diag?.rawTextSnippet).toBeNull()
    expect(diag?.zodIssues).toBeNull()
    expect(JSON.stringify(diag)).not.toContain('SECRET')
    // The WARN log carries no trace of the secret in any argument.
    expect(warnSpy).toHaveBeenCalled()
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SECRET')
    }
  })
})
