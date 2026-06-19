// backend/src/routes/__tests__/ws-session-combat.test.ts
//
// MYT-75 T8 — the WS inbound combat-mode routing, driven at the `handleInbound`
// seam with FAKE deps (mirrors ws-session-end.test.ts). Combat resolves
// single-shot; the session then SITS in `combat` mode (the `:combat` blob,
// status `resolved`) showing the result until ANY member sends `resume_combat`,
// which flips back to `exploration`. This suite covers:
//
//   - a `resume_combat` frame while mode==='combat' → setState flips mode to
//     'exploration', clearCombatState is called, ONE mode_change(combat→
//     exploration, reason 'resume') frame is published.
//   - a SECOND simultaneous `resume_combat` no-ops: the tryMarkResumed interlock
//     returns false → no second flip / clear / publish.
//   - a `player_message` while mode==='combat' is DROPPED at the top of
//     handleInbound — no persist (no :seq advance), no broadcast, no dm-trigger
//     re-arm.
//   - buildReconnectFrame is covered in the integration suite (it needs the real
//     repo + replay machinery); here we cover the handleInbound combat-mode seam.
//
// handleInbound is exported for exactly this seam. It NEVER throws (the per-frame
// error boundary), so these tests assert OBSERVABLE effects (recorded calls).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleInbound } from '../ws-session.js'
import type { WsSessionDeps } from '../ws-session.js'
import type { SessionStateBlob } from '../../redis/session-state.js'

const CAMPAIGN_ID = 'camp-combat-1'
const SESSION_ID = 'sess-combat-1'
const USER_ID = 'user-1'
const DISPLAY = 'Dee'
const CHARACTER = 'Aila'

/** A recording sessionState fake covering the combat seam: getState (mode read),
 *  setState (the resume flip), clearCombatState, and the tryMarkResumed
 *  interlock (first caller wins, like the real SET-NX). nextSeq is wired so a
 *  leaked-through persist would be observable. */
function makeFakeSessionState(opts: { mode?: SessionStateBlob['mode'] } = {}): {
  sessionState: WsSessionDeps['sessionState']
  calls: {
    getState: ReturnType<typeof vi.fn>
    setState: ReturnType<typeof vi.fn>
    clearCombatState: ReturnType<typeof vi.fn>
    tryMarkResumed: ReturnType<typeof vi.fn>
    nextSeq: ReturnType<typeof vi.fn>
    isEnding: ReturnType<typeof vi.fn>
  }
} {
  const blob: SessionStateBlob = {
    participants: [],
    mode: opts.mode ?? 'exploration',
    status: 'active',
  }
  let resumed = false
  const getState = vi.fn().mockResolvedValue(blob)
  const setState = vi.fn().mockResolvedValue(undefined)
  const clearCombatState = vi.fn().mockResolvedValue(undefined)
  const tryMarkResumed = vi.fn(() => {
    if (resumed) return Promise.resolve(false)
    resumed = true
    return Promise.resolve(true)
  })
  const nextSeq = vi.fn().mockResolvedValue(1)
  const isEnding = vi.fn().mockResolvedValue(false)
  const sessionState = {
    getState,
    setState,
    clearCombatState,
    tryMarkResumed,
    nextSeq,
    isEnding,
  } as unknown as WsSessionDeps['sessionState']
  return { sessionState, calls: { getState, setState, clearCombatState, tryMarkResumed, nextSeq, isEnding } }
}

