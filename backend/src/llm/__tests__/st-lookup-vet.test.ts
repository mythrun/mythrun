// backend/src/llm/__tests__/st-lookup-vet.test.ts
//
// MYT-72 §17.4 — the Opus ST-vet call. Mocks the SDK boundary (`'ai'`), NOT the
// canonical ai.ts wrapper: the wrapper's generateObject drives the SDK's
// generateText (with Output.object) underneath, so mocking `ai.generateText`
// to resolve `{ output, usage }` is what the wrapper reads back. Mirrors
// st-director.test.ts.
//
// The repairAttempted=true arm drives the wrapper's repair fallback (first call
// rejects with a structured error whose rawText parses but fails Zod → repair
// model call fires) per ai.test.ts's scaffold, then asserts runStLookupVet
// forwards the flag UNCHANGED.
//
// The secret-suppression arm drives the terminal-failure path with raw text
// embedding "SECRET" and asserts `redactRawText: true` keeps it out of BOTH
// the rethrown error's `.diagnostic.rawTextSnippet` and the WARN log.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { runStLookupVet } from '../st-lookup-vet.js'
import { LlmStructuredOutputError } from '../errors.js'
import type { LlmCallDiagnostic } from '../ai.js'
import { logger } from '../logger.js'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))

const mockGenerateText = vi.mocked(ai.generateText)

const okOutput = {
  mode: 'relay' as const,
  text: 'You recall the bridge was rebuilt after the floods two winters back.',
  tier: 'known' as const,
}

const baseInput = {
  question: 'What do I remember about the old bridge?',
  recentNarrative: 'The party crosses the river at dusk.',
  channel: 'dm' as const,
  npcFraming: '',
  results: 'TIER known: the bridge was rebuilt two winters ago.',
  resolverDegraded: false,
  sdPlaybook: 'SECRET: the duke financed the rebuild to hide a smuggling tunnel.',
  worldTone: 'weathered river-town realism',
  sessionId: 'sess-vet-1',
}

function structuredError(rawText: string): LlmStructuredOutputError {
  return new LlmStructuredOutputError('llm returned unparseable structured output', {
    cause: { text: rawText, name: 'AI_NoObjectGeneratedError' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runStLookupVet', () => {
  it('returns the result, usage, repairAttempted=false; threads context vars', async () => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    } as never)

    const r = await runStLookupVet(baseInput)

    expect(r.result).toEqual(okOutput)
    expect(r.repairAttempted).toBe(false)
    expect(r.usage.inputTokens).toBe(120)
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      providerOptions?: unknown
    }
    expect(call.providerOptions).toMatchObject({
      mythrun: { stage: 'st_lookup_vet', sessionId: 'sess-vet-1' },
    })
    expect(call.prompt).toContain('What do I remember about the old bridge?')
    expect(call.prompt).toContain('TIER known: the bridge was rebuilt two winters ago.')
    expect(call.prompt).toContain('weathered river-town realism')
    expect(call.prompt).toContain('healthy')
  })

  it('threads a caller abortSignal through to the model call', async () => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const controller = new AbortController()

    const r = await runStLookupVet({ ...baseInput, abortSignal: controller.signal })

    expect(r.result).toEqual(okOutput)
    // ai.ts combines the caller signal with its internal timeout via
    // AbortSignal.any, so the wire signal is a derived one — assert it threaded
    // through as an AbortSignal (the truthy spread arm), not object identity.
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { abortSignal?: AbortSignal }
    expect(call.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('renders resolver_degraded="degraded" when resolverDegraded is true', async () => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await runStLookupVet({ ...baseInput, resolverDegraded: true })

    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(call.prompt).toContain('Resolver health: degraded')
  })

  it('round-trips each mode value', async () => {
    for (const mode of ['relay', 'none', 'invent'] as const) {
      mockGenerateText.mockResolvedValueOnce({
        output: { ...okOutput, mode },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as never)
      const r = await runStLookupVet(baseInput)
      expect(r.result.mode).toBe(mode)
    }
  })

  it('surfaces repairAttempted=true (the caller treats this as fail-soft)', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    // Primary call rejects with a structured error whose rawText parses as JSON
    // but fails the schema (empty text) → the wrapper's repair tier fires.
    // Haiku repair (haiku-then-sonnet) returns a schema-valid tree.
    mockGenerateText.mockRejectedValueOnce(
      structuredError(JSON.stringify({ ...okOutput, text: '' })),
    )
    mockGenerateText.mockResolvedValueOnce({
      output: okOutput,
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
    } as never)

    const r = await runStLookupVet(baseInput)

    expect(r.repairAttempted).toBe(true)
    expect(r.result).toEqual(okOutput)
    // Primary (rejected) + one repair call.
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
  })

  it('redactRawText: true — secret never reaches diagnostic or the WARN log on terminal failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    // rawText parses but fails Zod (unknown mode), and the value embeds a
    // secret that must never surface.
    const originalErr = structuredError(
      JSON.stringify({ mode: 'SECRET-leak-mode', text: 'SECRET-the-duke', tier: 'known' }),
    )
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Haiku repair: still Zod-invalid.
    mockGenerateText.mockResolvedValueOnce({
      output: { mode: 'SECRET-still-bad', text: 'SECRET', tier: 'known' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    // Sonnet repair: still Zod-invalid → terminal sonnet_failed.
    mockGenerateText.mockResolvedValueOnce({
      output: { mode: 'SECRET-still-bad', text: 'SECRET', tier: 'known' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    let caught: unknown
    try {
      await runStLookupVet(baseInput)
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('st-lookup-vet')
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
