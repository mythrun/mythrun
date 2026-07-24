// backend/src/llm/schemas/secret-tripwire.ts
//
// MYT-73 — the per-turn secret tripwire output. A cheap Haiku call checks the
// Fast Thinker's player-facing prose against the session's CORE SECRETS (from
// the prep's sd_playbook) and emits an OPAQUE control signal: HOW the prose
// relates to a secret, the model's confidence, and a HANDLE to the nearest
// secret.
//
// myth-retprop — the verdict is a SEVERITY, not a boolean. The Fast Thinker
// writes under enforced ignorance, so a "hit" is either an accidental hard
// reveal OR improvised color that merely rhymes with a hidden truth. Collapsing
// those into one `breached:true` bit routed BOTH to the same disruptive open
// player-facing correction (the "Streisand retcon": an NPC whose gaze drifts to
// a door gets a public "actually his eyes were just wandering" correction that
// confuses the player and advertises the secret). Severity lets the scribe route
// proportionately — hard reveals get the open retcon, mere behavioral
// consistency gets a silent ST steer:
//   - "hard_reveal"      — the prose STATES a secret or a player could ONLY
//                          conclude its actual content from it (deducible). This
//                          alone warrants a player-facing correction.
//   - "soft_consistency" — the prose shows an NPC ACTING in line with a hidden
//                          agenda (gaze, mood, guarding a door) WITHOUT stating
//                          or necessarily implying the secret. Good DMing, not a
//                          leak.
//   - "none"             — no meaningful relation to any secret.
//
// CRITICAL — enforced ignorance: this call reasons over secrets, so its output
// must carry NONE of them. The schema is deliberately handle-only:
//   - `severity` — the routing verdict (above).
//   - `confidence` — 0..1; the model's certainty in the severity call. Used for
//     observability, NOT routing (severity is the gate).
//   - `secretRef` — the bracketed [SECRET-n] HANDLE of the nearest secret,
//     never the secret's text; null when severity is "none".
// There is intentionally NO `why`/free-text field — it would carry the secret.
// Flat object, NO .refine (a refine lets the repair chain author a "valid"
// tree and defeats the gate; and a refine message could echo input).

import { z } from 'zod'

export const SECRET_TRIPWIRE_SEVERITIES = ['none', 'soft_consistency', 'hard_reveal'] as const

export const SecretTripwireResultSchema = z.object({
  severity: z.enum(SECRET_TRIPWIRE_SEVERITIES),
  confidence: z.number().min(0).max(1),
  secretRef: z.string().nullable(),
})
export type SecretTripwireResult = z.infer<typeof SecretTripwireResultSchema>
export type SecretTripwireSeverity = (typeof SECRET_TRIPWIRE_SEVERITIES)[number]