/** A recording hub: records publish(campaignId, frame). */
function makeFakeHub(): {
  hub: WsSessionDeps['hub']
  publishes: { campaignId: string; frame: { type: string; [k: string]: unknown } }[]
} {
  const publishes: { campaignId: string; frame: { type: string; [k: string]: unknown } }[] = []
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

/** A fake repo whose sessionMessages.append records calls — a leaked-through
 *  persist (a dropped frame that wasn't dropped) would bump this. */
function makeFakeRepo(): { repo: WsSessionDeps['repo']; getAppends: () => number } {
  const state = { appends: 0 }
  const repo = {
    sessionMessages: {
      append: vi.fn(() => {
        state.appends += 1
        return Promise.resolve(undefined)
      }),
      listAfterSeq: vi.fn().mockResolvedValue([]),
    },
    campaigns: { getWorldId: vi.fn().mockResolvedValue('world-1') },
  } as unknown as WsSessionDeps['repo']
  return { repo, getAppends: () => state.appends }
}

function makeAppLog(): {
  error: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
} {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}

interface Harness {
  ctx: { app: { log: ReturnType<typeof makeAppLog> }; deps: WsSessionDeps }
  publishes: { campaignId: string; frame: { type: string; [k: string]: unknown } }[]
  stateCalls: {
    getState: ReturnType<typeof vi.fn>
    setState: ReturnType<typeof vi.fn>
    clearCombatState: ReturnType<typeof vi.fn>
    tryMarkResumed: ReturnType<typeof vi.fn>
    nextSeq: ReturnType<typeof vi.fn>
    isEnding: ReturnType<typeof vi.fn>
  }
  triggerCalls: {
    stampActivity: ReturnType<typeof vi.fn>
    armFirstUnresponded: ReturnType<typeof vi.fn>
    clearTyping: ReturnType<typeof vi.fn>
  }
  rescheduleAdd: ReturnType<typeof vi.fn>
  getAppends: () => number
}

function makeHarness(opts: { mode?: SessionStateBlob['mode'] } = {}): Harness {
  const { sessionState, calls: stateCalls } = makeFakeSessionState(opts)
  const { hub, publishes } = makeFakeHub()
  const { repo, getAppends } = makeFakeRepo()

  const stampActivity = vi.fn().mockResolvedValue(undefined)
  const armFirstUnresponded = vi.fn().mockResolvedValue(undefined)
  const clearTyping = vi.fn().mockResolvedValue(undefined)
  const triggerState = {
    markTyping: vi.fn().mockResolvedValue(undefined),
    clearTyping,
    stampActivity,
    armFirstUnresponded,
    firstUnrespondedMs: vi.fn().mockResolvedValue(null),
    respondedSeq: vi.fn().mockResolvedValue(0),
  } as unknown as WsSessionDeps['triggerState']

  const rescheduleAdd = vi.fn().mockResolvedValue(undefined)
  const deps = {
    repo,
    sessionState,
    hub,
    suspendQueue: { add: vi.fn(), getJob: vi.fn(), remove: vi.fn().mockResolvedValue(0) },
    reconcileQueue: { add: vi.fn().mockResolvedValue(undefined) },
    lock: { tryAcquire: vi.fn() },
    containerId: 'test-container',
    redisRealtime: {} as WsSessionDeps['redisRealtime'],
    redisKeyPrefix: 'test:combat:',
    // The dm-trigger debounce producer: a re-arm after a player_message shows up
    // here. A dropped combat-mode player_message must NOT reach it.
    dmTriggerQueue: { add: rescheduleAdd },
    sessionTurnQueue: { add: vi.fn().mockResolvedValue(undefined) },
    triggerState,
    turnPublisher: { dmThinking: vi.fn().mockResolvedValue(undefined) },
  } as unknown as WsSessionDeps

  const log = makeAppLog()
  const ctx = { app: { log }, deps }
  return {
    ctx,
    publishes,
    stateCalls,
    triggerCalls: { stampActivity, armFirstUnresponded, clearTyping },
    rescheduleAdd,
    getAppends,
  }
}

function frame(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj))
}

async function inbound(h: Harness, obj: unknown): Promise<void> {
  await handleInbound(h.ctx as never, USER_ID, CAMPAIGN_ID, SESSION_ID, frame(obj), DISPLAY, CHARACTER)
}

