import type { StoreApi } from 'zustand/vanilla'
import type { ClientFrame, ServerFrame } from '@mythrun/contract/events'
import type { ApiContext } from '../api/endpoint.ts'
import { createConnection, type Connection, type ConnectionState } from './connection.ts'
import { mintWsTicket } from './ws-ticket.ts'
import { runRefresh } from '../auth/token-manager.ts'
import { isHttpError } from '../api/errors.ts'

// The WebSocket session client (MYT-85): the bidirectional play transport, a
// dumb typed pipe with production-grade reconnection. Task 5 landed the LIFECYCLE
// + frame I/O half (ticket flow, socket open, inbound-frame dispatch, `send()`);
// Task 6 layers production reconnection over it:
//
//   - Reconnect-replay loop: a transient close → `recordDrop()` → (under the
//     ceiling) a backoff timer reopens with a FRESH ticket + `lastSeq=<high-water>`.
//     This module OWNS the timer (the connection primitive does not) and clears it
//     before any `markClosed()`/`reset()`.
//   - Seq + whole-turn dedup: `lastSeenSeq` advances per emitted frame in seq
//     order; a `session_reconnect` replay discards rows already seen
//     (seq <= lastSeenSeq — the load-bearing register-before-replay overlap). The
//     turn (`turnId`) is the dedup UNIT: the filtered `session_reconnect` is a
//     whole-turn-replace batch a flow reducer keys on turnId; combat frames
//     (turnId '') key on latest state. The transport never INTERPRETS turnId — it
//     does the mechanical seq filter + emits the batch; the flow does the replace.
//   - Close-routing on READABLE signals only: every socket close code (1006 /
//     1011-any-reason) is transient; a `session_end` DATA frame self-closes →
//     `closed`; a ticket-POST 403/404 → `failed{denied}`; 401/503/network → transient.
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

/** A frame's persisted-row `seq`, or `null` for a seq-less frame (live DM-turn /
 *  control / presence frames, and the synthetic combat reconnect frame). Only
 *  `player_message` always carries one live; the mechanical/combat frames carry
 *  one ONLY on reconnect replay. The high-water mark advances on a numeric seq. */
function frameSeq(frame: ServerFrame): number | null {
  const seq = (frame as { seq?: number }).seq
  return typeof seq === 'number' ? seq : null
}

/** The reconnect dedup bookkeeping (cohesive, per-instance — minted in the
 *  factory). Holds the `lastSeenSeq` high-water mark, advanced PER emitted
 *  seq-bearing frame in seq order (never batch-set to `max`); filters a replay
 *  batch (discard `seq <= lastSeenSeq` — the load-bearing register-before-replay
 *  overlap, keeping seq-LESS frames like the synthetic combat reconnect frame);
 *  and computes the `lastSeq` URL value (a reconnect ALWAYS sends it, even 0; a
 *  fresh connect omits it unless seeded). */
interface SeqTracker {
  advance(frame: ServerFrame): void
  filterReplay(messages: ServerFrame[]): ServerFrame[]
  lastSeqForUrl(isReconnect: boolean): number | null
  seed(seq: number): void
}

function createSeqTracker(): SeqTracker {
  let lastSeenSeq: number | null = null
  function advance(frame: ServerFrame): void {
    const seq = frameSeq(frame)
    if (seq !== null && seq > (lastSeenSeq ?? -1)) lastSeenSeq = seq
  }
  return {
    advance,
    filterReplay(messages) {
      const highWater = lastSeenSeq ?? -1
      const kept = messages.filter((m) => {
        const seq = frameSeq(m)
        return seq === null || seq > highWater
      })
      for (const m of kept) advance(m)
      return kept
    },
    lastSeqForUrl: (isReconnect) => (isReconnect ? (lastSeenSeq ?? 0) : lastSeenSeq),
    seed: (seq) => {
      lastSeenSeq = seq
    },
  }
}

/** The backoff reopen timer this client OWNS (the connection primitive does not).
 *  `schedule` records the drop then arms one reopen after `nextDelayMs()` (under
 *  the ceiling); at the ceiling `recordDrop()` returns false → `failed{exhausted}`
 *  and nothing is armed. `clear` MUST run before any `markClosed()`/`reset()` and
 *  in `close()` so a pending reopen never fires into a torn-down client. */
interface ReconnectTimer {
  schedule(connection: Connection, reopen: () => void): void
  clear(): void
}

