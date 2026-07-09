// backend/src/llm/schemas/world-introduction.ts
//
// Stage `world_introduction` (myth-zaqxh) LLM-output schema. The generator writes
// the PROSE and picks the dig-deeper entity NAMES; the worker owns the mechanical
// parts (the title is the persisted world name, not an LLM emission — see the
// stage handler — and the reference names are resolved to real entity ids, with
// dangling picks dropped).
//
// `prose` is free LLM prose: MIN-only floor, NO max — an over-length intro must
// not terminal-fail the stage (feedback_no_max_on_llm_prose_fields). `references`
// is a structural list of short entity-name labels, so array-length and per-name
// caps ARE appropriate (they're not prose).

import { z } from 'zod'

export const WorldIntroductionSchema = z.object({
  // A few paragraphs: the world's key tensions, how it works, any basic
  // vocabulary a player needs. min-only floor guards against a degenerate
  // one-liner; no max (see header).
  prose: z.string().min(200),
  // The ordered "additional references to dig deeper" list — entity NAMES the
  // LLM picks from the known-tier slice it was given. min(2) keeps the section
  // meaningful; the names resolve to real entity ids downstream (dangling picks
  // are dropped, so the persisted count may be lower).
  references: z.array(z.string().min(1).max(200)).min(2).max(12),
})

export type WorldIntroductionOutput = z.infer<typeof WorldIntroductionSchema>
