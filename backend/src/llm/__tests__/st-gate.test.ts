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
import { runStGate, splitGateTemplate } from '../st-gate.js'
import { loadPrompt } from '../prompts.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

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

const okVerdict = {
  output: { needed: true, confidence: 0.6, reason: 'r' },
  finishReason: 'stop',
  usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
} as never

describe('runStGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the structured verdict and threads sd_playbook + summary + slice into the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce(okVerdict)

    const r = await runStGate({
      sdPlaybook: 'SECRET-PLAYBOOK',
      runningSummary: 'SUMMARY',
      recentExchanges: 'EXCHANGES',
      sessionId: 'sess-gate-1',
    })

    expect(r.result).toEqual({ needed: true, confidence: 0.6, reason: 'r' })
    const call = mockGenerateText.mock.calls[0]?.[0] as unknown as {
      providerOptions?: unknown
    }
    expect(promptTextOf()).toContain('SECRET-PLAYBOOK')
    expect(promptTextOf()).toContain('SUMMARY')
    expect(promptTextOf()).toContain('EXCHANGES')
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

// Cost-wave1 §3 — gate caching. The template is already stable-first
// (instruction head + full sd_playbook above; per-turn summary/exchanges
// below), so this is ANNOTATION ONLY: the assembly compiles to two user
// blocks split at '## Running summary', with the cache breakpoint pinned on
// the stable block. Zero template byte changes — pinned by the concatenation
// test below.
describe('runStGate — stable-first blocks (cost-wave1 §3)', () => {
  const stableInput = {
    sdPlaybook: 'PLAYBOOK-SPAN with a trigger table',
    sessionId: 'sess-gate-blocks',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stable prefix is byte-identical across calls with different volatile inputs', async () => {
    mockGenerateText.mockResolvedValue(okVerdict)

    await runStGate({ ...stableInput, runningSummary: 'turn 3 summary', recentExchanges: 'A: hi' })
    await runStGate({
      ...stableInput,
      runningSummary: 'turn 4 summary, quite different',
      recentExchanges: 'B: something else entirely',
    })

    const first = messagesOf(0)
    const second = messagesOf(1)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // The stable block (head + playbook) is byte-identical; only the volatile
    // tail moves between turns.
    expect(second[0]?.content).toBe(first[0]?.content)
    expect(second[1]?.content).not.toBe(first[1]?.content)
  })

  it('breakpoint sits on the stable block only, after the playbook span', async () => {
    mockGenerateText.mockResolvedValueOnce(okVerdict)

    await runStGate({ ...stableInput, runningSummary: 's', recentExchanges: 'e' })

    const messages = messagesOf()
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.providerOptions).toEqual(BREAKPOINT)
    // The volatile tail carries NO providerOptions key at all (a stray
    // undefined-valued key would still serialize into the wire request).
    expect(Object.keys(messages[1] ?? {})).toEqual(['role', 'content'])
    // The split lands exactly at the volatile boundary: playbook above,
    // per-turn state below.
    expect(messages[0]?.content).toContain('PLAYBOOK-SPAN with a trigger table')
    expect(messages[1]?.content.startsWith('## Running summary')).toBe(true)
    expect(messages[0]?.content).not.toContain('## Running summary')
  })

  it('block concatenation is byte-identical to the legacy flat rendering (zero template byte changes)', async () => {
    mockGenerateText.mockResolvedValueOnce(okVerdict)

    const vars = {
      sd_playbook: 'PB with {{curly}} noise and $& regex traps',
      running_summary: 'summary $1 text',
      recent_exchanges: 'E1\nE2',
    }
    await runStGate({
      sdPlaybook: vars.sd_playbook,
      runningSummary: vars.running_summary,
      recentExchanges: vars.recent_exchanges,
      sessionId: 'sess-gate-bytes',
    })

    expect(promptTextOf()).toBe(loadPrompt('session', 'st-gate', vars))
  })
})

describe('splitGateTemplate — the volatile marker must appear exactly once', () => {
  it('throws when the marker is missing (template drift)', () => {
    expect(() => splitGateTemplate('no volatile boundary in sight')).toThrow(/not found/)
  })

  it('throws when the marker appears more than once (a first-occurrence cut would silently move the breakpoint)', () => {
    const doctored = 'head\n\n## Running summary\n\nmid\n\n## Running summary\n\ntail'
    expect(() => splitGateTemplate(doctored)).toThrow(/more than once/)
  })

  it('splits the real template at the single marker', () => {
    const { head, tail } = splitGateTemplate(loadPrompt('session', 'st-gate'))
    expect(head + tail).toBe(loadPrompt('session', 'st-gate'))
    expect(tail.startsWith('## Running summary')).toBe(true)
  })
})
