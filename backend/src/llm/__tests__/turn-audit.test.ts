// backend/src/llm/__tests__/turn-audit.test.ts
//
// myth-d6knq — the FT turn-audit classifier (auditTurn). One Haiku
// generateObject call through the canonical ai.ts wrapper, with a
// public-by-construction input serialized to plain text.
//
// Mock target: `'ai'` (the Vercel SDK), NOT the canonical wrapper `'../ai.js'`.
// The wrapper's generateObject internally calls the SDK's `generateText` with
// `Output.object`, populating `result.output` — so mocking `ai.generateText` to
// resolve `{ output, usage }` is what the wrapper reads back (mirrors
// dm-trigger-classifier.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { auditTurn, TURN_AUDIT_MODEL, type TurnAuditInput } from '../turn-audit.js'
import type { TurnAuditResult } from '../schemas/turn-audit.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const HAIKU_USAGE = { inputTokens: 600, outputTokens: 30, totalTokens: 630 }

const CLEAN: TurnAuditResult = {
  class: 'clean',
  confidence: 0.95,
  reason: 'The narration voices only NPCs and the world.',
}

const VIOLATION: TurnAuditResult = {
  class: 'pc_speech_authored',
  confidence: 0.9,
  reason: 'The narration puts new dialogue in Tally\'s mouth; Tally did not act.',
}

const INPUT: TurnAuditInput = {
  narration:
    '[DM] Tally lets the silence sit exactly as long as it needs to. Then she says, "What\'s in the hold, Trask?"',
  submittingMessage: 'Junie: I ask Venn where Coss would go next.',
  roster: ['Tally', 'Junie', 'Venn'],
  actingCharacters: ['Junie'],
}

describe('auditTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the model classification verbatim', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VIOLATION,
      finishReason: 'stop',
      usage: HAIKU_USAGE,
    } as never)

    const result = await auditTurn(INPUT)

    expect(result).toEqual(VIOLATION)
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })

  it('routes the call through HAIKU with the audit schema and FT-visible material only', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: CLEAN,
      finishReason: 'stop',
      usage: HAIKU_USAGE,
    } as never)

    await auditTurn(INPUT)

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      model: unknown
      output: unknown
      prompt: string
      system: string
    }
    expect(callOpts.model).toBe(TURN_AUDIT_MODEL)
    expect(callOpts.output).toBeDefined()
    // The narration, submitting message, and roster all land in the prompt.
    expect(callOpts.prompt).toContain('What\'s in the hold, Trask?')
    expect(callOpts.prompt).toContain('I ask Venn where Coss would go next.')
    expect(callOpts.prompt).toContain('Tally')
    // The audit system prompt is the loaded template.
    expect(callOpts.system).toContain('audit')
  })

  it('renders a player-less turn without a submitting message', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: CLEAN,
      finishReason: 'stop',
      usage: HAIKU_USAGE,
    } as never)

    await auditTurn({ narration: 'The lantern gutters and dies.', submittingMessage: '', roster: ['Tally'] })

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('player-less turn')
  })

  it('serializes an empty roster as "(none)"', async () => {
    // Every other case passes a populated roster; this exercises the empty-roster
    // side of serializeInput's ternary (a turn with no PCs seated).
    mockGenerateText.mockResolvedValueOnce({
      output: CLEAN,
      finishReason: 'stop',
      usage: HAIKU_USAGE,
    } as never)

    await auditTurn({ narration: 'The hall stands empty.', submittingMessage: 'x', roster: [] })

    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('Party roster: (none)')
  })

  it('propagates LLM call errors (the decorator owns fail-open)', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('haiku rate limit'))

    await expect(auditTurn(INPUT)).rejects.toThrow(/haiku rate limit/)
  })
})
