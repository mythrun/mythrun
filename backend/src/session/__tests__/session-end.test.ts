// MYT-74b T11 — `endSession` + `finalizeEndedSession` orchestration unit suite.
//
// The session-end lifecycle is now SPLIT into a begin + a complete phase so the
// live farewell send-off precedes the `session_end` frame:
//
//   - `endSession` BEGINS the end. It claims the once-only `ending` flag
//     (SET-NX), cancels the pending all-disconnected suspend, reads the responded
//     watermark, and enqueues ONE player-less FAREWELL turn (jobId per-session).
//     It does NOT flip the row / enqueue reconcile / broadcast — those run AFTER
//     the farewell renders. A second call (flag already set) is a no-op (no second
//     farewell). Reusable by the explicit `end_session` WS frame and T12's budget
//     auto-end — so the load-bearing property is IDEMPOTENCE.
//   - `finalizeEndedSession` COMPLETES the end (run by the turn worker after the
//     farewell render, and by the QueueEvents backstop). It conditionally flips
//     the row to 'ended' (markEnded → rowCount, broadcast exactly once), then
//     enqueues reconcile + analysis (both jobId-deduped → safe to re-enqueue).
//
// Every dependency is injected — the whole flow is unit-testable with recording
// fakes (no broker/Redis/PG/LLM). The fakes ARE the queue objects: the thin
// `enqueueFarewellTurn`/`enqueueReconcile`/`enqueuePostSessionAnalysis` wrappers
// call `queue.add(name, payload, opts)`, so a recording `add` captures everything.

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  bindFinalizeLogger,
  endSession,
  finalizeEndedSession,
  type EndSessionDeps,
  type FinalizeEndedSessionDeps,
  type EndSessionArgs,
} from '../session-end.js'
import { suspendJobId } from '../session-suspend.js'
import { FAREWELL_DIRECTION } from '../turn-queue.js'

const CAMPAIGN = 'c-end-1'
const SESSION = 's-end-1'
const WORLD = 'w-end-1'
const WATERMARK = 42

const ARGS: EndSessionArgs = { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD }

// ── endSession fakes ──────────────────────────────────────────────────────────

/** A recording ending-flag: `tryMarkEnding` returns true the FIRST time, false
 *  thereafter (the SET-NX idempotency the real session-state key provides). */
function makeFakeEndingFlag(): {
  sessionState: EndSessionDeps['sessionState']
  tryMarkEnding: ReturnType<typeof vi.fn>
} {
  let marked = false
  const tryMarkEnding = vi.fn(() => {
    if (marked) return Promise.resolve(false)
    marked = true
    return Promise.resolve(true)
  })
  return {
    sessionState: { tryMarkEnding },
    tryMarkEnding,
  }
}

/** A recording suspend queue: records each `remove(jobId)`. */
function makeFakeSuspendQueue(): {
  suspendQueue: EndSessionDeps['suspendQueue']
  removes: string[]
} {
  const removes: string[] = []
  const remove = ((jobId: string) => {
    removes.push(jobId)
    return Promise.resolve(undefined)
  }) as unknown as EndSessionDeps['suspendQueue']['remove']
  return {
    suspendQueue: { add: vi.fn(), getJob: vi.fn(), remove },
    removes,
  }
}

/** A recording turn queue: records each `add(name, payload, opts)` — the
 *  farewell-turn enqueue surface. */
function makeFakeTurnQueue(): {
  turnQueue: EndSessionDeps['turnQueue']
  adds: { name: string; payload: Record<string, unknown>; opts: { jobId?: string } }[]
} {
  const adds: { name: string; payload: Record<string, unknown>; opts: { jobId?: string } }[] = []
  const add = ((name: string, payload: Record<string, unknown>, opts: { jobId?: string }) => {
    adds.push({ name, payload, opts })
    return Promise.resolve(undefined)
  }) as unknown as EndSessionDeps['turnQueue']['add']
  return { turnQueue: { add }, adds }
}

