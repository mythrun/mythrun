// backend/src/session/tiers/__tests__/audited-fast-thinker.test.ts
//
// myth-d6knq — the turn-audit gate decorator. Pure unit test: a mock inner
// FastThinker (scripted AssistantMessages, capturing the ctx it is called with)
// + a mock audit classifier. No LLM, no DB, no worker.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditedFastThinker } from '../audited-fast-thinker.js'
import type { TurnAuditFn, TurnAuditInput } from '../../../llm/turn-audit.js'
import type { TurnAuditResult } from '../../../llm/schemas/turn-audit.js'
import type {
  AssistantMessage,
  ContentPart,
  FastThinker,
  FtTurnContext,
  TurnEmitter,
} from '../types.js'

const CLEAN: TurnAuditResult = { class: 'clean', confidence: 0.95, reason: 'ok' }
const PC_VIOLATION: TurnAuditResult = {
  class: 'pc_speech_authored',
  confidence: 0.9,
  reason: 'authored Tally speech',
}

function textAssistant(text: string): AssistantMessage {
  return { role: 'assistant', parts: [{ kind: 'text', text }], usage: { input: 10, output: 5 } }
}

function toolAssistant(text: string): AssistantMessage {
  const parts: ContentPart[] = [
    { kind: 'text', text },
    { kind: 'tool_call', toolCallId: 'c1', toolName: 'roll_skill_check', input: {} },
    { kind: 'tool_result', toolCallId: 'c1', toolName: 'roll_skill_check', output: { total: 12 } },
  ]
  return { role: 'assistant', parts, usage: { input: 10, output: 5 } }
}

// A minimal ctx: one player message in the history (the batch the render answered).
const CTX: FtTurnContext = {
  campaignId: 'camp',
  ftContext: 'prep',
  ftHistory: [
    { v: 1, role: 'user', parts: [{ kind: 'text', text: 'I ask Venn where Coss would go.' }], characterName: 'Junie' },
  ],
  participants: ['Tally', 'Junie', 'Venn'],
  usage: { input: 0, output: 0 },
  workingSet: [],
}

const NOOP_EMITTER = {} as unknown as TurnEmitter

/** A mock inner FastThinker that returns queued AssistantMessages in order and
 *  records each render's ctx (so we can assert the retry's correctiveInstruction). */
function makeInner(queue: AssistantMessage[]): {
  ft: FastThinker
  renderMock: ReturnType<typeof vi.fn>
  ctxAt: (i: number) => FtTurnContext
} {
  const renderMock = vi.fn((ctx: FtTurnContext, _emit: TurnEmitter) => {
    const next = queue.shift()
    if (next === undefined) throw new Error('inner render called more times than scripted')
    return Promise.resolve(next)
  })
  return {
    ft: { render: renderMock as unknown as FastThinker['render'] },
    renderMock,
    ctxAt: (i) => renderMock.mock.calls[i]?.[0] as FtTurnContext,
  }
}

