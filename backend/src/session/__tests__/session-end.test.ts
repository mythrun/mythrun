// MYT-74a T11 — `endSession` orchestration unit suite.
//
// The session-end lifecycle: set the `ending` flag (SET-NX, once-only), cancel
// the pending suspend, quiesce the in-flight turn (lock-fence), flip the session
// row to 'ended', enqueue ONE reconcile job, and broadcast `session_end`.
// Reusable by both the explicit `end_session` WS frame and T12's budget
// auto-end — so the load-bearing property is IDEMPOTENCE: a second call (the
// frame + the auto-end collapsing) is a no-op (no second reconcile, no second
// flip).
//
// Every dependency is injected — the whole flow is unit-testable with recording
// fakes (a fake ending flag, a fake suspend queue, a fake reconcile queue spy, a
// fake lock, a fake sessions repo, a fake publish). No broker/Redis/PG/LLM.

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { endSession, type EndSessionDeps, type EndSessionArgs } from '../session-end.js'
import { suspendJobId } from '../session-suspend.js'

const CAMPAIGN = 'c-end-1'
const SESSION = 's-end-1'
const WORLD = 'w-end-1'

const ARGS: EndSessionArgs = { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD }

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
  return { sessionState: { tryMarkEnding } as unknown as EndSessionDeps['sessionState'], tryMarkEnding }
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

/** A recording reconcile queue: records each `add(name, payload, opts)`. */
function makeFakeReconcileQueue(): {
  reconcileQueue: EndSessionDeps['reconcileQueue']
  adds: { name: string; payload: unknown; opts: unknown }[]
} {
  const adds: { name: string; payload: unknown; opts: unknown }[] = []
  const add = ((name: string, payload: unknown, opts: unknown) => {
    adds.push({ name, payload, opts })
    return Promise.resolve(undefined)
  }) as unknown as EndSessionDeps['reconcileQueue']['add']
  return { reconcileQueue: { add }, adds }
}

/** A recording lock: `tryAcquire` returns a handle that records its release.
 *  `over.acquire` lets a test simulate a contended lock (returns null). */
function makeFakeLock(over: { acquire?: () => Promise<unknown> } = {}): {
  lock: EndSessionDeps['lock']
  acquires: string[]
  releases: number
} {
  const acquires: string[] = []
  const state = { releases: 0 }
  const tryAcquire = vi.fn((campaignId: string) => {
    acquires.push(campaignId)
    if (over.acquire) return over.acquire()
    return Promise.resolve({
      token: 'tok',
      extend: () => Promise.resolve(true),
      release: () => {
        state.releases += 1
        return Promise.resolve()
      },
    })
  })
  return {
    lock: { tryAcquire } as unknown as EndSessionDeps['lock'],
    acquires,
    get releases() {
      return state.releases
    },
  }
}

/** A recording sessions repo: records each `update(id, patch)`. */
function makeFakeSessions(): {
  sessions: EndSessionDeps['sessions']
  updates: { id: string; patch: { status?: string; endedAt?: Date | null } }[]
} {
  const updates: { id: string; patch: { status?: string; endedAt?: Date | null } }[] = []
  const sessions = {
    update: vi.fn((id: string, patch: { status?: string; endedAt?: Date | null }) => {
      updates.push({ id, patch })
      return Promise.resolve({ id })
    }),
    getById: vi.fn().mockResolvedValue({ id: SESSION, campaignId: CAMPAIGN }),
  } as unknown as EndSessionDeps['sessions']
  return { sessions, updates }
}

/** A recording publish: records each `(campaignId, frame)`. */
function makeFakePublish(): {
  publish: EndSessionDeps['publish']
  publishes: { campaignId: string; frame: { type?: string; reason?: string } }[]
} {
  const publishes: { campaignId: string; frame: { type?: string; reason?: string } }[] = []
  const publish = vi.fn((campaignId: string, frame: { type?: string; reason?: string }) => {
    publishes.push({ campaignId, frame })
    return Promise.resolve()
  }) as unknown as EndSessionDeps['publish']
  return { publish, publishes }
}

