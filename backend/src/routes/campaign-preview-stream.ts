// backend/src/routes/campaign-preview-stream.ts
//
// myth-umggn — POST /api/campaigns/synthesize-preview/stream.
//
// The STREAMED sibling of POST /api/campaigns/synthesize-preview: same body,
// same guard chain, same gate, same Redis parking — but the response is a
// one-shot SSE stream so the player watches the world brief write itself
// instead of staring at a spinner. The synchronous route stays (the dev-tool
// panel and any non-streaming client drive it); the web create flow calls this
// one on BOTH funnel paths (myth-6t06f). Kept as its own module so
// campaign-preview.ts stays under the size cap; the shared pieces (body schema,
// rate-limit shape, cost guards) are imported from there — one copy, two
// transports.
//
// Guard order (identical to the JSON route; every guard runs BEFORE the reply
// is hijacked, so a trip is a plain JSON status the client handles exactly
// like the non-streaming endpoint's errors — and a cooling-down or 0-credit
// user burns ZERO Sonnet tokens):
//   1. Zod body parse (3 picks, or a 20..4000 concept)              → 400
//   2. rate-limit (5/min per user, route-level)                     → 429
//   3. rejection-storm cooldown (read-only Redis peek)              → 429
//   4. credit balance peek (NON-charging, BEFORE any LLM call)      → 403
//   5. hijack into SSE — from here every outcome is a data frame:
//        delta*  → (complete | rejected | error), then `close`.
//
// Wire contract: `SynthesizeStreamEvent` in @mythrun/contract/events. The
// terminal `rejected` frame mirrors the JSON route's 422 payload verbatim
// (shared `recordGateRejection` — storm increment + server-only reasoning log
// included); `complete` mirrors its 201. The gate judges (and the store
// parks) the VALIDATED output — authoritative over the streamed text, which a
// post-stream schema repair can rewrite. On the freeform path the gate runs on
// the player's RAW words BEFORE any streaming starts, so a rejected concept
// costs one cheap gate call and the player never watches prose arrive that is
// about to be thrown away.
//
// Cost control on disconnect: the SSE sink's onClose aborts the Sonnet stream
// (threaded via streamSynthesizeConcept's abortSignal), so a closed tab stops
// the token burn instead of generating into the void.

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Logger as PinoLogger } from 'pino'
import type { SynthesizeStreamEvent, SynthesizeStreamErrorCode } from '@mythrun/contract/events'

import { createRepo } from '../repo/index.js'
import { requireDbUser } from '../auth/require-db-user.js'
import {
  streamSynthesizeConcept,
  streamSynthesizeFromConcept,
  type SynthesizerPick,
} from '../llm/prep/synthesize-concept.js'
import { runInputGate, type InputGateVerdict } from '../llm/prep/input-gate.js'
import { LlmContentFilteredError } from '../llm/errors.js'
import { createRejectionStormCounter } from '../auth/rejection-storm.js'
import { putPreview } from '../preview/preview-store.js'
import { openSseConnection, type SseSink } from '../sse/sse-connection.js'
import { recordGateRejection } from './concept-gate.js'
import {
  previewRateLimit,
  runPreviewCostGuards,
  SynthesizePreviewBodySchema,
} from './campaign-preview.js'

export interface CampaignPreviewStreamOpts {
  readonly pool: Pool
  readonly redis: Redis
  readonly redisKeyPrefix: string
  /** The single allowlisted CORS origin for the hijacked SSE response —
   *  config.env.frontendBaseUrl, same as every other SSE route. */
  readonly frontendBaseUrl: string
}

/** Map a post-hijack failure to the wire's terminal error code, mirroring the
 *  global error handler's taxonomy (error-handler.ts): the content filter is
 *  its own terminal (retrying re-hits the same filter); every other typed LLM
 *  error is the transient `llm_upstream_unavailable` (the 503 twin); anything
 *  else is the honest `internal_error`. Duck-typed on the stable `code`
 *  prefix the llm/errors.ts classes all carry, so a new LLM error class maps
 *  correctly without touching this list. */
function streamErrorCode(err: unknown): SynthesizeStreamErrorCode {
  if (err instanceof LlmContentFilteredError) return 'content_filtered'
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('llm_')) return 'llm_upstream_unavailable'
  }
  return 'internal_error'
}

/** Serialize one typed event as a `data:` SSE frame. */
function emit(sink: SseSink, event: SynthesizeStreamEvent): void {
  sink.write(`data: ${JSON.stringify(event)}\n\n`)
}

interface StreamedSynthesisArgs {
  readonly sink: SseSink
  readonly signal: AbortSignal
  /** The proposal input: the brainstorm path's 3 picks, or (myth-6t06f) the
   *  freeform path's own concept text. */
  readonly source: { readonly picks: readonly SynthesizerPick[] } | { readonly concept: string }
  readonly userId: string
  readonly redis: Redis
  readonly redisKeyPrefix: string
  readonly incrementStorm: () => Promise<{ cooldownActive: boolean; retryAfterSeconds: number }>
  readonly logger: PinoLogger
}

/** Emit the terminal `rejected` frame with the JSON route's exact side-effects
 *  (storm increment + server-only reasoning log) and payload. `judged` is the
 *  text the gate ruled on — the synthesis on the brainstorm path, the player's
 *  own words on the freeform path — and it always rides the frame so the
 *  rejection screen can show it and seed "adjust it yourself". */
