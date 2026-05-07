import type { LanguageModelV3Middleware } from '@ai-sdk/provider'
import { logger } from './logger.js'
import { mapToMythrunError } from './errors.js'

interface MythrunContext {
  readonly sessionId?: string | undefined
  readonly userId?: string | undefined
}

/**
 * Pull `sessionId` and `userId` out of `params.providerOptions.mythrun`.
 * Callers attach them via `providerOptions: { mythrun: { sessionId, userId } }`
 * — namespaced under `mythrun` so they don't collide with provider-specific
 * options like `providerOptions.anthropic.cacheControl`.
 *
 * Returns an empty object if any layer is missing or the values aren't strings.
 */
function extractMythrunContext(params: unknown): MythrunContext {
  if (typeof params !== 'object' || params === null) return {}
  const providerOptions = (params as { providerOptions?: unknown }).providerOptions
  if (typeof providerOptions !== 'object' || providerOptions === null) return {}
  const mythrun = (providerOptions as { mythrun?: unknown }).mythrun
  if (typeof mythrun !== 'object' || mythrun === null) return {}
  const ctx = mythrun as MythrunContext
  return {
    sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined,
    userId: typeof ctx.userId === 'string' ? ctx.userId : undefined,
  }
}

/**
 * Wrap a language model with logging + error normalization.
 *
 * Emits `event: 'llm.call'` (info) on every successful generation with
 * model id, token counts, latency, finishReason, and optional session/user
 * context. Emits `event: 'llm.error'` (error) on failures. Maps Vercel
 * error classes to Mythrun-typed errors via `mapToMythrunError` before
 * rethrowing — route handlers catch only Mythrun classes.
 *
 * Token shape: in @ai-sdk/provider v3 the usage object holds nested
 * `{ inputTokens: { total, noCache, cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } }`.
 * We log the flat scalars expected by MYT-43 spend attribution: pull
 * `usage.inputTokens.total` / `usage.outputTokens.total` and compute the
 * sum (the SDK does not surface a precomputed `totalTokens`). Missing
 * counts surface as `undefined`, which pino serializes as omitted fields.
 *
 * FinishReason shape: v3's `LanguageModelV3FinishReason` is an object
 * `{ unified, raw }`. We log `unified` (one of stop|length|content-filter
 * |tool-calls|error|other) so log queries stay grep-friendly across
 * providers; the provider-specific `raw` value is dropped — pull it from
 * the model directly if a debugging session needs that detail.
 *
 * Streaming (`wrapStream`) is intentionally not implemented in this MYT-44
 * scope; it lands when Fast Thinker needs SSE.
 */
export function logAndNormalizeMiddleware(modelId: string): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params }) => {
      const start = Date.now()
      const ctx = extractMythrunContext(params)
      try {
        const result = await doGenerate()
        const inputTokens = result.usage.inputTokens.total
        const outputTokens = result.usage.outputTokens.total
        const totalTokens =
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined
        logger.info(
          {
            event: 'llm.call',
            model: modelId,
            inputTokens,
            outputTokens,
            totalTokens,
            latencyMs: Date.now() - start,
            finishReason: result.finishReason.unified,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
          },
          'llm call completed',
        )
        return result
      } catch (err) {
        logger.error(
          {
            event: 'llm.error',
            model: modelId,
            err,
            latencyMs: Date.now() - start,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
          },
          'llm call failed',
        )
        throw mapToMythrunError(err)
      }
    },
  }
}
