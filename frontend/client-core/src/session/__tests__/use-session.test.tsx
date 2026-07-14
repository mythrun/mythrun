import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import type { ClientFrame, ServerFrame } from '@mythrun/contract/events'
import type { ApiContext } from '../../api/endpoint.ts'
import type {
  ConnectionState,
  ConnectionStatus,
} from '../../realtime/connection.ts'
import type {
  WsSessionClient,
  WsSessionConnectOptions,
} from '../../realtime/ws-session-client.ts'
import { pm, reconnectFrame } from '../../realtime/ws-session-client.fixtures.ts'
import { configureTokenRefresh, resetTokenManager } from '../../auth/token-manager.ts'
import { emptyPresence, foldOutOfBand, useSession } from '../use-session.ts'

// useSession (MYT-92 A6): the play view-model over the shipped WS transport. It
// folds every inbound frame through the reconciling transcript reducer (Task 5),
// tracks the out-of-band control/presence state the reducer ignores (thinking /
// typing / ended), and owns the optimistic-send + reconnect confirm-or-resend
// wiring. Every test drives a hand-driven fake `WsSessionClient` through
// `deps.createClient` (mirroring use-session-prep's injected-transport seam) and
// the shipped frame builders from the ws-session-client fixtures — no real socket,
// no MSW.

const VIEWER = 'viewer-1'
const ctx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }
const params = { sessionId: 's1', viewerUserId: VIEWER, displayName: 'Dee', characterName: 'Cee' }

/** A hand-driven `WsSessionClient`: the test drives inbound frames via `emit`,
 *  connection transitions via `setStatus`, and reads `connectCalls` / `sent` /
 *  `closeCount`. `send` returns a configurable boolean (the transport returns
 *  `false` when the socket is not OPEN — the case the pending-resend path covers). */
function makeFakeTransport(opts: { sendResult?: boolean; honorUnsub?: boolean } = {}) {
  let sendResult = opts.sendResult ?? true
  const honorUnsub = opts.honorUnsub ?? true
  const frameCbs = new Set<(f: ServerFrame) => void>()
  const store = createStore<ConnectionState>(() => ({ status: 'connecting', attempt: 0 }))
  const connectCalls: { sessionId: string; opts: WsSessionConnectOptions | undefined }[] = []
  const sent: ClientFrame[] = []
  let closeCount = 0

  const client: WsSessionClient = {
    connect: (sessionId, connectOpts) => {
      connectCalls.push({ sessionId, opts: connectOpts })
    },
    onFrame: (cb) => {
      frameCbs.add(cb)
      return () => {
        if (honorUnsub) frameCbs.delete(cb)
      }
    },
    send: (frame) => {
      sent.push(frame)
      return sendResult
    },
    connectionState: store,
    close: () => {
      closeCount += 1
    },
    seedLastSeen: () => undefined,
    __simulateDrop: () => undefined,
  }

  return {
    client,
    connectCalls,
    sent,
    closeCount: () => closeCount,
    setSendResult: (v: boolean) => {
      sendResult = v
    },
    emit: (frame: ServerFrame) => {
      for (const cb of frameCbs) cb(frame)
    },
    setStatus: (status: ConnectionStatus, attempt = 0) => {
      store.setState({ status, attempt }, true)
    },
  }
}

/** A viewer-authored `player_message` echo (own-message reconcile input). */
function ownEcho(seq: number, text: string): Extract<ServerFrame, { type: 'player_message' }> {
  return { type: 'player_message', seq, userId: VIEWER, displayName: 'Dee', characterName: 'Cee', text }
}

const players = (items: readonly { kind: string }[]) => items.filter((i) => i.kind === 'player')