async function emitRejection(
  args: StreamedSynthesisArgs,
  gate: InputGateVerdict,
  judged: string,
): Promise<void> {
  const payload = await recordGateRejection({
    gate,
    echoJudgedConcept: true,
    synthesizedConcept: judged,
    stormIncrementer: args.incrementStorm,
    logger: args.logger,
  })
  emit(args.sink, {
    type: 'rejected',
    code: 'concept_rejected',
    // A reject verdict always carries a reason; the fallback mirrors
    // the FE's own defensive default and satisfies the non-null wire type.
    /* c8 ignore next */
    reason: payload.reason ?? 'inappropriate',
    rejectionMessage: payload.rejectionMessage,
    synthesizedConcept: judged,
  })
}

/** The post-hijack half of the route: stream deltas, gate, then terminal-frame
 *  (complete | rejected | error) and close. Every failure is caught here — the
 *  sink always gets a terminal.
 *
 *  Gate placement per path mirrors the JSON route exactly (see its header): the
 *  freeform arm gates the player's RAW words FIRST — before a token of Sonnet
 *  burns — and the brainstorm arm gates what it wrote. One gate call either way. */
async function runStreamedSynthesis(args: StreamedSynthesisArgs): Promise<void> {
  const { sink, signal, logger } = args

  try {
    if ('concept' in args.source) {
      const rawGate = await runInputGate({
        concept: args.source.concept,
        intentSummary: null,
        abortSignal: signal,
      })
      if (rawGate.verdict === 'reject') {
        await emitRejection(args, rawGate, args.source.concept)
        return
      }
    }

    const stream =
      'concept' in args.source
        ? streamSynthesizeFromConcept(args.source.concept, { abortSignal: signal })
        : streamSynthesizeConcept(args.source.picks, { abortSignal: signal })
    // Guard the output promise: if the delta loop throws, `output` may also
    // reject; pre-attaching a no-op handler keeps that from surfacing as an
    // unhandled rejection. The `await stream.output` below still observes it.
    stream.output.catch(() => undefined)

    for await (const delta of stream.deltas) {
      emit(sink, { type: 'delta', text: delta })
    }
    const synth = await stream.output

    // The brainstorm path judges its own synthesis; the freeform path already
    // judged the input it was built from, so re-gating would be a second
    // Sonnet call on text the player could not have altered.
    if (!('concept' in args.source)) {
      const gate = await runInputGate({
        concept: synth.concept,
        intentSummary: synth.intentSummary,
        // A disconnect during the gate beat cancels this call too.
        abortSignal: signal,
      })
      if (gate.verdict === 'reject') {
        await emitRejection(args, gate, synth.concept)
        return
      }
    }

    // Gate pass: park EXACTLY as the JSON route parks (same store, same
    // record shape, reworkCount:0, IDOR-safe user-keyed, non-charging).
    const previewId = await putPreview(args.redis, args.redisKeyPrefix, args.userId, {
      title: synth.title,
      concept: synth.concept,
      intentSummary: synth.intentSummary,
      reworkCount: 0,
    })
    emit(sink, { type: 'complete', previewId, title: synth.title, concept: synth.concept })
  } catch (err) {
    logger.error({ err }, 'synthesize-preview stream failed')
    // Failure honesty: a clear terminal frame, never a hung half-brief.
    // (A write after a client disconnect is a no-op on the closed sink.)
    emit(sink, { type: 'error', code: streamErrorCode(err) })
  } finally {
    sink.close('complete')
  }
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only the synchronous app.post registration).
// eslint-disable-next-line @typescript-eslint/require-await
export const campaignPreviewStreamRoutes: FastifyPluginAsync<CampaignPreviewStreamOpts> = async (app, opts) => {
  const repo = createRepo(opts.pool)
  const stormCounter = createRejectionStormCounter(opts.redis, opts.redisKeyPrefix)

  app.post(
    '/api/campaigns/synthesize-preview/stream',
    { config: { rateLimit: previewRateLimit } },
    async (request, reply) => {
      // Steps 1–4: the JSON route's guard chain, verbatim, BEFORE any hijack.
      const parsed = SynthesizePreviewBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_body', issues: parsed.error.issues })
      }
      const dbUser = requireDbUser(request)
      if (
        await runPreviewCostGuards({
          reply,
          redis: opts.redis,
          redisKeyPrefix: opts.redisKeyPrefix,
          credits: repo.credits,
          userId: dbUser.id,
        })
      ) {
        return reply
      }

      // Step 5: guards passed — hijack into SSE. From here every outcome
      // (success, gate reject, failure) is a terminal data frame; the close
      // reason is always 'complete' (the one-shot delivered its terminal).
      const abort = new AbortController()
      const sink = openSseConnection({
        request,
        reply,
        logger: request.log as PinoLogger,
        allowedOrigin: opts.frontendBaseUrl,
        onClose: () => {
          // Client disconnect (or our own normal close): stop the Sonnet burn.
          abort.abort()
        },
      })

      await runStreamedSynthesis({
        sink,
        signal: abort.signal,
        source: parsed.data,
        userId: dbUser.id,
        redis: opts.redis,
        redisKeyPrefix: opts.redisKeyPrefix,
        incrementStorm: () => stormCounter.incrementAndCheck(dbUser.id),
        logger: request.log as PinoLogger,
      })
      return reply
    },
  )
}
