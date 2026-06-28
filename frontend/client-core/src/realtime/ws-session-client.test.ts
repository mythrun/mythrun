import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createWsSessionClient, type WsSessionClient } from './ws-session-client.ts'
import type { ApiContext } from '../api/endpoint.ts'
import type { ClientFrame, ServerFrame } from '@mythrun/contract/events'
import { configureTokenRefresh, resetTokenManager } from '../auth/token-manager.ts'
import {
  applyFrame,
  combatResolved,
  combatStarted,
  liveLedger,
  liveSkill,
  MockWebSocket,
  newRenderState,
  pm,
  reconnectFrame,
  rowLedger,
  rowSkill,
} from './ws-session-client.fixtures.ts'

// The WS session client (MYT-85). Task 5 covered the lifecycle + frame I/O half
// (ticket → socket → onFrame → send → drop). Task 6 layers production
// reconnection: the backoff reopen loop (re-minting a ticket + sending
// lastSeq=<high-water>), seq + whole-turn dedup of the replay, and close-routing
// on the only READABLE signals. The `MockWebSocket` double + the frame builders +
// a reference flow reducer live in `./ws-session-client.fixtures.ts`.
//
// No network: `MockWebSocket` replaces `globalThis.WebSocket`, and MSW intercepts
// the ws-ticket POST (mirroring ws-ticket.test.ts).

const BASE_URL = 'http://api.test'
const server = setupServer()

/** Clients are tracked + `close()`d in afterEach: once Task 6 wires the
 *  reconnect-replay loop, a drop schedules a real backoff timer — `close()`
 *  clears it so it never fires into a torn-down test (a fetch with no handler). */
const clients: WsSessionClient[] = []
function newClient(c: ApiContext): WsSessionClient {
  const client = createWsSessionClient(c)
  clients.push(client)
  return client
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
beforeEach(() => {
  MockWebSocket.instances = []
  // jsdom's `WebSocket` global is read-only; `vi.stubGlobal` swaps it cleanly.
  vi.stubGlobal('WebSocket', MockWebSocket)
})
afterEach(() => {
  for (const client of clients) client.close()
  clients.length = 0
  server.resetHandlers()
  resetTokenManager()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
afterAll(() => {
  server.close()
})

const ctx: ApiContext = { baseUrl: BASE_URL, getAuthHeaders: () => Promise.resolve({}) }

function mockTicket(sessionId: string, ticket = 'nonce-1'): void {
  server.use(
    http.post(`${BASE_URL}/api/sessions/${sessionId}/ws-ticket`, () =>
      HttpResponse.json({ ticket }),
    ),
  )
}

/** Connect then wait for the (async) ticket-POST → socket-open chain to settle. */
async function connectAndAwaitSocket(
  client: WsSessionClient,
  sessionId: string,
  opts?: { seedLastSeq?: number },
): Promise<MockWebSocket> {
  client.connect(sessionId, opts)
  await vi.waitFor(() => {
    expect(MockWebSocket.instances.length).toBeGreaterThan(0)
  })
  return MockWebSocket.last()
}

describe('createWsSessionClient — connect + ticket flow', () => {
  it('runs the pre-flight runRefresh() before the ticket POST', async () => {
    const order: string[] = []
    configureTokenRefresh(() => {
      order.push('refresh')
      return Promise.resolve({ accessToken: 't', expiresIn: 3600 })
    })
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () => {
        order.push('ticket')
        return HttpResponse.json({ ticket: 'n' })
      }),
    )
    const client = newClient(ctx)
    await connectAndAwaitSocket(client, 's1')
    expect(order).toEqual(['refresh', 'ticket'])
  })

  it('mints a ticket then opens ws://…/ws/session/:id?ticket (lastSeq omitted on a fresh connect)', async () => {
    mockTicket('s1', 'abc')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(ws.url).toBe('ws://api.test/ws/session/s1?ticket=abc')
  })

  it('includes &lastSeq=<seed> when connect is seeded', async () => {
    mockTicket('s1', 'abc')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1', { seedLastSeq: 0 })
    expect(ws.url).toBe('ws://api.test/ws/session/s1?ticket=abc&lastSeq=0')
  })

  it('derives wss:// from an https baseUrl and url-encodes the ticket', async () => {
    const httpsCtx: ApiContext = {
      baseUrl: 'https://api.test',
      getAuthHeaders: () => Promise.resolve({}),
    }
    server.use(
      http.post('https://api.test/api/sessions/s1/ws-ticket', () =>
        HttpResponse.json({ ticket: 'a/b+c' }),
      ),
    )
    const client = newClient(httpsCtx)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(ws.url).toBe('wss://api.test/ws/session/s1?ticket=a%2Fb%2Bc')
  })

  it('transitions to connected on socket open (attempt reset)', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(client.connectionState.getState().status).toBe('connecting')
    ws.open()
    expect(client.connectionState.getState()).toMatchObject({ status: 'connected', attempt: 0 })
  })

  it('seedLastSeen makes the next open send lastSeq', async () => {
    mockTicket('s1', 'tk')
    const client = newClient(ctx)
    client.seedLastSeen(7)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(ws.url).toBe('ws://api.test/ws/session/s1?ticket=tk&lastSeq=7')
  })
})

