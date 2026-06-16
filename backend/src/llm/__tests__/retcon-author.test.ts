// backend/src/llm/__tests__/retcon-author.test.ts
//
// MYT-73 — the Opus retcon-author call. Mocks the SDK boundary (`'ai'`), NOT
// the canonical ai.ts wrapper: the wrapper's generateObject drives the SDK's
// generateText (with Output.object) underneath, so mocking `ai.generateText`
// to resolve `{ output, usage }` is what the wrapper reads back. Mirrors
// st-lookup-vet.test.ts.
//
// The repairAttempted=true arm drives the wrapper's repair fallback (first
// call rejects with a structured error whose rawText parses but fails Zod →
// repair model call fires), then asserts runRetconAuthor forwards the flag
// UNCHANGED.
//
// The secret-suppression arm drives the terminal-failure path with raw text
// embedding "SECRET" and asserts `redactRawText: true` keeps it out of BOTH
// the rethrown error's `.diagnostic.rawTextSnippet` and the WARN log.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { runRetconAuthor } from '../retcon-author.js'
import { LlmStructuredOutputError } from '../errors.js'
import type { LlmCallDiagnostic } from '../ai.js'
import { logger } from '../logger.js'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))

const mockGenerateText = vi.mocked(ai.generateText)

const okOutput = {
  retconText:
    'Correction — earlier I said the keeper turned you away. It was the gate guard; the keeper was elsewhere.',
  supersededContent: 'The narrator said the keeper turned the party away.',
  tier: 'known' as const,
}

const baseInput = {
  prose: 'The keeper bars the gate and turns the party away into the rain.',
  breach: 'The keeper cannot have been at the gate — the prose contradicts a core secret.',
  secret: 'SECRET: the keeper is the smuggler the party is hunting and was away that night.',
  recentNarrative: 'The party arrives at the gatehouse after dark, soaked through.',
}

function structuredError(rawText: string): LlmStructuredOutputError {
  return new LlmStructuredOutputError('llm returned unparseable structured output', {
    cause: { text: rawText, name: 'AI_NoObjectGeneratedError' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runRetconAuthor', () => {
  it('returns the result, usage, repairAttempted=false; threads breach + secret into the prompt', async () => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    } as never)

    const r = await runRetconAuthor(baseInput)

    expect(r.result).toEqual(okOutput)
    expect(r.repairAttempted).toBe(false)
    expect(r.usage.inputTokens).toBe(120)
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(call.prompt).toContain(baseInput.breach)
    expect(call.prompt).toContain(baseInput.secret)
    expect(call.prompt).toContain(baseInput.prose)
    expect(call.prompt).toContain(baseInput.recentNarrative)
  })

  it('threads a caller abortSignal through to the model call', async () => {
    mockGenerateText.mockResolvedValue({
      output: okOutput,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const controller = new AbortController()

    const r = await runRetconAuthor({ ...baseInput, abortSignal: controller.signal })

    expect(r.result).toEqual(okOutput)
    // ai.ts combines the caller signal with its internal timeout via
    // AbortSignal.any, so the wire signal is a derived one — assert it threaded
    // through as an AbortSignal (the truthy spread arm), not object identity.
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { abortSignal?: AbortSignal }
    expect(call.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('round-trips each tier value', async () => {
    for (const tier of ['known', 'discoverable', 'secret'] as const) {
      mockGenerateText.mockResolvedValueOnce({
        output: { ...okOutput, tier },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as never)
      const r = await runRetconAuthor(baseInput)
      expect(r.result.tier).toBe(tier)
    }
  })

  it('surfaces repairAttempted=true (the caller treats this as fail-soft)', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    // Primary call rejects with a structured error whose rawText parses as JSON
    // but fails the schema (empty retconText) → the wrapper's repair tier fires.
    // Haiku repair (haiku-then-sonnet) returns a schema-valid tree.
    mockGenerateText.mockRejectedValueOnce(
      structuredError(JSON.stringify({ ...okOutput, retconText: '' })),
    )
    mockGenerateText.mockResolvedValueOnce({
      output: okOutput,
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
    } as never)

    const r = await runRetconAuthor(baseInput)

    expect(r.repairAttempted).toBe(true)
    expect(r.result).toEqual(okOutput)
    // Primary (rejected) + one repair call.
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
  })

  it('redactRawText: true — secret never reaches diagnostic or the WARN log on terminal failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    // rawText parses but fails Zod (unknown tier), and the value embeds a
    // secret that must never surface.
    const originalErr = structuredError(
      JSON.stringify({
        retconText: 'SECRET-the-keeper-is-the-smuggler',
        supersededContent: 'SECRET-leak',
        tier: 'SECRET-leak-tier',
      }),
    )
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Haiku repair: still Zod-invalid.
    mockGenerateText.mockResolvedValueOnce({
      output: { retconText: 'SECRET', supersededContent: 'SECRET', tier: 'SECRET-still-bad' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    // Sonnet repair: still Zod-invalid → terminal sonnet_failed.
    mockGenerateText.mockResolvedValueOnce({
      output: { retconText: 'SECRET', supersededContent: 'SECRET', tier: 'SECRET-still-bad' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    let caught: unknown
    try {
      await runRetconAuthor(baseInput)
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('retcon-author')
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
