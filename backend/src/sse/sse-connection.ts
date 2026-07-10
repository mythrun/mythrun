// backend/src/sse/sse-connection.ts
//
// Fastify reply wrapper for an SSE response. Owns the response lifecycle:
//   - reply.hijack() before any raw writes (Fastify won't run onSend/onResponse
//     after hijack; we own the response).
//   - SSE response headers (no Connection: keep-alive — forbidden under HTTP/2).
//   - Keepalive: ':keepalive\n\n' every 25s via re-armed setTimeout (not
//     setInterval — avoids useless ticks on busy streams).
//   - Idle-timeout: 30 min no event → close with 'idle-timeout' reason.
//   - Back-pressure: write returns boolean; if false, arm 5s drain timer;
//     on timeout, close with 'back-pressure' reason.
//   - Cleanup: listen on BOTH request.raw 'close' AND reply.raw 'close'
//     (Fastify 5 / Node 22 emits on either depending on the closing party).
//     Idempotent.

import type { FastifyReply, FastifyRequest } from 'fastify'
import type pino from 'pino'

const KEEPALIVE_MS = 25_000
const IDLE_TIMEOUT_MS = 30 * 60_000
const DRAIN_TIMEOUT_MS = 5_000

export type CloseReason =
  | 'idle-timeout'
  | 'server-shutdown'
  | 'redis-resync-required'
  | 'rate-limited'
  | 'back-pressure'
  // myth-umggn: a ONE-SHOT stream (the synthesize-preview brief) delivered its
  // terminal event and the server is done — the normal end, not a drop.
  | 'complete'
  | 'unknown'

export interface SseSink {
  /** Returns false if the writer is back-pressured (caller may ignore). */
  readonly write: (frame: string) => boolean
  /** Closes the SSE response with a structured reason. Idempotent. */
  readonly close: (reason: CloseReason) => void
}

export interface OpenSseConnectionOpts {
  readonly request: FastifyRequest
  readonly reply: FastifyReply
  readonly logger: pino.Logger
  readonly onClose: () => void
  /** The single allowlisted CORS origin — config.env.frontendBaseUrl, the exact
   *  value @fastify/cors is registered with (app.ts). The hijacked SSE response
   *  echoes the same single-origin policy when the request Origin matches. */
  readonly allowedOrigin: string
}

// @fastify/cors is registered with { origin: [config.env.frontendBaseUrl],
// credentials: true } (app.ts). Its onSend hook that injects the CORS response
// headers NEVER runs on a hijacked reply — so an SSE response would otherwise
// carry NO Access-Control-Allow-Origin, and a cross-origin browser fetch (dev:
// localhost:5173 → localhost:3030) is blocked by CORS, starving the world-gen
// graph of events (curl "works" because curl ignores CORS entirely). We
// replicate that SAME single-origin policy here: echo the request Origin (with
// Vary: Origin + Access-Control-Allow-Credentials, because the app sets
// credentials:true) ONLY when it exactly matches the one allowlisted origin. A
// non-matching Origin gets no header — never reflect an arbitrary Origin; that
// is the security boundary. A same-origin request (no Origin header, e.g. prod
// behind the BFF/CloudFront proxy) needs no CORS header at all.
function corsHeaders(
  requestOrigin: string | undefined,
  allowedOrigin: string,
): Record<string, string> {
  if (requestOrigin === undefined || requestOrigin !== allowedOrigin) return {}
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  }
}

export function openSseConnection(opts: OpenSseConnectionOpts): SseSink {
  const { request, reply, logger, onClose, allowedOrigin } = opts

  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(request.headers.origin, allowedOrigin),
  })

  let closed = false
  let keepaliveHandle: NodeJS.Timeout | null = null
  let idleHandle: NodeJS.Timeout | null = null
  let drainHandle: NodeJS.Timeout | null = null

  function armKeepalive(): void {
    if (keepaliveHandle) clearTimeout(keepaliveHandle)
    keepaliveHandle = setTimeout(() => {
      /* c8 ignore start — closed-during-keepalive race: the close()
       * function clears keepaliveHandle, but a fire that's already
       * queued in the event loop might still execute. Defense-in-depth. */
      if (closed) return
      /* c8 ignore stop */
      raw.write(':keepalive\n\n')
      armKeepalive()
    }, KEEPALIVE_MS)
  }

  function armIdleTimeout(): void {
    if (idleHandle) clearTimeout(idleHandle)
    idleHandle = setTimeout(() => {
      close('idle-timeout')
    }, IDLE_TIMEOUT_MS)
  }

  function clearDrain(): void {
    if (drainHandle) {
      clearTimeout(drainHandle)
      drainHandle = null
    }
  }

  function onDrain(): void {
    clearDrain()
  }

  function close(reason: CloseReason): void {
    if (closed) return
    closed = true
    if (keepaliveHandle) clearTimeout(keepaliveHandle)
    if (idleHandle) clearTimeout(idleHandle)
    clearDrain()
    raw.off('drain', onDrain)
    request.raw.off('close', onUpstreamClose)
    raw.off('close', onUpstreamClose)
    /* c8 ignore start — best-effort write/end on already-half-closed
     * sockets: tests close the sink via the happy path, so the catch
     * arms (already-half-closed / already-ended) only fire under real-
     * network races. */
    try {
      raw.write(`event: close\ndata: ${JSON.stringify({ reason })}\n\n`)
    } catch {
      // Already-half-closed; ignore.
    }
    try {
      raw.end()
    } catch {
      // Already ended; ignore.
    }
    /* c8 ignore stop */
    try {
      onClose()
    } catch (err) {
      logger.warn({ err }, 'sse onClose handler threw')
    }
  }

  function onUpstreamClose(): void {
    close('unknown')
  }

  request.raw.on('close', onUpstreamClose)
  raw.on('close', onUpstreamClose)
  raw.on('drain', onDrain)

  armKeepalive()
  armIdleTimeout()

  function write(frame: string): boolean {
    if (closed) return false
    let result: boolean
    try {
      result = raw.write(frame)
    } catch (err) {
      logger.warn({ err }, 'sse write threw — closing connection')
      close('unknown')
      return false
    }
    // Reset both timers on a real event write.
    armKeepalive()
    armIdleTimeout()
    if (!result && !drainHandle) {
      drainHandle = setTimeout(() => {
        drainHandle = null
        close('back-pressure')
      }, DRAIN_TIMEOUT_MS)
    }
    return result
  }

  return { write, close }
}
