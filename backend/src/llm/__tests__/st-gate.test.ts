// backend/src/llm/__tests__/st-gate.test.ts
//
// MYT-69 §3: the Haiku gate. One generateObject through the canonical ai.ts
// wrapper decides whether the Opus ST call is worth spending. The verdict is
// consumed by CODE only and NEVER fed to the ST (gate independence).
//
// Mock target: `'ai'` (the Vercel SDK), NOT the canonical wrapper `'../ai.js'`.
// The wrapper's generateObject internally calls the SDK's generateText with
// Output.object, which populates `result.output` with the typed object — so
// mocking `ai.generateText` to resolve `{ output, usage }` is what the wrapper
// reads back. Mirrors src/llm/__tests__/dm-trigger-classifier.test.ts; the
// wrapper-direct mock doesn't intercept in this vitest+ESM config.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { runStGate } from '../st-gate.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

describe('runStGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the structured verdict and threads sd_playbook + summary + slice into the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { needed: true, confidence: 0.6, reason: 'r' },
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    } as never)

    const r = await runStGate({
      sdPlaybook: 'SECRET-PLAYBOOK',
      runningSummary: 'SUMMARY',
      recentExchanges: 'EXCHANGES',
      sessionId: 'sess-gate-1',
    })

    expect(r.result).toEqual({ needed: true, confidence: 0.6, reason: 'r' })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      providerOptions?: unknown
    }
    expect(call.prompt).toContain('SECRET-PLAYBOOK')
    expect(call.prompt).toContain('SUMMARY')
    expect(call.prompt).toContain('EXCHANGES')
    expect(call.providerOptions).toMatchObject({
      mythrun: { stage: 'st_gate', sessionId: 'sess-gate-1' },
    })
  })

  it('surfaces usage for :usage:st accounting', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { needed: false, confidence: 0.95, reason: 'routine' },
      finishReason: 'stop',
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
    } as never)

    const r = await runStGate({
      sdPlaybook: 'p',
      runningSummary: '',
      recentExchanges: 'e',
      sessionId: 'sess-gate-1',
    })

    expect(r.usage.inputTokens).toBe(9)
  })
})