function makeLogger(): EndSessionDeps['logger'] {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

interface EndHarness {
  deps: EndSessionDeps
  tryMarkEnding: ReturnType<typeof vi.fn>
  suspendRemoves: string[]
  turnAdds: { name: string; payload: Record<string, unknown>; opts: { jobId?: string } }[]
}

function makeEndHarness(): EndHarness {
  const { sessionState, tryMarkEnding } = makeFakeEndingFlag()
  const { suspendQueue, removes: suspendRemoves } = makeFakeSuspendQueue()
  const { turnQueue, adds: turnAdds } = makeFakeTurnQueue()
  const respondedSeq = vi.fn(() => Promise.resolve(WATERMARK))

  const deps: EndSessionDeps = {
    sessionState,
    suspendQueue,
    turnQueue,
    respondedSeq,
    logger: makeLogger(),
  }
  return { deps, tryMarkEnding, suspendRemoves, turnAdds }
}

// ── finalizeEndedSession fakes ────────────────────────────────────────────────

/** A recording reconcile queue: records each `add(name, payload, opts)`. */
function makeFakeReconcileQueue(): {
  reconcileQueue: FinalizeEndedSessionDeps['reconcileQueue']
  adds: { name: string; payload: unknown; opts: { jobId?: string } }[]
} {
  const adds: { name: string; payload: unknown; opts: { jobId?: string } }[] = []
  const add = ((name: string, payload: unknown, opts: { jobId?: string }) => {
    adds.push({ name, payload, opts })
    return Promise.resolve(undefined)
  }) as unknown as FinalizeEndedSessionDeps['reconcileQueue']['add']
  return { reconcileQueue: { add }, adds }
}

/** A recording analysis queue: records each `add(name, payload, opts)`. */
function makeFakeAnalysisQueue(): {
  analysisQueue: FinalizeEndedSessionDeps['analysisQueue']
  adds: { name: string; payload: unknown; opts: { jobId?: string } }[]
} {
  const adds: { name: string; payload: unknown; opts: { jobId?: string } }[] = []
  const add = ((name: string, payload: unknown, opts: { jobId?: string }) => {
    adds.push({ name, payload, opts })
    return Promise.resolve(undefined)
  }) as unknown as FinalizeEndedSessionDeps['analysisQueue']['add']
  return { analysisQueue: { add }, adds }
}

/** A recording publish: records each `(campaignId, frame)`. */
function makeFakePublish(): {
  publish: FinalizeEndedSessionDeps['publish']
  publishes: { campaignId: string; frame: { type?: string; reason?: string } }[]
} {
  const publishes: { campaignId: string; frame: { type?: string; reason?: string } }[] = []
  const publish = vi.fn((campaignId: string, frame: { type?: string; reason?: string }) => {
    publishes.push({ campaignId, frame })
    return Promise.resolve()
  }) as unknown as FinalizeEndedSessionDeps['publish']
  return { publish, publishes }
}

interface FinalizeHarness {
  deps: FinalizeEndedSessionDeps
  markEnded: ReturnType<typeof vi.fn>
  clearEnding: ReturnType<typeof vi.fn>
  reconcileAdds: { name: string; payload: unknown; opts: { jobId?: string } }[]
  analysisAdds: { name: string; payload: unknown; opts: { jobId?: string } }[]
  publishes: { campaignId: string; frame: { type?: string; reason?: string } }[]
}

function makeFinalizeHarness(markEndedRows: number): FinalizeHarness {
  const markEnded = vi.fn(() => Promise.resolve(markEndedRows))
  const { reconcileQueue, adds: reconcileAdds } = makeFakeReconcileQueue()
  const { analysisQueue, adds: analysisAdds } = makeFakeAnalysisQueue()
  const { publish, publishes } = makeFakePublish()

  const clearEnding = vi.fn(() => Promise.resolve())
  const deps: FinalizeEndedSessionDeps = {
    sessions: { markEnded },
    reconcileQueue,
    analysisQueue,
    publish,
    clearEnding,
    logger: makeLogger(),
  }
  return { deps, markEnded, clearEnding, reconcileAdds, analysisAdds, publishes }
}

describe('endSession (begin)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('on a fresh session: marks ending, cancels suspend, reads the watermark, and enqueues ONE farewell turn — no flip / reconcile / broadcast', async () => {
    const h = makeEndHarness()
    await endSession(h.deps, ARGS)

    // (a) ending flag claimed.
    expect(h.tryMarkEnding).toHaveBeenCalledWith(CAMPAIGN)

    // (b) the pending suspend is cancelled (by the stable per-session jobId).
    expect(h.suspendRemoves).toEqual([suspendJobId(SESSION)])

    // (c) exactly ONE farewell turn, jobId = farewell-${sessionId}.
    expect(h.turnAdds).toHaveLength(1)
    const enq = h.turnAdds[0]
    expect(enq?.opts.jobId).toBe(`farewell-${SESSION}`)

    // The payload is a player-less farewell carrying the watermark + worldId.
    expect(enq?.payload.trigger).toEqual({ kind: 'farewell' })
    expect(enq?.payload.triggerMessages).toEqual([])
    expect(enq?.payload.maxConsumedSeq).toBe(WATERMARK)
    expect(enq?.payload.farewellText).toBe(FAREWELL_DIRECTION)
    expect(enq?.payload.worldId).toBe(WORLD)
    // A turnId was allocated (UUID string).
    expect(typeof enq?.payload.turnId).toBe('string')
  })

  it('does NOT finalize: endSession alone never flips the row / enqueues reconcile / broadcasts', async () => {
    // endSession deps don't even expose a flip/reconcile/publish surface — proving
    // begin and complete are distinct phases. We assert via the absence of a
    // second enqueue: only the farewell turn lands.
    const h = makeEndHarness()
    await endSession(h.deps, ARGS)
    expect(h.turnAdds).toHaveLength(1)
    expect(h.turnAdds[0]?.payload.trigger).toEqual({ kind: 'farewell' })
  })

  it('is IDEMPOTENT: a second endSession (ending flag already set) is a no-op — no second farewell, no second suspend cancel', async () => {
    const h = makeEndHarness()
    await endSession(h.deps, ARGS)
    await endSession(h.deps, ARGS)

    // tryMarkEnding called twice; the SECOND returns false and short-circuits.
    expect(h.tryMarkEnding).toHaveBeenCalledTimes(2)
    // Only ONE farewell turn enqueued.
    expect(h.turnAdds).toHaveLength(1)
    // The second call didn't cancel the suspend again.
    expect(h.suspendRemoves).toEqual([suspendJobId(SESSION)])
  })
})