describe('createWsSessionClient — frame I/O', () => {
  it('dispatches an inbound JSON frame to onFrame listeners (typed)', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const received: ServerFrame[] = []
    client.onFrame((f) => received.push(f))
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    const frame: ServerFrame = {
      type: 'player_message',
      seq: 5,
      userId: 'u1',
      displayName: 'Dee',
      characterName: 'Cee',
      text: 'hi',
    }
    ws.emit(frame)
    expect(received).toEqual([frame])
  })

  it('onFrame returns an unsubscribe that stops further dispatch', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const received: ServerFrame[] = []
    const off = client.onFrame((f) => received.push(f))
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    off()
    ws.emit({ type: 'session_ready' })
    expect(received).toEqual([])
  })

  it('silently drops a malformed (non-JSON) frame', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const received: ServerFrame[] = []
    client.onFrame((f) => received.push(f))
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    ws.onmessage?.({ data: 'not json{' })
    expect(received).toEqual([])
  })
})

describe('createWsSessionClient — send() readyState guard', () => {
  it('writes the JSON frame and returns true when OPEN', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    const frame: ClientFrame = { type: 'player_message', text: 'hello' }
    expect(client.send(frame)).toBe(true)
    expect(ws.sent).toEqual([JSON.stringify(frame)])
  })

  it('returns false (no write) when the socket is still CONNECTING', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING)
    expect(client.send({ type: 'player_message', text: 'x' })).toBe(false)
    expect(ws.sent).toEqual([])
  })

  it('returns false when the socket is CLOSING (server-initiated)', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    ws.readyState = MockWebSocket.CLOSING
    expect(client.send({ type: 'player_message', text: 'x' })).toBe(false)
    expect(ws.sent).toEqual([])
  })

  it('returns false when there is no socket yet', () => {
    const client = newClient(ctx)
    expect(client.send({ type: 'dm_invoke' })).toBe(false)
  })
})

describe('createWsSessionClient — drop + teardown', () => {
  it('__simulateDrop() closes the socket and transitions to reconnecting', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    expect(client.connectionState.getState().status).toBe('connected')

    client.__simulateDrop()

    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    expect(client.connectionState.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 })
  })

  it('an unexpected socket close transitions to reconnecting', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    ws.close(1006)
    expect(client.connectionState.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 })
  })

  it('close() marks closed; the socket close it triggers does NOT flip to reconnecting', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()

    client.close()

    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    expect(client.connectionState.getState().status).toBe('closed')
  })
})

// ─── Task 6: reconnect-replay + seq/turn dedup + close-routing ────────────────
//
// Task 6 layers production reconnection over Task 5's lifecycle: a transient
// close → backoff reconnect (re-minting a ticket, sending lastSeq=<high-water>),
// seq + whole-turn dedup of the replay, and close-routing on the only READABLE
// signals (the socket close code, the ticket-POST status, a session_end DATA
// frame). Spec §"Seq + dedup", §Reconnection, §"Terminal-vs-transient".

/** Open a fresh socket and mark it OPEN (the common reconnect-test preamble). */
async function connectOpen(client: WsSessionClient, sessionId = 's1'): Promise<MockWebSocket> {
  const ws = await connectAndAwaitSocket(client, sessionId)
  ws.open()
  return ws
}

