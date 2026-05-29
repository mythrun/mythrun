import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { logger } from './logger.js'
import { mapToMythrunError, LlmStructuredOutputError, LlmContentFilteredError } from './errors.js'

interface MythrunContext {
  readonly sessionId?: string | undefined
  readonly userId?: string | undefined
  readonly worldId?: string | undefined
  readonly campaignId?: string | undefined
  readonly stage?: string | undefined
}

interface LogBindings extends MythrunContext {
  readonly event: 'llm.call' | 'llm.error'
  readonly model: string
  readonly mode: 'generate' | 'stream'
  readonly latencyMs: number
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly totalTokens?: number | undefined
  readonly finishReason?: string | undefined
  readonly err?: unknown
  readonly reason?: string | undefined
}

/**
 * Pull MythrunContext fields out of `params.providerOptions.mythrun`.
 * Callers attach them via `providerOptions: { mythrun: { ... } }` — namespaced
 * under `mythrun` so they don't collide with provider-specific options like
 * `providerOptions.anthropic.cacheControl`. Returns an empty object if any
 * layer is missing or the values aren't strings.
 */
function extractMythrunContext(params: unknown): MythrunContext {
  /* c8 ignore start — defensive narrowing of the providerOptions tree:
   * the Vercel SDK always passes a params object with a providerOptions
   * shape; the mythrun namespace and the per-field string narrowing are
   * defense-in-depth for hand-rolled callers that bypass the typed
   * helpers. */
  if (typeof params !== 'object' || params === null) return {}
  const providerOptions = (params as { providerOptions?: unknown }).providerOptions
  if (typeof providerOptions !== 'object' || providerOptions === null) return {}
  const mythrun = (providerOptions as { mythrun?: unknown }).mythrun
  if (typeof mythrun !== 'object' || mythrun === null) return {}
  const ctx = mythrun as MythrunContext
  return {
    sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined,
    userId: typeof ctx.userId === 'string' ? ctx.userId : undefined,
    worldId: typeof ctx.worldId === 'string' ? ctx.worldId : undefined,
    campaignId: typeof ctx.campaignId === 'string' ? ctx.campaignId : undefined,
    stage: typeof ctx.stage === 'string' ? ctx.stage : undefined,
  }
  /* c8 ignore stop */
}

function sumTokens(a: number | undefined, b: number | undefined): number | undefined {
  return a !== undefined && b !== undefined ? a + b : undefined
}

interface StreamTelemetry {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  totalTokens?: number | undefined
  finishReason?: string | undefined
}

/**
 * Build a ReadableStream wrapper that observes a doStream() result and emits
 * exactly one terminal log line via the `terminated` flag. Handles the
 * Success / Provider-graceful error / Content-policy filter / In-stream error /
 * Truncation / Cancellation arms of the seven-state matrix. Open-time error is
 * handled by the caller (it short-circuits before this helper runs).
 */
function wrapModelStream(
  upstream: LanguageModelV3StreamResult,
  modelId: string,
  ctx: MythrunContext,
  start: number,
): ReadableStream<LanguageModelV3StreamPart> {
  const telemetry: StreamTelemetry = {}
  let terminated = false

  function logSuccess(): void {
    /* c8 ignore start — reentry guard: the stream wrapper invokes each
     * terminal log exactly once; this guard is defense-in-depth against
     * a future caller looping on success. */
    if (terminated) return
    /* c8 ignore stop */
    terminated = true
    const bindings: LogBindings = {
      event: 'llm.call',
      model: modelId,
      mode: 'stream',
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      totalTokens: telemetry.totalTokens,
      finishReason: telemetry.finishReason,
      latencyMs: Date.now() - start,
      ...ctx,
    }
    logger.info(bindings, 'llm stream completed')
  }

  function logError(err: unknown, reason?: string): void {
    /* c8 ignore start — reentry guard: same as logSuccess; defense-in-
     * depth against a future caller invoking logError after success. */
    if (terminated) return
    /* c8 ignore stop */
    terminated = true
    const bindings: LogBindings = {
      event: 'llm.error',
      model: modelId,
      mode: 'stream',
      err,
      reason,
      latencyMs: Date.now() - start,
      ...ctx,
    }
    logger.error(bindings, 'llm stream failed')
  }

  const sourceReader = upstream.stream.getReader()
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      try {
        const { value, done } = await sourceReader.read()
        if (done) {
          if (!terminated) {
            const err = new LlmStructuredOutputError('llm stream truncated (no finish event)')
            logError(err, 'truncated')
            controller.error(err)
          } else {
            controller.close()
          }
          return
        }
        if (value.type === 'finish') {
          telemetry.inputTokens = value.usage.inputTokens.total
          telemetry.outputTokens = value.usage.outputTokens.total
          telemetry.totalTokens = sumTokens(telemetry.inputTokens, telemetry.outputTokens)
          telemetry.finishReason = value.finishReason.unified
          // Content-policy filter is terminal (MYT-52 §7.2): translate the
          // finishReason into a thrown LlmContentFilteredError so the stage
          // handler treats it as a non-retryable failure. Distinct from
          // `finishReason: 'error'` (provider-graceful, treated as success).
          if (value.finishReason.unified === 'content-filter') {
            const filtered = new LlmContentFilteredError(
              'llm stream stopped by content-policy filter',
            )
            logError(filtered, 'content-filter')
            controller.error(filtered)
            return
          }
          logSuccess()
        } else if (value.type === 'error') {
          const mapped = mapToMythrunError(value.error)
          logError(value.error)
          controller.error(mapped)
          return
        }
        controller.enqueue(value)
      } catch (err) {
        logError(err)
        controller.error(err instanceof Error ? err : new Error(String(err)))
      }
    },
    async cancel(reason: unknown) {
      if (!terminated) logError(reason, 'cancelled')
      await sourceReader.cancel(reason)
    },
  })
}

