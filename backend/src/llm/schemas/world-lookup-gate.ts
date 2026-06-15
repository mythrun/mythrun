// backend/src/llm/schemas/world-lookup-gate.ts
//
// MYT-72 T3 — the contextual world-lookup skill-gate DC table (Principle #5:
// pre-generate DC + three outcome tiers BEFORE rolling; the matched tier is the
// roller's constraint). UNLIKE the plain skill-check table, this one carries an
// `auto_success` flag: when the asker's PUBLIC standing makes the knowledge a
// foregone conclusion (the PC heading the org being asked about), the gate
// emits NO roll. Otherwise the model judges how hard recall is RELATIVE to the
// asker's standing and emits a DC. Flat z.object root (no discriminatedUnion —
// Anthropic rejects a root union). Outcome strings: .min(1) floors only, NO
// .max() — never reject valid generated prose for length. `dc` is bounded
// (int 1..30) as a structural envelope, ZFC-exempt like skill-check.

import { z } from 'zod'

export const WorldLookupGateResultSchema = z.object({
  auto_success: z.boolean(),
  dc: z.number().int().min(1).max(30),
  outcomes: z.object({
    fail: z.string().min(1),
    success: z.string().min(1),
    great_success: z.string().min(1),
  }),
})

export type WorldLookupGateResult = z.infer<typeof WorldLookupGateResultSchema>
