//
// MYT-68 §3.5 step 3 — the Haiku DC-outcome-table shape (Principle #5:
// pre-generate DC + three outcome tiers BEFORE rolling; the matched tier is
// injected into the FastThinker as a constraint). Ported from the prototype's
// inline dcResponseSchema with structural DC bounds added (the prompt
// requests 5-25; int 1..30 is the hard structural envelope — a DC of 200 or
// -3 makes the tier match degenerate). Outcome strings: .min(1) floors only,
// NO .max() — never reject valid generated prose for length.

import { z } from 'zod'

export const SkillCheckResultSchema = z.object({
  dc: z.number().int().min(1).max(30),
  outcomes: z.object({
    fail: z.string().min(1),
    success: z.string().min(1),
    great_success: z.string().min(1),
  }),
})

export type SkillCheckResult = z.infer<typeof SkillCheckResultSchema>
