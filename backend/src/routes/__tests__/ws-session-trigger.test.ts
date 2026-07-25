// backend/src/routes/__tests__/ws-session-trigger.test.ts
//
// MYT-67 T14 — the WS inbound DM-trigger integration, driven at the
// handleInbound seam with FAKE deps (recording triggerState, fake dm-trigger /
// session-turn producers, fake turn publisher, fake hub, fake repo, an
// ioredis-mock for the explicit rate-limit INCR). These tests pin the
// server-side trigger behavior (§4.1/§4.2/§4.5) WITHOUT a real Fastify upgrade,
// real Redis, or real Postgres — they exercise exactly the branch logic the
// inbound handler routes on:
//   - typing_start → mark typing + stamp activity + arm first-unresponded +
//     reschedule the quiet-window debounce (clamped) + publish.
//   - typing_stop → clear typing + publish (no reschedule).
//   - player_message (normal) → persist + publish + reschedule the debounce.
//   - player_message ("@dm …") → the EXPLICIT path (no debounce reschedule).
//   - dm_invoke → the EXPLICIT path.
//   - EXPLICIT with isResponding=false → dmThinking + enqueueTurn(explicit).
//   - EXPLICIT with isResponding=true → setExplicitPending (no enqueue).
//   - EXPLICIT rate limit → the 11th summon in the 60s window is dropped.
//
// handleInbound is exported from ws-session.ts for exactly this seam (mirrors
// the exported parseClientFrame). It NEVER throws (the per-frame error
// boundary), so a missing await or a thrown dep would otherwise be swallowed —
// these tests assert the OBSERVABLE effects (recorded calls), not "no error".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import IoredisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { handleInbound } from '../ws-session.js'
import type { WsSessionDeps } from '../ws-session.js'
import {
  QUIET_WINDOW_MS,
  DM_TRIGGER_JOB_NAME,
  MAX_QUIET_EXTENSION_MS,
} from '../../session/dm-trigger-config.js'

const CAMPAIGN_ID = 'camp-1'
const SESSION_ID = 'sess-1'
const USER_ID = 'user-1'
const DISPLAY = 'Dee'
const CHARACTER = 'Aila'

// --- Fakes -----------------------------------------------------------------

/** A recording TriggerState as a flat record of vi.fn()s. The `over` map lets a
 *  test swap a default (e.g. `isResponding` / `respondedSeq` for the explicit
 *  path). Returned as the inferred mock-object type (NOT cast to the
 *  `TriggerState` interface) so assertions on its methods don't trip
 *  @typescript-eslint/unbound-method; the cast to the interface happens once at
 *  the deps boundary in makeHarness. */
function makeFakeTriggerCalls(
  over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): Record<string, ReturnType<typeof vi.fn>> {
  return {
    markTyping: vi.fn().mockResolvedValue(undefined),
    listTyping: vi.fn().mockResolvedValue([]),
    clearTyping: vi.fn().mockResolvedValue(undefined),
    stampActivity: vi.fn().mockResolvedValue(undefined),
    lastActivityMs: vi.fn().mockResolvedValue(null),
    armFirstUnresponded: vi.fn().mockResolvedValue(undefined),
    firstUnrespondedMs: vi.fn().mockResolvedValue(null),
    clearFirstUnresponded: vi.fn().mockResolvedValue(undefined),
    setRespondedSeq: vi.fn().mockResolvedValue(undefined),
    respondedSeq: vi.fn().mockResolvedValue(0),
    setResponding: vi.fn().mockResolvedValue(undefined),
    isResponding: vi.fn().mockResolvedValue(false),
    clearResponding: vi.fn().mockResolvedValue(undefined),
    setExplicitPending: vi.fn().mockResolvedValue(undefined),
    takeExplicitPending: vi.fn().mockResolvedValue(false),
    claimTurnErrorPublish: vi.fn().mockResolvedValue(true),
    ...over,
  }
}

