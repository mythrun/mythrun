// backend/src/session/tiers/audited-fast-thinker.ts
//
// myth-d6knq — the turn-audit gate, wired as a FastThinker DECORATOR. This is
// the single chokepoint where FT narration is finalized before persistence: the
// SessionController calls `ft.render(ctx, emit)` exactly once, and the worker
// wraps the real SonnetFastThinker in this decorator at construction — so every
// rendered turn passes through the audit without the controller (a thin ZFC
// shell) or the FT tier learning anything about auditing.
//
// FLOW (a rare-path defense — the overwhelming majority of turns are clean and
// pay only ONE extra Haiku call):
//
//   1. Render attempt 1 through the REAL emitter (streams live, as always).
//   2. If the gate is disabled → return attempt 1 (no audit call, no latency).
//   3. Audit attempt 1's narration (Haiku, ZFC — the judgment is the model's).
//      Audit-call failure fails OPEN (never block a turn on the gate).
//   4. clean → return attempt 1 (one audit call, no retry).
//   5. violation:
//      - If attempt 1 called ANY tool → fail-open (return attempt 1). A retry
//        would re-run tool side effects (ledger mutations, combat, injections)
//        or desync a streamed roll — never safe. The real violations
//        (PC-speech / inline-correction / fake-end) are pure prose, so this
//        costs nothing in practice.
//      - Else RETRY once through a SILENT emitter (NO live re-stream — the
//        client accrues text_delta under a turnId, so a live re-stream would
//        DOUBLE the prose; only session_reconnect whole-turn-replaces). The
//        corrected render is what gets PERSISTED and thus what a reconnecting
//        client and the FT's own next-turn context see (the myth-ph544
//        contamination cycle is closed on the durable record).
//        - retry clean → return the retry (persist corrected).
//        - retry still violates → fail-open to attempt 1 (streamed == persisted;
//          the system behaves as if the gate were absent). warn + counter.
//
// Enforced ignorance holds by construction: the audit input is built only from
// FtTurnContext (public-by-type) and the FT's own output — no plot/secret
// material can reach the audit call.

import type { TurnAuditClass, TurnAuditFn, TurnAuditInput } from '../../llm/turn-audit.js'
import { checkFtProse } from '../../llm/ft-prose-guard.js'
import type { FtProseViolation } from '../../llm/ft-prose-guard.js'
import type {
  AssistantMessage,
  ContentPart,
  ConversationMessage,
  FastThinker,
  FtTurnContext,
  TurnEmitter,
} from './types.js'

interface AuditLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void
  info?: (obj: Record<string, unknown>, msg: string) => void
}

export interface AuditedFastThinkerDeps {
  /** The wrapped FastThinker (the real SonnetFastThinker in production). */
  readonly inner: FastThinker
  /** The injected audit classifier (production: `auditTurn`; tests: a stub). */
  readonly audit: TurnAuditFn
  /** Cost-harness scope id (cost wave 1 §1.0) — threaded into the audit
   *  input's providerOptions.mythrun only, NEVER the serialized prompt. */
  readonly sessionId: string
  /** The config gate. `false` short-circuits the audit entirely — attempt 1 is
   *  returned with no audit call. The worker threads `TURN_AUDIT_ENABLED`. */
  readonly enabled: boolean
  readonly logger?: AuditLogger
  /** Log-based counter seam: called once on every FAIL-OPEN (a violation the
   *  gate could not correct). A metrics backend can bind a counter here; tests
   *  spy on it. Optional. */
  readonly onFailOpen?: (audit: { class: TurnAuditClass }) => void
  /** myth-aiiao — called once when a violation was CORRECTED on the silent
   *  retry (the persisted turn now diverges from what streamed live). The
   *  worker binds this to arm the post-persist whole-turn-replace push, which
   *  repairs the live client's transcript. Optional. */
  readonly onCorrected?: (audit: { class: TurnAuditClass }) => void
  /** Counter seam for the DETERMINISTIC prose guard (ux-run1): called once per
   *  render whose narration tripped a structural check (leaked emphasis marker,
   *  fused sentence seam, internal-term leak). Observability only — the guard
   *  NEVER blocks or retries a turn; the render is returned unchanged. Tests spy
   *  on it. Optional. */
  readonly onProseGuard?: (violations: readonly FtProseViolation[]) => void
  /** Test seam — the emitter used for the RETRY render. Defaults to a no-op so
   *  the retry never re-streams (see the flow note). */
  readonly retryEmitter?: TurnEmitter
}