/**
 * Wrap a language model with logging + error normalization for both
 * `generate` and `stream` modes.
 *
 * **wrapGenerate**: emits `event: 'llm.call'` (info) on success with model id,
 * token counts, latency, finishReason, mode='generate', and MythrunContext.
 * Emits `event: 'llm.error'` (error) on failure. Maps Vercel error classes to
 * Mythrun-typed errors via `mapToMythrunError` before rethrowing — route
 * handlers catch only Mythrun classes.
 *
 * **wrapStream**: implements a seven-state terminal-state matrix, each producing
 * exactly one log line guarded by a `terminated` flag in the closure:
 *
 * | State                  | Trigger                                       | Log              | Caller                                            |
 * |------------------------|-----------------------------------------------|------------------|---------------------------------------------------|
 * | Success                | `type === 'finish'` part                       | `llm.call`       | stream closes naturally                           |
 * | Provider-graceful error| `finishReason.unified === 'error'`             | `llm.call`       | stream closes naturally                           |
 * | Content-policy filter  | `finishReason.unified === 'content-filter'`    | `llm.error`      | `controller.error(LlmContentFilteredError)` — terminal, no retry |
 * | In-stream error        | `type === 'error'` part                        | `llm.error`      | `controller.error(mapped)` — consumer throws      |
 * | Truncation             | stream closes with no finish/error             | `llm.error`      | `controller.error(LlmStructuredOutputError)`      |
 * | Cancellation           | downstream `cancel()` handler fires            | `llm.error`      | no rethrow — cancellation is consumer intent      |
 * | Open-time error        | `doStream()` rejects                           | `llm.error`      | `wrapStream` throws mapped error                  |
 *
 * Token + finishReason shapes: in @ai-sdk/provider v3 the usage object holds
 * nested `{ inputTokens: { total, ... }, outputTokens: { total, ... } }` and
 * `finishReason` is `{ unified, raw }`. We log the flat `total` scalars and
 * `unified` reason for MYT-43 spend attribution and grep-friendly queries.
 * Missing counts surface as `undefined`, which pino omits.
 */
export function logAndNormalizeMiddleware(modelId: string): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params }) => {
      const start = Date.now()
      const ctx = extractMythrunContext(params)
      // myth-4omh: log call.started BEFORE doGenerate so in-flight hangs
      // are observable in CloudWatch. Previously only llm.call (success)
      // and llm.error (terminal) fired — a hung call with no timeout
      // emitted nothing for the whole hang window. This complements the
      // ai.ts AbortSignal timeout: even with a 5-min budget, we want to
      // see the call started immediately.
      logger.info(
        { event: 'llm.call.started', model: modelId, mode: 'generate', ...ctx },
        'llm call started',
      )
      let result: Awaited<ReturnType<typeof doGenerate>>
      try {
        result = await doGenerate()
      } catch (err) {
        const bindings: LogBindings = {
          event: 'llm.error',
          model: modelId,
          mode: 'generate',
          err,
          latencyMs: Date.now() - start,
          ...ctx,
        }
        logger.error(bindings, 'llm call failed')
        throw mapToMythrunError(err)
      }
      const inputTokens = result.usage.inputTokens.total
      const outputTokens = result.usage.outputTokens.total
      // Content-policy filter is terminal (MYT-52 §7.2): mirror the
      // stream-side handling — log llm.error + throw so the caller treats
      // it as a non-retryable failure rather than a successful empty
      // result. Other finishReasons (incl. 'error') still flow through
      // as graceful successes. We log + throw OUTSIDE the doGenerate try
      // block so the catch arm above doesn't re-log this synthetic error.
      if (result.finishReason.unified === 'content-filter') {
        const filtered = new LlmContentFilteredError('llm call stopped by content-policy filter')
        const errBindings: LogBindings = {
          event: 'llm.error',
          model: modelId,
          mode: 'generate',
          inputTokens,
          outputTokens,
          totalTokens: sumTokens(inputTokens, outputTokens),
          latencyMs: Date.now() - start,
          finishReason: result.finishReason.unified,
          err: filtered,
          reason: 'content-filter',
          ...ctx,
        }
        logger.error(errBindings, 'llm call stopped by content-policy filter')
        throw filtered
      }
      const bindings: LogBindings = {
        event: 'llm.call',
        model: modelId,
        mode: 'generate',
        inputTokens,
        outputTokens,
        totalTokens: sumTokens(inputTokens, outputTokens),
        latencyMs: Date.now() - start,
        finishReason: result.finishReason.unified,
        ...ctx,
      }
      logger.info(bindings, 'llm call completed')
      return result
    },
    wrapStream: async ({ doStream, params }) => {
      const start = Date.now()
      const ctx = extractMythrunContext(params)
      // myth-4omh: same rationale as wrapGenerate's call.started — log
      // BEFORE doStream so in-flight streams are observable. Stream
      // stalls are particularly easy to miss: the upstream connection
      // may stay open with zero data flowing for minutes before the
      // AbortSignal cancellation fires.
      logger.info(
        { event: 'llm.call.started', model: modelId, mode: 'stream', ...ctx },
        'llm stream started',
      )

      let upstream: LanguageModelV3StreamResult
      try {
        upstream = await doStream()
      } catch (err) {
        const bindings: LogBindings = {
          event: 'llm.error',
          model: modelId,
          mode: 'stream',
          err,
          latencyMs: Date.now() - start,
          ...ctx,
        }
        logger.error(bindings, 'llm stream failed to open')
        throw mapToMythrunError(err)
      }

      return {
        ...upstream,
        stream: wrapModelStream(upstream, modelId, ctx, start),
      }
    },
  }
}