function makeLogger(): EndSessionDeps['logger'] {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

interface Harness {
  deps: EndSessionDeps
  tryMarkEnding: ReturnType<typeof vi.fn>
  suspendRemoves: string[]
  reconcileAdds: { name: string; payload: unknown; opts: unknown }[]
  lockAcquires: string[]
  sessionUpdates: { id: string; patch: { status?: string; endedAt?: Date | null } }[]
  publishes: { campaignId: string; frame: { type?: string; reason?: string } }[]
  getLockReleases: () => number
}

function makeHarness(over: { acquire?: () => Promise<unknown> } = {}): Harness {
  const { sessionState, tryMarkEnding } = makeFakeEndingFlag()
  const { suspendQueue, removes: suspendRemoves } = makeFakeSuspendQueue()
  const { reconcileQueue, adds: reconcileAdds } = makeFakeReconcileQueue()
  const lockH = makeFakeLock(over)
  const { sessions, updates: sessionUpdates } = makeFakeSessions()
  const { publish, publishes } = makeFakePublish()

  const deps: EndSessionDeps = {
    sessionState,
    suspendQueue,
    reconcileQueue,
    lock: lockH.lock,
    sessions,
    publish,
    logger: makeLogger(),
  }
  return {
    deps,
    tryMarkEnding,
    suspendRemoves,
    reconcileAdds,
    lockAcquires: lockH.acquires,
    sessionUpdates,
    publishes,
    getLockReleases: () => lockH.releases,
  }
}

describe('endSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('on a fresh session: marks ending, cancels suspend, flips status to ended with endedAt, enqueues ONE reconcile, broadcasts session_end', async () => {
    const h = makeHarness()
    await endSession(h.deps, ARGS)

    // (a) ending flag set.
    expect(h.tryMarkEnding).toHaveBeenCalledWith(CAMPAIGN)

    // (b) the pending suspend is cancelled (by the stable per-session jobId).
    expect(h.suspendRemoves).toEqual([suspendJobId(SESSION)])

    // (d) status flips to 'ended' with an endedAt Date.
    expect(h.sessionUpdates).toHaveLength(1)
    expect(h.sessionUpdates[0]?.id).toBe(SESSION)
    expect(h.sessionUpdates[0]?.patch.status).toBe('ended')
    expect(h.sessionUpdates[0]?.patch.endedAt).toBeInstanceOf(Date)

    // (e) exactly ONE reconcile job, carrying {campaignId, sessionId, worldId}.
    expect(h.reconcileAdds).toHaveLength(1)
    expect(h.reconcileAdds[0]?.payload).toEqual({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: WORLD,
    })

    // (f) a session_end broadcast with reason 'normal'.
    expect(h.publishes).toHaveLength(1)
    expect(h.publishes[0]?.campaignId).toBe(CAMPAIGN)
    expect(h.publishes[0]?.frame.type).toBe('session_end')
    expect(h.publishes[0]?.frame.reason).toBe('normal')
  })

  it('quiesces by acquiring + releasing the per-session lock around the flip', async () => {
    const h = makeHarness()
    await endSession(h.deps, ARGS)

    expect(h.lockAcquires).toEqual([CAMPAIGN])
    expect(h.getLockReleases()).toBe(1)
  })

  it('a contended lock (tryAcquire → null) still flips + enqueues (the reconcile worker re-acquires the lock as the backstop)', async () => {
    const h = makeHarness({ acquire: () => Promise.resolve(null) })
    await endSession(h.deps, ARGS)

    // No handle to release, but the end still proceeds.
    expect(h.getLockReleases()).toBe(0)
    expect(h.sessionUpdates).toHaveLength(1)
    expect(h.sessionUpdates[0]?.patch.status).toBe('ended')
    expect(h.reconcileAdds).toHaveLength(1)
    expect(h.publishes[0]?.frame.type).toBe('session_end')
  })

  it('is IDEMPOTENT: a second endSession (ending flag already set) is a no-op — no second flip, no second reconcile, no second broadcast', async () => {
    const h = makeHarness()
    await endSession(h.deps, ARGS)
    await endSession(h.deps, ARGS)

    // tryMarkEnding called twice (both ends attempt it); the SECOND returns
    // false and short-circuits.
    expect(h.tryMarkEnding).toHaveBeenCalledTimes(2)
    // Everything downstream ran exactly once.
    expect(h.sessionUpdates).toHaveLength(1)
    expect(h.reconcileAdds).toHaveLength(1)
    expect(h.publishes).toHaveLength(1)
    // The second call didn't even cancel the suspend again.
    expect(h.suspendRemoves).toEqual([suspendJobId(SESSION)])
  })
})
