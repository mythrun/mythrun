import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import type { RouteObject } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { ApiClientProvider, type ApiContext } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'

// The DEV-lazy `/dev/transport` transport harness (MYT-85 T9). Two concerns in
// one file:
//
//   1. ROUTER REGISTRATION — the harness route is gated on `import.meta.env.DEV`.
//      `buildRoutes(false)` (a prod build's route tree) must OMIT it; the route
//      array gating + the `React.lazy(() => import(...))` static-DEV guard are
//      what tree-shake the chunk out of the prod bundle. `buildRoutes(true)` and
//      the shipped `routes` (tests run under DEV) must include it.
//
//   2. HARNESS WIRING — the harness composes @mythrun/ui + i18n (no raw strings,
//      no ad-hoc UI — the lint rails prove that) and wires its controls to the
//      real barrel clients: connect/send/__simulateDrop drive the WS client;
//      inbound `onFrame` rows render in the log; the SSE section opens a path and
//      renders `onEvent` rows. The client FACTORIES are mocked to deterministic
//      stubs (the actual reconnect-replay / seq state machine is exhaustively
//      covered by the connection + ws-session-client tests, and end-to-end by the
//      staging smoke); this asserts the harness WIRING + RENDER, not the protocol.

// Hoisted stubs the module mock factory closes over (vi.hoisted runs before the
// `@mythrun/client-core` mock factory). `emitFrame`/`emitEvent` replay the
// callbacks the harness registers via `onFrame`/`onEvent`, so the test can push
// an inbound row through the real subscription wiring.
const stubs = vi.hoisted(() => {
  let frameCb: ((frame: unknown) => void) | undefined
  let eventCb: ((event: unknown) => void) | undefined
  const ws = {
    connect: vi.fn(),
    onFrame: vi.fn((cb: (frame: unknown) => void) => {
      frameCb = cb
      return vi.fn()
    }),
    send: vi.fn(() => true),
    close: vi.fn(),
    seedLastSeen: vi.fn(),
    __simulateDrop: vi.fn(),
    connectionState: { __kind: 'ws' },
  }
  const sse = {
    open: vi.fn(),
    onEvent: vi.fn((cb: (event: unknown) => void) => {
      eventCb = cb
      return vi.fn()
    }),
    onSnapshot: vi.fn(() => vi.fn()),
    close: vi.fn(),
    connectionState: { __kind: 'sse' },
  }
  return {
    ws,
    sse,
    emitFrame: (frame: unknown): void => frameCb?.(frame),
    emitEvent: (event: unknown): void => eventCb?.(event),
    reset(): void {
      for (const fn of [ws.connect, ws.send, ws.close, ws.seedLastSeen, ws.__simulateDrop, sse.open, sse.close]) {
        fn.mockClear()
      }
    },
  }
})

vi.mock('@mythrun/client-core', async (importActual) => {
  const actual = await importActual<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    createWsSessionClient: vi.fn(() => stubs.ws),
    createSseStatusClient: vi.fn(() => stubs.sse),
    // Identity-routed so the WS readout and the SSE readout report distinct
    // states (the harness passes each client to useConnectionState).
    useConnectionState: vi.fn((client: unknown) =>
      client === stubs.ws
        ? { status: 'reconnecting', attempt: 2 }
        : { status: 'connected', attempt: 0 },
    ),
  }
})

// Imported AFTER the mock factory so they bind the mocked barrel (vitest hoists
// vi.mock above the imports regardless of source order).
import { DevTransportRoute } from './dev-transport.tsx'
import { buildRoutes, routes } from '../app/router.tsx'

// ENVIRONMENT shim (Node vs jsdom localStorage) — ThemeProvider reads localStorage
// on mount; mirrors the home.test / router.test precedent in this package.
class MemStorage {
  private readonly store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  get length(): number {
    return this.store.size
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  cleanup()
  stubs.reset()
})

/** Does the route tree contain a route with this exact `path` anywhere in it? */
function hasPath(tree: readonly RouteObject[], path: string): boolean {
  return tree.some((route) => route.path === path || (route.children ? hasPath(route.children, path) : false))
}

const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

function renderHarness(): void {
  render(
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <DevTransportRoute />
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>,
  )
}

describe('dev-transport route registration (DEV-lazy)', () => {
  it('OMITS /dev/transport from a prod-config route tree', () => {
    expect(hasPath(buildRoutes(false), 'dev/transport')).toBe(false)
  })

  it('INCLUDES /dev/transport in a DEV route tree (and the shipped routes, since tests run under DEV)', () => {
    expect(import.meta.env.DEV).toBe(true)
    expect(hasPath(buildRoutes(true), 'dev/transport')).toBe(true)
    expect(hasPath(routes, 'dev/transport')).toBe(true)
  })
})

describe('dev-transport harness wiring', () => {
  it('wires connect / send / __simulateDrop to the WS client and renders the connection readout', () => {
    renderHarness()

    fireEvent.change(screen.getByTestId('ws-session-input'), { target: { value: 's-1' } })
    fireEvent.click(screen.getByTestId('ws-connect'))
    expect(stubs.ws.connect).toHaveBeenCalledWith('s-1')

    fireEvent.change(screen.getByTestId('ws-message-input'), { target: { value: 'well met' } })
    fireEvent.click(screen.getByTestId('ws-send'))
    expect(stubs.ws.send).toHaveBeenCalledWith({ type: 'player_message', text: 'well met' })

    fireEvent.click(screen.getByTestId('ws-drop'))
    expect(stubs.ws.__simulateDrop).toHaveBeenCalledTimes(1)

    // The useConnectionState readout reflects the (mocked) WS state.
    expect(screen.getByTestId('ws-status').textContent).toContain('reconnecting')
    expect(screen.getByTestId('ws-attempt').textContent).toContain('2')
  })

  it('renders inbound WS frames pushed through the onFrame subscription', () => {
    renderHarness()
    expect(screen.getByTestId('ws-frames-empty')).toBeDefined()

    act(() => {
      stubs.emitFrame({ type: 'player_message', seq: 5, text: 'hello' })
    })

    const log = screen.getByTestId('ws-frames')
    expect(log.textContent).toContain('player_message')
    expect(screen.queryByTestId('ws-frames-empty')).toBeNull()
  })

  it('opens the SSE stream and renders inbound events', () => {
    renderHarness()

    fireEvent.change(screen.getByTestId('sse-path-input'), {
      target: { value: '/api/campaigns/c1/status/stream' },
    })
    fireEvent.click(screen.getByTestId('sse-open'))
    expect(stubs.sse.open).toHaveBeenCalledWith('/api/campaigns/c1/status/stream')

    act(() => {
      stubs.emitEvent({ type: 'world_status', status: 'generating' })
    })
    expect(screen.getByTestId('sse-events').textContent).toContain('world_status')
  })
})