/** A recording dm-trigger producer: records each `add(name, data, opts)`. */
function makeFakeDmTriggerQueue(): {
  queue: WsSessionDeps['dmTriggerQueue']
  adds: { name: string; data: unknown; opts: unknown }[]
} {
  const adds: { name: string; data: unknown; opts: unknown }[] = []
  const add = ((name: string, data: unknown, opts: unknown) => {
    adds.push({ name, data, opts })
    return Promise.resolve(undefined)
  }) as unknown as WsSessionDeps['dmTriggerQueue']['add']
  return { queue: { add }, adds }
}

/** A recording session-turn producer: records each enqueued turn payload. */
function makeFakeTurnQueue(over: { add?: () => Promise<unknown> } = {}): {
  queue: WsSessionDeps['sessionTurnQueue']
  adds: { name: string; payload: unknown }[]
} {
  const adds: { name: string; payload: unknown }[] = []
  const add = ((name: string, payload: unknown) => {
    adds.push({ name, payload })
    return over.add ? over.add() : Promise.resolve(undefined)
  }) as unknown as WsSessionDeps['sessionTurnQueue']['add']
  return { queue: { add }, adds }
}

/** A recording turn publisher: records dmThinking(campaignId, turnId). */
function makeFakeTurnPublisher(): {
  publisher: WsSessionDeps['turnPublisher']
  dmThinkingCalls: { campaignId: string; turnId: string }[]
} {
  const dmThinkingCalls: { campaignId: string; turnId: string }[] = []
  const publisher = {
    dmThinking: vi.fn((campaignId: string, turnId: string) => {
      dmThinkingCalls.push({ campaignId, turnId })
      return Promise.resolve()
    }),
    textDelta: vi.fn().mockResolvedValue(undefined),
    turnEnd: vi.fn().mockResolvedValue(undefined),
    turnError: vi.fn().mockResolvedValue(undefined),
    emitFor: vi.fn().mockReturnValue(() => Promise.resolve(undefined)),
  } as unknown as WsSessionDeps['turnPublisher']
  return { publisher, dmThinkingCalls }
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

/** A fake repo with the methods buildTurnBatch + persistMessage touch:
 *  sessionMessages.{listAfterSeq,append} + campaigns.listMembersBasic. */
function makeFakeRepo(
  rows: { seq: number; userId: string | null; messageType: string; content: string }[] = [],
): WsSessionDeps['repo'] {
  return {
    // myth-ficc: handleInbound gates every frame on the suspension predicate.
    // These fixtures are all users in good standing.
    users: { isSuspended: vi.fn().mockResolvedValue(false) },
    sessionMessages: {
      listAfterSeq: vi.fn().mockResolvedValue(rows),
      append: vi.fn().mockResolvedValue(undefined),
    },
    campaigns: {
      listMembersBasic: vi.fn().mockResolvedValue([{ user_id: USER_ID, display_name: DISPLAY }]),
    },
  } as unknown as WsSessionDeps['repo']
}

/** A pino-shaped recording logger for the fake ctx.app. */
function makeAppLog(): { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}

interface Harness {
  deps: WsSessionDeps
  redis: Redis
  keyPrefix: string
  triggerCalls: Record<string, ReturnType<typeof vi.fn>>
  dmTriggerAdds: ReturnType<typeof makeFakeDmTriggerQueue>['adds']
  turnAdds: ReturnType<typeof makeFakeTurnQueue>['adds']
  dmThinkingCalls: ReturnType<typeof makeFakeTurnPublisher>['dmThinkingCalls']
  publishes: ReturnType<typeof makeFakeHub>['publishes']
  log: ReturnType<typeof makeAppLog>
  ctx: { app: { log: ReturnType<typeof makeAppLog> }; deps: WsSessionDeps }
}

function makeHarness(opts: {
  triggerOver?: Partial<Record<string, ReturnType<typeof vi.fn>>>
  rows?: { seq: number; userId: string | null; messageType: string; content: string }[]
  nextSeq?: number
} = {}): Harness {
  // ioredis-mock instances with default options share ONE in-process store, so
  // the explicit-rate INCR key would leak across tests in this file. A unique
  // key prefix per harness isolates the rate-limit counter (the only real Redis
  // op these tests exercise) so each test starts from a clean count.
  const keyPrefix = `test:trig:${Math.random().toString(36).slice(2, 10)}:`
  const redis: Redis = new IoredisMock()
  const triggerCalls = makeFakeTriggerCalls(opts.triggerOver)
  const { queue: dmTriggerQueue, adds: dmTriggerAdds } = makeFakeDmTriggerQueue()
  const { queue: sessionTurnQueue, adds: turnAdds } = makeFakeTurnQueue()
  const { publisher: turnPublisher, dmThinkingCalls } = makeFakeTurnPublisher()
  const { hub, publishes } = makeFakeHub()
  const log = makeAppLog()

  // sessionState needs nextSeq for the player_message persist path, isEnding for
  // the MYT-74a inbound end drop-gate, and getState for the MYT-75 combat
  // drop-gate — both at the top of handleInbound. These trigger tests run with
  // the session NOT ending and NOT in combat, so the gates pass through (isEnding
  // → false, getState → null so `state?.mode === 'combat'` is false).
  const sessionState = {
    nextSeq: vi.fn().mockResolvedValue(opts.nextSeq ?? 1),
    isEnding: vi.fn().mockResolvedValue(false),
    getState: vi.fn().mockResolvedValue(null),
  } as unknown as WsSessionDeps['sessionState']

  const deps: WsSessionDeps = {
    repo: makeFakeRepo(opts.rows),
    sessionState,
    hub,
    suspendQueue: { add: vi.fn(), getJob: vi.fn(), remove: vi.fn() },
    containerId: 'test-container',
    redisRealtime: redis,
    redisKeyPrefix: keyPrefix,
    dmTriggerQueue,
    sessionTurnQueue,
    triggerState: triggerCalls as unknown as WsSessionDeps['triggerState'],
    turnPublisher,
    // MYT-74a T11: the end-flow deps. These trigger tests don't drive the
    // `end_session` path (ws-session-end.test.ts owns it), so a no-op reconcile
    // producer + a lock that always grants suffice for the type contract.
    reconcileQueue: { add: vi.fn().mockResolvedValue(undefined) },
    lock: {
      tryAcquire: vi.fn().mockResolvedValue({
        token: 'tok',
        extend: () => Promise.resolve(true),
        release: () => Promise.resolve(),
      }),
    },
  }
  const ctx = { app: { log }, deps }
  return { deps, redis, keyPrefix, triggerCalls, dmTriggerAdds, turnAdds, dmThinkingCalls, publishes, log, ctx }
}

function frame(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj))
}

