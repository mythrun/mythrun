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
import { runSecretTripwire, splitTripwireTemplate } from '../secret-tripwire.js'
import { LlmStructuredOutputError } from '../errors.js'
import type { LlmCallDiagnostic } from '../ai.js'
import { logger } from '../logger.js'
import { loadPrompt } from '../prompts.js'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))

const mockGenerateText = vi.mocked(ai.generateText)

/** The FT-proven per-message breakpoint shape (fast-thinker.ts §3.9). */
const BREAKPOINT = { anthropic: { cacheControl: { type: 'ephemeral' } } }

interface CapturedMessage {
  role: string
  content: string
  providerOptions?: unknown
}

function messagesOf(call = 0): CapturedMessage[] {
  const args = mockGenerateText.mock.calls[call]?.[0] as unknown as {
    messages: CapturedMessage[]
  }
  return args.messages
}

function promptTextOf(call = 0): string {
  return messagesOf(call)
    .map((m) => m.content)
    .join('')
}

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
  sessionId: 'sess-trip-1',
  campaignId: 'camp-trip-1',
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
      providerOptions?: unknown
    }
    expect(call.providerOptions).toMatchObject({
      mythrun: { stage: 'secret_tripwire', sessionId: 'sess-trip-1', campaignId: 'camp-trip-1' },
    })
    expect(promptTextOf()).toContain(
      'The innkeeper slides a tankard across the bar and eyes the door.',
    )
    expect(promptTextOf()).toContain('[SECRET-1]: the innkeeper is the exiled prince in hiding.')
    // The PUBLIC briefing (grounding floor) is threaded into the prompt too.
    expect(promptTextOf()).toContain('The Rusty Anchor is a dockside inn.')
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
    // Cost wave 1 §1.0: the repair call preserves the caller's ids — the
    // repair-path providerOptions override swaps ONLY the stage (to a
    // world-gen label the extractor drops-and-flags), never the ids.
    const repairCall = mockGenerateText.mock.calls[1]?.[0] as unknown as {
      providerOptions?: unknown
    }
    expect(repairCall.providerOptions).toMatchObject({
      mythrun: { sessionId: 'sess-trip-1', campaignId: 'camp-trip-1' },
    })
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

// Cost-wave1 §3 — tripwire caching. The template is reordered stable-first
// (instruction head + secrets + publicContext + consistencyContext above the
// breakpoint; the per-turn prose + dice outcomes + the output-format tail
// below). The assembly compiles to two user blocks split at the volatile
// marker with the cache breakpoint pinned on the stable block. Decision
// parity for the reorder is gated in secret-tripwire-parity.test.ts.
describe('runSecretTripwire — stable-first blocks (cost-wave1 §3)', () => {
  const stableInput = {
    secrets: '[SECRET-1]: the innkeeper is the exiled prince in hiding.',
    publicContext: 'The Rusty Anchor is a dockside inn. The innkeeper is watchful.',
    consistencyContext: 'Encounter script: the caravan arrives on the third day.',
    sessionId: 'sess-trip-blocks',
  }

  const cleanResult = {
    output: cleanOutput,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stable prefix is byte-identical across calls with different volatile inputs', async () => {
    mockGenerateText.mockResolvedValue(cleanResult)

    await runSecretTripwire({
      ...stableInput,
      prose: 'Turn 3: the innkeeper pours an ale.',
      diceOutcomes: 'Perception DC 12: success.',
    })
    await runSecretTripwire({
      ...stableInput,
      prose: 'Turn 4: rain drums on the shutters, and a stranger enters.',
      diceOutcomes: 'Stealth DC 15: fail.',
    })

    const first = messagesOf(0)
    const second = messagesOf(1)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // The stable block (head + secrets + publicContext + consistencyContext)
    // is byte-identical across turns; only the volatile tail moves.
    expect(second[0]?.content).toBe(first[0]?.content)
    expect(second[1]?.content).not.toBe(first[1]?.content)
  })

  it('breakpoint sits on the stable block only; prose and dice ride the volatile tail', async () => {
    mockGenerateText.mockResolvedValueOnce(cleanResult)

    await runSecretTripwire({
      ...stableInput,
      prose: 'PROSE-UNDER-TEST',
      diceOutcomes: 'DICE-THIS-TURN',
    })

    const messages = messagesOf()
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.providerOptions).toEqual(BREAKPOINT)
    // The volatile tail carries NO providerOptions key at all (a stray
    // undefined-valued key would still serialize into the wire request).
    expect(Object.keys(messages[1] ?? {})).toEqual(['role', 'content'])
    // Stable side: the per-session material, none of the per-turn material.
    expect(messages[0]?.content).toContain(stableInput.secrets)
    expect(messages[0]?.content).toContain(stableInput.publicContext)
    expect(messages[0]?.content).toContain(stableInput.consistencyContext)
    expect(messages[0]?.content).not.toContain('PROSE-UNDER-TEST')
    expect(messages[0]?.content).not.toContain('DICE-THIS-TURN')
    // Volatile side: starts at the prose marker, carries the turn material.
    expect(messages[1]?.content.startsWith('Player-facing prose this turn:')).toBe(true)
    expect(messages[1]?.content).toContain('PROSE-UNDER-TEST')
    expect(messages[1]?.content).toContain('DICE-THIS-TURN')
    expect(messages[1]?.content).not.toContain(stableInput.secrets)
  })

  it('block concatenation is byte-identical to the flat rendering of the reordered template', async () => {
    mockGenerateText.mockResolvedValueOnce(cleanResult)

    await runSecretTripwire({
      ...stableInput,
      prose: 'Prose with {{curly}} noise and $& regex traps',
      diceOutcomes: 'Dice $1 text',
    })

    expect(promptTextOf()).toBe(
      loadPrompt('session', 'secret-tripwire', {
        prose: 'Prose with {{curly}} noise and $& regex traps',
        secrets: stableInput.secrets,
        publicContext: stableInput.publicContext,
        consistencyContext: stableInput.consistencyContext,
        diceOutcomes: 'Dice $1 text',
      }),
    )
  })

  it('absent optional fields render the same defaults on the blocks path', async () => {
    mockGenerateText.mockResolvedValueOnce(cleanResult)

    await runSecretTripwire({
      prose: 'p',
      secrets: stableInput.secrets,
      publicContext: stableInput.publicContext,
    })

    expect(promptTextOf()).toBe(
      loadPrompt('session', 'secret-tripwire', {
        prose: 'p',
        secrets: stableInput.secrets,
        publicContext: stableInput.publicContext,
        consistencyContext: '(none)',
        diceOutcomes: '(none this turn)',
      }),
    )
  })
})

describe('splitTripwireTemplate — the volatile marker must appear exactly once', () => {
  it('throws when the marker is missing (template drift)', () => {
    expect(() => splitTripwireTemplate('no volatile boundary in sight')).toThrow(/not found/)
  })

  it('throws when the marker appears more than once (a first-occurrence cut would silently move the breakpoint)', () => {
    const doctored =
      'head\n\nPlayer-facing prose this turn:\n{{prose}}\n\nPlayer-facing prose this turn:\n\ntail'
    expect(() => splitTripwireTemplate(doctored)).toThrow(/more than once/)
  })

  it('splits the real template at the single marker', () => {
    const { head, tail } = splitTripwireTemplate(loadPrompt('session', 'secret-tripwire'))
    expect(head + tail).toBe(loadPrompt('session', 'secret-tripwire'))
    expect(tail.startsWith('Player-facing prose this turn:')).toBe(true)
  })
})
