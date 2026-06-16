// backend/src/llm/schemas/secret-tripwire.ts
//
// MYT-73 — the per-turn secret tripwire output. A cheap Haiku call checks the
// Fast Thinker's player-facing prose against the session's CORE SECRETS (from
// the prep's sd_playbook) and emits an OPAQUE control signal: whether a secret
// was breached, the model's confidence, and a HANDLE to the breached secret.
//
// CRITICAL — enforced ignorance: this call reasons over secrets, so its output
// must carry NONE of them. The schema is deliberately handle-only:
//   - `breached` — the gating bit.
//   - `confidence` — 0..1; bias toward recall means breaches may carry LOW
//     confidence (the Slow Thinker double-checks).
//   - `secretRef` — the bracketed [SECRET-n] HANDLE of the breached secret,
//     never the secret's text; null when breached:false.
// There is intentionally NO `why`/free-text field — it would carry the secret.
// Flat object, NO .refine (a refine lets the repair chain author a "valid"
// tree and defeats the gate; and a refine message could echo input).

import { z } from 'zod'

export const SecretTripwireResultSchema = z.object({
  breached: z.boolean(),
  confidence: z.number().min(0).max(1),
  secretRef: z.string().nullable(),
})
export type SecretTripwireResult = z.infer<typeof SecretTripwireResultSchema>