describe('createWsSessionClient — Task 6 seq dedup', () => {
  it('(a) discards replay frames with seq <= lastSeenSeq (the register-before-replay overlap)', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const frames: ServerFrame[] = []
    client.onFrame((f) => frames.push(f))
    const ws = await connectOpen(client)

    ws.emit(pm(5)) // a live player_message advances the high-water mark to 5
    ws.emit(reconnectFrame([pm(5), pm(6)])) // replay re-includes the seq-5 overlap

    const replay = frames.find(
      (f): f is Extract<ServerFrame, { type: 'session_reconnect' }> => f.type === 'session_reconnect',
    )
    expect(replay?.messages).toEqual([pm(6)]) // seq 5 discarded, seq 6 kept
  })

  it('(b) advances lastSeenSeq per emitted frame (live + replay), filtering the next batch on it', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const frames: ServerFrame[] = []
    client.onFrame((f) => frames.push(f))
    const ws = await connectOpen(client)

    ws.emit(pm(3)) // live per-frame advance → lastSeenSeq = 3
    ws.emit(reconnectFrame([pm(3), pm(4)])) // proves lastSeenSeq was 3 (drops 3), advances to 4
    ws.emit(reconnectFrame([pm(4), pm(5)])) // proves the replay advanced to 4 (drops 4)

    const replays = frames.filter(
      (f): f is Extract<ServerFrame, { type: 'session_reconnect' }> => f.type === 'session_reconnect',
    )
    expect(replays[0]?.messages).toEqual([pm(4)])
    expect(replays[1]?.messages).toEqual([pm(5)])
  })
})

describe('createWsSessionClient — Task 6 whole-turn (turnId) dedup', () => {
  it('(c) replaces a live-rendered turn from the replay rows — prose AND mechanical, no duplicate cards', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const render = newRenderState()
    client.onFrame((f) => { applyFrame(render, f) })
    const ws = await connectOpen(client)

    // Live DM turn T: streamed prose + 2 skill checks + 1 ledger update (all seq-less).
    ws.emit({ type: 'text_delta', turnId: 'T', text: 'You creep toward the door…' })
    ws.emit(liveSkill('T', 'Stealth'))
    ws.emit(liveSkill('T', 'Perception'))
    ws.emit(liveLedger('T'))
    expect(render.turns.get('T')).toHaveLength(4)

    // Reconnect: T replays from rows (consolidated prose row + the mechanical rows,
    // each now carrying a seq). The whole turn is REPLACED, not appended.
    ws.emit(
      reconnectFrame([
        { type: 'dm_message', seq: 10, turnId: 'T', text: 'You creep toward the door…' },
        rowSkill(11, 'T', 'Stealth'),
        rowSkill(12, 'T', 'Perception'),
        rowLedger(13, 'T'),
      ]),
    )

    const turn = render.turns.get('T')
    expect(turn).toHaveLength(4) // NOT 8 — the live frames were discarded
    expect(turn?.map((f) => f.type)).toEqual(['dm_message', 'skill_check', 'skill_check', 'ledger_update'])
  })

  it('(d) combat dedups by the LATEST state, not turnId (turnId "" is never a turn)', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const render = newRenderState()
    client.onFrame((f) => { applyFrame(render, f) })
    const ws = await connectOpen(client)

    ws.emit(reconnectFrame([combatStarted()]))
    ws.emit(reconnectFrame([combatResolved()]))

    expect(render.combat?.type).toBe('combat_resolved')
    expect(render.turns.size).toBe(0)
  })
})

describe('createWsSessionClient — Task 6 reconnect re-mints a fresh ticket + sends lastSeq', () => {
  it('(e) after a drop, reopens with a NEW ticket and lastSeq=<high-water>', async () => {
    let n = 0
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () => {
        n += 1
        return HttpResponse.json({ ticket: `tk-${String(n)}` })
      }),
    )
    const client = newClient(ctx)
    const ws1 = await connectOpen(client)
    expect(ws1.url).toBe('ws://api.test/ws/session/s1?ticket=tk-1') // fresh connect omits lastSeq
    ws1.emit(pm(3)) // high-water → 3

    ws1.close(1006) // transient drop → backoff reconnect
    expect(client.connectionState.getState().status).toBe('reconnecting')

    // The first backoff step (~1s + jitter) fires the reopen on real timers.
    await vi.waitFor(() => { expect(MockWebSocket.instances.length).toBe(2) }, { timeout: 3000 })
    const ws2 = MockWebSocket.last()
    expect(ws2.url).toBe('ws://api.test/ws/session/s1?ticket=tk-2&lastSeq=3')
  })
})

