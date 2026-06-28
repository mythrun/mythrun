import type { StoreApi } from 'zustand/vanilla'
import type { ClientFrame, ServerFrame } from '@mythrun/contract/events'
import type { ApiContext } from '../api/endpoint.ts'
import { createConnection, type ConnectionState } from './connection.ts'
import { mintWsTicket } from './ws-ticket.ts'
import { runRefresh } from '../auth/token-manager.ts'

// The WebSocket session client (MYT-85): the bidirectional play transport, a
// dumb typed pipe with production-grade reconnection. This module is Task 5 — the
// LIFECYCLE + frame I/O half: ticket flow, socket open, inbound-frame dispatch,
// `send()`, and the drop → `reconnecting` transition. The reconnect-replay loop,
// seq/turnId dedup, and full close-code routing (1006/1011/session_end/denied)
// land in Task 6 over this same surface — the seams here (the per-frame
// `handleMessage`, the `handleClose` drop router, the `lastSeenSeq` high-water
// mark) are where that logic attaches.
//
// Built on the shared connection primitive (`connection.ts`): per-instance state,
// the single-flight generation token (a superseded socket's late `close`/message
// self-ignores), and the backoff/ceiling machine. Auth: a pre-flight
// `runRefresh()` before the ticket POST; the ticket (not a header) gates the WS
// upgrade, so the URL carries `?ticket=<nonce>` and nothing sensitive otherwise.

// `import.meta.env.DEV` is the bundler-injected dev flag — Vite statically
// replaces it with a literal so the `__simulateDrop` body dead-code-eliminates
// from the prod bundle. client-core is platform-neutral and deliberately carries
// no `vite/client` ambient types (that would couple the client brain to Vite), so
// we declare just the single field this module reads.
declare global {
  interface ImportMeta {
    readonly env?: { readonly DEV?: boolean }
  }
}

/** The reconnect-attempt ceiling (≈10) — see `connection.ts`. */
const RECONNECT_CEILING = 10

export interface WsSessionConnectOptions {
  /** Seed the dedup high-water mark so this connect sends `lastSeq=<seed>` (e.g.
   *  after a REST history-load). A truly fresh connect (no seed) omits `lastSeq`
   *  → the server replies `session_ready` with no replay. */
  seedLastSeq?: number
}

export interface WsSessionClient {
  /** Open the session socket: pre-flight refresh → mint ticket → connect. */
  connect(sessionId: string, opts?: WsSessionConnectOptions): void
  /** Subscribe to inbound server frames; returns an unsubscribe. */
  onFrame(cb: (frame: ServerFrame) => void): () => void
  /** Write a client frame. Returns `false` (no throw, no write) unless the live
   *  socket is OPEN — the flow retries an unsent frame. */
  send(frame: ClientFrame): boolean
  /** The per-instance connection-state store (read via `useConnectionState`). */
  readonly connectionState: StoreApi<ConnectionState>
  /** Clean teardown → `closed`. */
  close(): void
  /** Seed the dedup high-water mark on a live client (a reconnect then sends it). */
  seedLastSeen(seq: number): void
  /** DEV-only: force a transient drop to exercise reconnect-replay in the harness. */
  __simulateDrop(): void
}

/** `http→ws`, `https→wss`. The leading `http` match covers both (https→wss). */
function toWsBase(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws')
}

function buildWsUrl(
  wsBase: string,
  sessionId: string,
  ticket: string,
  lastSeenSeq: number | null,
): string {
  const base = `${wsBase}/ws/session/${sessionId}?ticket=${encodeURIComponent(ticket)}`
  return lastSeenSeq === null ? base : `${base}&lastSeq=${String(lastSeenSeq)}`
}

/** The wire-boundary decode. The backend validates every outbound frame against
 *  the contract, so the client trusts the typed `ServerFrame` union here; there is
 *  no runtime Zod parser for it. A non-JSON payload is dropped (returns `null`). */
function decodeFrame(data: unknown): ServerFrame | null {
  try {
    return JSON.parse(String(data)) as ServerFrame
  } catch {
    return null
  }
}

export function createWsSessionClient(ctx: ApiContext): WsSessionClient {
  const connection = createConnection({ ceiling: RECONNECT_CEILING })
  const wsBase = toWsBase(ctx.baseUrl)
  const frameListeners = new Set<(frame: ServerFrame) => void>()

  let socket: WebSocket | null = null
  // The dedup high-water mark: `null` on a truly fresh connect (omit `lastSeq`);
  // a number once seeded or (Task 6) advanced per emitted frame.
  let lastSeenSeq: number | null = null

  function emit(frame: ServerFrame): void {
    for (const cb of frameListeners) cb(frame)
  }

  function handleMessage(gen: number, data: unknown): void {
    if (gen !== connection.generation()) return // superseded socket — self-ignore
    const frame = decodeFrame(data)
    // Task 6 layers seq/turnId dedup + per-frame `lastSeenSeq` advance +
    // `session_end` → `close()` over this dispatch.
    if (frame !== null) emit(frame)
  }

  function handleClose(gen: number): void {
    if (gen !== connection.generation()) return // superseded / explicit close — self-ignore
    socket = null
    // Task 6 refines this into full close-code routing + the backoff reopen timer.
    // Task 5 lands only the drop → `reconnecting` transition.
    connection.recordDrop()
  }

  async function openSocket(sessionId: string): Promise<void> {
    const gen = connection.nextGeneration()
    try {
      await runRefresh() // pre-flight: refresh the access token before the ticket POST
      if (gen !== connection.generation()) return // superseded while awaiting
      const { ticket } = await mintWsTicket(sessionId, ctx)
      if (gen !== connection.generation()) return
      const ws = new WebSocket(buildWsUrl(wsBase, sessionId, ticket, lastSeenSeq))
      socket = ws
      ws.onopen = () => {
        if (gen === connection.generation()) connection.onOpenSuccess()
      }
      ws.onmessage = (ev: MessageEvent) => {
        const data: unknown = ev.data
        handleMessage(gen, data)
      }
      ws.onclose = () => {
        handleClose(gen)
      }
    } catch {
      // A ticket-POST / refresh failure is a transient drop in Task 5 (Task 6
      // routes 403/404 → failed{denied} vs 401/503/network → transient + reopen).
      if (gen === connection.generation()) connection.recordDrop()
    }
  }

  function connect(sessionId: string, opts?: WsSessionConnectOptions): void {
    if (opts?.seedLastSeq !== undefined) lastSeenSeq = opts.seedLastSeq
    connection.reset()
    void openSocket(sessionId)
  }

  function send(frame: ClientFrame): boolean {
    const ws = socket
    // Guard on the LIVE readyState (not the store, which can lag a server-initiated
    // CLOSING). `WebSocket.send` only throws in CONNECTING and silently discards in
    // CLOSING/CLOSED — so we check OPEN and return false (no silent loss) otherwise.
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(frame))
    return true
  }

  function close(): void {
    connection.nextGeneration() // supersede the live socket so its onclose self-ignores
    const ws = socket
    socket = null
    connection.markClosed()
    ws?.close()
  }

  function onFrame(cb: (frame: ServerFrame) => void): () => void {
    frameListeners.add(cb)
    return () => {
      frameListeners.delete(cb)
    }
  }

  function __simulateDrop(): void {
    if (import.meta.env?.DEV !== true) return
    socket?.close() // its onclose routes the drop → reconnecting
  }

  function seedLastSeen(seq: number): void {
    lastSeenSeq = seq
  }

  return {
    connect,
    onFrame,
    send,
    connectionState: connection.store,
    close,
    seedLastSeen,
    __simulateDrop,
  }
}
