// backend/src/session/tiers/__tests__/audited-fast-thinker.test.ts
//
// myth-d6knq — the turn-audit gate decorator. Pure unit test: a mock inner
// FastThinker (scripted AssistantMessages, capturing the ctx it is called with)
// + a mock audit classifier. No LLM, no DB, no worker.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditedFastThinker, correctiveInstructionFor } from '../audited-fast-thinker.js'
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
  renderMock: ReturnType<typeof vi.fn<FastThinker['render']>>
  ctxAt: (i: number) => FtTurnContext
} {
  const renderMock = vi.fn<FastThinker['render']>(() => {
    const next = queue.shift()
    if (next === undefined) throw new Error('inner render called more times than scripted')
    return Promise.resolve(next)
  })
  return {
    ft: { render: renderMock },
    renderMock,
    ctxAt: (i) => {
      const ctx = renderMock.mock.calls[i]?.[0]
      if (ctx === undefined) throw new Error(`no render call at index ${String(i)}`)
      return ctx
    },
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
    const audit = vi.fn<TurnAuditFn>((input) => {
      captured.push(input)
      return Promise.resolve(PC_VIOLATION)
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

  it('retry audit itself failing fails open to attempt 1 with a null retriedClass', async () => {
    // attempt 1 violates (retryable); the RETRY render succeeds but the retry
    // AUDIT throws → classify returns null → `retryAudit === null` → the failOpen
    // carries retriedClass:null (distinct from "retry came back still-violating").
    const { ft, renderMock } = makeInner([
      textAssistant('attempt-1 puppets Tally'), // attempt 1 (violates)
      textAssistant('retry text (unaudited)'), // retry render (succeeds)
    ])
    const audit = vi
      .fn<TurnAuditFn>()
      .mockResolvedValueOnce(PC_VIOLATION) // attempt-1 audit
      .mockRejectedValueOnce(new Error('retry audit 529')) // retry audit itself fails
    const warn = vi.fn()
    const onFailOpen = vi.fn()
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true, logger: { warn }, onFailOpen })

    const result = await gate.render(CTX, NOOP_EMITTER)

    expect(renderMock).toHaveBeenCalledTimes(2) // one retry, then give up
    expect(result.parts).toEqual([{ kind: 'text', text: 'attempt-1 puppets Tally' }]) // fail-open to attempt 1
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ft_turn_audit_fail_open',
        reason: 'retry_not_clean',
        retriedClass: null,
      }),
      expect.any(String),
    )
    expect(onFailOpen).toHaveBeenCalledWith({ class: 'pc_speech_authored' })
  })

  it('an audit that rejects with a NON-Error still fails open (String(err) branch)', async () => {
    const { ft, renderMock } = makeInner([textAssistant('the world answers')])
    const audit = vi.fn<TurnAuditFn>().mockRejectedValue('haiku string failure') // a non-Error throw
    const warn = vi.fn()
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true, logger: { warn } })

    const result = await gate.render(CTX, NOOP_EMITTER)

    expect(result.parts[0]).toEqual({ kind: 'text', text: 'the world answers' })
    expect(renderMock).toHaveBeenCalledTimes(1)
    // The non-Error was stringified into the structured warn.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ft_turn_audit_error', err: 'haiku string failure' }),
      expect.any(String),
    )
  })

  it('extractBatch stops at the prior DM turn (only the trailing player run is the batch)', async () => {
    // A history whose trailing player message is PRECEDED by an assistant (DM)
    // turn exercises the loop-break: the batch is only the messages after the
    // last DM turn.
    const ctxWithPriorDm: FtTurnContext = {
      ...CTX,
      ftHistory: [
        { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'The prior DM turn.' }] },
        { v: 1, role: 'user', parts: [{ kind: 'text', text: 'I open the door.' }], characterName: 'Junie' },
      ],
    }
    const { ft } = makeInner([textAssistant('The door swings wide.')])
    const captured: TurnAuditInput[] = []
    const audit = vi.fn<TurnAuditFn>((input) => {
      captured.push(input)
      return Promise.resolve(CLEAN)
    })
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true })

    await gate.render(ctxWithPriorDm, NOOP_EMITTER)

    expect(captured[0]?.submittingMessage).toBe('Junie: I open the door.')
  })

  it('extractBatch labels a nameless player message as "Player" and excludes it from acting characters', async () => {
    const ctxNameless: FtTurnContext = {
      ...CTX,
      ftHistory: [{ v: 1, role: 'user', parts: [{ kind: 'text', text: 'What do I see?' }] }], // no characterName
    }
    const { ft } = makeInner([textAssistant('A long gallery, unlit.')])
    const captured: TurnAuditInput[] = []
    const audit = vi.fn<TurnAuditFn>((input) => {
      captured.push(input)
      return Promise.resolve(CLEAN)
    })
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true })

    await gate.render(ctxNameless, NOOP_EMITTER)

    expect(captured[0]?.submittingMessage).toBe('Player: What do I see?')
    expect(captured[0]?.actingCharacters).toEqual([]) // nameless → not an acting character
  })

  it('the RETRY renders through the default SILENT emitter — every emit method resolves and nothing re-streams', async () => {
    // The retry render receives the decorator's default retryEmitter (the
    // SILENT_EMITTER), whose eight no-op arrows must swallow every frame kind so
    // the corrected turn is NOT re-streamed to the client (the player already
    // saw attempt 1's text_delta; a live re-stream would double the prose). This
    // inner drives ALL eight methods on the emitter it is handed on the retry.
    let call = 0
    const inner: FastThinker = {
      render: async (_ctx, emit) => {
        call += 1
        if (call === 1) return textAssistant('attempt-1 puppets Tally')
        // The retry: exercise every emit method on the (silent) emitter handed in.
        await Promise.all([
          emit.emitText('x'),
          emit.emitSkillCheck({
            characterName: 'Venn',
            skill: 'Insight',
            context: 'reading the room',
            roll: 12,
            roll2: null,
            rollType: 'normal',
            modifier: 3,
            total: 15,
            dc: 12,
            outcomeTier: 'success',
            constraint: 'He clocks the lie.',
          }),
          emit.emitDiceRoll({ count: 1, sides: 6, results: [3], total: 3 }),
          emit.emitLedgerUpdate({ characterName: 'Venn', kind: 'gold', summary: 'Pays 2gp.', gold: 40 }),
          emit.emitModeChange({ from: 'exploration', to: 'combat', reason: 'a blade clears leather' }),
          emit.emitCombatStarted({
            enemies: [{ name: 'Cutpurse', description: 'a wiry cutpurse', count: 1 }],
            initiative: [{ combatant: 'Venn', roll: 14 }],
          }),
          emit.emitCombatResolved({ narration: 'It ends.', outcome: 'victory', casualties: [], hpChanges: [] }),
          emit.emitCorrection({ text: 'On reflection, the door was already ajar.' }),
        ])
        return textAssistant('Venn scratches his jaw and considers your question.')
      },
    }
    // attempt 1 violates (no tool → retryable); retry comes back clean.
    const audit = vi.fn<TurnAuditFn>().mockResolvedValueOnce(PC_VIOLATION).mockResolvedValueOnce(CLEAN)
    const gate = new AuditedFastThinker({ inner, audit, enabled: true })

    const result = await gate.render(CTX, NOOP_EMITTER)

    // All eight silent-emitter calls resolved (no throw) and the corrected retry
    // render is what gets returned (persisted).
    expect(result.parts).toEqual([
      { kind: 'text', text: 'Venn scratches his jaw and considers your question.' },
    ])
    expect(call).toBe(2) // exactly one retry
  })

  it('correctiveInstructionFor maps each violation class to its named instruction; clean → undefined', () => {
    // Direct unit of the exhaustive switch — `render` only ever reaches it with a
    // NON-clean class (a clean turn returns before the retry), so the defensive
    // `clean` arm is unreachable through the decorator and is covered here.
    expect(correctiveInstructionFor('pc_speech_authored')).toMatch(/never put words/i)
    expect(correctiveInstructionFor('inline_meta_correction')).toMatch(/issue_correction tool/)
    expect(correctiveInstructionFor('fake_session_end')).toMatch(/ended the session/i)
    expect(correctiveInstructionFor('clean')).toBeUndefined()
  })

  it('an inline_meta_correction violation retries with the issue_correction-tool instruction', async () => {
    const { ft, ctxAt } = makeInner([
      textAssistant('Correction: the lantern was lit, not dark.'), // attempt 1 (violates)
      textAssistant('The lantern throws a thin, wavering light.'), // retry (clean)
    ])
    const audit = vi
      .fn<TurnAuditFn>()
      .mockResolvedValueOnce({ class: 'inline_meta_correction', confidence: 0.9, reason: 'inline fix' })
      .mockResolvedValueOnce(CLEAN)
    const info = vi.fn()
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true, logger: { warn: vi.fn(), info } })

    await gate.render(CTX, NOOP_EMITTER)

    expect(ctxAt(1).correctiveInstruction).toMatch(/issue_correction tool/)
    // A corrected-on-retry turn logs the structured info event.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ft_turn_audit_corrected', originalClass: 'inline_meta_correction' }),
      expect.any(String),
    )
  })

  it('a fake_session_end violation retries with the leave-the-scene-open instruction', async () => {
    const { ft, ctxAt } = makeInner([
      textAssistant('And so the session draws to a close. Until next time, adventurers.'), // attempt 1
      textAssistant('The tide keeps rising; Trask waits for your answer.'), // retry (clean)
    ])
    const audit = vi
      .fn<TurnAuditFn>()
      .mockResolvedValueOnce({ class: 'fake_session_end', confidence: 0.9, reason: 'fake end' })
      .mockResolvedValueOnce(CLEAN)
    const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true })

    await gate.render(CTX, NOOP_EMITTER)

    expect(ctxAt(1).correctiveInstruction).toMatch(/leave the scene open/i)
  })

  // ux-run1 — the deterministic prose guard rides post-render, observability-only.
  describe('deterministic prose guard (ux-run1)', () => {
    it('fires onProseGuard + warns when the narration leaks an internal term — but never blocks or retries', async () => {
      const leak = 'The passage narrows as the session context says it does.'
      const { ft, renderMock } = makeInner([textAssistant(leak)])
      const audit = vi.fn<TurnAuditFn>().mockResolvedValue(CLEAN)
      const onProseGuard = vi.fn()
      const warn = vi.fn()
      const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true, onProseGuard, logger: { warn } })

      const result = await gate.render(CTX, NOOP_EMITTER)

      // The turn is returned UNCHANGED (no block, no extra render) — guard is log-only.
      expect(result.parts).toEqual([{ kind: 'text', text: leak }])
      expect(renderMock).toHaveBeenCalledTimes(1)
      expect(onProseGuard).toHaveBeenCalledTimes(1)
      expect(onProseGuard.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ kind: 'internal_term' }),
      ])
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ft_prose_guard' }),
        expect.any(String),
      )
    })

    it('runs even when the Haiku audit gate is disabled (independent deterministic check)', async () => {
      const { ft } = makeInner([textAssistant('opened *but never closed and it.You fused')])
      const audit = vi.fn<TurnAuditFn>().mockResolvedValue(CLEAN)
      const onProseGuard = vi.fn()
      const gate = new AuditedFastThinker({ inner: ft, audit, enabled: false, onProseGuard })

      await gate.render(CTX, NOOP_EMITTER)

      expect(audit).not.toHaveBeenCalled() // gate off
      const kinds = (onProseGuard.mock.calls[0]?.[0] as { kind: string }[]).map((v) => v.kind)
      expect(kinds).toContain('unrendered_emphasis')
      expect(kinds).toContain('fused_sentence')
    })

    it('stays silent on clean narration', async () => {
      const { ft } = makeInner([textAssistant('The ferry rocks against the pilings.')])
      const audit = vi.fn<TurnAuditFn>().mockResolvedValue(CLEAN)
      const onProseGuard = vi.fn()
      const gate = new AuditedFastThinker({ inner: ft, audit, enabled: true, onProseGuard })

      await gate.render(CTX, NOOP_EMITTER)

      expect(onProseGuard).not.toHaveBeenCalled()
    })
  })
})
