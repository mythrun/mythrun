import { z } from 'zod'
import { defineEndpoint } from './endpoint.ts'

// The live play-session lifecycle endpoints (MYT-92). Distinct from api/session.ts
// (the auth-BFF session). `start` DEBITS the campaign OWNER'S session credit and
// creates the row the WS transport then connects to; `active` resolves the running
// session for the 409-already-active join path. Both throw HttpError on non-2xx —
// the start-flow classifier (start-flow.ts) branches on `.status`/`.code`/`.body`.

const StartSessionResponseSchema = z.object({ sessionId: z.string() })
export type StartSessionResponse = z.infer<typeof StartSessionResponseSchema>

const ActiveSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  sessionNumber: z.number(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
})
export type ActiveSession = z.infer<typeof ActiveSessionSchema>

const ActiveSessionResponseSchema = z.object({ session: ActiveSessionSchema.nullable() })
export type ActiveSessionResponse = z.infer<typeof ActiveSessionResponseSchema>

/** The 402 body shape (read off `HttpError.body`) — the purchase-moment seam. */
export interface InsufficientCreditsBody {
  code: string
  available: number
  required: number
}

export const startSession = defineEndpoint<StartSessionResponse, { campaignId: string }>({
  method: 'POST',
  path: ({ campaignId }) => `/api/sessions/${encodeURIComponent(campaignId)}/start`,
  response: StartSessionResponseSchema,
})

export const getActiveSession = defineEndpoint<ActiveSessionResponse, { campaignId: string }>({
  method: 'GET',
  path: ({ campaignId }) => `/api/sessions/${encodeURIComponent(campaignId)}/active`,
  response: ActiveSessionResponseSchema,
})