describe('useSession', () => {
  afterEach(() => {
    resetTokenManager()
  })

  it('connects on mount with seedLastSeq:0 (full-history replay)', () => {
    const t = makeFakeTransport()
    renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    expect(t.connectCalls).toEqual([{ sessionId: 's1', opts: { seedLastSeq: 0 } }])
  })

  it('renders a session_reconnect backlog through the reducer', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      t.emit(
        reconnectFrame([
          { type: 'dm_message', seq: 1, turnId: 'T', text: 'You enter the hall.' },
          pm(2, 'hi'),
        ]),
      )
    })
    expect(result.current.items.map((i) => i.kind)).toEqual(['dm', 'player'])
  })

  it('opens thinking on dm_thinking and clears it on the first text_delta', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      t.emit({ type: 'dm_thinking', turnId: 'T' })
    })
    expect(result.current.thinking).toBe(true)
    act(() => {
      t.emit({ type: 'text_delta', turnId: 'T', text: 'A cold wind…' })
    })
    expect(result.current.thinking).toBe(false)
  })

  it('clears thinking on turn_error', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      t.emit({ type: 'dm_thinking', turnId: 'T' })
    })
    act(() => {
      t.emit({ type: 'turn_error', turnId: 'T', message: 'boom' })
    })
    expect(result.current.thinking).toBe(false)
  })

  it('clears a stuck thinking indicator on reconnect', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      t.emit({ type: 'dm_thinking', turnId: 'T' })
    })
    expect(result.current.thinking).toBe(true)
    act(() => {
      t.setStatus('reconnecting', 1)
    })
    act(() => {
      t.setStatus('connected')
    })
    act(() => {
      t.emit(reconnectFrame([{ type: 'dm_message', seq: 1, turnId: 'T', text: 'done' }]))
    })
    expect(result.current.thinking).toBe(false)
  })

  it('tracks typing users from typing_start / typing_stop (dedup)', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      t.emit({ type: 'typing_start', userId: 'p2' })
    })
    expect(result.current.typingUserIds).toEqual(['p2'])
    act(() => {
      t.emit({ type: 'typing_start', userId: 'p2' })
    })
    expect(result.current.typingUserIds).toEqual(['p2'])
    act(() => {
      t.emit({ type: 'typing_stop', userId: 'p2' })
    })
    expect(result.current.typingUserIds).toEqual([])
  })

  it('optimistically adds an own message, sends it, and confirms on the echo', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      result.current.sendMessage('hi there')
    })
    const pending = players(result.current.items)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ pending: true, text: 'hi there' })
    expect(t.sent).toEqual([{ type: 'player_message', text: 'hi there' }])

    act(() => {
      t.emit(ownEcho(7, 'hi there'))
    })
    const confirmed = players(result.current.items)
    expect(confirmed).toHaveLength(1) // reconciled in place — not a duplicate
    expect(confirmed[0]).toMatchObject({ pending: false, seq: 7 })
  })

  it('summonDm optimistically adds and sends the token-bearing message', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      result.current.summonDm('@dm what now?')
    })
    expect(t.sent).toEqual([{ type: 'player_message', text: '@dm what now?' }])
    expect(players(result.current.items)[0]).toMatchObject({ pending: true, text: '@dm what now?' })
  })

  it('leaves a message pending when send fails and resends it after the replay batch settles', () => {
    const t = makeFakeTransport({ sendResult: false })
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      result.current.sendMessage('queued')
    })
    expect(t.sent).toHaveLength(1)
    expect(players(result.current.items)[0]).toMatchObject({ pending: true })

    act(() => {
      t.setStatus('reconnecting', 1)
    })
    act(() => {
      t.setStatus('connected')
    })
    // The 'connected' transition alone must NOT resend — the resend waits for the
    // replay batch so a message the replay confirms is not duplicated.
    expect(t.sent).toHaveLength(1)

    act(() => {
      t.emit(reconnectFrame([]))
    })
    expect(t.sent).toHaveLength(2)
    expect(t.sent[1]).toEqual({ type: 'player_message', text: 'queued' })
  })

  it('confirms a pending message from the reconnect replay instead of resending it', () => {
    const t = makeFakeTransport({ sendResult: false })
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      result.current.sendMessage('landed')
    })
    expect(t.sent).toHaveLength(1)

    act(() => {
      t.setStatus('reconnecting', 1)
    })
    act(() => {
      t.setStatus('connected')
    })
    act(() => {
      t.emit(reconnectFrame([ownEcho(3, 'landed')]))
    })
    const confirmed = players(result.current.items)
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]).toMatchObject({ pending: false, seq: 3 })
    expect(t.sent).toHaveLength(1) // the replay confirmed it — nothing resent
  })

  it('sets ended on session_end', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    expect(result.current.ended).toBe(false)
    act(() => {
      t.emit({ type: 'session_end', reason: 'normal' })
    })
    expect(result.current.ended).toBe(true)
  })

  it('endSession sends an end_session frame', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    act(() => {
      result.current.endSession()
    })
    expect(t.sent).toEqual([{ type: 'end_session' }])
  })

  it('exposes the live transport connection state', () => {
    const t = makeFakeTransport()
    const { result } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    expect(result.current.connection.status).toBe('connecting')
    act(() => {
      t.setStatus('connected')
    })
    expect(result.current.connection.status).toBe('connected')
  })

  it('closes the transport on unmount', () => {
    const t = makeFakeTransport()
    const { unmount } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))
    expect(t.closeCount()).toBe(0)
    unmount()
    expect(t.closeCount()).toBe(1)
  })

  it('drops a late frame from a leaky transport via the mounted-ref guard', () => {
    const t = makeFakeTransport({ honorUnsub: false })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderHook(() => useSession(ctx, params, { createClient: () => t.client }))

    unmount()
    // The leaky transport never removed our listener, so the callback still fires
    // after teardown — the case the hook's mountedRef guard absorbs. It must not
    // setState-after-unmount (React logs a console.error if it does).
    act(() => {
      t.emit({ type: 'session_end', reason: 'normal' })
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('defaults createClient to the real WS session client when no transport is injected', () => {
    // Park the connect coroutine on a never-settling token refresh so the REAL
    // createWsSessionClient default constructs + connect()s without a wiring throw
    // and without opening a socket — proving the production default wiring, not
    // just the injected seam.
    configureTokenRefresh(() => new Promise(() => undefined))
    const { result, unmount } = renderHook(() => useSession(ctx, params))
    expect(result.current.connection.status).toBe('connecting')
    expect(() => {
      unmount()
    }).not.toThrow()
  })
})

// The extracted out-of-band fold (the frame-fold the plan pins as a pure,
// directly-unit-tested helper). It owns the control/presence state the transcript
// reducer deliberately ignores.
describe('foldOutOfBand', () => {
  it('opens the thinking indicator on dm_thinking', () => {
    expect(foldOutOfBand(emptyPresence, { type: 'dm_thinking', turnId: 'T' })).toEqual({
      thinkingTurnId: 'T',
      typingUserIds: [],
      ended: false,
    })
  })

  it('clears the matching thinking turn on turn_end', () => {
    const open = { thinkingTurnId: 'T', typingUserIds: [], ended: false }
    expect(foldOutOfBand(open, { type: 'turn_end', turnId: 'T' }).thinkingTurnId).toBeNull()
  })

  it('leaves a non-matching turn signal untouched (referentially stable)', () => {
    const open = { thinkingTurnId: 'T', typingUserIds: [], ended: false }
    expect(foldOutOfBand(open, { type: 'text_delta', turnId: 'OTHER', text: 'x' })).toBe(open)
  })

  it('is a no-op for a turn signal with no open indicator', () => {
    expect(foldOutOfBand(emptyPresence, { type: 'text_delta', turnId: 'T', text: 'x' })).toBe(
      emptyPresence,
    )
  })

  it('dedups a repeated typing_start (referentially stable)', () => {
    const once = foldOutOfBand(emptyPresence, { type: 'typing_start', userId: 'p' })
    expect(once.typingUserIds).toEqual(['p'])
    expect(foldOutOfBand(once, { type: 'typing_start', userId: 'p' })).toBe(once)
  })

  it('removes a user on typing_stop', () => {
    const typing = { thinkingTurnId: null, typingUserIds: ['p'], ended: false }
    expect(foldOutOfBand(typing, { type: 'typing_stop', userId: 'p' }).typingUserIds).toEqual([])
  })

  it('sets ended on session_end', () => {
    expect(foldOutOfBand(emptyPresence, { type: 'session_end', reason: 'normal' }).ended).toBe(true)
  })

  it('resets a stuck indicator on session_reconnect', () => {
    const open = { thinkingTurnId: 'T', typingUserIds: [], ended: false }
    expect(foldOutOfBand(open, reconnectFrame([])).thinkingTurnId).toBeNull()
  })

  it('is a no-op for session_reconnect with no open indicator', () => {
    expect(foldOutOfBand(emptyPresence, reconnectFrame([]))).toBe(emptyPresence)
  })

  it('ignores an unrelated presence frame (player_joined)', () => {
    expect(
      foldOutOfBand(emptyPresence, {
        type: 'player_joined',
        userId: 'p',
        displayName: 'D',
        characterName: 'C',
      }),
    ).toBe(emptyPresence)
  })
})
