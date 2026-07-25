import { uuidv7 } from './uuidv7.js'
import type { ClientLike } from './_types.js'

// tripwire_verdicts (migration 037) — myth-g4hf3: one row per post-turn secret-
// tripwire verdict. HANDLE-ONLY by design: `secret_ref` stores the opaque
// [SECRET-n] handle (or [CONSISTENCY]/[UNRECOGNIZED]), never secret content —
// the scribe worker sanitizes before insert. The run-2 forensics had to infer a
// firing breach from two incidental "skipping re-author" log lines; this table
// makes every verdict durable and queryable per turn.
//
//   id UUID PK, campaign_id UUID FK→campaigns (CASCADE),
//   session_id UUID FK→sessions (CASCADE), turn_id UUID NOT NULL,
//   severity TEXT CHECK (none|soft_consistency|hard_reveal),
//   confidence REAL CHECK (0..1), secret_ref TEXT NULL,
//   created_at TIMESTAMPTZ DEFAULT now().

export interface TripwireVerdictInsert {
  readonly campaignId: string
  readonly sessionId: string
  readonly turnId: string
  readonly severity: 'none' | 'soft_consistency' | 'hard_reveal'
  readonly confidence: number
  readonly secretRef: string | null
}

// Composable binder — see sessionsNs for the pattern rationale.
export function tripwireVerdictsNs(c: ClientLike) {
  return {
    insert: async (v: TripwireVerdictInsert): Promise<void> => {
      await c.query(
        `INSERT INTO tripwire_verdicts
           (id, campaign_id, session_id, turn_id, severity, confidence, secret_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv7(), v.campaignId, v.sessionId, v.turnId, v.severity, v.confidence, v.secretRef],
      )
    },
  }
}
