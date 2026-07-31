// backend/src/llm/__tests__/secret-tripwire.test.ts
//
// MYT-73 — the Haiku secret tripwire. Mocks the SDK boundary (`'ai'`), NOT the
// canonical ai.ts wrapper: the wrapper's generateObject drives the SDK's
// generateText (with Output.object) underneath, so mocking `ai.generateText`
// to resolve `{ output, usage }` is what the wrapper reads back. Mirrors
// st-lookup-vet.test.ts.
//
// The secret-suppression arm drives the terminal-failure path with raw text
// embedding "SECRET" and asserts `redactRawText: true` keeps it out of BOTH
// the rethrown error's `.diagnostic` (rawTextSnippet + zodIssues nulled) and
// every WARN-log argument.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { runSecretTripwire } from '../secret-tripwire.js'
import { LlmStructuredOutputError } from '../errors.js'
import type { LlmCallDiagnostic } from '../ai.js'
import { logger } from '../logger.js'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))

const mockGenerateText = vi.mocked(ai.generateText)

type Severity = 'none' | 'soft_consistency' | 'hard_reveal'

const cleanOutput = {
  severity: 'none' as Severity,
  confidence: 0.96,
  secretRef: null as string | null,
}

// The prose below is the canonical SOFT-consistency case: an NPC "eyes the door"
// — behavior consistent with a hidden identity, but nothing a player could deduce
// the secret from. Under myth-retprop this is `soft_consistency`, NOT a hard
// reveal (and so must NOT trigger a public correction downstream).
const softOutput = {
  severity: 'soft_consistency' as Severity,
  confidence: 0.35,
  secretRef: '[SECRET-1]' as string | null,
}

const baseInput = {
  prose: 'The innkeeper slides a tankard across the bar and eyes the door.',
  secrets: '[SECRET-1]: the innkeeper is the exiled prince in hiding.',
  publicContext: 'The Rusty Anchor is a dockside inn. The innkeeper is watchful and taciturn.',
}

function structuredError(rawText: string): LlmStructuredOutputError {
  return new LlmStructuredOutputError('llm returned unparseable structured output', {
    cause: { text: rawText, name: 'AI_NoObjectGeneratedError' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runSecretTripwire', () => {
  it('clean path → severity:none; threads {{prose}} + {{secrets}}', async () => {
    mockGenerateText.mockResolvedValue({
      output: cleanOutput,
      usage: { inputTokens: 90, outputTokens: 12, totalTokens: 102 },
    } as never)

    const r = await runSecretTripwire(baseInput)

    expect(r.result).toEqual(cleanOutput)
    expect(r.result.severity).toBe('none')
    expect(r.repairAttempted).toBe(false)
    expect(r.usage.inputTokens).toBe(90)
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      providerOptions?: unknown
    }
    expect(call.providerOptions).toMatchObject({ mythrun: { stage: 'secret_tripwire' } })
    expect(call.prompt).toContain(
      'The innkeeper slides a tankard across the bar and eyes the door.',
    )
    expect(call.prompt).toContain('[SECRET-1]: the innkeeper is the exiled prince in hiding.')
    // The PUBLIC briefing (grounding floor) is threaded into the prompt too.
    expect(call.prompt).toContain('The Rusty Anchor is a dockside inn.')
  })

  it('hit path → a non-clean severity carries an opaque secretRef handle', async () => {
    mockGenerateText.mockResolvedValue({
      output: softOutput,
      usage: { inputTokens: 90, outputTokens: 12, totalTokens: 102 },
    } as never)

    const r = await runSecretTripwire(baseInput)

    expect(r.result.severity).toBe('soft_consistency')
    expect(r.result.secretRef).toBe('[SECRET-1]')
  })

  it('round-trips each field (clean and soft-hit)', async () => {
    for (const output of [cleanOutput, softOutput]) {
      mockGenerateText.mockResolvedValueOnce({
        output,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as never)
      const r = await runSecretTripwire(baseInput)
      expect(r.result.severity).toBe(output.severity)
      expect(r.result.confidence).toBe(output.confidence)
      expect(r.result.secretRef).toBe(output.secretRef)
    }
  })

  it('threads a caller abortSignal through to the model call', async () => {
    mockGenerateText.mockResolvedValue({
      output: cleanOutput,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const controller = new AbortController()

    const r = await runSecretTripwire({ ...baseInput, abortSignal: controller.signal })

    expect(r.result).toEqual(cleanOutput)
    // ai.ts combines the caller signal with its internal timeout via
    // AbortSignal.any, so the wire signal is a derived one — assert it threaded
    // through as an AbortSignal (the truthy spread arm), not object identity.
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { abortSignal?: AbortSignal }
    expect(call.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('surfaces repairAttempted=true (the caller treats this as fail-soft)', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    // Primary call rejects with a structured error whose rawText parses as JSON
    // but fails the schema (confidence out of range) → the wrapper's repair tier
    // fires. Haiku repair (haiku-then-sonnet) returns a schema-valid tree.
    mockGenerateText.mockRejectedValueOnce(
      structuredError(JSON.stringify({ ...cleanOutput, confidence: 2 })),
    )
    mockGenerateText.mockResolvedValueOnce({
      output: cleanOutput,
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    } as never)

    const r = await runSecretTripwire(baseInput)

    expect(r.repairAttempted).toBe(true)
    expect(r.result).toEqual(cleanOutput)
    // Primary (rejected) + one repair call.
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
  })

  it('redactRawText: true — secret never reaches diagnostic or the WARN log on terminal failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    // rawText parses but fails Zod (confidence out of range), and the value
    // embeds a secret token that must never surface.
    const originalErr = structuredError(
      JSON.stringify({ severity: 'hard_reveal', confidence: 9, secretRef: 'SECRET-the-prince' }),
    )
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Haiku repair: still Zod-invalid (confidence out of range).
    mockGenerateText.mockResolvedValueOnce({
      output: { severity: 'hard_reveal', confidence: 9, secretRef: 'SECRET-the-prince' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    // Sonnet repair: still Zod-invalid → terminal sonnet_failed.
    mockGenerateText.mockResolvedValueOnce({
      output: { severity: 'hard_reveal', confidence: 9, secretRef: 'SECRET-the-prince' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    let caught: unknown
    try {
      await runSecretTripwire(baseInput)
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('secret-tripwire')
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