/** A no-op emitter: on a PLAYER-TRIGGERED turn the retry render must NOT
 *  re-stream to the client (that would double the prose the player already
 *  saw). The corrected turn reaches the client via the worker's post-persist
 *  whole-turn-replace push (myth-aiiao; `onCorrected` arms it), on reconnect
 *  (session_reconnect), and via the persisted rows in the FT's own next-turn
 *  context. */
const SILENT_EMITTER: TurnEmitter = {
  emitText: () => Promise.resolve(),
  emitSkillCheck: () => Promise.resolve(),
  emitDiceRoll: () => Promise.resolve(),
  emitLedgerUpdate: () => Promise.resolve(),
  emitModeChange: () => Promise.resolve(),
  emitCombatStarted: () => Promise.resolve(),
  emitCombatResolved: () => Promise.resolve(),
  emitCorrection: () => Promise.resolve(),
}

/** myth-aiiao — a recording emitter for PLAYER-LESS (correction / farewell)
 *  turns: frames buffer in emission order and reach the real emitter only when
 *  the audit gate releases the winning render (`flushTo`). A puppeteer attempt
 *  that the retry replaces is then never player-visible — there is no latency
 *  pressure on a playerless turn, so buffering costs nothing a player can see.
 *  Exported for tests. */
export class BufferingTurnEmitter implements TurnEmitter {
  private readonly ops: ((real: TurnEmitter) => Promise<void>)[] = []

  emitText(text: string): Promise<void> {
    this.ops.push((real) => real.emitText(text))
    return Promise.resolve()
  }
  emitSkillCheck(p: Parameters<TurnEmitter['emitSkillCheck']>[0]): Promise<void> {
    this.ops.push((real) => real.emitSkillCheck(p))
    return Promise.resolve()
  }
  emitDiceRoll(p: Parameters<TurnEmitter['emitDiceRoll']>[0]): Promise<void> {
    this.ops.push((real) => real.emitDiceRoll(p))
    return Promise.resolve()
  }
  emitLedgerUpdate(p: Parameters<TurnEmitter['emitLedgerUpdate']>[0]): Promise<void> {
    this.ops.push((real) => real.emitLedgerUpdate(p))
    return Promise.resolve()
  }
  emitModeChange(p: Parameters<TurnEmitter['emitModeChange']>[0]): Promise<void> {
    this.ops.push((real) => real.emitModeChange(p))
    return Promise.resolve()
  }
  emitCombatStarted(p: Parameters<TurnEmitter['emitCombatStarted']>[0]): Promise<void> {
    this.ops.push((real) => real.emitCombatStarted(p))
    return Promise.resolve()
  }
  emitCombatResolved(p: Parameters<TurnEmitter['emitCombatResolved']>[0]): Promise<void> {
    this.ops.push((real) => real.emitCombatResolved(p))
    return Promise.resolve()
  }
  emitCorrection(p: Parameters<TurnEmitter['emitCorrection']>[0]): Promise<void> {
    this.ops.push((real) => real.emitCorrection(p))
    return Promise.resolve()
  }

  /** Replay every buffered frame into `real`, in emission order. */
  async flushTo(real: TurnEmitter): Promise<void> {
    for (const op of this.ops) await op(real)
  }
}

export class AuditedFastThinker implements FastThinker {
  private readonly inner: FastThinker
  private readonly audit: TurnAuditFn
  private readonly sessionId: string
  private readonly enabled: boolean
  private readonly logger: AuditLogger | undefined
  private readonly onFailOpen: ((audit: { class: TurnAuditClass }) => void) | undefined
  private readonly onCorrected: ((audit: { class: TurnAuditClass }) => void) | undefined
  private readonly onProseGuard: ((violations: readonly FtProseViolation[]) => void) | undefined
  private readonly retryEmitter: TurnEmitter

  constructor(deps: AuditedFastThinkerDeps) {
    this.inner = deps.inner
    this.audit = deps.audit
    this.sessionId = deps.sessionId
    this.enabled = deps.enabled
    this.logger = deps.logger
    this.onFailOpen = deps.onFailOpen
    this.onCorrected = deps.onCorrected
    this.onProseGuard = deps.onProseGuard
    this.retryEmitter = deps.retryEmitter ?? SILENT_EMITTER
  }