async function inbound(h: Harness, obj: unknown): Promise<void> {
  await handleInbound(
    h.ctx as never,
    USER_ID,
    CAMPAIGN_ID,
    SESSION_ID,
    frame(obj),
    DISPLAY,
    CHARACTER,
  )
}

describe('ws-session inbound DM-trigger (handleInbound seam)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('typing_start: marks typing, stamps activity, arms first-unresponded, reschedules the (clamped) debounce, then publishes', async () => {
    const h = makeHarness()
    await inbound(h, { type: 'typing_start' })

    expect(h.triggerCalls.markTyping).toHaveBeenCalledWith(CAMPAIGN_ID, USER_ID)
    expect(h.triggerCalls.stampActivity).toHaveBeenCalledWith(CAMPAIGN_ID, expect.any(Number))
    expect(h.triggerCalls.armFirstUnresponded).toHaveBeenCalledWith(CAMPAIGN_ID, expect.any(Number))

    // One debounce reschedule with the full quiet window (no first-unresponded
    // anchor yet → clampQuietDelay returns QUIET_WINDOW_MS).
    expect(h.dmTriggerAdds).toHaveLength(1)
    expect(h.dmTriggerAdds[0]?.name).toBe(DM_TRIGGER_JOB_NAME)
    expect(h.dmTriggerAdds[0]?.data).toEqual({ campaignId: CAMPAIGN_ID })
    expect((h.dmTriggerAdds[0]?.opts as { delay: number }).delay).toBe(QUIET_WINDOW_MS)

    // The typing_start frame is still fanned out to peers.
    expect(h.publishes.map((p) => p.frame.type)).toContain('typing_start')
  })

  it('typing_start: the reschedule delay is CLAMPED by the max-wait ceiling when first-unresponded is old', async () => {
    // first-unresponded anchored at `now - (MAX - 1000)` → only ~1000ms of room
    // remains before the ceiling, which is < QUIET_WINDOW_MS → clamp wins.
    const now = Date.now()
    const anchor = now - (MAX_QUIET_EXTENSION_MS - 1_000)
    const h = makeHarness({
      triggerOver: { firstUnrespondedMs: vi.fn().mockResolvedValue(anchor) },
    })
    await inbound(h, { type: 'typing_start' })

    const delay = (h.dmTriggerAdds[0]?.opts as { delay: number }).delay
    expect(delay).toBeLessThan(QUIET_WINDOW_MS)
    expect(delay).toBeLessThanOrEqual(1_000)
    expect(delay).toBeGreaterThanOrEqual(0)
  })

  it('typing_stop: clears typing + publishes; no debounce reschedule (a stop is not activity)', async () => {
    const h = makeHarness()
    await inbound(h, { type: 'typing_stop' })

    expect(h.triggerCalls.clearTyping).toHaveBeenCalledWith(CAMPAIGN_ID, USER_ID)
    expect(h.dmTriggerAdds).toHaveLength(0)
    expect(h.publishes.map((p) => p.frame.type)).toContain('typing_stop')
  })

  it('player_message (normal): persists+broadcasts, clears typing, stamps, then reschedules the debounce (no enqueue)', async () => {
    const h = makeHarness()
    await inbound(h, { type: 'player_message', text: 'I head into the tavern.' })

    // Persist-then-broadcast preserved: the player_message frame went out.
    expect(h.publishes.map((p) => p.frame.type)).toContain('player_message')
    // A send implies "done typing".
    expect(h.triggerCalls.clearTyping).toHaveBeenCalledWith(CAMPAIGN_ID, USER_ID)
    expect(h.triggerCalls.stampActivity).toHaveBeenCalledWith(CAMPAIGN_ID, expect.any(Number))
    expect(h.triggerCalls.armFirstUnresponded).toHaveBeenCalledWith(CAMPAIGN_ID, expect.any(Number))
    // Normal message → debounce reschedule, NOT a direct turn enqueue.
    expect(h.dmTriggerAdds).toHaveLength(1)
    expect(h.turnAdds).toHaveLength(0)
    expect(h.dmThinkingCalls).toHaveLength(0)
  })

  it('player_message ("@dm …", isResponding=false): EXPLICIT path → dmThinking + enqueueTurn(explicit), no debounce reschedule', async () => {
    const h = makeHarness({
      rows: [{ seq: 1, userId: USER_ID, messageType: 'player_message', content: '@dm what do I see?' }],
      triggerOver: { isResponding: vi.fn().mockResolvedValue(false), respondedSeq: vi.fn().mockResolvedValue(0) },
    })
    await inbound(h, { type: 'player_message', text: '@dm what do I see?' })

    // The chat message itself is still persisted + broadcast.
    expect(h.publishes.map((p) => p.frame.type)).toContain('player_message')

    // Explicit fast-path: dm_thinking is broadcast IMMEDIATELY (input locks),
    // then one session-turn is enqueued with trigger.kind='explicit'.
    expect(h.dmThinkingCalls).toHaveLength(1)
    expect(h.dmThinkingCalls[0]?.campaignId).toBe(CAMPAIGN_ID)
    const turnId = h.dmThinkingCalls[0]?.turnId
    expect(typeof turnId).toBe('string')

    expect(h.turnAdds).toHaveLength(1)
    const payload = h.turnAdds[0]?.payload as {
      campaignId: string
      sessionId: string
      turnId: string
      trigger: { kind: string }
      maxConsumedSeq: number
      triggerMessages: { text: string }[]
    }
    expect(payload.campaignId).toBe(CAMPAIGN_ID)
    expect(payload.sessionId).toBe(SESSION_ID)
    expect(payload.turnId).toBe(turnId) // same turnId the dm_thinking carried
    expect(payload.trigger).toEqual({ kind: 'explicit' })
    expect(payload.maxConsumedSeq).toBe(1)
    expect(payload.triggerMessages).toHaveLength(1)

    // EXPLICIT bypasses the dm-trigger debounce queue entirely.
    expect(h.dmTriggerAdds).toHaveLength(0)
  })

  it('player_message ("@DM …" mixed-case): also takes the EXPLICIT path (prefix is case-insensitive)', async () => {
    const h = makeHarness({
      rows: [{ seq: 1, userId: USER_ID, messageType: 'player_message', content: '@DM, a question' }],
      triggerOver: { isResponding: vi.fn().mockResolvedValue(false) },
    })
    await inbound(h, { type: 'player_message', text: '  @DM, a question' })
    expect(h.dmThinkingCalls).toHaveLength(1)
    expect(h.turnAdds).toHaveLength(1)
    expect(h.dmTriggerAdds).toHaveLength(0)
  })

  it('explicit (isResponding=true): sets the explicit-pending flag, does NOT enqueue or broadcast dm_thinking', async () => {
    const h = makeHarness({
      triggerOver: { isResponding: vi.fn().mockResolvedValue(true) },
    })
    await inbound(h, { type: 'dm_invoke' })

    expect(h.triggerCalls.setExplicitPending).toHaveBeenCalledWith(CAMPAIGN_ID)
    expect(h.turnAdds).toHaveLength(0)
    expect(h.dmThinkingCalls).toHaveLength(0)
  })

  it('dm_invoke (isResponding=false): EXPLICIT path → dmThinking + enqueueTurn(explicit); not persisted as chat', async () => {
    const h = makeHarness({
      rows: [{ seq: 3, userId: USER_ID, messageType: 'player_message', content: 'earlier line' }],
      triggerOver: { isResponding: vi.fn().mockResolvedValue(false), respondedSeq: vi.fn().mockResolvedValue(0) },
    })
    await inbound(h, { type: 'dm_invoke' })

    // dm_invoke carries no text → never persisted/broadcast as a chat message.
    expect(h.publishes.map((p) => p.frame.type)).not.toContain('player_message')
    // Explicit fast-path fired.
    expect(h.dmThinkingCalls).toHaveLength(1)
    expect(h.turnAdds).toHaveLength(1)
    expect((h.turnAdds[0]?.payload as { trigger: { kind: string } }).trigger).toEqual({ kind: 'explicit' })
    expect((h.turnAdds[0]?.payload as { maxConsumedSeq: number }).maxConsumedSeq).toBe(3)
    expect(h.dmTriggerAdds).toHaveLength(0)
  })

  it('explicit rate limit: the 11th summon within the 60s window is dropped (no enqueue), and the expiry is set on the first', async () => {
    const h = makeHarness({
      triggerOver: { isResponding: vi.fn().mockResolvedValue(false) },
    })
    // Fire 10 explicit summons — all within the per-(campaign,user) window.
    for (let i = 0; i < 10; i++) {
      await inbound(h, { type: 'dm_invoke' })
    }
    expect(h.turnAdds).toHaveLength(10)
    expect(h.dmThinkingCalls).toHaveLength(10)

    // The 11th is over the ceiling → dropped (no new turn, no new dm_thinking),
    // and a rate-limit warning is logged.
    await inbound(h, { type: 'dm_invoke' })
    expect(h.turnAdds).toHaveLength(10)
    expect(h.dmThinkingCalls).toHaveLength(10)
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN_ID, userId: USER_ID }),
      'ws-session explicit summon rate-limited — dropped',
    )

    // The window key carries a TTL (set on the first INCR) so it self-expires.
    const ttl = await h.redis.ttl(`${h.keyPrefix}explicit-rate:${CAMPAIGN_ID}:${USER_ID}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60)
  })

  it('a debounce reschedule failure is logged at WARN and does NOT throw (message already persisted+broadcast)', async () => {
    const h = makeHarness()
    // Make the dm-trigger queue's add reject.
    ;(h.deps.dmTriggerQueue as { add: unknown }).add = (() =>
      Promise.reject(new Error('queue down'))) as WsSessionDeps['dmTriggerQueue']['add']

    await expect(inbound(h, { type: 'player_message', text: 'hello there' })).resolves.toBeUndefined()
    // The message was still persisted+broadcast before the reschedule.
    expect(h.publishes.map((p) => p.frame.type)).toContain('player_message')
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
      'ws-session debounce reschedule failed',
    )
  })
})
