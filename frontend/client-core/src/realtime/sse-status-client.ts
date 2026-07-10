import type { PipelineEvent } from '@mythrun/contract/events'
import type { StoreApi } from 'zustand/vanilla'
import type { ApiContext } from '../api/endpoint.ts'
import { getStreamingFetch } from '../platform/streaming-fetch.ts'
import { runRefresh } from '../auth/token-manager.ts'
import { createConnection, type ConnectionState } from './connection.ts'
import { parseSseFrame, readStream } from './sse-frames.ts'

// The SSE status client (MYT-85): the unidirectional world-gen / session-prep
// status stream as a DUMB, TYPED PIPE with production-grade reconnection. All the
// framing/decode/reconnect logic lives HERE in the DOM-free brain; the only
// platform-divergent work — the open status + the raw decoded text chunks —
// arrives through the injected `StreamingFetch` seam (`EventSource` is banned by
// R1). The transport carries frames and exposes connection state; it does NOT
// interpret frames or decide flow lifecycle. Specifically it NEVER auto-closes on
// a data frame (`finalized` is per-entity, not terminal) — the consuming flow
// calls `close()` on its own terminal event.
//
// Auth is computed in core: each (re)connect runs a pre-flight `runRefresh()`
// then hands `ctx.getAuthHeaders()` to the seam as `headers` — the web impl is
// `ctx`-free and applies whatever it's handed (mode-correct Bearer /
// x-mythrun-dev-sub). The `runRefresh()` boolean is lossy (it collapses
// "logged out" and "transient refresh outage"), so the client does NOT branch on
// it: a genuine logout surfaces downstream as a ticket/open `401` → transient →
// the ceiling → `failed{exhausted}`, never as a premature terminal.
//
// Open-status routing (the only OBSERVABLE signals, per spec §"SSE contract"):
//   - 403 / 404            → terminal `failed{denied}` (no session / not a member)
//   - any other non-200    → transient → backoff reconnect (401/429/503 + the
//                            CloudFront-generated 502/504)
//   - a stream-end or error with NO `event: close` (the wifi-drop case), AND an
//     `event: close` CloseReason frame → transient → backoff reconnect
// The reconnect ceiling (≈10) bounds it; on exhaustion → `failed{exhausted}`
// (re-armable — a flow may call `open()` again).

export interface SseStatusClient {
  /** Start the connection cycle for an SSE path (appended to `ctx.baseUrl`).
   *  Re-callable to re-arm after a terminal/exhausted end. */
  open(path: string): void
  /** Subscribe to decoded `PipelineEvent`s (every `data:` frame except snapshot).
   *  Returns an unsubscribe fn. */
  onEvent(cb: (event: PipelineEvent) => void): () => void
  /** Subscribe to the raw (un-decoded) first-frame `event: snapshot` payload —
   *  it is NOT a `PipelineEvent`. Returns an unsubscribe fn. */
  onSnapshot(cb: (raw: unknown) => void): () => void
  /** The per-instance connection-state store (subscribe via `useConnectionState`). */
  connectionState: StoreApi<ConnectionState>
  /** Explicit teardown by the flow (e.g. on its terminal data event) → `closed`. */
  close(): void
}

/** ≈10 reconnect attempts before `failed{exhausted}` (see connection.ts). */
const RECONNECT_CEILING = 10

// The `\n\n` frame parser + the chunk-reassembling read loop moved verbatim to
// sse-frames.ts (myth-umggn) so the one-shot synthesize stream client shares
// them; this module keeps only the status-stream-specific routing below.

/** Route one parsed frame to the right listener set. Returns `'close'` when an
 *  `event: close` CloseReason frame was seen (the read loop ends → reconnect).
 *  Module-scoped — it closes over no per-instance state. */
function emitFrame(
  raw: string,
  snapshotListeners: ReadonlySet<(raw: unknown) => void>,
  eventListeners: ReadonlySet<(event: PipelineEvent) => void>,
): 'close' | 'ok' {
  const frame = parseSseFrame(raw)
  if (frame === null) return 'ok'
  if (frame.event === 'close') return 'close'
  if (frame.data === '') return 'ok'
  const parsed: unknown = JSON.parse(frame.data)
  if (frame.event === 'snapshot') {
    for (const cb of snapshotListeners) cb(parsed)
    return 'ok'
  }
  // The transport is a dumb typed pipe: there is no runtime schema for the
  // `PipelineEvent` union (it is wire-format JSON the flow reducers interpret),
  // so this narrowing assertion is unavoidable here.
  const event = parsed as PipelineEvent
  for (const cb of eventListeners) cb(event)
  return 'ok'
}

export function createSseStatusClient(ctx: ApiContext): SseStatusClient {
  const conn = createConnection({ ceiling: RECONNECT_CEILING })
  const eventListeners = new Set<(event: PipelineEvent) => void>()
  const snapshotListeners = new Set<(raw: unknown) => void>()

  let path: string | null = null
  let controller: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  /** A superseded attempt (close()/re-open() bumped the generation) or an
   *  explicit teardown must not mutate the live state machine. */
  const isStale = (generation: number): boolean =>
    closed || generation !== conn.generation()

  const clearTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  /** A transient drop: under the ceiling → schedule the backoff reconnect; at the
   *  ceiling → `failed{exhausted}` (recordDrop already set the state). */
  function scheduleReconnect(generation: number): void {
    if (isStale(generation)) return
    if (!conn.recordDrop()) return
    const delay = conn.nextDelayMs()
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void runConnect()
    }, delay)
  }

  async function runConnect(): Promise<void> {
    const generation = conn.nextGeneration()
    // Defensive: runConnect is entered only from open() (path set, closed=false)
    // or the reconnect timer (cleared by close() before it can fire post-close),
    // so this guard is unreachable — it documents the precondition.
    /* v8 ignore next */
    if (closed || path === null) return
    await runRefresh() // pre-flight; lossy boolean intentionally ignored (see header)
    if (isStale(generation)) return
    const ctrl = new AbortController()
    controller = ctrl
    let result: { status: number; chunks: AsyncIterable<string> }
    try {
      const headers = await ctx.getAuthHeaders()
      result = await getStreamingFetch()(ctx.baseUrl + path, { headers, signal: ctrl.signal })
    } catch {
      scheduleReconnect(generation)
      return
    }
    if (isStale(generation)) return
    if (result.status === 403 || result.status === 404) {
      conn.fail('denied')
      return
    }
    if (result.status !== 200) {
      scheduleReconnect(generation)
      return
    }
    conn.onOpenSuccess()
    try {
      await readStream(
        result.chunks,
        () => isStale(generation),
        (raw) => emitFrame(raw, snapshotListeners, eventListeners),
      )
    } catch {
      scheduleReconnect(generation)
      return
    }
    // Stream ended (clean end OR an `event: close` CloseReason) → transient.
    scheduleReconnect(generation)
  }

  return {
    connectionState: conn.store,
    open(nextPath) {
      clearTimer()
      controller?.abort()
      path = nextPath
      closed = false
      conn.reset()
      void runConnect()
    },
    onEvent(cb) {
      eventListeners.add(cb)
      return () => {
        eventListeners.delete(cb)
      }
    },
    onSnapshot(cb) {
      snapshotListeners.add(cb)
      return () => {
        snapshotListeners.delete(cb)
      }
    },
    close() {
      if (closed) return
      closed = true
      clearTimer()
      controller?.abort()
      conn.markClosed()
    },
  }
}