  async render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage> {
    // myth-aiiao — a PLAYER-LESS turn (correction / farewell) has no first-token
    // latency pressure, so attempt 1 renders into a BUFFER and frames reach the
    // live channel only after the audit picks the winning render. A puppeteer
    // attempt 1 is then never player-visible. Player-triggered turns keep the
    // stream-live-then-silently-retry flow (latency is the product there).
    const buffered = this.enabled && ctx.playerlessTurn === true
    const firstEmitter = buffered ? new BufferingTurnEmitter() : emit
    const first = await this.inner.render(ctx, firstEmitter)
    // Deterministic prose guard (ux-run1): runs on EVERY render, independent of the
    // Haiku audit gate — it is cheap and never touches the model. Observability only;
    // it logs + counts a structural leak, never blocks or retries (a prose nit must
    // not strand a live turn). The real fixes are the client renderer + the prompt.
    this.runProseGuard(first)
    if (!this.enabled) return first

    // Release the winning render's buffered frames on every exit of a buffered
    // turn (attempt 1 unless the corrected-retry arm flushed the retry buffer).
    const releaseFirst = async (): Promise<void> => {
      if (buffered) await (firstEmitter as BufferingTurnEmitter).flushTo(emit)
    }

    const batch = extractBatch(ctx.ftHistory)
    const firstAudit = await this.classify(buildInput(ctx, first, batch, this.sessionId), 'attempt-1')
    // Audit call failed, or the narration is clean → keep attempt 1.
    if (firstAudit === null || firstAudit.class === 'clean') {
      await releaseFirst()
      return first
    }

    // A violation. A retry re-runs the model, so it is only safe when attempt 1
    // called no tools (no side effects to double-apply, no streamed roll to
    // desync). Otherwise fail open.
    if (hasToolCalls(first)) {
      this.failOpen(firstAudit.class, 'tool_calls_present', { retriedClass: null })
      await releaseFirst()
      return first
    }

    const correctiveInstruction = correctiveInstructionFor(firstAudit.class)
    // `clean` is already handled above, so a violation class always maps to an
    // instruction; the guard is defensive (and narrows the type to `string` for
    // the exactOptionalPropertyTypes spread below).
    /* c8 ignore start — unreachable defensive narrowing: correctiveInstructionFor
       returns undefined ONLY for `clean`, and a clean audit already returned at the
       top of render, so this arm can never fire in practice. */
    if (correctiveInstruction === undefined) {
      await releaseFirst()
      return first
    }
    /* c8 ignore stop */
    // Buffered turn → the retry records into its OWN buffer (released below iff
    // it wins); live turn → the silent emitter (never re-stream over accrued
    // prose; the worker's whole-turn-replace push repairs the live client).
    const retryBuffer = buffered ? new BufferingTurnEmitter() : null
    const retry = await this.inner.render({ ...ctx, correctiveInstruction }, retryBuffer ?? this.retryEmitter)
    const retryAudit = await this.classify(buildInput(ctx, retry, batch, this.sessionId), 'retry')
    if (retryAudit !== null && retryAudit.class === 'clean') {
      this.logger?.info?.(
        { event: 'ft_turn_audit_corrected', originalClass: firstAudit.class },
        'ft turn audit: violation corrected on retry',
      )
      // myth-aiiao — arm the worker's post-persist whole-turn-replace push: on a
      // LIVE turn the client's streamed attempt 1 now diverges from the durable
      // retry. (A buffered turn flushed the retry itself — live == durable —
      // and the worker skips the push for playerless turns.)
      this.onCorrected?.({ class: firstAudit.class })
      if (retryBuffer !== null) await retryBuffer.flushTo(emit)
      return retry
    }

    // The retry did not come back clean (still violating, or the retry audit
    // itself failed). Fail open to attempt 1: it is the durable render (and on
    // a live turn the one already streamed), so streamed == persisted and the
    // system behaves as if the gate were absent.
    this.failOpen(firstAudit.class, 'retry_not_clean', {
      retriedClass: retryAudit === null ? null : retryAudit.class,
    })
    await releaseFirst()
    return first
  }

