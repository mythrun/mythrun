// backend/src/routes/__tests__/ws-session-end.test.ts
//
// MYT-74a T11 — the WS inbound session-end routing + the ending-flag drop-gate,
// driven at the `handleInbound` seam with FAKE deps. Two behaviors:
//
//   - an `end_session` frame routes to `endSession`: it marks the ending flag,
//     flips the session row to 'ended', enqueues ONE reconcile job, and
//     broadcasts `session_end`. The worldId is resolved via the blob cache /
//     campaigns.getWorldId (resolveWorldId) and threaded onto the reconcile job.
//   - a `player_message` arriving while the ending flag is ALREADY set is
//     DROPPED at the top of handleInbound — no persist, no broadcast, no
//     trigger reschedule (no new turn after an end has begun).
//
// handleInbound is exported for exactly this seam (mirrors parseClientFrame). It
// NEVER throws (the per-frame error boundary), so these tests assert OBSERVABLE
// effects (recorded calls), not "no error".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleInbound } from '../ws-session.js'
import type { WsSessionDeps } from '../ws-session.js'

const CAMPAIGN_ID = 'camp-end-1'
const SESSION_ID = 'sess-end-1'
const WORLD_ID = 'world-end-1'
const USER_ID = 'user-1'
const DISPLAY = 'Dee'
const CHARACTER = 'Aila'

/** A recording sessionState fake: the ending flag (tryMarkEnding/isEnding), the
 *  worldId blob cache (getState/setState), and nextSeq for the persist path. */
function makeFakeSessionState(opts: { ending?: boolean; worldId?: string } = {}): {
  sessionState: WsSessionDeps['sessionState']
  calls: { tryMarkEnding: ReturnType<typeof vi.fn>; isEnding: ReturnType<typeof vi.fn> }
} {
  let marked = false
  const isEnding = vi.fn(() => Promise.resolve(opts.ending ?? false))
  const tryMarkEnding = vi.fn(() => {
    if (marked) return Promise.resolve(false)
    marked = true
    return Promise.resolve(true)
  })
  const sessionState = {
    tryMarkEnding,
    isEnding,
    nextSeq: vi.fn().mockResolvedValue(1),
    // resolveWorldId reads getState; a blob carrying worldId short-circuits the
    // campaigns.getWorldId read.
    getState: vi.fn().mockResolvedValue(
      opts.worldId !== undefined
        ? { participants: [], mode: 'exploration', status: 'active', worldId: opts.worldId }
        : { participants: [], mode: 'exploration', status: 'active' },
    ),
    setState: vi.fn().mockResolvedValue(undefined),
  } as unknown as WsSessionDeps['sessionState']
  return { sessionState, calls: { tryMarkEnding, isEnding } }
}

/** A recording reconcile queue: records each add(name, payload, opts). */
function makeFakeReconcileQueue(): {
  reconcileQueue: WsSessionDeps['reconcileQueue']
  adds: { name: string; payload: unknown; opts: unknown }[]
} {
  const adds: { name: string; payload: unknown; opts: unknown }[] = []
  const add = ((name: string, payload: unknown, opts: unknown) => {
    adds.push({ name, payload, opts })
    return Promise.resolve(undefined)
  }) as unknown as WsSessionDeps['reconcileQueue']['add']
  return { reconcileQueue: { add }, adds }
}

/** A recording lock: tryAcquire returns a releasable handle. */
function makeFakeLock(): { lock: WsSessionDeps['lock']; releases: { n: number } } {
  const releases = { n: 0 }
  const lock = {
    tryAcquire: vi.fn(() =>
      Promise.resolve({
        token: 'tok',
        extend: () => Promise.resolve(true),
        release: () => {
          releases.n += 1
          return Promise.resolve()
        },
      }),
    ),
  } as unknown as WsSessionDeps['lock']
  return { lock, releases }
}

/** A recording hub: records publish(campaignId, frame). */
function makeFakeHub(): {
  hub: WsSessionDeps['hub']
  publishes: { campaignId: string; frame: { type: string } }[]
} {
  const publishes: { campaignId: string; frame: { type: string } }[] = []
  const hub = {
    register: vi.fn(),
    deregister: vi.fn(),
    hasLocal: vi.fn().mockReturnValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn((campaignId: string, frame: { type: string }) => {
      publishes.push({ campaignId, frame })
      return Promise.resolve()
    }),
  } as unknown as WsSessionDeps['hub']
  return { hub, publishes }
}

/** A fake repo: sessions.update/getById (the end flip), campaigns.getWorldId
 *  (worldId fallback), sessionMessages.append (persist path). */
function makeFakeRepo(): {
  repo: WsSessionDeps['repo']
  updates: { id: string; patch: { status?: string; endedAt?: Date | null } }[]
  appends: number
} {
  const updates: { id: string; patch: { status?: string; endedAt?: Date | null } }[] = []
  const state = { appends: 0 }
  const repo = {
    sessions: {
      update: vi.fn((id: string, patch: { status?: string; endedAt?: Date | null }) => {
        updates.push({ id, patch })
        return Promise.resolve({ id })
      }),
      getById: vi.fn().mockResolvedValue({ id: SESSION_ID, campaignId: CAMPAIGN_ID }),
    },
    campaigns: {
      getWorldId: vi.fn().mockResolvedValue(WORLD_ID),
    },
    sessionMessages: {
      append: vi.fn(() => {
        state.appends += 1
        return Promise.resolve(undefined)
      }),
      listAfterSeq: vi.fn().mockResolvedValue([]),
    },
  } as unknown as WsSessionDeps['repo']
  return {
    repo,
    updates,
    get appends() {
      return state.appends
    },
  }
}