describe('createWsSessionClient — Task 6 close routing (readable signals only)', () => {
  it.each([
    { code: 1006, reason: '' },
    { code: 1011, reason: 'redis-resync-required' },
    { code: 1011, reason: 'connect-failed' },
  ])('routes a socket close $code/$reason to a transient reconnect', async ({ code, reason }) => {
    mockTicket('s1')
    const client = newClient(ctx)
    const ws = await connectOpen(client)
    ws.close(code, reason)
    expect(client.connectionState.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 })
  })

  it('routes a session_end DATA frame to close() → closed (the server does NOT close the socket)', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const received: ServerFrame[] = []
    client.onFrame((f) => received.push(f))
    const ws = await connectOpen(client)

    ws.emit({ type: 'session_end', reason: 'normal' })

    expect(received).toEqual([{ type: 'session_end', reason: 'normal' }]) // flow sees it first
    expect(client.connectionState.getState()).toEqual({ status: 'closed', attempt: 0 })
    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
  })

  it.each([403, 404])('routes a ticket-POST %i to terminal failed{denied} (no socket)', async (status) => {
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () =>
        HttpResponse.json({ code: 'denied' }, { status }),
      ),
    )
    const client = newClient(ctx)
    client.connect('s1')
    await vi.waitFor(() => {
      expect(client.connectionState.getState()).toEqual({
        status: 'failed', attempt: 0, failedReason: 'denied',
      })
    })
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it.each([401, 503])('routes a ticket-POST %i to a transient reconnect', async (status) => {
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () =>
        HttpResponse.json({ code: 'transient' }, { status }),
      ),
    )
    const client = newClient(ctx)
    client.connect('s1')
    await vi.waitFor(() => {
      expect(client.connectionState.getState().status).toBe('reconnecting')
    })
  })
})

describe('createWsSessionClient — Task 6 reconnect lastSeq when nothing was seen', () => {
  it('sends lastSeq=0 on a reconnect that follows a drop with no frames seen', async () => {
    let n = 0
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () => {
        n += 1
        return HttpResponse.json({ ticket: `tk-${String(n)}` })
      }),
    )
    const client = newClient(ctx)
    const ws1 = await connectOpen(client)
    // No frame is emitted → the high-water mark stays null; the reconnect must
    // still send lastSeq, defaulting to 0 (a reconnect ALWAYS sends it).
    ws1.close(1006)
    await vi.waitFor(() => { expect(MockWebSocket.instances.length).toBe(2) }, { timeout: 3000 })
    expect(MockWebSocket.last().url).toBe('ws://api.test/ws/session/s1?ticket=tk-2&lastSeq=0')
  })
})

