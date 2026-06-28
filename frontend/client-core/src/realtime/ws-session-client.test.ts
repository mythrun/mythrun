import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createWsSessionClient, type WsSessionClient } from './ws-session-client.ts'
import type { ApiContext } from '../api/endpoint.ts'
import type { ClientFrame, ServerFrame } from '@mythrun/contract/events'
import { configureTokenRefresh, resetTokenManager } from '../auth/token-manager.ts'

// The WS session client (MYT-85 Task 5): the lifecycle + frame I/O half. It mints
// a ticket (pre-flighting a token refresh), opens the `/ws/session/:id` socket,
// dispatches inbound JSON frames to `onFrame`, guards `send()` on the live
// `readyState`, and routes a drop → `reconnecting`. The reconnect-replay loop +
// seq/turn dedup + full close-code routing land in Task 6 — NOT here.
//
// No network: a `MockWebSocket` test double replaces `globalThis.WebSocket`, and
// MSW intercepts the ws-ticket POST (mirroring ws-ticket.test.ts).

interface CloseLike {
  code?: number
  reason?: string
}

/** A minimal `WebSocket` test double. The client drives it through the standard
 *  `onopen`/`onmessage`/`onclose` property handlers + `send`/`close`; the test
 *  drives the "server side" through `open()`/`emit()` and reads `url`/`sent`. */
class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  static last(): MockWebSocket {
    const ws = MockWebSocket.instances.at(-1)
    if (ws === undefined) throw new Error('no MockWebSocket has been constructed')
    return ws
  }

  readyState = MockWebSocket.CONNECTING
  readonly url: string
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: CloseLike) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: code ?? 1006, reason: reason ?? '' })
  }

  // --- test-side drivers (the "server") ---
  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const BASE_URL = 'http://api.test'
const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
beforeEach(() => {
  MockWebSocket.instances = []
  // jsdom's `WebSocket` global is read-only; `vi.stubGlobal` swaps it cleanly.
  vi.stubGlobal('WebSocket', MockWebSocket)
})
afterEach(() => {
  server.resetHandlers()
  resetTokenManager()
  vi.unstubAllGlobals()
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
    const client = createWsSessionClient(ctx)
    await connectAndAwaitSocket(client, 's1')
    expect(order).toEqual(['refresh', 'ticket'])
  })

  it('mints a ticket then opens ws://…/ws/session/:id?ticket (lastSeq omitted on a fresh connect)', async () => {
    mockTicket('s1', 'abc')
    const client = createWsSessionClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(ws.url).toBe('ws://api.test/ws/session/s1?ticket=abc')
  })

  it('includes &lastSeq=<seed> when connect is seeded', async () => {
    mockTicket('s1', 'abc')
    const client = createWsSessionClient(ctx)
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
    const client = createWsSessionClient(httpsCtx)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(ws.url).toBe('wss://api.test/ws/session/s1?ticket=a%2Fb%2Bc')
  })

  it('transitions to connected on socket open (attempt reset)', async () => {
    mockTicket('s1')
    const client = createWsSessionClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(client.connectionState.getState().status).toBe('connecting')
    ws.open()
    expect(client.connectionState.getState()).toMatchObject({ status: 'connected', attempt: 0 })
  })

  it('seedLastSeen makes the next open send lastSeq', async () => {
    mockTicket('s1', 'tk')
    const client = createWsSessionClient(ctx)
    client.seedLastSeen(7)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(ws.url).toBe('ws://api.test/ws/session/s1?ticket=tk&lastSeq=7')
  })
})

describe('createWsSessionClient — frame I/O', () => {
  it('dispatches an inbound JSON frame to onFrame listeners (typed)', async () => {
    mockTicket('s1')
    const client = createWsSessionClient(ctx)
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
    const client = createWsSessionClient(ctx)
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
    const client = createWsSessionClient(ctx)
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
    const client = createWsSessionClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    const frame: ClientFrame = { type: 'player_message', text: 'hello' }
    expect(client.send(frame)).toBe(true)
    expect(ws.sent).toEqual([JSON.stringify(frame)])
  })

  it('returns false (no write) when the socket is still CONNECTING', async () => {
    mockTicket('s1')
    const client = createWsSessionClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING)
    expect(client.send({ type: 'player_message', text: 'x' })).toBe(false)
    expect(ws.sent).toEqual([])
  })

  it('returns false when the socket is CLOSING (server-initiated)', async () => {
    mockTicket('s1')
    const client = createWsSessionClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    ws.readyState = MockWebSocket.CLOSING
    expect(client.send({ type: 'player_message', text: 'x' })).toBe(false)
    expect(ws.sent).toEqual([])
  })

  it('returns false when there is no socket yet', () => {
    const client = createWsSessionClient(ctx)
    expect(client.send({ type: 'dm_invoke' })).toBe(false)
  })
})

describe('createWsSessionClient — drop + teardown', () => {
  it('__simulateDrop() closes the socket and transitions to reconnecting', async () => {
    mockTicket('s1')
    const client = createWsSessionClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    expect(client.connectionState.getState().status).toBe('connected')

    client.__simulateDrop()

    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    expect(client.connectionState.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 })
  })

  it('an unexpected socket close transitions to reconnecting', async () => {
    mockTicket('s1')
    const client = createWsSessionClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()
    ws.close(1006)
    expect(client.connectionState.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 })
  })

  it('close() marks closed; the socket close it triggers does NOT flip to reconnecting', async () => {
    mockTicket('s1')
    const client = createWsSessionClient(ctx)
    const ws = await connectAndAwaitSocket(client, 's1')
    ws.open()

    client.close()

    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    expect(client.connectionState.getState().status).toBe('closed')
  })
})
