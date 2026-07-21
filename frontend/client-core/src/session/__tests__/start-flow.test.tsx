import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ApiContext } from '../../api/endpoint.ts'
import { HttpError } from '../../api/errors.ts'
import type { ActiveSession } from '../../api/play-session.ts'
import {
  backoffDelay,
  classifyStartError,
  DEFAULT_BACKOFF,
  useSessionStart,
  type SessionStartDeps,
} from '../start-flow.ts'

// start-flow (MYT-92 A7; storm fix myth-ep74g): the start-arm classifier + the
// `useSessionStart` async state machine over it. `classifyStartError` is pure — it
// maps a caught endpoint error to a discriminated `StartOutcome`. The hook drives it:
// a manual/initial attempt PROBES `/active` first (join a running session with no
// 409), else `POST /start`; 200 → ready; join → /active lookup → ready; the transient
// between-sessions codes (prep_not_ready / reconcile_pending / session_ending) →
// `waiting`, from which the hook BACKOFF-POLLS `/start` (no burst, no 429);
// purchase/blocked/error → the matching phase.

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

/** A start-flow deps object with both endpoints stubbed to a benign default (no
 *  running session → the probe falls through; `/start` succeeds); each test
 *  overrides the arm it exercises. `rng: () => 0` pins the backoff jitter to 0 so a
 *  waiting-poll test sees exact spacing. */
function makeDeps(over: Partial<SessionStartDeps> = {}): SessionStartDeps {
  return {
    startSession: vi.fn().mockResolvedValue({ sessionId: 'sid' }),
    getActiveSession: vi.fn().mockResolvedValue({ session: null }),
    rng: () => 0,
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
  if (vi.isFakeTimers()) vi.useRealTimers()
})

