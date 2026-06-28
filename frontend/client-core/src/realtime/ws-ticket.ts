import { WsTicketResponseSchema, type WsTicketResponse } from '@mythrun/contract/rest'
import { defineEndpoint, type ApiContext } from '../api/endpoint.ts'

// The WS session ticket endpoint (MYT-85). The session client mints a fresh
// ticket before every (re)connect: POST /api/sessions/:id/ws-ticket → a single
// short-lived ticket string, which it then passes as the `ticket` query param
// when opening the WebSocket. The access token never rides in the WS URL — the
// ticket gates the /ws/* CloudFront behavior instead.
//
// This is `defineEndpoint` compiled, so it inherits the single-flight 401
// refresh-retry (a ticket POST on a just-expired access token refreshes + retries
// once before surfacing the failure to the connection state machine).

/** POST /api/sessions/:id/ws-ticket — mints a short-lived WS connect ticket. */
export const mintWsTicket: (sessionId: string, ctx: ApiContext) => Promise<WsTicketResponse> =
  defineEndpoint<WsTicketResponse, string>({
    method: 'POST',
    path: (sessionId) => `/api/sessions/${sessionId}/ws-ticket`,
    response: WsTicketResponseSchema,
  })
