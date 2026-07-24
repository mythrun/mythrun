// REST response contract for the session-recap endpoint
// (`GET /api/sessions/:campaignId/recap`, myth-lhp99). The player-facing
// close-out of a live session: the campaign's MOST-RECENT ended session, in the
// SECRET-FREE surface only — the `summary` + `emergingThreads` the post-session
// analysis (MYT-74b) writes from player-witnessed material. The secret-aware
// `handoff` / ST running summary are NEVER modeled here (they live in a column
// this endpoint does not read), so enforced ignorance holds at the wire.
//
// The analysis is ASYNC — enqueued at finalize, written by an Opus job seconds
// to minutes later. So a just-ended session returns `status: 'pending'` (facts
// only, no prose) until the write lands; the recap route polls until `ready`.
import { z } from 'zod'

export const SessionRecapSchema = z.object({
  // The ended session's number (1-based), for the recap heading.
  sessionNumber: z.number(),
  // ISO timestamp the session ended (JSON serializes the Date column → string).
  endedAt: z.string().nullable(),
  // `ready` once the analysis summary is written; `pending` while the Opus job
  // is still running (the prose fields are absent until ready).
  status: z.enum(['ready', 'pending']),
  // Secret-free recap prose — a few sentences of what the party witnessed.
  // Present only when `status === 'ready'`.
  summary: z.string().optional(),
  // Secret-free open threads — what's left unresolved. Present only when ready.
  emergingThreads: z.array(z.string()).optional(),
})
export type SessionRecap = z.infer<typeof SessionRecapSchema>

export const SessionRecapResponseSchema = z.object({
  // `null` when the campaign has no ended session yet (nothing to recap).
  recap: SessionRecapSchema.nullable(),
})
export type SessionRecapResponse = z.infer<typeof SessionRecapResponseSchema>
