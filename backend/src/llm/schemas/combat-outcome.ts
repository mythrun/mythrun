//
// MYT-75 §4 — the Haiku combat-outcome-table shape (Principle #5: pre-generate
// a DC + four tiered outcome descriptions BEFORE rolling; deterministic code
// rolls and the matched tier becomes the FT's combat constraint). The L1
// analogue of SkillCheckResultSchema: a whole fight resolves as one big skill
// check. DC int 8..22 is the structural envelope (the prompt requests the same
// band); a degenerate DC makes the tier match meaningless. Outcome strings:
// .min(20) floors only, NO .max() — never reject valid generated prose for
// length (the LLM-prose-schema rule).

import { z } from 'zod'

export const CombatOutcomeTableSchema = z.object({
  dc: z.number().int().min(8).max(22),
  outcomes: z.object({
    routed: z.string().min(20),
    pyrrhic: z.string().min(20),
    costly: z.string().min(20),
    decisive: z.string().min(20),
  }),
})

export type CombatOutcomeTable = z.infer<typeof CombatOutcomeTableSchema>
