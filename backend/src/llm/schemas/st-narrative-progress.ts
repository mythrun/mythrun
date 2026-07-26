// backend/src/llm/schemas/st-narrative-progress.ts
//
// myth-3jna1 — the narrative-progress judgment: how far through the prep's
// intended arc the session actually is, 0-1. SECRET-SIDE by construction — the
// call that produces it is fed the whole sd_playbook, and the result is
// consumed by CODE only (converge-policy compares the fraction against the
// mechanical one). Nothing on this type is ever written to a channel the Fast
// Thinker or the client reads.
//
// `basis` is ordered FIRST deliberately: the model states which goals and
// revelations have actually landed before it commits to a number, so the
// fraction is the conclusion of a reading rather than a first impression. It is
// secret-aware prose about the playbook and has no consumer — not logs, not
// diagnostics, not a channel. It exists to make `progress` better.

import { z } from 'zod'

export const StNarrativeProgressResultSchema = z.object({
  basis: z.string().min(1),
  progress: z.number().min(0).max(1),
})

export type StNarrativeProgressResult = z.infer<typeof StNarrativeProgressResultSchema>
