// backend/src/llm/schemas/st-director.ts
//
// MYT-69 §4 — the ST director's output: the STRUCTURAL SPLIT that IS the §8.2
// leak bound. Forcing the secret-aware reasoning into its own `reasoning`
// field is what keeps ride-along leaks out of the direction text. NO `.refine`
// cross-field constraints — the repair chain must not be able to author a
// "valid" tree; the set/text coupling is checked in code (the worker),
// and a repairAttempted result is DISCARDED whole by the worker (§4).

import { z } from 'zod'

export const StDirectorResultSchema = z.object({
  // PRIVATE: secret-aware reasoning. Logged server-side only; NEVER crosses
  // into any FT-facing artifact.
  reasoning: z.string().min(1),
  intervene: z.boolean(),
  // PUBLIC-FACING: the one-shot stage direction (1-2 sentences; what-not-how;
  // may carry SANCTIONED reveal content). Crosses into the FT via fusion.
  direction: z.string().min(1).nullable(),
  // PUBLIC-FACING: the standing-directive op. A DISCRIMINATED shape, NOT an
  // ''/null trichotomy — models confuse empty-vs-null, and an accidental ''
  // would silently clear an active wind-down directive.
  standingDirective: z.object({
    action: z.enum(['set', 'clear', 'keep']),
    text: z.string().nullable(), // required for 'set'; null otherwise (code-validated)
  }),
  // The FULL replacement summary (rewrite semantics — §4).
  summaryUpdate: z.string().min(1),
})

export type StDirectorResult = z.infer<typeof StDirectorResultSchema>
