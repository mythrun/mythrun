import { z } from 'zod'
import { defineEndpoint } from './endpoint.ts'

// GET /api/llm-health — the sitewide LLM outage readout (outage-resilience
// design §4.1): public (mirrors /health/ready), one Redis read behind it, a
// plain polling GET with no caching. The frame's NoticeStrip hook polls this
// on a 60s cadence and shows the strip only on a positive "degraded" reading.
// The two-field schema lives inline (the z.void() precedent in session.ts)
// until/unless the backend publishes it through @mythrun/contract/rest — then
// this import swaps, same shape.

export const LlmHealthResponseSchema = z.object({
  state: z.enum(['ok', 'degraded']),
  /** Epoch ms the current degradation was first observed; null while ok. */
  since: z.number().nullable(),
})

export type LlmHealthResponse = z.infer<typeof LlmHealthResponseSchema>

export const getLlmHealth = defineEndpoint<LlmHealthResponse>({
  method: 'GET',
  path: () => '/api/llm-health',
  response: LlmHealthResponseSchema,
})
