// REST contract for the WS session ticket endpoint (MYT-85). The SPA POSTs to
// /api/sessions/:id/ws-ticket and receives a single short-lived ticket string,
// which it then passes as the `ticket` query param when opening the WebSocket.
// The ticket gates the /ws/* CloudFront behavior; the access token never rides
// in the WS URL.
import { z } from 'zod'

export const WsTicketResponseSchema = z.object({
  ticket: z.string().min(1),
})
export type WsTicketResponse = z.infer<typeof WsTicketResponseSchema>