describe('createWsSessionClient — single-flight superseded guards', () => {
  it('a superseded socket self-ignores inbound frames (a later connect bumped the generation)', async () => {
    mockTicket('s1')
    const client = newClient(ctx)
    const received: ServerFrame[] = []
    client.onFrame((f) => received.push(f))
    const ws1 = await connectOpen(client)

    // A second connect mints a fresh generation synchronously (nextGeneration in
    // openSocket), superseding ws1; a frame on the OLD socket must be ignored.
    client.connect('s1')
    ws1.emit(pm(9))

    expect(received).toEqual([])
    // Let gen-2's ticket POST + socket settle so its request is handled inside the
    // test (not after afterEach resets the MSW handlers).
    await vi.waitFor(() => { expect(MockWebSocket.instances.length).toBe(2) })
  })

  it('ignores an openSocket superseded while awaiting the pre-flight refresh', async () => {
    mockTicket('s1')
    let releaseRefresh = (): void => undefined
    const gate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    let ticketCalls = 0
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () => {
        ticketCalls += 1
        return HttpResponse.json({ ticket: `tk-${String(ticketCalls)}` })
      }),
    )
    configureTokenRefresh(() => gate.then(() => ({ accessToken: 't', expiresIn: 3600 })))
    const client = newClient(ctx)

    client.connect('s1') // gen 1 → parks at await runRefresh()
    client.connect('s1') // gen 2 → coalesced onto the same single-flight refresh
    releaseRefresh()

    // gen-1's openSocket finds itself stale post-refresh and returns BEFORE the
    // ticket POST, so exactly one ticket is minted and one socket opens.
    await vi.waitFor(() => { expect(MockWebSocket.instances.length).toBe(1) })
    await Promise.resolve()
    expect(ticketCalls).toBe(1)
    expect(MockWebSocket.instances.length).toBe(1)
  })

  it('ignores an openSocket superseded while awaiting the ticket POST', async () => {
    let releaseTicket = (): void => undefined
    const gate = new Promise<void>((resolve) => { releaseTicket = resolve })
    let ticketCalls = 0
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, async () => {
        ticketCalls += 1
        if (ticketCalls === 1) await gate // gen-1 parks here
        return HttpResponse.json({ ticket: `tk-${String(ticketCalls)}` })
      }),
    )
    configureTokenRefresh(() => Promise.resolve({ accessToken: 't', expiresIn: 3600 }))
    const client = newClient(ctx)

    client.connect('s1') // gen 1 → parks at await mintWsTicket()
    await vi.waitFor(() => { expect(ticketCalls).toBe(1) })
    client.connect('s1') // gen 2 → its own ticket resolves + opens a socket
    await vi.waitFor(() => { expect(MockWebSocket.instances.length).toBe(1) })

    releaseTicket() // gen-1's ticket finally resolves; it is stale → no second socket
    await vi.waitFor(() => { expect(ticketCalls).toBe(2) })
    await Promise.resolve()
    expect(MockWebSocket.instances.length).toBe(1)
  })

  it('ignores an openSocket superseded while a failing ticket POST is in flight', async () => {
    let releaseTicket = (): void => undefined
    const gate = new Promise<void>((resolve) => { releaseTicket = resolve })
    let ticketCalls = 0
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, async () => {
        ticketCalls += 1
        if (ticketCalls === 1) {
          await gate
          return HttpResponse.json({ code: 'transient' }, { status: 500 }) // gen-1 rejects late
        }
        return HttpResponse.json({ ticket: 'tk-2' })
      }),
    )
    configureTokenRefresh(() => Promise.resolve({ accessToken: 't', expiresIn: 3600 }))
    const client = newClient(ctx)

    client.connect('s1') // gen 1 → parks at the (soon-rejecting) ticket POST
    await vi.waitFor(() => { expect(ticketCalls).toBe(1) })
    client.connect('s1') // gen 2 → opens a socket (connecting)
    await vi.waitFor(() => { expect(MockWebSocket.instances.length).toBe(1) })

    releaseTicket() // gen-1's POST rejects; the catch sees it is stale → no reconnect/fail
    await vi.waitFor(() => { expect(ticketCalls).toBe(2) })
    await Promise.resolve()
    // The state reflects gen-2 (connecting, attempt 0), NOT a gen-1 transient drop.
    expect(client.connectionState.getState()).toEqual({ status: 'connecting', attempt: 0 })
  })
})

describe('createWsSessionClient — Task 6 ceiling exhaustion is re-armable', () => {
  it('(g) reaches failed{exhausted} after the ceiling, then a connect() re-arms', async () => {
    vi.useFakeTimers()
    // Every ticket POST fails transiently → each reconnect attempt drops again.
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () =>
        HttpResponse.json({ code: 'transient' }, { status: 503 }),
      ),
    )
    const client = newClient(ctx)
    client.connect('s1')

    // Drive past the ceiling (10); the backoff caps at 30s, so advance generously.
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(35_000)
    expect(client.connectionState.getState()).toEqual({
      status: 'failed', attempt: 10, failedReason: 'exhausted',
    })

    // Re-arm: a fresh connect with a now-succeeding ticket restarts the cycle.
    server.use(
      http.post(`${BASE_URL}/api/sessions/s1/ws-ticket`, () => HttpResponse.json({ ticket: 'ok' })),
    )
    client.connect('s1')
    await vi.advanceTimersByTimeAsync(0)
    expect(client.connectionState.getState().status).toBe('connecting')
    const ws = MockWebSocket.last()
    expect(ws.url).toBe('ws://api.test/ws/session/s1?ticket=ok') // re-armed fresh connect
    ws.open()
    expect(client.connectionState.getState().status).toBe('connected')
  })
})