function createReconnectTimer(): ReconnectTimer {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule(connection, reopen) {
      if (!connection.recordDrop()) return
      timer = setTimeout(() => {
        timer = null
        reopen()
      }, connection.nextDelayMs())
    },
    clear() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/** The dependencies the inbound-frame router closes over (the factory's per-instance
 *  pieces). Passed explicitly so the routing logic lives at module scope. */
interface InboundDeps {
  connection: Connection
  tracker: SeqTracker
  emit: (frame: ServerFrame) => void
  /** The client's `close()` — a `session_end` DATA frame self-closes through it. */
  close: () => void
}

/** Route one inbound socket message: a superseded socket self-ignores; a
 *  malformed payload drops; a `session_reconnect` is seq-filtered + emitted (the
 *  flow does the whole-turn replace); a `session_end` emits then self-closes; any
 *  other frame emits + advances the high-water mark. */
function routeInbound(deps: InboundDeps, gen: number, data: unknown): void {
  const { connection, tracker, emit, close } = deps
  if (gen !== connection.generation()) return // superseded socket — self-ignore
  const frame = decodeFrame(data)
  if (frame === null) return
  if (frame.type === 'session_reconnect') {
    // A replay batch: discard the register-before-replay overlap + advance the
    // high-water mark, then emit the filtered batch. The whole-turn (turnId)
    // replace over this batch is the flow reducer's job — the transport does the
    // mechanical seq filter only (it never interprets turnId; combat keys on the
    // latest seq-less frame downstream).
    emit({ ...frame, messages: tracker.filterReplay(frame.messages) })
    return
  }
  emit(frame)
  if (frame.type === 'session_end') {
    // Terminal DATA frame: the server does NOT close the socket — the client
    // self-closes (→ `closed`). The flow has already seen the frame above.
    close()
    return
  }
  tracker.advance(frame) // a live player_message advances the high-water mark
}

export function createWsSessionClient(ctx: ApiContext): WsSessionClient {
  const connection = createConnection({ ceiling: RECONNECT_CEILING })
  const wsBase = toWsBase(ctx.baseUrl)
  const frameListeners = new Set<(frame: ServerFrame) => void>()

  const tracker = createSeqTracker()
  const reconnect = createReconnectTimer()
  let socket: WebSocket | null = null

  function emit(frame: ServerFrame): void {
    for (const cb of frameListeners) cb(frame)
  }

  // The inbound-frame router's deps (built once; `routeInbound` lives at module
  // scope). `emit`/`close` are hoisted function declarations.
  const inboundDeps: InboundDeps = { connection, tracker, emit, close }

  /** A transient drop → a backoff reopen (or `failed{exhausted}` at the ceiling). */
  function scheduleReconnect(sessionId: string): void {
    reconnect.schedule(connection, () => {
      void openSocket(sessionId, true)
    })
  }

  function handleClose(gen: number, sessionId: string): void {
    if (gen !== connection.generation()) return // superseded / explicit close — self-ignore
    socket = null
    // Every READABLE socket close is transient: 1006 (heartbeat terminate /
    // abnormal — the browser's view of any non-101 upgrade too) and 1011 ANY
    // reason (`redis-resync-required` AND `connect-failed` are both transient —
    // the backend emits `connect-failed` for transient DB/Redis faults too). The
    // terminal signals live elsewhere: a `session_end` DATA frame (routeInbound)
    // and a ticket-POST 403/404 (openSocket's catch).
    scheduleReconnect(sessionId)
  }

  async function openSocket(sessionId: string, isReconnect: boolean): Promise<void> {
    const gen = connection.nextGeneration()
    try {
      await runRefresh() // pre-flight: refresh the access token before the ticket POST
      if (gen !== connection.generation()) return // superseded while awaiting
      const { ticket } = await mintWsTicket(sessionId, ctx)
      if (gen !== connection.generation()) return
      const ws = new WebSocket(
        buildWsUrl(wsBase, sessionId, ticket, tracker.lastSeqForUrl(isReconnect)),
      )
      socket = ws
      ws.onopen = () => {
        if (gen === connection.generation()) connection.onOpenSuccess()
      }
      ws.onmessage = (ev: MessageEvent) => {
        const data: unknown = ev.data
        routeInbound(inboundDeps, gen, data)
      }
      ws.onclose = () => {
        handleClose(gen, sessionId)
      }
    } catch (err) {
      if (gen !== connection.generation()) return // superseded while awaiting
      // Ticket-POST 403/404 → terminal `failed{denied}` (no session / not a
      // member). 401/429/503 / network / any other error → transient reconnect
      // (ceiling-bounded); a 401 already exhausted defineEndpoint's refresh-retry,
      // and the lossy refresh boolean must not strand a recoverable hiccup.
      if (isHttpError(err) && (err.status === 403 || err.status === 404)) {
        connection.fail('denied')
        return
      }
      scheduleReconnect(sessionId)
    }
  }

  function connect(sessionId: string, opts?: WsSessionConnectOptions): void {
    if (opts?.seedLastSeq !== undefined) tracker.seed(opts.seedLastSeq)
    reconnect.clear() // a re-arm after failed{exhausted} must not leave a stale timer
    connection.reset()
    void openSocket(sessionId, false)
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
    reconnect.clear() // cancel a pending backoff reopen before tearing down
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
    tracker.seed(seq)
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
