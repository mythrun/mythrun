// backend/src/routes/__tests__/ws-session-suspension.test.ts
//
// myth-ficc — suspended-user enforcement on an ALREADY-OPEN socket, driven at
// the `handleInbound` seam with fake deps (same harness shape as
// ws-session-end.test.ts).
//
// The handshake gate (ws-session.test.ts, "rejects (403) a SUSPENDED member")
// covers connect-time. This file covers the harder half: a player who was in
// good standing when the socket opened and is suspended MID-SESSION. There is
// no in-app suspend action today — an operator sets `suspended_at` directly in
// Postgres — so nothing publishes a kill message, and the socket only learns
// about the ban by ASKING. Hence a per-frame `users.isSuspended` read: the
// first thing the user tries to do after the ban is their last.
//
// The two failure modes this pins down:
//   - suspended ⇒ the frame does NOTHING (no persist, no publish, no trigger
//     re-arm) and the socket is torn down via hub.closeUser.
//   - the lookup THROWS (DB wobble) ⇒ the frame still does nothing. handleInbound
//     is a per-frame error boundary, so the throw is swallowed and the socket
//     survives — but the action does not happen. Fail-closed on the ACT is the
//     property that matters; a suspended user waiting out a DB blip gains
//     nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleInbound } from '../ws-session.js'
import type { WsSessionDeps } from '../ws-session.js'

const CAMPAIGN_ID = 'camp-susp-1'
const SESSION_ID = 'sess-susp-1'
const USER_ID = 'user-banned'
const DISPLAY = 'Dee'
const CHARACTER = 'Aila'

interface Harness {
  ctx: { app: { log: ReturnType<typeof makeAppLog> }; deps: WsSessionDeps }
  isSuspended: ReturnType<typeof vi.fn>
  closeUser: ReturnType<typeof vi.fn>
  appends: () => number
  publishes: { type: string }[]
  stampActivity: ReturnType<typeof vi.fn>
  log: ReturnType<typeof makeAppLog>
}

function makeAppLog(): {
  error: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
} {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}

/** `suspended` drives users.isSuspended: `true`/`false` resolve, `'throw'`
 *  simulates the DB wobble. */
function makeHarness(suspended: boolean | 'throw'): Harness {
  const state = { appends: 0 }
  const publishes: { type: string }[] = []

  const isSuspended = vi.fn(() =>
    suspended === 'throw'
      ? Promise.reject(new Error('ECONNRESET: pg transient'))
      : Promise.resolve(suspended),
  )
  const closeUser = vi.fn(() => 1)
  const stampActivity = vi.fn().mockResolvedValue(undefined)

  const repo = {
    users: { isSuspended },
    sessions: { getById: vi.fn().mockResolvedValue({ id: SESSION_ID, campaignId: CAMPAIGN_ID }) },
    campaigns: { getWorldId: vi.fn().mockResolvedValue('world-1') },
    sessionMessages: {
      append: vi.fn(() => {
        state.appends += 1
        return Promise.resolve(undefined)
      }),
      listAfterSeq: vi.fn().mockResolvedValue([]),
    },
  } as unknown as WsSessionDeps['repo']

  const sessionState = {
    isEnding: vi.fn().mockResolvedValue(false),
    tryMarkEnding: vi.fn().mockResolvedValue(true),
    getState: vi
      .fn()
      .mockResolvedValue({ participants: [], mode: 'exploration', status: 'active' }),
    setState: vi.fn().mockResolvedValue(undefined),
    nextSeq: vi.fn().mockResolvedValue(1),
  } as unknown as WsSessionDeps['sessionState']

  const hub = {
    register: vi.fn(),
    deregister: vi.fn(),
    closeUser,
    hasLocal: vi.fn().mockReturnValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn((_campaignId: string, f: { type: string }) => {
      publishes.push(f)
      return Promise.resolve()
    }),
  } as unknown as WsSessionDeps['hub']

  const triggerState = {
    markTyping: vi.fn().mockResolvedValue(undefined),
    clearTyping: vi.fn().mockResolvedValue(undefined),
    stampActivity,
    armFirstUnresponded: vi.fn().mockResolvedValue(undefined),
    firstUnrespondedMs: vi.fn().mockResolvedValue(null),
    respondedSeq: vi.fn().mockResolvedValue(0),
  } as unknown as WsSessionDeps['triggerState']

  const deps = {
    repo,
    sessionState,
    hub,
    triggerState,
    suspendQueue: { add: vi.fn(), getJob: vi.fn(), remove: vi.fn().mockResolvedValue(0) },
    reconcileQueue: { add: vi.fn().mockResolvedValue(undefined) },
    lock: { tryAcquire: vi.fn().mockResolvedValue(null) },
    containerId: 'test-container',
    redisRealtime: {} as WsSessionDeps['redisRealtime'],
    redisKeyPrefix: 'test:susp:',
    dmTriggerQueue: { add: vi.fn().mockResolvedValue(undefined) },
    sessionTurnQueue: { add: vi.fn().mockResolvedValue(undefined) },
    turnPublisher: { dmThinking: vi.fn().mockResolvedValue(undefined) },
  } as unknown as WsSessionDeps

  const log = makeAppLog()
  return {
    ctx: { app: { log }, deps },
    isSuspended,
    closeUser,
    appends: () => state.appends,
    publishes,
    stampActivity,
    log,
  }
}

