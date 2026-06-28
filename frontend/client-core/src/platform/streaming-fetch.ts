// The DOM-free client brain's seam for streamed HTTP reads (the SSE status
// client's only platform-divergent dependency). ALL framing/decode/reconnect
// logic lives in client-core; this port surfaces just the two platform-specific
// outputs the brain can't compute itself: the open **status** (so non-200
// routing is observable in core) and the **raw decoded text chunks**. The web
// impl is fetch + ReadableStream + TextDecoder, in @mythrun/web's
// `src/platform/web/**` (the sanctioned web-globals carve-out) — `EventSource`
// is banned here (R1), so the stream reaches core through this interface.
//
// Auth is computed in core: the caller passes mode-correct `headers` (Bearer /
// x-mythrun-dev-sub via `ctx.getAuthHeaders()`), so the web impl is `ctx`-free
// and applies whatever it's handed. The transport itself is INJECTED
// (configureStreamingFetch) so this module has no import of the web impl —
// keeping the import graph acyclic, mirroring the `configureTokenRefresh` seam.
// Unlike token refresh, the boot wiring is UNCONDITIONAL (both auth modes).

/**
 * A single streamed HTTP read. Resolves once the response head is available —
 * NOT once the body completes — so the open `status` routes before the body is
 * consumed. `chunks` yields raw decoded text (the SSE client owns `\n\n`
 * framing); `signal` aborts the in-flight read on `close()`/reconnect.
 */
export type StreamingFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; chunks: AsyncIterable<string> }>

let streamingFetch: StreamingFetch | null = null

export function configureStreamingFetch(fn: StreamingFetch): void {
  streamingFetch = fn
}

/** Returns the configured impl; throws if the boot wiring never ran (a wiring
 *  bug, not a runtime condition the brain should branch on). */
export function getStreamingFetch(): StreamingFetch {
  if (streamingFetch === null) {
    throw new Error('streaming-fetch not configured: call configureStreamingFetch() at boot')
  }
  return streamingFetch
}

/** TEST-ONLY: reset module state between tests. Intentionally NOT exported from
 *  the client-core barrel (imported via the direct module path in tests). */
export function resetStreamingFetch(): void {
  streamingFetch = null
}