describe('classifyStartError', () => {
  it('a non-HttpError (transport/other) → error', () => {
    expect(classifyStartError(new Error('boom'))).toEqual({ kind: 'error' })
  })

  it('409 session_already_active → join (the mid-session-join signal)', () => {
    expect(classifyStartError(httpError(409, 'session_already_active'))).toEqual({ kind: 'join' })
  })

  it.each(['prep_not_ready', 'reconcile_pending', 'session_ending'])(
    '409 %s → wait carrying the code (the calm between-sessions poll)',
    (code) => {
      expect(classifyStartError(httpError(409, code))).toEqual({ kind: 'wait', code })
    },
  )

  it('409 members_without_characters with a well-formed body → blocked carrying the display names', () => {
    const body = {
      members: [
        { userId: 'u1', displayName: 'Kessa' },
        { userId: 'u2', displayName: 'Bram' },
      ],
    }
    expect(classifyStartError(httpError(409, 'members_without_characters', body))).toEqual({
      kind: 'blocked',
      code: 'members_without_characters',
      memberNames: ['Kessa', 'Bram'],
    })
  })

  it('409 members_without_characters with a malformed body → bare blocked (degrades, never crashes)', () => {
    expect(classifyStartError(httpError(409, 'members_without_characters', { nope: 1 }))).toEqual({
      kind: 'blocked',
      code: 'members_without_characters',
    })
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

  it('409 campaign_not_active → blocked (NOT transient — a manual retry, not a poll)', () => {
    expect(classifyStartError(httpError(409, 'campaign_not_active'))).toEqual({
      kind: 'blocked',
      code: 'campaign_not_active',
    })
  })

  it('409 with an off-contract code → blocked carrying the code', () => {
    expect(classifyStartError(httpError(409, 'something_new'))).toEqual({ kind: 'blocked', code: 'something_new' })
  })

  it('409 with no code (off-contract) → error', () => {
    expect(classifyStartError(httpError(409))).toEqual({ kind: 'error' })
  })

  it('a non-409/402 HttpError (e.g. 500) → error', () => {
    expect(classifyStartError(httpError(500, 'boom'))).toEqual({ kind: 'error' })
  })
})

describe('backoffDelay', () => {
  it('grows exponentially from base and caps, with rng=0 giving no jitter', () => {
    const rng = () => 0
    expect(backoffDelay(0, DEFAULT_BACKOFF, rng)).toBe(2000)
    expect(backoffDelay(1, DEFAULT_BACKOFF, rng)).toBe(4000)
    expect(backoffDelay(2, DEFAULT_BACKOFF, rng)).toBe(8000)
    expect(backoffDelay(3, DEFAULT_BACKOFF, rng)).toBe(12000) // capped (2000*2^3=16000 → 12000)
    expect(backoffDelay(9, DEFAULT_BACKOFF, rng)).toBe(12000) // stays capped
  })

  it('adds jitter within [0, jitterMs) on top of the (capped) base', () => {
    const near1 = () => 0.999
    // At the cap (12000) + ~2000 jitter → ~13998, still within the "10–15s" band.
    expect(backoffDelay(3, DEFAULT_BACKOFF, near1)).toBeGreaterThanOrEqual(12000)
    expect(backoffDelay(3, DEFAULT_BACKOFF, near1)).toBeLessThan(14000)
    // Base tier stays in the 2–4s band.
    expect(backoffDelay(0, DEFAULT_BACKOFF, near1)).toBeGreaterThanOrEqual(2000)
    expect(backoffDelay(0, DEFAULT_BACKOFF, near1)).toBeLessThan(4000)
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

  it('an already-running session is JOINED via the /active probe — no POST /start, no 409 (myth-ep74g)', async () => {
    const getActive = vi.fn().mockResolvedValue({ session: activeSession('running-id') })
    const start = vi.fn().mockResolvedValue({ sessionId: 'unused' })
    const { result } = renderStart(makeDeps({ startSession: start, getActiveSession: getActive }))

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'running-id' })
    })
    // The join path never issues the 409-provoking POST — the whole point of the fix.
    expect(getActive).toHaveBeenCalledWith({ campaignId: CID }, ctx)
    expect(start).not.toHaveBeenCalled()
  })

  it('the probe is best-effort — a /active failure falls through to POST /start', async () => {
    const getActive = vi.fn().mockRejectedValue(new Error('active down'))
    const start = vi.fn().mockResolvedValue({ sessionId: 'sid-fallthrough' })
    const { result } = renderStart(makeDeps({ startSession: start, getActiveSession: getActive }))

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'sid-fallthrough' })
    })
    expect(start).toHaveBeenCalledWith({ campaignId: CID }, ctx)
  })

  it('race: probe finds nothing, POST answers session_already_active → /active join → ready', async () => {
    // The probe runs before any active row exists; a session appears between probe
    // and POST, so POST 409s and the join lookup resolves it.
    const getActive = vi
      .fn()
      .mockResolvedValueOnce({ session: null }) // probe: nothing yet
      .mockResolvedValueOnce({ session: activeSession('raced-id') }) // join lookup
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(409, 'session_already_active')),
      getActiveSession: getActive,
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'raced-id' })
    })
    expect(getActive).toHaveBeenCalledTimes(2)
  })

  it('join race — the /active join lookup comes back null → blocked (retryable)', async () => {
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

  it('join race — the /active join lookup itself THROWS → error (never an unhandled rejection)', async () => {
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(409, 'session_already_active')),
      getActiveSession: vi
        .fn()
        .mockResolvedValueOnce({ session: null }) // probe: nothing
        .mockRejectedValueOnce(new Error('network tear mid-join')), // join lookup dies
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'error' })
    })
  })

  it('members_without_characters 409 → blocked phase CARRIES the names to the surface', async () => {
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(
        httpError(409, 'members_without_characters', {
          members: [{ userId: 'u9', displayName: 'Perrin' }],
        }),
      ),
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({
        phase: 'blocked',
        code: 'members_without_characters',
        memberNames: ['Perrin'],
      })
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

  it('409 campaign_not_active → blocked with the code (a manual retry, not an auto-poll)', async () => {
    const deps = makeDeps({
      startSession: vi.fn().mockRejectedValue(httpError(409, 'campaign_not_active')),
    })
    const { result } = renderStart(deps)

    act(() => {
      result.current.start()
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'blocked', code: 'campaign_not_active' })
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

  it('retry() is start() — a waiting arm then a 200 retry reaches ready', async () => {
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
      expect(result.current.state).toEqual({ phase: 'waiting', code: 'prep_not_ready' })
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
    // deps, the hook drives the REAL defineEndpoint calls. Stub the transport so the
    // /active probe finds a running session — resolving to `ready` without any POST.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        const url = String(input)
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

describe('useSessionStart — the waiting backoff poll (myth-ep74g storm fix)', () => {
  it('prep_not_ready enters waiting and BACKOFF-POLLS /start — spacing grows 2s→4s→8s→cap, no burst', async () => {
    vi.useFakeTimers()
    // /start always answers prep_not_ready; /active always empty (the between-sessions
    // window). rng=0 → deterministic spacing.
    const start = vi.fn().mockRejectedValue(httpError(409, 'prep_not_ready'))
    const getActive = vi.fn().mockResolvedValue({ session: null })
    const { result } = renderStart(makeDeps({ startSession: start, getActiveSession: getActive, rng: () => 0 }))

    // First attempt (probe + POST) → waiting.
    await act(async () => {
      result.current.start()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.state).toEqual({ phase: 'waiting', code: 'prep_not_ready' })
    expect(start).toHaveBeenCalledTimes(1)
    // The probe ran exactly once (the initial attempt); polls do NOT re-probe /active.
    expect(getActive).toHaveBeenCalledTimes(1)

    // NO poll before the first 2s backoff elapses — the anti-storm invariant.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999)
    })
    expect(start).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    }) // t=2000 → poll #1
    expect(start).toHaveBeenCalledTimes(2)

    // Next gap DOUBLES to 4s (no early fire at 2s again).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999)
    })
    expect(start).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    }) // t=6000 → poll #2
    expect(start).toHaveBeenCalledTimes(3)

    // Then 8s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000)
    }) // t=14000 → poll #3
    expect(start).toHaveBeenCalledTimes(4)

    // Capped at 12s thereafter (never faster).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11999)
    })
    expect(start).toHaveBeenCalledTimes(4)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    }) // t=26000 → poll #4
    expect(start).toHaveBeenCalledTimes(5)

    // Still waiting throughout — no phase thrash, and never a 429-provoking burst.
    expect(result.current.state).toEqual({ phase: 'waiting', code: 'prep_not_ready' })
  })

  it('a waiting poll that finally succeeds → ready (prep completed)', async () => {
    vi.useFakeTimers()
    const start = vi
      .fn()
      .mockRejectedValueOnce(httpError(409, 'prep_not_ready')) // first attempt
      .mockResolvedValueOnce({ sessionId: 'sid-ready' }) // the 2s poll succeeds
    const { result } = renderStart(makeDeps({ startSession: start, rng: () => 0 }))

    await act(async () => {
      result.current.start()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.state).toEqual({ phase: 'waiting', code: 'prep_not_ready' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'sid-ready' })
  })

  it('a manual retry during waiting cancels the scheduled poll (no double-fire)', async () => {
    vi.useFakeTimers()
    const start = vi
      .fn()
      .mockRejectedValueOnce(httpError(409, 'prep_not_ready')) // attempt 1 → waiting
      .mockResolvedValueOnce({ sessionId: 'sid-manual' }) // the manual retry
      .mockRejectedValue(httpError(409, 'prep_not_ready')) // any stray poll (should not happen)
    const { result } = renderStart(makeDeps({ startSession: start, rng: () => 0 }))

    await act(async () => {
      result.current.start()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.state).toEqual({ phase: 'waiting', code: 'prep_not_ready' })

    // Retry before the 2s poll fires → resets the schedule and reaches ready.
    await act(async () => {
      result.current.retry()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'sid-manual' })

    // The originally-scheduled 2s poll must NOT fire now (its generation is stale).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(start).toHaveBeenCalledTimes(2) // attempt 1 + the manual retry only
    expect(result.current.state).toEqual({ phase: 'ready', sessionId: 'sid-manual' })
  })
})