describe('ws-session inbound combat mode (handleInbound seam)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('resume_combat while mode==="combat" → claims the interlock, flips mode to exploration, clears combat, publishes ONE mode_change(combat→exploration, reason "resume")', async () => {
    const h = makeHarness({ mode: 'combat' })
    await inbound(h, { type: 'resume_combat' })

    // The resume interlock was claimed.
    expect(h.stateCalls.tryMarkResumed).toHaveBeenCalledWith(CAMPAIGN_ID)

    // The mode flipped to exploration (setState carries the prior blob + mode).
    expect(h.stateCalls.setState).toHaveBeenCalledTimes(1)
    const setArg = h.stateCalls.setState.mock.calls[0]?.[1] as SessionStateBlob
    expect(setArg).toMatchObject({ mode: 'exploration', status: 'active' })

    // The combat blob (+ resume interlock) was cleared.
    expect(h.stateCalls.clearCombatState).toHaveBeenCalledWith(CAMPAIGN_ID)

    // ONE mode_change frame, combat→exploration, reason 'resume'.
    expect(h.publishes).toHaveLength(1)
    expect(h.publishes[0]?.frame).toMatchObject({
      type: 'mode_change',
      from: 'combat',
      to: 'exploration',
      reason: 'resume',
    })

    // No turn-advancing side effects: no persist, no trigger re-arm.
    expect(h.getAppends()).toBe(0)
    expect(h.rescheduleAdd).not.toHaveBeenCalled()
  })

  it('a SECOND simultaneous resume_combat no-ops (tryMarkResumed returns false): no second flip / clear / publish', async () => {
    const h = makeHarness({ mode: 'combat' })
    // First resume wins.
    await inbound(h, { type: 'resume_combat' })
    expect(h.stateCalls.setState).toHaveBeenCalledTimes(1)
    expect(h.publishes).toHaveLength(1)

    // Second resume loses the interlock race → short-circuits with no effect.
    await inbound(h, { type: 'resume_combat' })
    expect(h.stateCalls.tryMarkResumed).toHaveBeenCalledTimes(2)
    expect(h.stateCalls.setState).toHaveBeenCalledTimes(1) // still 1
    expect(h.stateCalls.clearCombatState).toHaveBeenCalledTimes(1) // still 1
    expect(h.publishes).toHaveLength(1) // still 1
  })

  it('resume_combat while mode!=="combat" (nothing to resume) → no interlock claim, no flip, no publish', async () => {
    const h = makeHarness({ mode: 'exploration' })
    await inbound(h, { type: 'resume_combat' })

    expect(h.stateCalls.tryMarkResumed).not.toHaveBeenCalled()
    expect(h.stateCalls.setState).not.toHaveBeenCalled()
    expect(h.stateCalls.clearCombatState).not.toHaveBeenCalled()
    expect(h.publishes).toHaveLength(0)
  })

  it('player_message while mode==="combat" is DROPPED: no persist (no :seq advance), no broadcast, no trigger re-arm', async () => {
    const h = makeHarness({ mode: 'combat' })
    await inbound(h, { type: 'player_message', text: 'I attack again!' })

    // The mode gate read fired and dropped the frame before any side effect.
    expect(h.stateCalls.getState).toHaveBeenCalledWith(CAMPAIGN_ID)
    expect(h.stateCalls.nextSeq).not.toHaveBeenCalled()
    expect(h.getAppends()).toBe(0)
    expect(h.publishes).toHaveLength(0)
    expect(h.rescheduleAdd).not.toHaveBeenCalled()
    expect(h.triggerCalls.stampActivity).not.toHaveBeenCalled()
    expect(h.triggerCalls.armFirstUnresponded).not.toHaveBeenCalled()
  })

  it('a player_message while mode==="exploration" still flows (the gate does not over-drop)', async () => {
    const h = makeHarness({ mode: 'exploration' })
    await inbound(h, { type: 'player_message', text: 'I open the door.' })

    // Normal exploration turn: persisted + broadcast + trigger re-armed.
    expect(h.getAppends()).toBe(1)
    expect(h.publishes).toHaveLength(1)
    expect(h.publishes[0]?.frame).toMatchObject({ type: 'player_message', text: 'I open the door.' })
    expect(h.triggerCalls.stampActivity).toHaveBeenCalled()
  })

  it('end_session is NOT dropped by the combat gate (it flows through to the end branch)', async () => {
    // The combat-mode gate must let end_session through (a member can end a
    // session that is sitting in combat). We don't fully exercise endSession
    // here (that's ws-session-end.test.ts) — we assert the frame was NOT dropped
    // by the gate: the resume branch did not claim the interlock (end_session is
    // not resume_combat) and no mode_change was published.
    const h = makeHarness({ mode: 'combat' })
    await inbound(h, { type: 'end_session' })
    expect(h.stateCalls.tryMarkResumed).not.toHaveBeenCalled()
    const modeChanges = h.publishes.filter((p) => p.frame.type === 'mode_change')
    expect(modeChanges).toHaveLength(0)
  })
})
