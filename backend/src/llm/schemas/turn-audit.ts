import { z } from 'zod'

/**
 * Result of the FT turn-audit classifier (Haiku): a post-render semantic check
 * on the Fast Thinker's player-facing narration (myth-d6knq). ZFC-compliant —
 * the judgment lives in the model, never in keyword/regex matching on the FT
 * output.
 *
 * - `class`: the violation the narration commits, or `clean`.
 *   - `pc_speech_authored`: the narration authored NEW dialogue, a decision, or
 *     movement for a player character who did not submit this turn (the
 *     myth-d6knq scene-switch signature — a semantic sibling of myth-ph544 that
 *     the deterministic prefix-strip can't catch because the speech is inline).
 *   - `inline_meta_correction`: the narration breaks the fourth wall to correct
 *     its own earlier narration in prose ("A moment — let me correct…") instead
 *     of using the structured `issue_correction` tool.
 *   - `fake_session_end`: the narration closes the session — an "— End of
 *     Session —" marker or a send-off flourish — inside a regular turn (closings
 *     belong only to the farewell flow).
 *   - `clean`: none of the above.
 * - `confidence`: probability in [0, 1]. The gate acts on a violation class
 *   regardless of confidence (fail-open on retry), but the value is logged for
 *   tuning the escalation threshold later.
 * - `reason`: free-prose justification (`.min(1)` only — no prose cap).
 */
export const TurnAuditResultSchema = z.object({
  class: z.enum(['pc_speech_authored', 'inline_meta_correction', 'fake_session_end', 'clean']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
})

export type TurnAuditResult = z.infer<typeof TurnAuditResultSchema>
export type TurnAuditClass = TurnAuditResult['class']
