import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ApiContext } from '../../api/endpoint.ts'
import { HttpError } from '../../api/errors.ts'
import type { ActiveSession } from '../../api/play-session.ts'
import { classifyStartError, useSessionStart, type SessionStartDeps } from '../start-flow.ts'

// start-flow (MYT-92 A7): the start-arm classifier + the `useSessionStart` async
// state machine over it. `classifyStartError` is pure — it maps a caught endpoint
// error to a discriminated `StartOutcome` keyed on the LIVE contract recorded in
// tmp/sdd/myt92-verify-notes.md (post-DEV-1 the backend truthfully emits
// `session_already_active` to a mid-session joiner; the 402 body is
// `{code:'insufficient_credits',available,required:1}`). The hook drives it: 200 →
// ready; join → /active lookup → ready (or blocked on the vanished-session race);
// prep/purchase/blocked/error → the matching phase. Every test injects the two
// endpoint fns through `deps` (no real transport), except the one default-wiring
// test that proves the `?? startSession` / `?? getActiveSession` production defaults.

const CID = 'campaign-123'
const ctx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

const httpError = (status: number, code?: string, body?: unknown): HttpError =>
  new HttpError(status, `HTTP ${String(status)}`, code, body)

const activeSession = (id: string): ActiveSession => ({
  id,
  status: 'active',
  sessionNumber: 1,
  startedAt: '2026-06-11T00:28:11.759Z',
  endedAt: null,
})

/** A start-flow deps object with both endpoints stubbed to a benign default; each
 *  test overrides the arm it exercises. */
function makeDeps(over: Partial<SessionStartDeps> = {}): SessionStartDeps {
  return {
    startSession: vi.fn().mockResolvedValue({ sessionId: 'sid' }),
    getActiveSession: vi.fn().mockResolvedValue({ session: null }),
    ...over,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const renderStart = (deps: SessionStartDeps, viewerIsOwner = true) =>
  renderHook(() => useSessionStart(ctx, { campaignId: CID, viewerIsOwner }, deps))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyStartError', () => {
  it('a non-HttpError (transport/other) → error', () => {
    expect(classifyStartError(new Error('boom'))).toEqual({ kind: 'error' })
  })

  it('409 session_already_active → join (the mid-session-join signal)', () => {
    expect(classifyStartError(httpError(409, 'session_already_active'))).toEqual({ kind: 'join' })
  })

  it('409 prep_not_ready → prep', () => {
    expect(classifyStartError(httpError(409, 'prep_not_ready'))).toEqual({ kind: 'prep' })
  })

  it('402 with a well-formed body → purchase carrying the body', () => {
    const body = { code: 'insufficient_credits', available: 0, required: 1 }
    expect(classifyStartError(httpError(402, 'insufficient_credits', body))).toEqual({
      kind: 'purchase',
      body,
    })
  })

  it('402 with a malformed body (missing numbers) → error — cannot build a purchase moment', () => {
    expect(classifyStartError(httpError(402, 'insufficient_credits', { code: 'x' }))).toEqual({
      kind: 'error',
    })
  })

  it.each(['campaign_not_active', 'reconcile_pending', 'session_ending'])(
    '409 %s → blocked carrying the code',
    (code) => {
      expect(classifyStartError(httpError(409, code))).toEqual({ kind: 'blocked', code })
    },
  )

  it('409 with no code (off-contract) → error', () => {
    expect(classifyStartError(httpError(409))).toEqual({ kind: 'error' })
  })

  it('a non-409/402 HttpError (e.g. 500) → error', () => {
    expect(classifyStartError(httpError(500, 'boom'))).toEqual({ kind: 'error' })
  })
})

