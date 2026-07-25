// The one-shot synthesize-preview stream client (myth-umggn): opens
// POST /api/campaigns/synthesize-preview/stream and folds its
// `SynthesizeStreamEvent` frames into a small observable store the create flow
// renders — the world brief writing itself, then exactly one terminal state.
//
// myth-6t06f: BOTH funnel paths open this stream. The body is either the
// brainstorm path's 3 picks or the freeform path's own concept text; the frames,
// the store, and every screen that reads it are identical either way.
//
// Shape notes (why this is NOT the reconnecting SseStatusClient):
//   - The stream is a NON-IDEMPOTENT POST — a reconnect would re-run the
//     Sonnet synthesis (new brief, new token burn), so a drop is a TERMINAL
//     `failed{stream_interrupted}`, never a silent retry. The player retries
//     deliberately, from the guided screen.
//   - Open failures mirror `defineEndpoint` exactly: the guard chain's
//     400/429/403 arrive as plain JSON statuses BEFORE any SSE framing, so
//     `startSynthesisStream` REJECTS with the same `HttpError` (status/code/
//     body) the non-streaming endpoint would throw — the guided screen's
//     existing error mapping applies unchanged. The returned promise resolves
//     only on a 200 head; every post-open outcome lands in the store.
//   - State is a zustand vanilla store (the `connectionState` precedent), so
//     the screen that renders the arriving text can mount AFTER the open
//     resolved without missing frames — it reads the accumulated snapshot.
//
// Auth mirrors the SSE status client: a pre-flight `runRefresh()` (lossy
// boolean intentionally ignored) then `ctx.getAuthHeaders()` into the
// injected StreamingFetch seam (EventSource is banned — R1).

import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import {
  SynthesizePreviewRequestSchema,
  type ConceptRejection,
  type SynthesizePreviewRequest,
} from '@mythrun/contract/rest'
import type { SynthesizeStreamErrorCode, SynthesizeStreamEvent } from '@mythrun/contract/events'
import { getStreamingFetch } from '../platform/streaming-fetch.ts'
import { runRefresh } from '../auth/token-manager.ts'
import { parseSseFrame, readStream } from '../realtime/sse-frames.ts'
import { ContractValidationError, HttpError, NetworkError } from './errors.ts'
import type { ApiContext } from './endpoint.ts'

/** Why a stream ended in `failed`: a wire terminal (`error` frame) or the
 *  client-observed drop (`stream_interrupted` — the connection ended without
 *  any terminal frame). */
export type SynthesisFailureCode = SynthesizeStreamErrorCode | 'stream_interrupted'

/** The observable lifecycle the guided flow renders. `streaming.text` is the
 *  accumulated prose so far; exactly one terminal (`complete` / `rejected` /
 *  `failed`) follows — or none, when the consumer `close()`d first. `failed`
 *  KEEPS the partial text so the halted brief stays on the page under the
 *  failure notice instead of vanishing (streamed-text honesty). */
export type SynthesisStreamState =
  | { readonly status: 'streaming'; readonly text: string }
  | {
      readonly status: 'complete'
      readonly previewId: string
      /** The world's name (myth-z3icr) — the proposal screen headlines it. */
      readonly title: string
      readonly concept: string
    }
  | { readonly status: 'rejected'; readonly rejection: ConceptRejection }
  | { readonly status: 'failed'; readonly code: SynthesisFailureCode; readonly text: string }

export interface SynthesisStream {
  /** The per-stream state store (subscribe via `useSynthesisState`). */
  readonly state: StoreApi<SynthesisStreamState>
  /** Intentional teardown (back-out mid-stream): aborts the read and freezes
   *  the state as-is — an intentional close is not a failure. Idempotent. */
  close(): void
}

const STREAM_PATH = '/api/campaigns/synthesize-preview/stream'

/** Read the whole (non-200) body, mirroring defineEndpoint's readErrorPayload:
 *  a non-JSON / empty body yields `{}` so the HttpError still carries status. */
async function readErrorBody(
  chunks: AsyncIterable<string>,
): Promise<{ code?: string; body?: unknown }> {
  let text = ''
  try {
    for await (const chunk of chunks) text += chunk
    const body: unknown = JSON.parse(text)
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const code = (body as { code?: unknown }).code
      return typeof code === 'string' ? { body, code } : { body }
    }
    return { body }
  } catch {
    return {}
  }
}

