// backend/src/llm/schemas/post-session-analysis.ts
//
// MYT-74b — the structured output of the post-session analysis call (an Opus
// call) that closes out a live session. It produces two distinct surfaces:
//
//   - `summary` / `emergingThreads` — SECRET-FREE recap. These describe only
//     what players witnessed (player-facing recap material). They must never
//     carry prep-only / secret-aware knowledge.
//   - `handoff` — the SessionHandoff. This MAY be secret-aware (it feeds the
//     prep pipeline for the next session, not the player-facing surface).
//
// Per-NPC handoff carries two distinct fields:
//   - `state` — a paraphrasable prep-prompt INPUT describing where the NPC
//     stands relative to the party (the prep engine may reword it freely).
//   - `voice` — VERBATIM late-session relational excerpts (the NPC's own
//     distinctive lines). These are deterministically injected into the next
//     session's ft_context and are NEVER paraphrased, so the array length is
//     bounded (caps the FT's static voice budget) but the individual strings
//     carry NO `.max()` (a verbatim line must survive at its real length).
//
// Schema style mirrors session-reconcile.ts: flat `z.object` root, `.min(1)`
// floors on required free-prose fields, NO `.max()` on free-prose STRING
// content (rejecting valid generated prose for length wastes spent tokens +
// terminal-fails the stage). Array-length `.max()` IS used deliberately: the
// `voice`, `npcs`, and `keyLocations` arrays are injected verbatim into the
// next session's ft_context, so their COUNT is bounded to cap the FT's static
// budget.

import { z } from 'zod'

const NpcHandoffSchema = z.object({
  name: z.string().min(1),
  // Paraphrasable prep-prompt input — where the NPC stands relative to the party.
  state: z.string().min(1),
  // Verbatim late-session relational excerpts; deterministically injected into
  // ft_context and NEVER paraphrased. Array bounded; NO string .max().
  voice: z.array(z.string().min(1)).max(4),
})
const PartyMemberHandoffSchema = z.object({
  characterName: z.string().min(1),
  location: z.string().min(1),
  condition: z.string().min(1),
})
const KeyLocationHandoffSchema = z.object({
  name: z.string().min(1),
  atmosphere: z.string().min(1),
})
export const SessionHandoffSchema = z.object({
  party: z.array(PartyMemberHandoffSchema),
  timeOfDay: z.string().min(1),
  unresolvedThreads: z.array(z.string().min(1)),
  npcs: z.array(NpcHandoffSchema).max(8),
  keyLocations: z.array(KeyLocationHandoffSchema).max(8),
})
export const PostSessionAnalysisSchema = z.object({
  // SECRET-FREE recap: player-witnessed only.
  summary: z.string().min(1),
  // SECRET-FREE recap: player-witnessed only.
  emergingThreads: z.array(z.string().min(1)),
  // MAY be secret-aware (prep-only; feeds the next session's prep pipeline).
  handoff: SessionHandoffSchema,
})
export type SessionHandoff = z.infer<typeof SessionHandoffSchema>
export type PostSessionAnalysis = z.infer<typeof PostSessionAnalysisSchema>