describe('useSessionStart', () => {
  it('starts idle', () => {
    const { result } = renderStart(makeDeps())
    expect(result.current.state).toEqual({ phase: 'idle' })
  })

  it('200 → transitions idle → starting → ready with the sessionId', async () => {
    const deps = makeDeps({ startSession: vi.fn().mockResolvedValue({ sessionId: 'sid-200' }) })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    expect(result.current.state).toEqual({ phase: 'starting' })

    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'sid-200' })
    })
    expect(deps.startSession).toHaveBeenCalledWith({ campaignId: CID }, ctx)
  })

  it('409 session_already_active → looks up /active → ready with the active id', async () => {
    const getActive = vi.fn().mockResolvedValue({ session: activeSession('active-id') })
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(409, 'session_already_active')),
      getActiveSession: getActive,
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'active-id' })
    })
    expect(getActive).toHaveBeenCalledWith({ campaignId: CID }, ctx)
  })

  it('join race — /active comes back null → blocked (retryable)', async () => {
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(409, 'session_already_active')),
      getActiveSession: vi.fn().mockResolvedValue({ session: null }),
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'blocked', code: 'session_already_active' })
    })
  })

  it('join path — the /active lookup itself throws → error', async () => {
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(409, 'session_already_active')),
      getActiveSession: vi.fn().mockRejectedValue(new Error('down')),
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'error' })
    })
  })

  it('409 prep_not_ready → prep', async () => {
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(409, 'prep_not_ready')),
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'prep' })
    })
  })

  it('402 → purchase with the moment (available/required from the body, viewerIsOwner threaded)', async () => {
    const body = { code: 'insufficient_credits', available: 3, required: 1 }
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(402, 'insufficient_credits', body)),
    })
    const { result } = renderStart(deps, true)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({
        phase: 'purchase',
        moment: { available: 3, required: 1, viewerIsOwner: true },
      })
    })
  })

  it('402 for a non-owner → purchase moment carries viewerIsOwner:false', async () => {
    const body = { code: 'insufficient_credits', available: 0, required: 1 }
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(402, 'insufficient_credits', body)),
    })
    const { result } = renderStart(deps, false)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({
        phase: 'purchase',
        moment: { available: 0, required: 1, viewerIsOwner: false },
      })
    })
  })

  it('409 session_ending → blocked with the code', async () => {
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(409, 'session_ending')),
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'blocked', code: 'session_ending' })
    })
  })

  it('a network/other error → error', async () => {
    const deps = makeDeps({ startSession: vi.fn().mockRejectedValue(new Error('offline')) })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'error' })
    })
  })

  it('retry() is start() — a prep arm then a 200 retry reaches ready', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(httpError(409, 'prep_not_ready'))
      .mockResolvedValueOnce({ sessionId: 'sid-retry' })
    const { result } = renderStart(makeDeps({ startSession: start }))

    expect(result.current.retry).toBe(result.current.start)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'prep' })
    })

    act(() => {
      result.current.retry()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'sid-retry' })
    })
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('does not setState after unmount (mounted-ref guard)', async () => {
    const pending = deferred<{ sessionId: string }>()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { result, unmount } = renderStart(makeDeps({ startSession: () => pending.promise }))

    act(() => {
      result.current.start()
    })
    unmount()
    await act(async () => {
      pending.resolve({ sessionId: 'late' })
      await pending.promise
    })

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('defaults startSession/getActiveSession to the real endpoints when no deps are injected', async () => {
    // Prove the production `?? startSession` / `?? getActiveSession` wiring: with no
    // deps, the hook drives the REAL defineEndpoint calls. Stub the transport so a
    // 409 join then a populated /active resolves to `ready` — both defaults exercised.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        const url = String(input)
        if (url.endsWith('/start')) {
          return Promise.resolve(
            new Response(JSON.stringify({ code: 'session_already_active' }), {
              status: 409,
              headers: { 'content-type': 'application/json' },
            }),
          )
        }
        if (url.endsWith('/active')) {
          return Promise.resolve(
            new Response(JSON.stringify({ session: activeSession('wired-active') }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        }
        return Promise.reject(new Error(`unexpected fetch ${url}`))
      }),
    )

    const { result } = renderHook(() =>
      useSessionStart(ctx, { campaignId: CID, viewerIsOwner: true }),
    )

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'wired-active' })
    })
  })
})