async function inbound(h: Harness, obj: unknown): Promise<void> {
  await handleInbound(
    h.ctx as never,
    USER_ID,
    CAMPAIGN_ID,
    SESSION_ID,
    Buffer.from(JSON.stringify(obj)),
    DISPLAY,
    CHARACTER,
  )
}

describe('ws-session suspended-user enforcement (handleInbound seam)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lets a user in good standing act (the gate is not a blanket drop)', async () => {
    const h = makeHarness(false)
    await inbound(h, { type: 'player_message', text: 'I open the door.' })
    expect(h.isSuspended).toHaveBeenCalledWith(USER_ID)
    expect(h.closeUser).not.toHaveBeenCalled()
    expect(h.appends()).toBe(1)
    expect(h.publishes.map((f) => f.type)).toContain('player_message')
  })

  it('drops a suspended user’s message AND tears their sockets down', async () => {
    const h = makeHarness(true)
    await inbound(h, { type: 'player_message', text: 'I open the door.' })
    expect(h.closeUser).toHaveBeenCalledWith(USER_ID)
    // Nothing happened: no durable row, no broadcast, no DM-trigger re-arm.
    expect(h.appends()).toBe(0)
    expect(h.publishes).toHaveLength(0)
    expect(h.stampActivity).not.toHaveBeenCalled()
  })

  it('drops a suspended user’s end_session too (a ban is not a way to end play)', async () => {
    const h = makeHarness(true)
    await inbound(h, { type: 'end_session' })
    expect(h.closeUser).toHaveBeenCalledWith(USER_ID)
    expect(h.publishes).toHaveLength(0)
  })

  it('drops a suspended user’s typing frame (no debounce re-arm)', async () => {
    const h = makeHarness(true)
    await inbound(h, { type: 'typing_start' })
    expect(h.closeUser).toHaveBeenCalledWith(USER_ID)
    expect(h.publishes).toHaveLength(0)
  })

  it('does NOT act when the suspension lookup throws (fail-closed on the act)', async () => {
    const h = makeHarness('throw')
    await inbound(h, { type: 'player_message', text: 'I open the door.' })
    // The frame is dropped by handleInbound's per-frame boundary: no persist,
    // no broadcast. The socket stays up (a DB blip must not kick honest
    // players), and the next frame re-checks.
    expect(h.appends()).toBe(0)
    expect(h.publishes).toHaveLength(0)
    expect(h.closeUser).not.toHaveBeenCalled()
    expect(h.log.error).toHaveBeenCalled()
  })

  it('does not spend a DB lookup on an unparseable frame', async () => {
    const h = makeHarness(false)
    await handleInbound(
      h.ctx as never,
      USER_ID,
      CAMPAIGN_ID,
      SESSION_ID,
      Buffer.from('{not json'),
      DISPLAY,
      CHARACTER,
    )
    expect(h.isSuspended).not.toHaveBeenCalled()
  })
})