describe('AuditedFastThinker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('(c) clean narration → no retry and exactly one audit call', async () => {
    const { ft, renderMock } = makeInner([textAssistant('The ferry rocks against the pilings.')])
    const audit = vi.fn<TurnAuditFn>().mockResolvedValue(CLEAN)
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true })

    const result = await gate.render(CTX, NOOP_EMITTER)

    expect(result.parts).toEqual([{ kind: 'text', text: 'The ferry rocks against the pilings.' }])
    expect(renderMock).toHaveBeenCalledTimes(1) // no retry render
    expect(audit).toHaveBeenCalledTimes(1) // the audit itself is the only extra call
  })

  it('(d) gate disabled by config → no audit call, no retry', async () => {
    const { ft, renderMock } = makeInner([textAssistant('Tally says nothing.')])
    const audit = vi.fn<TurnAuditFn>().mockResolvedValue(CLEAN)
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: false })

    await gate.render(CTX, NOOP_EMITTER)

    expect(renderMock).toHaveBeenCalledTimes(1)
    expect(audit).not.toHaveBeenCalled()
  })

  it('(a) violation → FT retried once with a corrective instruction naming the violation', async () => {
    const { ft, renderMock, ctxAt } = makeInner([
      textAssistant('[DM] Tally says, "What\'s in the hold, Trask?"'), // attempt 1 (violates)
      textAssistant('Venn scratches his jaw and considers your question.'), // retry (clean)
    ])
    const audit = vi
      .fn<TurnAuditFn>()
      .mockResolvedValueOnce(PC_VIOLATION) // attempt 1
      .mockResolvedValueOnce(CLEAN) // retry
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true })

    const result = await gate.render(CTX, NOOP_EMITTER)

    // Retried exactly once (two inner renders), audited twice.
    expect(renderMock).toHaveBeenCalledTimes(2)
    expect(audit).toHaveBeenCalledTimes(2)
    // The retry ctx carries a corrective instruction that names the PC-speech violation.
    const retryCtx = ctxAt(1)
    expect(retryCtx.correctiveInstruction).toBeDefined()
    expect(retryCtx.correctiveInstruction).toMatch(/player character/i)
    expect(retryCtx.correctiveInstruction).toMatch(/never put words/i)
    // The first render had NO corrective instruction.
    expect(ctxAt(0).correctiveInstruction).toBeUndefined()
    // The corrected render is what is returned (persisted).
    expect(result.parts).toEqual([{ kind: 'text', text: 'Venn scratches his jaw and considers your question.' }])
  })

  it('(a) audit input carries the submitting message + roster (enforced-ignorance-safe)', async () => {
    const { ft } = makeInner([textAssistant('x'), textAssistant('y')])
    const captured: TurnAuditInput[] = []
    const audit = vi.fn<TurnAuditFn>(async (input) => {
      captured.push(input)
      return PC_VIOLATION
    })
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true })

    await gate.render(CTX, NOOP_EMITTER)

    expect(captured[0]?.submittingMessage).toContain('Junie: I ask Venn where Coss would go.')
    expect(captured[0]?.roster).toEqual(['Tally', 'Junie', 'Venn'])
    expect(captured[0]?.actingCharacters).toEqual(['Junie'])
  })

  it('(b) retry still violating → fail-open to attempt 1 + warn log + counter', async () => {
    const { ft, renderMock } = makeInner([
      textAssistant('attempt-1 puppets Tally'), // attempt 1 (violates)
      textAssistant('retry still puppets Tally'), // retry (still violates)
    ])
    const audit = vi.fn<TurnAuditFn>().mockResolvedValue(PC_VIOLATION) // both attempts violate
    const warn = vi.fn()
    const onFailOpen = vi.fn()
    const gate = new AuditedFastThinker({
      inner: ft,
      audit,
      enabled: true,
      logger: { warn },
      onFailOpen,
    })

    const result = await gate.render(CTX, NOOP_EMITTER)

    expect(renderMock).toHaveBeenCalledTimes(2) // one retry, then give up
    // Fail-open returns the STREAMED attempt 1 (streamed == persisted).
    expect(result.parts).toEqual([{ kind: 'text', text: 'attempt-1 puppets Tally' }])
    // A structured warn + the counter hook fired.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ft_turn_audit_fail_open', class: 'pc_speech_authored' }),
      expect.any(String),
    )
    expect(onFailOpen).toHaveBeenCalledWith({ class: 'pc_speech_authored' })
  })

  it('violation but attempt 1 called a tool → NO retry (side-effect safety), fail-open', async () => {
    const { ft, renderMock } = makeInner([toolAssistant('rolled, then puppeted Tally')])
    const audit = vi.fn<TurnAuditFn>().mockResolvedValue(PC_VIOLATION)
    const warn = vi.fn()
    const onFailOpen = vi.fn()
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true, logger: { warn }, onFailOpen })

    const result = await gate.render(CTX, NOOP_EMITTER)

    expect(renderMock).toHaveBeenCalledTimes(1) // NO retry — a tool ran
    expect(audit).toHaveBeenCalledTimes(1)
    expect(result.parts[0]).toEqual({ kind: 'text', text: 'rolled, then puppeted Tally' })
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ft_turn_audit_fail_open', reason: 'tool_calls_present' }),
      expect.any(String),
    )
    expect(onFailOpen).toHaveBeenCalledTimes(1)
  })

  it('audit call failure fails open (never blocks a turn on the gate)', async () => {
    const { ft, renderMock } = makeInner([textAssistant('the world answers')])
    const audit = vi.fn<TurnAuditFn>().mockRejectedValue(new Error('haiku 529'))
    const warn = vi.fn()
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true, logger: { warn } })

    const result = await gate.render(CTX, NOOP_EMITTER)

    expect(result.parts[0]).toEqual({ kind: 'text', text: 'the world answers' })
    expect(renderMock).toHaveBeenCalledTimes(1) // no retry on an audit error
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ft_turn_audit_error', phase: 'attempt-1' }),
      expect.any(String),
    )
  })
})
