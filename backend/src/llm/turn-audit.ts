// backend/src/llm/turn-audit.ts
//
// myth-d6knq — the FT turn-audit gate. A ZFC-compliant post-render check: one
// cheap Haiku generateObject call decides whether the Fast Thinker's
// player-facing narration committed a boundary violation (authoring another
// player character's speech/decision on a scene-switch, an inline meta
// correction, or a fake session end). NO keyword/regex matching on the FT
// output — the semantic judgment is the model's.
//
// Enforced ignorance by construction: `TurnAuditInput` carries ONLY FT-visible
// material — the FT's own narration, the submitting player message(s), and the
// public PC roster. No field can hold a plot fact, an NPC secret, or a hidden
// motive, so the audit call never sees off-screen information (cf. CLAUDE.md
// non-negotiable #1, mirrored on the DM-trigger classifier boundary).
//
// Failure posture: this function does NOT swallow errors. A terminal LLM
// failure (after the wrapper's repair attempts) propagates; the CALLER (the
// AuditedFastThinker decorator) owns the fail-open policy — a turn is never
// blocked on the gate.

import { generateObject } from './ai.js'
import { HAIKU } from './models.js'
import { loadPrompt } from './prompts.js'
import { TurnAuditResultSchema, type TurnAuditResult } from './schemas/turn-audit.js'

// Re-export the result/class types so consumers (the AuditedFastThinker
// decorator) have ONE import point for the whole audit surface.
export type { TurnAuditResult, TurnAuditClass } from './schemas/turn-audit.js'

/** The audit runs on Haiku — the cheapest tier that can make the call (tiered
 *  inference, CLAUDE.md principle #3). Never hardcode the model id at the call
 *  site; the constant resolves to the config-pinned Haiku model. */
export const TURN_AUDIT_MODEL = HAIKU

/** One extra Haiku pass per rendered turn is the gate's cost. The timeout is
 *  generous relative to a short classification but well under the FT's per-turn
 *  budget so the audit can never dominate turn latency. */
export const TURN_AUDIT_TIMEOUT_MS = 20_000

/** Default gate on/off flag. The worker threads this into the decorator; a
 *  deploy can flip it to disable the audit without touching wiring. Default ON:
 *  the gate defends a P1 player-trust boundary. */
export const TURN_AUDIT_ENABLED = true

/**
 * Public-by-construction input to the turn audit. Every field is FT-visible:
 * the narration the FT just produced, the player message(s) it answered, and
 * the public PC roster. No field may carry a secret — that is the
 * enforced-ignorance guarantee for this tier.
 */
export interface TurnAuditInput {
  /** The FT's assembled player-facing prose for this turn (text parts joined). */
  readonly narration: string
  /** The submitting player message(s) this turn responded to, attributed. */
  readonly submittingMessage: string
  /** The party roster — every player character's name at the table. */
  readonly roster: readonly string[]
  /** The player characters who ACTED this turn (the batch), a cheap proxy for
   *  "whose declared intent the DM may execute". Optional — absent on a
   *  player-less turn. */
  readonly actingCharacters?: readonly string[]
}

/** The injected shape the decorator calls; production binds it to `auditTurn`,
 *  tests bind a stub. Keeping the seam a plain function keeps the decorator
 *  testable without the LLM layer. */
export type TurnAuditFn = (input: TurnAuditInput) => Promise<TurnAuditResult>

/**
 * Deterministic plain-text rendering of the public audit input for the Haiku
 * prompt. Only FT-visible fields are included.
 */
function serializeInput(input: TurnAuditInput): string {
  const roster = input.roster.length > 0 ? input.roster.join(', ') : '(none)'
  const acted =
    input.actingCharacters && input.actingCharacters.length > 0
      ? input.actingCharacters.join(', ')
      : '(none)'
  return [
    `Party roster: ${roster}`,
    `Characters who acted this turn: ${acted}`,
    '',
    'Player message(s) this narration responds to:',
    input.submittingMessage.trim() === '' ? '(none — a player-less turn)' : input.submittingMessage,
    '',
    'DM narration to audit:',
    input.narration,
  ].join('\n')
}

/**
 * Classify one FT narration for a boundary violation (myth-d6knq). A single
 * Haiku call returns the structured result verbatim. Errors propagate — the
 * decorator owns the fail-open policy.
 */
export async function auditTurn(input: TurnAuditInput): Promise<TurnAuditResult> {
  const result = await generateObject({
    model: TURN_AUDIT_MODEL,
    schema: TurnAuditResultSchema,
    schemaName: 'TurnAuditResultSchema',
    system: loadPrompt('session', 'turn-audit'),
    prompt: serializeInput(input),
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: TURN_AUDIT_TIMEOUT_MS,
    callSite: 'ft-turn-audit',
  })
  return result.output
}