describe('finalizeEndedSession (complete)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('markEnded → 1 (the winning flip): enqueues reconcile + analysis AND broadcasts session_end', async () => {
    const h = makeFinalizeHarness(1)
    await finalizeEndedSession(h.deps, ARGS)

    expect(h.markEnded).toHaveBeenCalledWith(SESSION)

    // ONE reconcile job, jobId per-session, carrying {campaignId, sessionId, worldId}.
    expect(h.reconcileAdds).toHaveLength(1)
    expect(h.reconcileAdds[0]?.opts.jobId).toBe(`reconcile-${SESSION}`)
    expect(h.reconcileAdds[0]?.payload).toEqual({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: WORLD,
    })

    // ONE analysis job, jobId per-session, carrying {campaignId, sessionId}.
    expect(h.analysisAdds).toHaveLength(1)
    expect(h.analysisAdds[0]?.opts.jobId).toBe(`analysis-${SESSION}`)
    expect(h.analysisAdds[0]?.payload).toEqual({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
    })

    // The session_end broadcast went out exactly once with reason 'normal'.
    expect(h.publishes).toHaveLength(1)
    expect(h.publishes[0]?.campaignId).toBe(CAMPAIGN)
    expect(h.publishes[0]?.frame.type).toBe('session_end')
    expect(h.publishes[0]?.frame.reason).toBe('normal')

    // myth-x4ca4: the winning finalize releases the `:ending` fence — without
    // this the 1h TTL blocked the campaign's next /start after every clean end.
    expect(h.clearEnding).toHaveBeenCalledWith(CAMPAIGN)
  })

  it('markEnded → 0 (a prior finalize already flipped): STILL enqueues reconcile + analysis but does NOT broadcast', async () => {
    const h = makeFinalizeHarness(0)
    await finalizeEndedSession(h.deps, ARGS)

    // reconcile + analysis are jobId-deduped → safe to re-enqueue.
    expect(h.reconcileAdds).toHaveLength(1)
    expect(h.reconcileAdds[0]?.payload).toEqual({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: WORLD,
    })
    expect(h.analysisAdds).toHaveLength(1)
    expect(h.analysisAdds[0]?.payload).toEqual({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
    })

    // But the broadcast did NOT fire (the flip lost → another finalize already
    // broadcast).
    expect(h.publishes).toHaveLength(0)

    // myth-x4ca4: the noop arm STILL releases the fence (idempotent DEL — a
    // backstop finalize must clear a fence its crashed winner never released).
    expect(h.clearEnding).toHaveBeenCalledWith(CAMPAIGN)
  })
})

