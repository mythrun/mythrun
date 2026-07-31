// backend/src/llm/__tests__/st-narrative-progress.test.ts
//
// myth-3jna1 — the narrative-progress judgment. One cheap Haiku generateObject
// through the canonical ai.ts wrapper answers "how far through the prep's
// intended arc is this session?". Per ZFC the judgment is the model's; code
// only compares the returned fraction against the mechanical one.
//
// Mock target: `'ai'` (the Vercel SDK), NOT the canonical wrapper `'../ai.js'`.
// The wrapper's generateObject drives the SDK's generateText with Output.object
// underneath, so mocking `ai.generateText` to resolve `{ output, usage }` is
// what the wrapper reads back. Mirrors st-gate.test.ts.
//
// SECRET-SIDE: this call is fed the full sd_playbook (it cannot judge the arc
// without it) and its output is consumed by CODE only — the worker turns it
// into a boolean. The tests below pin both halves of that: the playbook DOES
// reach the prompt, and the returned shape carries nothing an FT-facing
// artifact could pick up beyond a number.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { runStNarrativeProgress } from '../st-narrative-progress.js'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))

const mockGenerateText = vi.mocked(ai.generateText)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runStNarrativeProgress', () => {
  it('returns the structured judgment and threads playbook + summary + slice into the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { basis: 'two of three goals landed', progress: 0.6 },
      finishReason: 'stop',
      usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 },
    } as never)

    const r = await runStNarrativeProgress({
      sdPlaybook: 'SECRET-PLAYBOOK',
      runningSummary: 'SUMMARY',
      recentExchanges: 'EXCHANGES',
    })

    expect(r.result).toEqual({ basis: 'two of three goals landed', progress: 0.6 })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      prompt: string
      providerOptions?: unknown
    }
    expect(call.prompt).toContain('SECRET-PLAYBOOK')
    expect(call.prompt).toContain('SUMMARY')
    expect(call.prompt).toContain('EXCHANGES')
    expect(call.providerOptions).toMatchObject({
      mythrun: { stage: 'st_narrative_progress' },
    })
  })

  it('surfaces usage for :usage:st accounting', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { basis: 'b', progress: 0.1 },
      finishReason: 'stop',
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    } as never)

    const r = await runStNarrativeProgress({
      sdPlaybook: 'p',
      runningSummary: '',
      recentExchanges: 'e',
    })

    expect(r.usage.inputTokens).toBe(11)
  })

  it('is a JUDGMENT call, not a steer: the prompt asks for a fraction and issues no direction', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { basis: 'b', progress: 0.9 },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await runStNarrativeProgress({ sdPlaybook: 'p', runningSummary: '', recentExchanges: 'e' })

    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    // The measured axis is the PREP'S ARC, not the scene and not the budget.
    expect(call.prompt).toMatch(/Session Goals/)
    expect(call.prompt).toMatch(/Revelation List/)
    // It must not be told how much budget is left — a probe that knows the
    // clock would anchor its arc judgment to the clock and the comparison in
    // converge-policy would compare a number against itself.
    expect(call.prompt).not.toMatch(/token budget|tokens remaining/i)
  })
})