  /** Run the audit, mapping any thrown error to `null` (fail-open) with a warn.
   *  The audit must NEVER block a turn — `auditTurn` propagates LLM errors by
   *  design, so the decorator is where they are absorbed. */
  private async classify(
    input: TurnAuditInput,
    phase: 'attempt-1' | 'retry',
  ): Promise<{ class: TurnAuditClass } | null> {
    try {
      return await this.audit(input)
    } catch (err) {
      this.logger?.warn(
        { event: 'ft_turn_audit_error', phase, err: err instanceof Error ? err.message : String(err) },
        'ft turn audit call failed; failing open',
      )
      return null
    }
  }

  private failOpen(
    auditClass: TurnAuditClass,
    reason: string,
    extra: { retriedClass: TurnAuditClass | null },
  ): void {
    this.logger?.warn(
      { event: 'ft_turn_audit_fail_open', class: auditClass, reason, retriedClass: extra.retriedClass },
      'ft turn audit: violation passed through (fail-open)',
    )
    this.onFailOpen?.({ class: auditClass })
  }

  /** The deterministic structural guard: warn + count any leaked emphasis marker,
   *  fused sentence seam, or internal-term leak in this render's joined narration.
   *  Log-only; the render proceeds unchanged. A clean render is silent. */
  private runProseGuard(assistant: AssistantMessage): void {
    const violations = checkFtProse(joinNarration(assistant))
    if (violations.length === 0) return
    this.logger?.warn(
      { event: 'ft_prose_guard', violations: violations.map((v) => ({ kind: v.kind, detail: v.detail })) },
      'ft prose guard: deterministic narration defect(s) detected',
    )
    this.onProseGuard?.(violations)
  }
}

/** The corrective instruction injected on the retry render, one per violation
 *  class. Each NAMES the violation so the FT knows what to avoid — this is the
 *  content the gate escalates with. `clean` has no instruction (unreachable via
 *  `render` — a clean turn never retries). Exported so the exhaustive-switch
 *  arms (including the defensive `clean` arm) are directly unit-testable. */
export function correctiveInstructionFor(cls: TurnAuditClass): string | undefined {
  switch (cls) {
    case 'pc_speech_authored':
      return (
        'Your previous narration authored dialogue, a decision, or movement for a player character who did not ' +
        'act this turn. Respond ONLY to the player message(s) above. Voice NPCs and the world — never put words in ' +
        "another player character's mouth, decide what they do, or move them. If a prior scene sat unresolved, it " +
        'stays unresolved; do not close it by acting for an absent character.'
      )
    case 'inline_meta_correction':
      return (
        'Your previous narration corrected earlier narration inline, in prose. Never do that. If a correction is ' +
        'genuinely needed, call the issue_correction tool. Otherwise re-narrate this turn in response to the player ' +
        'message(s) above with no inline meta-correction.'
      )
    case 'fake_session_end':
      return (
        'Your previous narration ended the session or added an end-of-session flourish. This is a normal turn, not ' +
        'the farewell. Re-narrate in response to the player message(s) above and leave the scene open for the players.'
      )
    case 'clean':
      return undefined
  }
}

interface Batch {
  readonly message: string
  readonly acting: string[]
}

/** The trailing run of player messages after the last DM turn — the batch this
 *  render answered — formatted as attributed "Name: text" lines, plus the acting
 *  character names. Mirrors the controller's actingCharacters fill. */
function extractBatch(history: readonly ConversationMessage[]): Batch {
  const lines: string[] = []
  const acting: string[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m === undefined || m.role === 'assistant') break
    const text = m.parts
      .filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('')
    const name = m.characterName !== undefined && m.characterName !== '' ? m.characterName : 'Player'
    lines.unshift(`${name}: ${text}`)
    if (m.characterName !== undefined && m.characterName !== '') acting.unshift(m.characterName)
  }
  return { message: lines.join('\n'), acting }
}

/** Assemble the public audit input from the context + the rendered assistant. */
function buildInput(
  ctx: FtTurnContext,
  assistant: AssistantMessage,
  batch: Batch,
  sessionId: string,
): TurnAuditInput {
  return {
    narration: joinNarration(assistant),
    submittingMessage: batch.message,
    roster: ctx.participants,
    actingCharacters: batch.acting,
    sessionId,
  }
}

function joinNarration(assistant: AssistantMessage): string {
  return assistant.parts
    .filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n\n')
}

function hasToolCalls(assistant: AssistantMessage): boolean {
  return assistant.parts.some((p) => p.kind === 'tool_call')
}