// ── bindFinalizeLogger (myth: the MYT-92 E2E's finalize-crash) ──────────────
// Pino methods read instance internals via `this`; a detached pluck throws
// `this[writeSym] is not a function`. The fake below reproduces that failure
// shape: its methods touch a private field, so a detached call throws exactly
// like pino's. The adapter must deliver on the INSTANCE.
describe('bindFinalizeLogger', () => {
  class BindingSensitiveLogger {
    #lines: string[] = []
    info(o: Record<string, unknown> | string, m?: string): void {
      this.#lines.push(`info:${typeof o === 'string' ? o : (m ?? '')}`)
    }
    warn(o: Record<string, unknown> | string, m?: string): void {
      this.#lines.push(`warn:${typeof o === 'string' ? o : (m ?? '')}`)
    }
    error(o: Record<string, unknown> | string, m?: string): void {
      this.#lines.push(`error:${typeof o === 'string' ? o : (m ?? '')}`)
    }
    get lines(): readonly string[] {
      return this.#lines
    }
  }

  it('the detached-pluck shape throws with a pino-like logger (the bug being pinned)', () => {
    const pinoLike = new BindingSensitiveLogger()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- DELIBERATE: this pluck IS the bug shape being pinned (the production interface's property-function style exempts it from this rule, which is why the original slipped through)
    const detached = { info: pinoLike.info, warn: pinoLike.warn, error: pinoLike.error }
    expect(() => {
      detached.info({}, 'session_finalized')
    }).toThrow(TypeError)
  })

  it('delivers info/warn/error on the source instance', () => {
    const pinoLike = new BindingSensitiveLogger()
    const bound = bindFinalizeLogger(pinoLike)
    bound.info({}, 'session_finalized')
    bound.warn({}, 'w')
    bound.error({}, 'e')
    expect(pinoLike.lines).toEqual(['info:session_finalized', 'warn:w', 'error:e'])
  })

  it('falls back to warn (on the instance) when the source has no info', () => {
    const pinoLike = new BindingSensitiveLogger()
    const bound = bindFinalizeLogger({
      warn: (o, m) => {
        pinoLike.warn(o, m)
      },
      error: (o, m) => {
        pinoLike.error(o, m)
      },
    })
    bound.info({}, 'session_finalized')
    expect(pinoLike.lines).toEqual(['warn:session_finalized'])
  })
})