/**
 * Open the streamed synthesis. Resolves with the live stream once the 200
 * head arrives; rejects (ContractValidationError / HttpError / NetworkError —
 * the defineEndpoint taxonomy) when the request never got to streaming.
 */
export async function startSynthesisStream(
  ctx: ApiContext,
  body: SynthesizePreviewRequest,
): Promise<SynthesisStream> {
  const validated = SynthesizePreviewRequestSchema.safeParse(body)
  if (!validated.success) {
    throw new ContractValidationError('request did not match contract', validated.error)
  }

  await runRefresh() // pre-flight; lossy boolean intentionally ignored (see header)
  const headers = await ctx.getAuthHeaders()
  const controller = new AbortController()

  let result: { status: number; chunks: AsyncIterable<string> }
  try {
    result = await getStreamingFetch()(ctx.baseUrl + STREAM_PATH, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      signal: controller.signal,
      method: 'POST',
      body: JSON.stringify(validated.data),
    })
  } catch (cause) {
    throw new NetworkError(cause instanceof Error ? cause.message : 'request failed')
  }

  if (result.status !== 200) {
    const { code, body: errorBody } = await readErrorBody(result.chunks)
    throw new HttpError(result.status, `HTTP ${String(result.status)}`, code, errorBody)
  }

  const store = createStore<SynthesisStreamState>(() => ({ status: 'streaming', text: '' }))
  let closed = false
  // The accumulated prose, kept OUTSIDE the store: the failure arms (terminal
  // `error` frame, interrupted stream) carry it into `failed.text` without
  // re-deriving it from whatever state the store happens to hold.
  let accumulated = ''

  /** Fold one wire event into the store. Returns `'close'` on a terminal —
   *  the read loop stops there (the server closes right after anyway). */
  const applyEvent = (event: SynthesizeStreamEvent): 'close' | 'ok' => {
    switch (event.type) {
      case 'delta':
        accumulated += event.text
        store.setState({ status: 'streaming', text: accumulated }, true)
        return 'ok'
      case 'complete':
        store.setState(
          {
            status: 'complete',
            previewId: event.previewId,
            title: event.title,
            concept: event.concept,
          },
          true,
        )
        return 'close'
      case 'rejected':
        store.setState(
          {
            status: 'rejected',
            rejection: {
              code: 'concept_rejected',
              reason: event.reason,
              rejectionMessage: event.rejectionMessage,
              synthesizedConcept: event.synthesizedConcept,
            },
          },
          true,
        )
        return 'close'
      case 'error':
        store.setState({ status: 'failed', code: event.code, text: accumulated }, true)
        return 'close'
    }
  }

  // The read loop, detached: every outcome lands in the store. `event: close`
  // (or a bare stream end) WITHOUT a preceding terminal data frame is a drop —
  // the honest `stream_interrupted`, unless the consumer closed intentionally.
  const emit = (raw: string): 'close' | 'ok' => {
    const frame = parseSseFrame(raw)
    if (frame === null) return 'ok' // keepalive comment
    if (frame.event === 'close') return 'close'
    if (frame.data === '') return 'ok' // a bare named event carries nothing to fold
    // Dumb typed pipe (the status-client precedent): the wire union is our own
    // backend's serialized frame; no runtime schema.
    return applyEvent(JSON.parse(frame.data) as SynthesizeStreamEvent)
  }
  // A NAMED function (not an IIFE) deliberately: TS's IIFE control-flow
  // narrowing pins `closed` to its initializer `false` inside an IIFE body
  // (the mutation lives in `close()` below) and flags the post-loop guard as
  // always-truthy — but the guard is real across the await points.
  const runReadLoop = async (): Promise<void> => {
    try {
      await readStream(result.chunks, () => closed, emit)
    } catch {
      // Transport drop mid-read — fall through to the interrupted check.
    }
    if (!closed && store.getState().status === 'streaming') {
      store.setState({ status: 'failed', code: 'stream_interrupted', text: accumulated }, true)
    }
  }
  void runReadLoop()

  return {
    state: store,
    close() {
      if (closed) return
      closed = true
      controller.abort()
    },
  }
}

/** The React read seam: subscribe a component to a stream's state store so
 *  flows never import `zustand` directly (mirrors `useConnectionState`). */
export function useSynthesisState(stream: SynthesisStream): SynthesisStreamState {
  return useStore(stream.state)
}