function makeAppLog(): { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}

interface Harness {
  ctx: { app: { log: ReturnType<typeof makeAppLog> }; deps: WsSessionDeps }
  reconcileAdds: { name: string; payload: unknown; opts: unknown }[]
  publishes: { campaignId: string; frame: { type: string } }[]
  sessionUpdates: { id: string; patch: { status?: string; endedAt?: Date | null } }[]
  endingCalls: { tryMarkEnding: ReturnType<typeof vi.fn>; isEnding: ReturnType<typeof vi.fn> }
  lockReleases: { n: number }
  getAppends: () => number
}

function makeHarness(opts: { ending?: boolean; worldId?: string } = {}): Harness {
  const { sessionState, calls: endingCalls } = makeFakeSessionState(opts)
  const { reconcileQueue, adds: reconcileAdds } = makeFakeReconcileQueue()
  const { lock, releases: lockReleases } = makeFakeLock()
  const { hub, publishes } = makeFakeHub()
  const { repo, updates: sessionUpdates, ...repoRest } = makeFakeRepo()

  const triggerState = {
    markTyping: vi.fn().mockResolvedValue(undefined),
    clearTyping: vi.fn().mockResolvedValue(undefined),
    stampActivity: vi.fn().mockResolvedValue(undefined),
    armFirstUnresponded: vi.fn().mockResolvedValue(undefined),
    firstUnrespondedMs: vi.fn().mockResolvedValue(null),
  } as unknown as WsSessionDeps['triggerState']

  const deps = {
    repo,
    sessionState,
    hub,
    suspendQueue: { add: vi.fn(), getJob: vi.fn(), remove: vi.fn().mockResolvedValue(0) },
    reconcileQueue,
    lock,
    containerId: 'test-container',
    redisRealtime: {} as WsSessionDeps['redisRealtime'],
    redisKeyPrefix: 'test:end:',
    dmTriggerQueue: { add: vi.fn().mockResolvedValue(undefined) },
    sessionTurnQueue: { add: vi.fn().mockResolvedValue(undefined) },
    triggerState,
    turnPublisher: { dmThinking: vi.fn().mockResolvedValue(undefined) },
  } as unknown as WsSessionDeps

  const log = makeAppLog()
  const ctx = { app: { log }, deps }
  return {
    ctx,
    reconcileAdds,
    publishes,
    sessionUpdates,
    endingCalls,
    lockReleases,
    getAppends: () => repoRest.appends,
  }
}

function frame(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj))
}

async function inbound(h: Harness, obj: unknown): Promise<void> {
  await handleInbound(h.ctx as never, USER_ID, CAMPAIGN_ID, SESSION_ID, frame(obj), DISPLAY, CHARACTER)
}

describe('ws-session inbound session-end (handleInbound seam)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('end_session frame: routes to endSession — marks ending, flips to ended, enqueues ONE reconcile (with worldId), broadcasts session_end', async () => {
    const h = makeHarness({ worldId: WORLD_ID })
    await inbound(h, { type: 'end_session' })

    // The ending flag was claimed.
    expect(h.endingCalls.tryMarkEnding).toHaveBeenCalledWith(CAMPAIGN_ID)

    // The session row flipped to 'ended'.
    expect(h.sessionUpdates).toHaveLength(1)
    expect(h.sessionUpdates[0]?.id).toBe(SESSION_ID)
    expect(h.sessionUpdates[0]?.patch.status).toBe('ended')

    // ONE reconcile job carrying the resolved worldId.
    expect(h.reconcileAdds).toHaveLength(1)
    expect(h.reconcileAdds[0]?.payload).toEqual({
      campaignId: CAMPAIGN_ID,
      sessionId: SESSION_ID,
      worldId: WORLD_ID,
    })

    // A session_end broadcast went out.
    expect(h.publishes.map((p) => p.frame.type)).toContain('session_end')
    // The quiesce lock was released.
    expect(h.lockReleases.n).toBe(1)
  })

  it('player_message dropped when the ending flag is set: no persist, no broadcast', async () => {
    const h = makeHarness({ ending: true })
    await inbound(h, { type: 'player_message', text: 'too late, the session is over' })

    // The gate read fired and the frame was dropped before any side effect.
    expect(h.endingCalls.isEnding).toHaveBeenCalledWith(CAMPAIGN_ID)
    expect(h.getAppends()).toBe(0)
    expect(h.publishes).toHaveLength(0)
    // No reconcile (it wasn't an end_session frame) and no end flip.
    expect(h.reconcileAdds).toHaveLength(0)
    expect(h.sessionUpdates).toHaveLength(0)
  })
})
