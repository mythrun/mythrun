// backend/src/llm/schemas/st-gate.ts
//
// MYT-69 §3 — the Haiku gate verdict. The gate decides ONLY whether the Opus
// ST call happens; the skip rule (`!needed && confidence ≥ floor`) is policy in
// the worker, not the schema. The verdict is NEVER fed to the ST (gate
// independence). `reason` is logged server-side only.

import { z } from 'zod'

export const StGateResultSchema = z.object({
  needed: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
})

export type StGateResult = z.infer<typeof StGateResultSchema>
