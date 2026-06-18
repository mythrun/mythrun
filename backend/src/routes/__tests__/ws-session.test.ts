// backend/src/routes/__tests__/ws-session.test.ts
//
// Integration test for the MYT-65 Task 7 WebSocket session route. Boots an
// EPHEMERAL Fastify app (register @fastify/websocket + the wsSessionRoutes
// plugin), wires a REAL createSessionHub + makeSessionState over a real Redis
// (:6379) + a test-pool repo + a recording stub suspend queue, and drives the
// route with the @fastify/websocket `app.injectWS` test client.
//
// Why injectWS rather than app.listen({port:0}) + the `ws` client lib: `ws`
// isn't a direct backend dependency (it's the @fastify/websocket peer, not
// importable from this package), and injectWS performs the SAME real upgrade
// handshake against the in-memory server — on a successful 101 it resolves an
// opened `ws` WebSocket client, and on a PRE-UPGRADE reply (the preHandler's
// reply.code(401).send()) it REJECTS with "Unexpected server response: 401",
// which is exactly the no-socket-opens assertion the enforced-ignorance
// handshake must guarantee. That rejection IS the proof the preHandler
// rejects before the upgrade completes.
//
// Real Redis + createTestPool per CONVENTIONS.md. Scoped fixtures isolate
// rows; the hub + sessionState use a per-run key prefix so a parallel worker
// doesn't see this run's pub/sub or presence keys.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createRedisClient } from '../../redis/client.js'
import { createRepo } from '../../repo/index.js'
import { createUsersRepo } from '../../repo/users.js'
import { createWorldsRepo } from '../../repo/worlds.js'
import { createCampaignsRepo } from '../../repo/campaigns.js'
import { createCharactersRepo } from '../../repo/characters.js'
import { createSessionsRepo } from '../../repo/sessions.js'
import { createSessionHub, type SessionHub } from '../../ws/session-hub.js'
import { makeSessionState } from '../../redis/session-state.js'
import { makeTriggerState } from '../../session/trigger-state.js'
import { createTurnPublisher } from '../../session/turn-publisher.js'
import { createSessionLock } from '../../session/session-lock.js'
import { mintWsTicket } from '../../auth/ws-ticket.js'
import type { ServerFrame } from '../../contract/session-events.js'
import type { SuspendQueueLike } from '../../session/session-suspend.js'
import type { TurnQueueLike } from '../../session/turn-queue.js'
import type { DmTriggerQueueLike } from '../../session/dm-trigger-queue.js'
import type { ReconcileQueueLike } from '../../session/session-reconcile.js'
import { wsSessionRoutes, type WsSessionDeps } from '../ws-session.js'

/** A no-op session-turn / dm-trigger / reconcile producer for the integration
 *  suite. The existing connect/persist/disconnect tests don't assert on a turn
 *  or reconcile enqueue; the explicit-trigger path is unit-covered in
 *  ws-session-trigger.test.ts and the end flow in ws-session-end.test.ts. */
function noopTurnQueue(): TurnQueueLike {
  return { add: (() => Promise.resolve(undefined)) as unknown as TurnQueueLike['add'] }
}
function noopDmTriggerQueueLocal(): DmTriggerQueueLike {
  return { add: (() => Promise.resolve(undefined)) as unknown as DmTriggerQueueLike['add'] }
}
function noopReconcileQueue(): ReconcileQueueLike {
  return { add: (() => Promise.resolve(undefined)) as unknown as ReconcileQueueLike['add'] }
}

const databaseUrl = process.env.DATABASE_URL ?? ''
const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'

// Per-run key prefix so parallel workers / re-runs don't share pub/sub
// channels, presence keys, or ws-ticket keys.
const KEY_PREFIX = `test:wss:${Math.random().toString(36).slice(2, 10)}:`
const TICKET_PREFIX = `${KEY_PREFIX}ws:ticket:`
const CONTAINER_ID = 'test-container-1'

const sheetInput = {
  name: 'Aila Thornwood',
  level: 1,
  class: 'Ranger',
  species: 'Half-Elf',
  background: 'Outlander',
  str: 12,
  dex: 16,
  con: 13,
  int: 11,
  wis: 14,
  cha: 10,
  hitPoints: 11,
  maxHitPoints: 11,
  armorClass: 14,
  proficiencyBonus: 2,
  // MYT-70 ledger-init fields (empty sub-tables → no per-entry fields).
  startingGold: 0,
  hitDie: 8,
  hitDiceRemaining: 1,
  spellcastingProgression: 'none',
  slotRows: [],
  skills: [],
  features: [],
  equipment: [],
  spells: [],
} as const

/** A recording stub of the suspend queue's producer surface. */
interface RecordingSuspendQueue extends SuspendQueueLike {
  readonly adds: { sessionId: string; jobId: string | undefined }[]
  readonly removes: string[]
}

function makeRecordingSuspendQueue(): RecordingSuspendQueue {
  const adds: { sessionId: string; jobId: string | undefined }[] = []
  const removes: string[] = []
  const queue: RecordingSuspendQueue = {
    adds,
    removes,
    add: ((_name, data, opts) => {
      adds.push({ sessionId: data.sessionId, jobId: opts?.jobId })
      return Promise.resolve({ id: opts?.jobId } as never)
    }) as SuspendQueueLike['add'],
    getJob: (() => Promise.resolve(undefined)) as SuspendQueueLike['getJob'],
    remove: (jobId) => {
      removes.push(jobId)
      return Promise.resolve(1 as never)
    },
  }
  return queue
}

// `ws` isn't a direct dependency (it's the @fastify/websocket peer), so we
// model the subset of the client `app.injectWS` returns that this test uses,
// rather than importing the `ws` types. `injectWS`'s declared return type
// references `ws`'s WebSocket; we cast through this local view at the call site.
interface WsClient {
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'message', listener: (data: { toString(): string }) => void): void
  off(event: 'message', listener: (data: { toString(): string }) => void): void
}

/** Collect the next N parsed server frames from an open ws client. */
function collectFrames(ws: WsClient, n: number, timeoutMs = 4000): Promise<ServerFrame[]> {
  return new Promise<ServerFrame[]>((resolve, reject) => {
    const frames: ServerFrame[] = []
    const timer = setTimeout(() => {
      reject(
        new Error(
          `collectFrames timed out after ${String(timeoutMs)}ms with ${String(
            frames.length,
          )}/${String(n)} frames: ${JSON.stringify(frames)}`,
        ),
      )
    }, timeoutMs)
    const onMessage = (raw: { toString(): string }): void => {
      frames.push(JSON.parse(raw.toString()) as ServerFrame)
      if (frames.length >= n) {
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(frames)
      }
    }
    ws.on('message', onMessage)
  })
}

describe('ws-session route (integration)', () => {
  let pool: Pool
  let redis: Redis
  let hub: SessionHub
  // Reassigned per test (fresh ephemeral app); undefined before the first
  // beforeEach, so the `if (app)` close-guards are genuine.
  let app: FastifyInstance | undefined
  let suspendQueue: RecordingSuspendQueue
  let scope: TestScope

  let userId: string
  let strangerId: string
  // Accepted member with NO integrated character — passes the auth handshake
  // but trips sessionParticipants.join (NoCharacterForParticipantError),
  // exercising the connect-failure → socket-close path.
  let noCharMemberId: string
  let campaignId: string
  let sessionId: string
  let displayName: string

  async function cleanupScope(): Promise<void> {
    // session_participants pins characters via RESTRICT-FK → delete those rows
    // before the scope's characters/users. CASCADE handles sessions on the
    // campaign delete inside cleanupTestScope.
    await pool.query(
      `DELETE FROM session_participants
         WHERE character_id IN (
           SELECT id FROM characters
            WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)
         )`,
      [`${scope.id}%`],
    )
    await pool.query(
      `DELETE FROM characters
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
      [`${scope.id}%`],
    )
    await cleanupTestScope(pool, scope)
  }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    redis = createRedisClient(redisUrl)
    await redis.connect()
    scope = makeTestScope('wssession')

    hub = await createSessionHub({
      redis,
      keyPrefix: KEY_PREFIX,
      // Silent pino-shaped logger — the hub only logs on reconnect/error paths
      // we don't exercise here.
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as never,
    })
  })

  afterAll(async () => {
    await cleanupScope()
    if (app) await app.close()
    await hub.close()
    await redis.quit()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupScope()
    suspendQueue = makeRecordingSuspendQueue()

    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const characters = createCharactersRepo(pool)
    const sessions = createSessionsRepo(pool)

    const owner = await users.create(pool, {
      cognitoSub: scope.userSub(0),
      username: scope.username(0),
      displayName: scope.displayName(0),
    })
    userId = owner.id
    displayName = owner.displayName

    const stranger = await users.create(pool, {
      cognitoSub: scope.userSub(1),
      username: scope.username(1),
      displayName: scope.displayName(1),
    })
    strangerId = stranger.id

    const noCharMember = await users.create(pool, {
      cognitoSub: scope.userSub(2),
      username: scope.username(2),
      displayName: scope.displayName(2),
    })
    noCharMemberId = noCharMember.id

    const world = await worlds.create({
      createdBy: userId,
      name: scope.worldName(0),
      concept: 'A test world.',
    })
    const campaign = await campaigns.create({
      worldId: world.id,
      createdBy: userId,
      name: scope.campaignName(0),
      status: 'active',
    })
    campaignId = campaign.id
    // Owner is an accepted member; the stranger gets a PENDING (not-accepted)
    // membership so the 403 case exercises requireCampaignMember's exact
    // `!member?.inviteAccepted` predicate.
    await campaigns.addMember({ campaignId, userId, role: 'owner', inviteAccepted: true })
    await campaigns.addMember({
      campaignId,
      userId: strangerId,
      role: 'player',
      inviteAccepted: false,
    })
    // Accepted member, but we deliberately DON'T give them a character.
    await campaigns.addMember({
      campaignId,
      userId: noCharMemberId,
      role: 'player',
      inviteAccepted: true,
    })

    // The owner needs an integrated character for sessionParticipants.join.
    await characters.replaceSubTables({ campaignId, userId, ...sheetInput })

    const session = await sessions.create({ campaignId, sessionNumber: 1, status: 'active' })
    sessionId = session.id

    // Fresh ephemeral app per test so a prior test's hub registry / presence
    // doesn't bleed in. The hub itself is shared (one PSUBSCRIBE per run).
    if (app) await app.close()
    app = Fastify({ logger: false })
    await app.register(websocket)
    const deps: WsSessionDeps = {
      repo: createRepo(pool),
      sessionState: makeSessionState(redis, KEY_PREFIX),
      hub,
      suspendQueue,
      containerId: CONTAINER_ID,
      redisRealtime: redis,
      redisKeyPrefix: KEY_PREFIX,
      dmTriggerQueue: noopDmTriggerQueueLocal(),
      sessionTurnQueue: noopTurnQueue(),
      triggerState: makeTriggerState(redis, KEY_PREFIX),
      turnPublisher: createTurnPublisher(redis, KEY_PREFIX),
      reconcileQueue: noopReconcileQueue(),
      lock: createSessionLock(redis, KEY_PREFIX, 45_000),
    }
    await app.register(wsSessionRoutes, deps)
    await app.ready()
  })

  async function mint(forSessionId = sessionId, forUserId = userId): Promise<string> {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: TICKET_PREFIX },
      { userId: forUserId, sessionId: forSessionId, campaignId },
    )
    return ticket
  }

  /** The current ephemeral app (always assigned by beforeEach before any
   *  `it` body runs); centralizes the non-null narrowing. */
  function currentApp(): FastifyInstance {
    if (!app) throw new Error('test app not initialized')
    return app
  }

  /** Open a ws client against the current app via injectWS. Returns the typed
   *  client subset (WsClient) — see the WsClient note for why we model it. */
  function connect(path: string): Promise<WsClient> {
    return currentApp().injectWS(path)
  }

  it('rejects the upgrade pre-handshake when the ticket is absent (no socket)', async () => {
    // injectWS REJECTS (no socket opens) when the preHandler replies pre-upgrade
    // — the proof the enforced-ignorance handshake rejects before the upgrade.
    await expect(connect(`/ws/session/${sessionId}`)).rejects.toThrow(/401/)
  })

  it('rejects the upgrade pre-handshake for a bad/unknown ticket (no socket)', async () => {
    await expect(
      connect(`/ws/session/${sessionId}?ticket=not-a-real-ticket`),
    ).rejects.toThrow(/401/)
  })

  it('rejects (401) when the ticket is bound to a DIFFERENT sessionId', async () => {
    // Mint a ticket whose payload.sessionId points at some OTHER session.
    const otherSessionId = '00000000-0000-7000-8000-000000000999'
    const ticket = await mint(otherSessionId)
    await expect(connect(`/ws/session/${sessionId}?ticket=${ticket}`)).rejects.toThrow(/401/)
  })

  it('rejects (403) a non-accepted-member (pending invite)', async () => {
    const ticket = await mint(sessionId, strangerId)
    await expect(connect(`/ws/session/${sessionId}?ticket=${ticket}`)).rejects.toThrow(/403/)
  })

  it('replies 503 (not 500) when the ticket-store consume THROWS (transient Redis)', async () => {
    // A throwing GETDEL (Redis wobble) must surface as 503 — operationally
    // distinct from a stale-ticket 401 — and still fail closed (no socket).
    // Build a one-off app whose redisRealtime throws on `getdel` (the method
    // consumeWsTicket calls); everything else stays the real wiring.
    const ticket = await mint()
    const throwingRedis = new Proxy(redis, {
      get(target, prop, receiver: unknown) {
        if (prop === 'getdel') {
          return () => Promise.reject(new Error('ECONNRESET: redis transient'))
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const throwApp = Fastify({ logger: false })
    await throwApp.register(websocket)
    await throwApp.register(wsSessionRoutes, {
      repo: createRepo(pool),
      sessionState: makeSessionState(redis, KEY_PREFIX),
      hub,
      suspendQueue,
      containerId: CONTAINER_ID,
      redisRealtime: throwingRedis,
      redisKeyPrefix: KEY_PREFIX,
      dmTriggerQueue: noopDmTriggerQueueLocal(),
      sessionTurnQueue: noopTurnQueue(),
      triggerState: makeTriggerState(redis, KEY_PREFIX),
      turnPublisher: createTurnPublisher(redis, KEY_PREFIX),
      reconcileQueue: noopReconcileQueue(),
      lock: createSessionLock(redis, KEY_PREFIX, 45_000),
    })
    await throwApp.ready()
    try {
      await expect(
        throwApp.injectWS(`/ws/session/${sessionId}?ticket=${ticket}`),
      ).rejects.toThrow(/503/)
    } finally {
      await throwApp.close()
    }
  })

  it('valid ticket → session_ready first, presence 1, player_joined broadcast', async () => {
    const sessionState = makeSessionState(redis, KEY_PREFIX)
    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}`)
    try {
      // The connect path broadcasts player_joined (via the hub → cross-process
      // pub/sub → back to this same registered socket) AND sends session_ready
      // directly. Both arrive; assert session_ready is present and a
      // player_joined was broadcast.
      const frames = await collectFrames(ws, 2)
      const types = frames.map((f) => f.type)
      expect(types).toContain('session_ready')
      expect(types).toContain('player_joined')
      const joined = frames.find((f) => f.type === 'player_joined')
      expect(joined).toMatchObject({ userId, displayName })
      // player_joined is a seq-LESS presence frame — it must NOT carry a seq
      // (only player_message advances the seq stream; arch overview §5.2).
      expect(joined).not.toHaveProperty('seq')

      expect(await sessionState.countPresence(campaignId)).toBe(1)
      // A returning player cancels any pending suspend on connect.
      expect(suspendQueue.removes).toContain(`suspend-${sessionId}`)
    } finally {
      ws.terminate()
    }
  })

  it('MYT-68: a join does NOT write the FT roster onto :state.participants (worker-derived now)', async () => {
    // The racy :state.participants read-modify-write was DELETED: two
    // simultaneous joins lost a name to last-write-wins (caught live in the
    // MYT-68 smoke). The roster is now worker-derived per turn from
    // session_participants — the join path must leave :state.participants alone.
    // Seed an empty-participants blob; after a join it must STILL be empty (the
    // join wrote the session_participants row, not this blob).
    const repo = createRepo(pool)
    const sessionState = makeSessionState(redis, KEY_PREFIX)
    await sessionState.setState(campaignId, {
      participants: [],
      mode: 'exploration',
      status: 'active',
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}`)
    try {
      await collectFrames(ws, 2) // drain session_ready + player_joined
      // The join persisted the participant row (the worker's source of truth)…
      await vi.waitFor(
        async () => {
          const participants = await repo.sessionParticipants.list(sessionId)
          expect(participants).toHaveLength(1)
        },
        { timeout: 4000, interval: 50 },
      )
      // …but did NOT touch :state.participants (the old racy RMW is gone).
      const blob = await sessionState.getState(campaignId)
      expect(blob?.participants).toEqual([])
    } finally {
      ws.terminate()
    }
  })

  it('MYT-68 §3.7: reconnect replay reconstructs dm_message + skill_check frames; a corrupt row is dropped', async () => {
    const repo = createRepo(pool)
    // A player message at seq 1, then a DM turn (dm_text + skill_check + a
    // CORRUPT skill_check) at seqs 2/3/4. appendDmTurn writes them with a shared
    // turn_id in ordinal order.
    await repo.sessionMessages.append({
      sessionId,
      seq: 1,
      userId,
      messageType: 'player_message',
      content: 'I search the altar.',
    })
    const turnId = '01900000-0000-7000-8000-0000000000aa'
    const skillOutput = {
      character_name: sheetInput.name,
      skill: 'Investigation',
      context: 'searching the altar',
      roll: 14,
      roll2: null,
      roll_type: 'normal',
      modifier: 3,
      total: 17,
      dc: 12,
      outcome_tier: 'success',
      constraint: 'You find a hidden catch beneath the lip of the stone.',
    }
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'The altar is cold beneath your fingers.' },
        {
          kind: 'skill_check',
          content: JSON.stringify({ toolCallId: 'tc-1', input: {}, output: skillOutput }),
        },
        // Corrupt: non-JSON content → must be dropped, the rest intact.
        { kind: 'skill_check', content: 'not-json{' },
      ],
      seqs: [2, 3, 4],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      expect(first?.type).toBe('session_reconnect')
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')

      // The corrupt seq-4 row was dropped; the other three replay in seq order.
      expect(first.messages.map((m) => m.type)).toEqual([
        'player_message',
        'dm_message',
        'skill_check',
      ])
      const [playerFrame, dmFrame, skillFrame] = first.messages
      expect(playerFrame).toMatchObject({ type: 'player_message', seq: 1, text: 'I search the altar.' })
      expect(dmFrame).toMatchObject({
        type: 'dm_message',
        seq: 2,
        turnId,
        text: 'The altar is cold beneath your fingers.',
      })
      expect(skillFrame).toMatchObject({
        type: 'skill_check',
        seq: 3,
        turnId,
        characterName: sheetInput.name,
        skill: 'Investigation',
        context: 'searching the altar',
        roll: 14,
        roll2: null,
        rollType: 'normal',
        modifier: 3,
        total: 17,
        dc: 12,
        outcomeTier: 'success',
        constraint: 'You find a hidden catch beneath the lip of the stone.',
      })
    } finally {
      ws.terminate()
    }
  })

  it('MYT-68 §3.7: reconnect replay reconstructs a dice_roll frame', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-0000000000bb'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        {
          kind: 'dice_roll',
          content: JSON.stringify({
            toolCallId: 'tc-d1',
            input: { count: 2, sides: 6 },
            // count/sides absent on output → fall back to input.
            output: { results: [3, 5], total: 8 },
          }),
        },
      ],
      seqs: [1],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      expect(first.messages).toHaveLength(1)
      expect(first.messages[0]).toMatchObject({
        type: 'dice_roll',
        seq: 1,
        turnId,
        count: 2,
        sides: 6,
        results: [3, 5],
        total: 8,
      })
    } finally {
      ws.terminate()
    }
  })

  it('MYT-68 §3.7: a skill_check row with valid JSON but an ill-typed field is dropped, rest intact', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-0000000000cc'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'The lock resists.' },
        {
          kind: 'skill_check',
          // Parses fine, but roll_type is not in the union and roll is a string
          // → the field-validation arm drops it.
          content: JSON.stringify({
            toolCallId: 'tc-bad',
            input: {},
            output: {
              character_name: sheetInput.name,
              skill: 'Sleight of Hand',
              context: 'picking the lock',
              roll: '14',
              roll2: null,
              roll_type: 'bogus',
              modifier: 3,
              total: 17,
              dc: 12,
              outcome_tier: 'success',
              constraint: 'unused',
            },
          }),
        },
      ],
      seqs: [1, 2],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      // The ill-typed skill_check dropped; the dm_text frame replays intact.
      expect(first.messages.map((m) => m.type)).toEqual(['dm_message'])
      expect(first.messages[0]).toMatchObject({ type: 'dm_message', seq: 1, turnId })
    } finally {
      ws.terminate()
    }
  })

  it('MYT-68 §3.7: a dice_roll row with unparseable content is dropped, rest intact', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-0000000000dd'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'The dice clatter.' },
        { kind: 'dice_roll', content: 'not-json{' },
      ],
      seqs: [1, 2],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      expect(first.messages.map((m) => m.type)).toEqual(['dm_message'])
    } finally {
      ws.terminate()
    }
  })

  it('MYT-68 §3.7: a dice_roll row with valid JSON but an ill-typed field is dropped, rest intact', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-0000000000ee'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'A single die skitters off the table.' },
        {
          kind: 'dice_roll',
          // Parses fine, but results holds a non-number and count is absent
          // from BOTH output and input → the field-validation arm drops it.
          content: JSON.stringify({
            toolCallId: 'tc-bad-dice',
            input: { sides: 6 },
            output: { sides: 6, results: [3, 'five'], total: 8 },
          }),
        },
      ],
      seqs: [1, 2],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      expect(first.messages.map((m) => m.type)).toEqual(['dm_message'])
    } finally {
      ws.terminate()
    }
  })

  it('MYT-68 §3.7: replay branch sweep — null turnIds, all roll-type/outcome unions, output-carried dice fields, non-object content', async () => {
    // Plain `append` writes rows with a NULL turn_id (only appendDmTurn sets
    // it), exercising every `row.turnId ?? ''` fallback. The valid rows sweep
    // the union members the other tests don't (advantage / disadvantage,
    // great_success / fail, roll2 as a number, count/sides carried on output);
    // the corrupt rows sweep parseDmRowContent's non-object arm and asRecord's
    // non-object-output arm.
    const repo = createRepo(pool)
    const skill = (over: Record<string, unknown>): string =>
      JSON.stringify({
        toolCallId: 'tc-s',
        input: {},
        output: {
          character_name: sheetInput.name,
          skill: 'Athletics',
          context: 'climbing',
          roll: 11,
          roll2: 18,
          roll_type: 'advantage',
          modifier: 2,
          total: 20,
          dc: 15,
          outcome_tier: 'great_success',
          constraint: 'You crest the wall in one clean pull.',
          ...over,
        },
      })
    const rows: { type: string; content: string }[] = [
      { type: 'dm_text', content: 'A lone DM line with no turn.' }, // null turnId → ''
      { type: 'skill_check', content: skill({}) }, // advantage + great_success + roll2 number
      { type: 'skill_check', content: skill({ roll_type: 'disadvantage', outcome_tier: 'fail' }) },
      {
        type: 'dice_roll',
        // count/sides carried on OUTPUT (no input fallback needed).
        content: JSON.stringify({ toolCallId: 'tc-d', input: {}, output: { count: 1, sides: 20, results: [13], total: 13 } }),
      },
      {
        // An ok:true ledger_update row with a NULL turn_id → exercises the
        // ledger frame's `row.turnId ?? ''` fallback (parseLedgerUpdateRow path).
        type: 'spend_resource',
        content: JSON.stringify({
          toolCallId: 'tc-l',
          input: {},
          output: {
            ok: true,
            payload: { characterName: sheetInput.name, kind: 'gold', summary: 'Pays 3 gold.', gold: 3 },
          },
        }),
      },
      { type: 'skill_check', content: '42' }, // valid JSON, not an object → drop
      {
        type: 'skill_check',
        // Parses to an object but output is a string → asRecord null → drop.
        content: JSON.stringify({ toolCallId: 'tc-x', input: {}, output: 'nope' }),
      },
      // An unmapped messageType (a future row kind) → the default arm drops it.
      { type: 'st_evaluation', content: 'not a replayable row kind' },
    ]
    for (const [i, row] of rows.entries()) {
      await repo.sessionMessages.append({
        sessionId,
        seq: i + 1,
        userId: null,
        messageType: row.type,
        content: row.content,
      })
    }

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      // The two corrupt rows (seqs 6, 7) + the unmapped row kind (seq 8)
      // dropped; the five valid frames replay with null turn_id degraded to ''.
      expect(first.messages.map((m) => m.type)).toEqual([
        'dm_message',
        'skill_check',
        'skill_check',
        'dice_roll',
        'ledger_update',
      ])
      expect(first.messages[4]).toMatchObject({
        type: 'ledger_update',
        seq: 5,
        turnId: '',
        kind: 'gold',
        gold: 3,
      })
      expect(first.messages[0]).toMatchObject({ type: 'dm_message', seq: 1, turnId: '' })
      expect(first.messages[1]).toMatchObject({
        type: 'skill_check',
        seq: 2,
        turnId: '',
        roll2: 18,
        rollType: 'advantage',
        outcomeTier: 'great_success',
      })
      expect(first.messages[2]).toMatchObject({
        type: 'skill_check',
        seq: 3,
        rollType: 'disadvantage',
        outcomeTier: 'fail',
      })
      expect(first.messages[3]).toMatchObject({
        type: 'dice_roll',
        seq: 4,
        turnId: '',
        count: 1,
        sides: 20,
        results: [13],
        total: 13,
      })
    } finally {
      ws.terminate()
    }
  })

  it('MYT-70 §8: an ok:true cast_spell row → a spell_slot ledger_update frame (characterName + seq)', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-00000000a001'
    // The persisted OUTPUT is the resolver's LedgerResolution success arm:
    // { ok: true, payload: LedgerUpdatePayload }.
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        {
          kind: 'cast_spell',
          content: JSON.stringify({
            toolCallId: 'tc-cs1',
            input: { characterName: sheetInput.name, spellName: 'Cure Wounds', slotLevel: 1 },
            output: {
              ok: true,
              payload: {
                characterName: sheetInput.name,
                kind: 'spell_slot',
                summary: `${sheetInput.name} casts Cure Wounds (1 level-1 slot remaining).`,
                slotLevel: 1,
                slotsRemaining: 1,
              },
            },
          }),
        },
      ],
      seqs: [1],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      expect(first.messages).toHaveLength(1)
      expect(first.messages[0]).toMatchObject({
        type: 'ledger_update',
        turnId,
        seq: 1,
        characterName: sheetInput.name,
        kind: 'spell_slot',
        summary: `${sheetInput.name} casts Cure Wounds (1 level-1 slot remaining).`,
        slotLevel: 1,
        slotsRemaining: 1,
      })
    } finally {
      ws.terminate()
    }
  })

  it('MYT-70 §8: an ok:false ledger row is SILENTLY skipped — no frame, no warn', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-00000000a002'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'The vial is empty.' },
        {
          kind: 'spend_resource',
          // A binding rejection — expected, NOT corrupt. Replay drops the frame
          // but must NOT warn (distinct from the corrupt-blob warn path).
          content: JSON.stringify({
            toolCallId: 'tc-sr-rej',
            input: { characterName: sheetInput.name, resource: 'Potion of Healing' },
            output: {
              ok: false,
              binding: true,
              found: true,
              constraint: 'There are no Potions of Healing left to spend.',
            },
          }),
        },
      ],
      seqs: [1, 2],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      // The ok:false row produced NO frame; the dm_text replays intact.
      expect(first.messages.map((m) => m.type)).toEqual(['dm_message'])
      // The rejection is expected, not corrupt → the warn log must NOT fire for it.
      // (No corrupt rows in this turn, so no warn at all.)
      const warn = app?.log.warn
      if (warn && 'mock' in warn) {
        const calls = (warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
        const droppedLedger = calls.some((c) =>
          c.some((a) => typeof a === 'string' && a.includes('dropped corrupt')),
        )
        expect(droppedLedger).toBe(false)
      }
    } finally {
      ws.terminate()
    }
  })

  it('MYT-70 §8: a ledger row whose output.ok is neither true nor false is dropped + WARNED (corrupt blob)', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-00000000a009'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'A strange shimmer in the ledger.' },
        {
          kind: 'spend_resource',
          // A persisted output whose `ok` discriminant is a non-boolean: a valid
          // record (so it passes asRecord), but neither the ok:true success nor
          // the ok:false rejection arm — a corrupt blob → dropped + WARNED.
          content: JSON.stringify({
            toolCallId: 'tc-sr-corrupt',
            input: { characterName: sheetInput.name, resource: 'Potion of Healing' },
            output: { ok: 'maybe', payload: { characterName: sheetInput.name } },
          }),
        },
      ],
      seqs: [1, 2],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      // The corrupt-ok row produced NO ledger_update frame; the dm_text replays.
      expect(first.messages.map((m) => m.type)).toEqual(['dm_message'])
      // A malformed blob → the corrupt-drop warn MUST fire (distinct from ok:false).
      const warn = app?.log.warn
      if (warn && 'mock' in warn) {
        const calls = (warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
        const droppedLedger = calls.some((c) =>
          c.some((a) => typeof a === 'string' && a.includes('dropped corrupt ledger_update row')),
        )
        expect(droppedLedger).toBe(true)
      }
    } finally {
      ws.terminate()
    }
  })

  it('MYT-70 §8: a take_rest row affecting two characters → two ledger_update frames', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-00000000a003'
    // take_rest persists ONE row whose payload is an ARRAY (one entry per
    // character); replay emits one frame per entry.
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        {
          kind: 'take_rest',
          content: JSON.stringify({
            toolCallId: 'tc-rest',
            input: { type: 'short' },
            output: {
              ok: true,
              payload: [
                {
                  characterName: sheetInput.name,
                  kind: 'rest',
                  summary: `${sheetInput.name} takes a short rest (12/12 HP).`,
                  hp: 12,
                  maxHp: 12,
                  diceRolled: [5],
                },
                {
                  characterName: 'Borin Stoneff',
                  kind: 'rest',
                  summary: 'Borin Stoneff takes a short rest (9/14 HP).',
                  hp: 9,
                  maxHp: 14,
                  diceRolled: [],
                },
              ],
            },
          }),
        },
      ],
      seqs: [1],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      expect(first.messages.map((m) => m.type)).toEqual(['ledger_update', 'ledger_update'])
      expect(first.messages[0]).toMatchObject({
        type: 'ledger_update',
        turnId,
        seq: 1,
        characterName: sheetInput.name,
        kind: 'rest',
        hp: 12,
        maxHp: 12,
        diceRolled: [5],
      })
      expect(first.messages[1]).toMatchObject({
        type: 'ledger_update',
        turnId,
        seq: 1,
        characterName: 'Borin Stoneff',
        kind: 'rest',
        hp: 9,
        maxHp: 14,
        diceRolled: [],
      })
    } finally {
      ws.terminate()
    }
  })

  it('MYT-70 §8: an update_condition row with changed:false replays NO frame', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-00000000a004'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'Nothing changes.' },
        {
          kind: 'update_condition',
          // changed:false no-op — same rule as live emission: replay no frame.
          content: JSON.stringify({
            toolCallId: 'tc-cond-noop',
            input: { characterName: sheetInput.name, condition: 'prone', apply: false },
            output: {
              ok: true,
              payload: {
                characterName: sheetInput.name,
                kind: 'condition',
                changed: false,
                summary: `${sheetInput.name}'s prone state is unchanged (no-op).`,
                condition: 'prone',
              },
            },
          }),
        },
      ],
      seqs: [1, 2],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      // The changed:false condition produced NO frame; the dm_text replays.
      expect(first.messages.map((m) => m.type)).toEqual(['dm_message'])
    } finally {
      ws.terminate()
    }
  })

  it('MYT-70 §8: an update_condition row with changed:true → one condition ledger_update frame', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-00000000a005'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        {
          kind: 'update_condition',
          content: JSON.stringify({
            toolCallId: 'tc-cond',
            input: { characterName: sheetInput.name, condition: 'poisoned', apply: true },
            output: {
              ok: true,
              payload: {
                characterName: sheetInput.name,
                kind: 'condition',
                changed: true,
                summary: `${sheetInput.name} is now poisoned.`,
                condition: 'poisoned',
              },
            },
          }),
        },
      ],
      seqs: [1],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      expect(first.messages).toHaveLength(1)
      expect(first.messages[0]).toMatchObject({
        type: 'ledger_update',
        turnId,
        seq: 1,
        characterName: sheetInput.name,
        kind: 'condition',
        condition: 'poisoned',
        summary: `${sheetInput.name} is now poisoned.`,
      })
    } finally {
      ws.terminate()
    }
  })

  it('MYT-70 §8: a corrupt ledger blob is dropped + warned (distinct from the silent ok:false skip)', async () => {
    const repo = createRepo(pool)
    const turnId = '01900000-0000-7000-8000-00000000a006'
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId,
      rows: [
        { kind: 'dm_text', content: 'A flask shatters.' },
        // Non-JSON content → corrupt blob → drop + warn (the existing posture).
        { kind: 'acquire_resource', content: 'not-json{' },
        // Valid JSON but payload missing required fields → drop + warn.
        {
          kind: 'adjust_hp',
          content: JSON.stringify({
            toolCallId: 'tc-hp-bad',
            input: {},
            output: { ok: true, payload: { kind: 'hp' } },
          }),
        },
      ],
      seqs: [1, 2, 3],
    })

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=0`)
    try {
      const [first] = await collectFrames(ws, 1)
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')
      // Both corrupt rows dropped; only the dm_text replays.
      expect(first.messages.map((m) => m.type)).toEqual(['dm_message'])
      const warn = app?.log.warn
      if (warn && 'mock' in warn) {
        const calls = (warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
        const dropped = calls.filter((c) =>
          c.some((a) => typeof a === 'string' && a.includes('dropped corrupt ledger_update')),
        )
        expect(dropped.length).toBe(2)
      }
    } finally {
      ws.terminate()
    }
  })

  it('reconnect with ?lastSeq=N → session_reconnect replaying only seq > N (Task 8)', async () => {
    // Seed three persisted player_message rows (seq 1,2,3) directly via the
    // repo — the transcript a prior, now-dropped, socket would have written.
    const repo = createRepo(pool)
    for (const [seq, content] of [
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ] as const) {
      await repo.sessionMessages.append({
        sessionId,
        seq,
        userId,
        messageType: 'player_message',
        content,
      })
    }

    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=2`)
    try {
      // The FIRST frame on a reconnect is session_reconnect (a direct
      // socket.send), NOT session_ready and NOT the round-tripped player_joined
      // (which arrives later via the Redis pub/sub loop).
      const [first] = await collectFrames(ws, 1)
      expect(first?.type).toBe('session_reconnect')
      if (first?.type !== 'session_reconnect') throw new Error('expected session_reconnect')

      // Only seq strictly greater than lastSeq=2 is replayed → [3].
      expect(first.messages.map((m) => (m.type === 'player_message' ? m.seq : -1))).toEqual([3])
      const replayed = first.messages[0]
      expect(replayed).toMatchObject({
        type: 'player_message',
        seq: 3,
        userId,
        displayName,
        text: 'three',
      })

      // participants includes the connected member, resolved with names.
      expect(first.participants).toContainEqual(
        expect.objectContaining({ userId, displayName }),
      )
      expect(first.mode).toBe('exploration')

      // The connect path is otherwise unchanged: presence recorded, suspend
      // cancelled.
      const sessionState = makeSessionState(redis, KEY_PREFIX)
      expect(await sessionState.countPresence(campaignId)).toBe(1)
      expect(suspendQueue.removes).toContain(`suspend-${sessionId}`)
    } finally {
      ws.terminate()
    }
  })

  it('reconnect with a malformed ?lastSeq → treated as a fresh connect (session_ready)', async () => {
    // A non-integer lastSeq is ignored → the connect behaves exactly like a
    // fresh connect (session_ready, no session_reconnect).
    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}&lastSeq=not-a-number`)
    try {
      const frames = await collectFrames(ws, 2)
      const types = frames.map((f) => f.type)
      expect(types).toContain('session_ready')
      expect(types).not.toContain('session_reconnect')
    } finally {
      ws.terminate()
    }
  })

  it('inbound player_message → persist-then-broadcast (seq 1 echo + a DB row)', async () => {
    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}`)
    try {
      // Drain the connect frames (session_ready + player_joined) first.
      await collectFrames(ws, 2)

      const echoP = collectFrames(ws, 1)
      ws.send(JSON.stringify({ type: 'player_message', text: 'Hello, party.' }))
      const [echo] = await echoP
      expect(echo).toMatchObject({
        type: 'player_message',
        seq: 1,
        userId,
        text: 'Hello, party.',
      })

      // Persisted row exists at seq 1.
      const repo = createRepo(pool)
      const messages = await repo.sessionMessages.listAfterSeq(sessionId, 0)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        seq: 1,
        userId,
        messageType: 'player_message',
        content: 'Hello, party.',
      })
    } finally {
      ws.terminate()
    }
  })

  it('drops an unknown / non-client frame type (no persist, no broadcast)', async () => {
    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}`)
    try {
      await collectFrames(ws, 2)
      // A server-only DM-turn frame type (`dm_thinking`) is NOT in
      // CLIENT_FRAME_TYPES → dropped. (`dm_invoke` is now a real client frame —
      // see the explicit-trigger unit suite — so it can't be the drop probe.)
      ws.send(JSON.stringify({ type: 'dm_thinking', turnId: 'should-be-ignored' }))
      // typing_start IS valid → it broadcasts with no seq, no persist; we use
      // it as a "did the prior frame get dropped?" probe: only the typing
      // frame should come back.
      const probeP = collectFrames(ws, 1)
      ws.send(JSON.stringify({ type: 'typing_start' }))
      const [probe] = await probeP
      expect(probe?.type).toBe('typing_start')

      const repo = createRepo(pool)
      const messages = await repo.sessionMessages.listAfterSeq(sessionId, 0)
      expect(messages).toHaveLength(0)
    } finally {
      ws.terminate()
    }
  })

  it('on disconnect → presence drops to 0 and a suspend job is scheduled', async () => {
    const sessionState = makeSessionState(redis, KEY_PREFIX)
    const ticket = await mint()
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}`)
    await collectFrames(ws, 2)
    expect(await sessionState.countPresence(campaignId)).toBe(1)

    // terminate() (abrupt drop) — NOT close(): @fastify/websocket's injectWS
    // synthetic PassThrough streams don't relay a graceful WS close frame back
    // to the SERVER socket (verified: ws.close() yields no server 'close' event,
    // ws.terminate() yields server 'close' code 1006). A real TCP socket relays
    // close() fine; this is a test-harness artifact, so we terminate to exercise
    // the server's disconnect path (the same path a dropped connection takes).
    ws.terminate()

    // The close handler runs async on the server in sequence: dropPresence →
    // countPresence → (if 0) scheduleSuspend. scheduleSuspend is the LAST step,
    // so poll for the scheduled suspend job itself. Waiting only for presence=0
    // (an earlier step) races the later scheduleSuspend under parallel load —
    // the presence key drops, the assert fires, but the schedule hasn't landed
    // yet. Polling the terminal effect implies every prior step completed.
    await vi.waitFor(
      () => {
        expect(suspendQueue.adds.map((a) => a.sessionId)).toContain(sessionId)
      },
      { timeout: 4000, interval: 50 },
    )
    expect(suspendQueue.adds.map((a) => a.jobId)).toContain(`suspend-${sessionId}`)
    expect(await sessionState.countPresence(campaignId)).toBe(0)
  })

  it('a throwing publish on player_message DROPS the frame but KEEPS THE SOCKET ALIVE', async () => {
    // Wrap the real hub so `publish` throws ONLY for player_message frames
    // (player_joined on connect + the later typing_start still go through). The
    // persist-then-broadcast means the row IS written before publish throws;
    // handleInbound's guard then swallows the publish error and leaves the
    // socket usable — a subsequent typing_start must still round-trip.
    const throwOnMessageHub: SessionHub = {
      register: (c, u, w) => {
        hub.register(c, u, w)
      },
      deregister: (c, u) => {
        hub.deregister(c, u)
      },
      hasLocal: (c) => hub.hasLocal(c),
      close: () => hub.close(),
      publish: (c, frame) => {
        if (frame.type === 'player_message') {
          return Promise.reject(new Error('redis publish transient'))
        }
        return hub.publish(c, frame)
      },
    }
    const throwApp = Fastify({ logger: false })
    await throwApp.register(websocket)
    await throwApp.register(wsSessionRoutes, {
      repo: createRepo(pool),
      sessionState: makeSessionState(redis, KEY_PREFIX),
      hub: throwOnMessageHub,
      suspendQueue,
      containerId: CONTAINER_ID,
      redisRealtime: redis,
      redisKeyPrefix: KEY_PREFIX,
      dmTriggerQueue: noopDmTriggerQueueLocal(),
      sessionTurnQueue: noopTurnQueue(),
      triggerState: makeTriggerState(redis, KEY_PREFIX),
      turnPublisher: createTurnPublisher(redis, KEY_PREFIX),
      reconcileQueue: noopReconcileQueue(),
      lock: createSessionLock(redis, KEY_PREFIX, 45_000),
    })
    await throwApp.ready()
    const ticket = await mint()
    const ws = (await throwApp.injectWS(
      `/ws/session/${sessionId}?ticket=${ticket}`,
    )) as unknown as WsClient
    try {
      // Drain connect frames (session_ready + player_joined).
      await collectFrames(ws, 2)

      // This player_message: persist succeeds, publish throws → frame dropped,
      // socket stays alive (no echo, no close).
      ws.send(JSON.stringify({ type: 'player_message', text: 'boom' }))

      // The player_message WAS persisted (persist-then-broadcast; publish is
      // what threw). Poll for the row — the INSERT is in flight on a separate
      // 'message' tick. The client recovers the missing seq via REST backfill.
      const repo = createRepo(pool)
      await vi.waitFor(
        async () => {
          const messages = await repo.sessionMessages.listAfterSeq(sessionId, 0)
          expect(messages).toHaveLength(1)
          expect(messages[0]).toMatchObject({ seq: 1, content: 'boom' })
        },
        { timeout: 4000, interval: 50 },
      )

      // Prove the socket is still alive: a typing_start (publish doesn't throw)
      // must round-trip back. If the throwing frame had killed the socket or
      // floated a rejection, this would time out.
      const probeP = collectFrames(ws, 1)
      ws.send(JSON.stringify({ type: 'typing_start' }))
      const [probe] = await probeP
      expect(probe?.type).toBe('typing_start')
    } finally {
      ws.terminate()
      await throwApp.close()
    }
  })

  it('connect failure (member has no character) closes the socket — no session_ready, no leaked state', async () => {
    // noCharMember is an ACCEPTED member, so the auth handshake passes and the
    // upgrade completes (101) — but sessionParticipants.join throws
    // NoCharacterForParticipantError, so handleConnection's guard runs:
    // best-effort cleanup + socket.close(1011, 'connect-failed').
    //
    // We can't assert the 1011 code via injectWS: its synthetic PassThrough
    // streams don't relay a SERVER-initiated GRACEFUL close to the client
    // (verified — only terminate()/1006 propagates; a real TCP socket relays
    // close(1011) fine). So we assert the harness-observable end state instead:
    // the client NEVER receives session_ready (the connect threw before the
    // send), and no participant row / presence key leaked.
    const ticket = await mint(sessionId, noCharMemberId)
    const ws = await connect(`/ws/session/${sessionId}?ticket=${ticket}`)
    try {
      // A short collect must TIME OUT — no frame is ever delivered on a failed
      // connect (no player_joined fan-out, no session_ready).
      await expect(collectFrames(ws, 1, 600)).rejects.toThrow(/timed out/)

      // No participant row was written (join threw), and no presence leaked.
      const repo = createRepo(pool)
      const participants = await repo.sessionParticipants.list(sessionId)
      expect(participants).toHaveLength(0)
      const sessionState = makeSessionState(redis, KEY_PREFIX)
      expect(await sessionState.countPresence(campaignId)).toBe(0)
    } finally {
      ws.terminate()
    }
  })

  // --- 404 / 409 pre-upgrade auth arms (real injectWS, real wiring) --------

  it('rejects (404) when the session row does not exist', async () => {
    // A valid ticket bound to a sessionId that has no row → wsSessionAuth loads
    // null from repo.sessions.getById → 404 session_not_found, no socket.
    const missingSessionId = '00000000-0000-7000-8000-0000000004a4'
    const ticket = await mint(missingSessionId)
    await expect(
      connect(`/ws/session/${missingSessionId}?ticket=${ticket}`),
    ).rejects.toThrow(/404/)
  })

  it('rejects (409) when the session row is not active', async () => {
    // Flip the session to a non-active status; the auth handshake loads the row
    // and 409s (session_not_active) before the upgrade.
    await pool.query(`UPDATE sessions SET status = 'ended' WHERE id = $1`, [sessionId])
    const ticket = await mint()
    await expect(connect(`/ws/session/${sessionId}?ticket=${ticket}`)).rejects.toThrow(/409/)
  })
})

// --- Connection-handler unit harness (stub deps, fake socket) -------------
//
// The heartbeat timers, the persistMessage reseed-retry, handleDisconnect's
// per-step best-effort catches, the rawToString Buffer[]/ArrayBuffer decode
// arms, parseClientFrame's malformed-frame drops, and the void-dispatch outer
// `.catch` nets are unreachable (or only flakily reachable) through injectWS:
// they need 30s/10s timers fast-forwarded, deep repo/Redis fault injection, a
// fragmented/binary WS frame the public client can't emit, and a synchronous
// view of the post-upgrade socket the harness doesn't expose.
//
// So this block drives the SAME registered connection handler directly. The
// plugin body only calls `app.get(path, opts, handler)` and reads `app.log` in
// the handlers, so a minimal fake app captures the `(socket, request)` handler;
// we then invoke it with a controllable fake socket + a request carrying the
// auth the (separately-tested) preHandler would have stashed. No prod change.

interface FakeWsSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(event: string, listener: (...args: never[]) => void): void
  // Test affordances:
  readonly sent: string[]
  readonly closes: { code: number | undefined; reason: string | undefined }[]
  pingCount: number
  terminateCount: number
  emit(event: string, ...args: unknown[]): void
}

function makeFakeWsSocket(opts: { throwOnClose?: boolean } = {}): FakeWsSocket {
  const listeners = new Map<string, ((...a: never[]) => void)[]>()
  const sent: string[] = []
  const closes: { code: number | undefined; reason: string | undefined }[] = []
  const socket: FakeWsSocket = {
    sent,
    closes,
    pingCount: 0,
    terminateCount: 0,
    send: (data) => {
      sent.push(data)
    },
    close: (code, reason) => {
      if (opts.throwOnClose) throw new Error('close-boom')
      closes.push({ code, reason })
    },
    terminate: () => {
      socket.terminateCount += 1
    },
    ping: () => {
      socket.pingCount += 1
    },
    on: (event, listener) => {
      const arr = listeners.get(event) ?? []
      arr.push(listener)
      listeners.set(event, arr)
    },
    emit: (event, ...args) => {
      for (const l of listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args)
    },
  }
  return socket
}

type ConnHandler = (socket: FakeWsSocket, request: unknown) => void

/** A pino-shaped recording logger for the fake app. */
function makeAppLog(): { log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } } {
  return {
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }
}

/** Register the plugin against a fake app, returning the captured connection
 *  handler + the fake app (for its recording log). */
async function captureHandler(
  deps: WsSessionDeps,
): Promise<{ handler: ConnHandler; appLog: ReturnType<typeof makeAppLog> }> {
  let handler: ConnHandler | undefined
  const appLog = makeAppLog()
  const fakeApp = {
    ...appLog,
    get: (_path: string, _opts: unknown, h: ConnHandler) => {
      handler = h
    },
  }
  await wsSessionRoutes(fakeApp as never, deps)
  if (!handler) throw new Error('connection handler not captured')
  return { handler, appLog }
}

/** A flexible stub SessionState whose every method is a vi.fn() defaulting to a
 *  benign resolution; individual tests override the ones they fault-inject. */
function makeStubSessionState(): {
  nextSeq: ReturnType<typeof vi.fn>
  reseedSeq: ReturnType<typeof vi.fn>
  addPresence: ReturnType<typeof vi.fn>
  dropPresence: ReturnType<typeof vi.fn>
  countPresence: ReturnType<typeof vi.fn>
  getState: ReturnType<typeof vi.fn>
  setState: ReturnType<typeof vi.fn>
  refreshTtls: ReturnType<typeof vi.fn>
  isEnding: ReturnType<typeof vi.fn>
} {
  return {
    nextSeq: vi.fn().mockResolvedValue(1),
    reseedSeq: vi.fn().mockResolvedValue(undefined),
    addPresence: vi.fn().mockResolvedValue(undefined),
    dropPresence: vi.fn().mockResolvedValue(undefined),
    countPresence: vi.fn().mockResolvedValue(0),
    getState: vi.fn().mockResolvedValue(null),
    setState: vi.fn().mockResolvedValue(undefined),
    refreshTtls: vi.fn().mockResolvedValue(undefined),
    // MYT-74a T11: the inbound end drop-gate reads this at the top of
    // handleInbound; these unit tests run with the session NOT ending.
    isEnding: vi.fn().mockResolvedValue(false),
  }
}

/** A stub hub recording publishes; publish resolves unless overridden. */
function makeStubHub(): {
  register: ReturnType<typeof vi.fn>
  deregister: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  hasLocal: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    register: vi.fn(),
    deregister: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
    hasLocal: vi.fn().mockReturnValue(false),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

/** A stub repo with only the methods the connection handlers touch. Each test
 *  overrides the ones it needs; defaults model a clean single-member session. */
function makeStubRepo(over: Record<string, unknown> = {}): {
  repo: WsSessionDeps['repo']
  sessionMessages: { append: ReturnType<typeof vi.fn>; listAfterSeq: ReturnType<typeof vi.fn> }
} {
  const sessionMessages = {
    append: vi.fn().mockResolvedValue(undefined),
    listAfterSeq: vi.fn().mockResolvedValue([]),
  }
  const repo = {
    sessionParticipants: {
      join: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    users: { getById: vi.fn().mockResolvedValue({ displayName: 'Dee' }) },
    characters: {
      findUserCharacterForCampaign: vi.fn().mockResolvedValue({ name: 'Char' }),
      listForCampaign: vi.fn().mockResolvedValue([]),
    },
    sessionMessages,
    campaigns: { listMembers: vi.fn().mockResolvedValue([]) },
    ...over,
  } as unknown as WsSessionDeps['repo']
  return { repo, sessionMessages }
}

/** A benign stub TriggerState — every method resolves to a no-op default. The
 *  connection-handler unit harness exercises connect/persist/disconnect/
 *  heartbeat paths that now also touch the trigger-state writes; none of those
 *  tests assert on trigger behavior (that's ws-session-trigger.test.ts), so a
 *  resolve-everything stub keeps them passing without a real Redis. */
function makeStubTriggerState(): WsSessionDeps['triggerState'] {
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
    markTurnEmitted: vi.fn().mockResolvedValue(undefined),
    wasTurnEmitted: vi.fn().mockResolvedValue(false),
    setOneShotDirection: vi.fn().mockResolvedValue(undefined),
    takeOneShotDirection: vi.fn().mockResolvedValue(null),
    peekOneShotDirection: vi.fn().mockResolvedValue(null),
    setStandingDirection: vi.fn().mockResolvedValue(undefined),
    readStandingDirection: vi.fn().mockResolvedValue(null),
    clearStandingDirection: vi.fn().mockResolvedValue(undefined),
    incrTurnsSinceSt: vi.fn().mockResolvedValue(0),
    turnsSinceSt: vi.fn().mockResolvedValue(0),
    resetTurnsSinceSt: vi.fn().mockResolvedValue(undefined),
    resetSessionKeys: vi.fn().mockResolvedValue(undefined),
  }
}

/** A benign stub TurnPublisher — every method resolves. Same rationale as
 *  makeStubTriggerState: the unit harness doesn't drive the explicit path. */
function makeStubTurnPublisher(): WsSessionDeps['turnPublisher'] {
  return {
    dmThinking: vi.fn().mockResolvedValue(undefined),
    textDelta: vi.fn().mockResolvedValue(undefined),
    skillCheck: vi.fn().mockResolvedValue(undefined),
    diceRoll: vi.fn().mockResolvedValue(undefined),
    ledgerUpdate: vi.fn().mockResolvedValue(undefined),
    modeChange: vi.fn().mockResolvedValue(undefined),
    combatStarted: vi.fn().mockResolvedValue(undefined),
    combatResolved: vi.fn().mockResolvedValue(undefined),
    turnEnd: vi.fn().mockResolvedValue(undefined),
    turnError: vi.fn().mockResolvedValue(undefined),
    emitFor: vi.fn().mockReturnValue({
      emitText: () => Promise.resolve(undefined),
      emitSkillCheck: () => Promise.resolve(undefined),
      emitDiceRoll: () => Promise.resolve(undefined),
      emitLedgerUpdate: () => Promise.resolve(undefined),
      emitModeChange: () => Promise.resolve(undefined),
      emitCombatStarted: () => Promise.resolve(undefined),
      emitCombatResolved: () => Promise.resolve(undefined),
    }),
  }
}

function makeUnitDeps(parts: {
  repo: WsSessionDeps['repo']
  sessionState: ReturnType<typeof makeStubSessionState>
  hub: ReturnType<typeof makeStubHub>
}): WsSessionDeps {
  return {
    repo: parts.repo,
    sessionState: parts.sessionState as unknown as WsSessionDeps['sessionState'],
    // The stub hub's mock-typed methods are already structurally assignable to
    // SessionHub, so no cast is needed here (sessionState's nextSeq:Promise<number>
    // return is not, hence its cast above).
    hub: parts.hub,
    suspendQueue: makeRecordingSuspendQueue(),
    containerId: CONTAINER_ID,
    redisRealtime: {} as unknown as Redis,
    redisKeyPrefix: 'unit:',
    dmTriggerQueue: { add: (() => Promise.resolve(undefined)) as unknown as DmTriggerQueueLike['add'] },
    sessionTurnQueue: { add: (() => Promise.resolve(undefined)) as unknown as TurnQueueLike['add'] },
    triggerState: makeStubTriggerState(),
    turnPublisher: makeStubTurnPublisher(),
    reconcileQueue: { add: (() => Promise.resolve(undefined)) as unknown as ReconcileQueueLike['add'] },
    lock: { tryAcquire: () => Promise.resolve(null) },
  }
}

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

function fakeRequest(opts: {
  sessionId?: string
  lastSeq?: string
  auth?: { userId: string; campaignId: string } | undefined
}): unknown {
  return {
    params: { sessionId: opts.sessionId ?? 'sess-1' },
    query: { lastSeq: opts.lastSeq },
    wsSessionAuth: 'auth' in opts ? opts.auth : { userId: 'u-1', campaignId: 'c-1' },
  }
}

describe('ws-session connection handler (stub-deps unit harness)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defensively closes the socket when wsSessionAuth is somehow absent', async () => {
    const { handler } = await captureHandler(
      makeUnitDeps({ repo: makeStubRepo().repo, sessionState: makeStubSessionState(), hub: makeStubHub() }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({ auth: undefined }))
    await flush()
    expect(socket.closes).toContainEqual({ code: 1011, reason: 'auth-missing' })
  })

  it('heartbeat: ping fires on interval, refreshes presence, and terminates on un-ponged grace; a pong clears the timer', async () => {
    // Fake only the interval/timeout timers — leave setImmediate real so the
    // `flush()` (which awaits the connect body's microtasks) still resolves.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const sessionState = makeStubSessionState()
    const { repo } = makeStubRepo()
    const { handler } = await captureHandler(
      makeUnitDeps({ repo, sessionState, hub: makeStubHub() }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush() // let the awaited connect body settle

    // First ping interval: ping sent, presence refreshed, pong timer armed.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.pingCount).toBe(1)
    expect(sessionState.addPresence).toHaveBeenCalled()

    // A pong before the grace clears the pending terminate.
    socket.emit('pong')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.terminateCount).toBe(0)

    // Next ping; no pong this time → grace elapses → terminate.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.pingCount).toBe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.terminateCount).toBe(1)

    // 'close' clears both timers (no throw, no further pings).
    socket.emit('close')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.pingCount).toBe(2)
  })

  it('heartbeat: a presence-refresh failure during ping is logged-and-swallowed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const sessionState = makeStubSessionState()
    // First addPresence (connect) ok; the ping-time one rejects.
    sessionState.addPresence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('presence transient'))
    const { handler, appLog } = await captureHandler(
      makeUnitDeps({ repo: makeStubRepo().repo, sessionState, hub: makeStubHub() }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()

    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(appLog.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session presence refresh failed',
    )
    socket.emit('close')
  })

  it('persistMessage: a seq-unique violation triggers ONE re-INCR + retry', async () => {
    const sessionState = makeStubSessionState()
    sessionState.nextSeq.mockResolvedValueOnce(5).mockResolvedValueOnce(6)
    const { repo, sessionMessages } = makeStubRepo()
    const uniqueErr = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'idx_session_messages_session_seq_unique',
    })
    sessionMessages.append
      .mockRejectedValueOnce(uniqueErr) // seq 5 collides
      .mockResolvedValueOnce(undefined) // seq 6 succeeds
    const hub = makeStubHub()
    const { handler } = await captureHandler(makeUnitDeps({ repo, sessionState, hub }))
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'player_message', text: 'hi' })))
    await flush()

    expect(sessionState.nextSeq).toHaveBeenCalledTimes(2)
    expect(sessionMessages.append).toHaveBeenCalledTimes(2)
    // The broadcast carried the RETRY seq (6).
    expect(hub.publish).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ type: 'player_message', seq: 6, text: 'hi' }),
    )
  })

  it('persistMessage: a NON-unique append error propagates (frame dropped, socket alive)', async () => {
    const sessionState = makeStubSessionState()
    const { repo, sessionMessages } = makeStubRepo()
    sessionMessages.append.mockRejectedValue(new Error('connection reset'))
    const { handler, appLog } = await captureHandler(
      makeUnitDeps({ repo, sessionState, hub: makeStubHub() }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'player_message', text: 'x' })))
    await flush()
    // nextSeq called once (no retry — not a unique violation), error logged.
    expect(sessionState.nextSeq).toHaveBeenCalledTimes(1)
    expect(appLog.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session inbound frame failed — dropped, socket kept alive',
    )
  })

  it('inbound: rawToString decodes a Buffer[] (fragmented) and an ArrayBuffer frame', async () => {
    const hub = makeStubHub()
    const { handler } = await captureHandler(
      makeUnitDeps({ repo: makeStubRepo().repo, sessionState: makeStubSessionState(), hub }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()

    // Buffer[] (a fragmented text frame `ws` would deliver with binaryType:'fragments').
    const json = JSON.stringify({ type: 'typing_start' })
    const half = Math.floor(json.length / 2)
    socket.emit('message', [Buffer.from(json.slice(0, half)), Buffer.from(json.slice(half))])
    await flush()

    // ArrayBuffer (binaryType:'arraybuffer').
    const ab = new TextEncoder().encode(JSON.stringify({ type: 'typing_stop' })).buffer
    socket.emit('message', ab)
    await flush()

    const broadcastTypes = hub.publish.mock.calls.map((c) => (c[1] as { type: string }).type)
    expect(broadcastTypes).toContain('typing_start')
    expect(broadcastTypes).toContain('typing_stop')
  })

  it('inbound: drops malformed frames — non-JSON, non-object, missing/unknown type, non-string + oversized text', async () => {
    const hub = makeStubHub()
    const { repo, sessionMessages } = makeStubRepo()
    const { handler } = await captureHandler(
      makeUnitDeps({ repo, sessionState: makeStubSessionState(), hub }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()
    const publishesBefore = hub.publish.mock.calls.length

    const send = (s: string): void => {
      socket.emit('message', Buffer.from(s))
    }
    send('not json{')                                  // JSON.parse throws → null
    send(JSON.stringify(42))                            // not an object → null
    send(JSON.stringify(null))                          // null → null
    send(JSON.stringify({ noType: true }))              // missing type → null
    send(JSON.stringify({ type: 'dm_thinking' }))       // server-only type, not allowlisted → null
    send(JSON.stringify({ type: 'player_message' }))    // text not a string → null
    send(JSON.stringify({ type: 'player_message', text: 'a'.repeat(4_001) })) // oversized → null
    await flush()

    // Nothing persisted, nothing newly broadcast.
    expect(sessionMessages.append).not.toHaveBeenCalled()
    expect(hub.publish.mock.calls.length).toBe(publishesBefore)
  })

  it('reconnect replay: a departed author (and a null-author row) fall back to "Former player"', async () => {
    const sessionState = makeStubSessionState()
    const { repo } = makeStubRepo({
      sessionMessages: {
        append: vi.fn().mockResolvedValue(undefined),
        // seq 3 authored by a user no longer in members/characters; seq 4 has a
        // null author (anomalous player row). Both byline-degrade to the
        // placeholder. messageType is REQUIRED since the MYT-68 replay switch —
        // a row without it falls to the default arm and is dropped entirely.
        listAfterSeq: vi
          .fn()
          .mockResolvedValue([
            { seq: 3, userId: 'departed-user', content: 'left long ago', messageType: 'player_message' },
            { seq: 4, userId: null, content: 'system note', messageType: 'player_message' },
          ]),
      },
      sessionParticipants: {
        join: vi.fn().mockResolvedValue(undefined),
        // A participant row whose userId isn't in the members/characters maps.
        list: vi.fn().mockResolvedValue([{ userId: 'departed-user' }]),
      },
      campaigns: { listMembers: vi.fn().mockResolvedValue([]) }, // empty → no display names
      characters: {
        findUserCharacterForCampaign: vi.fn().mockResolvedValue({ name: 'Char' }),
        listForCampaign: vi.fn().mockResolvedValue([]), // empty → no character names
      },
    })
    const { handler } = await captureHandler(
      makeUnitDeps({ repo, sessionState, hub: makeStubHub() }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({ lastSeq: '2' }))
    await flush()

    const reconnect = socket.sent
      .map((s) => JSON.parse(s) as { type: string })
      .find((f) => f.type === 'session_reconnect') as
      | { type: 'session_reconnect'; messages: { seq?: number; displayName: string; characterName: string }[]; participants: { displayName: string }[]; mode: string }
      | undefined
    expect(reconnect).toBeDefined()
    if (!reconnect) throw new Error('expected session_reconnect')
    // Both replayed messages degrade their byline to the placeholder. The
    // length assert guards against the replay switch silently dropping them
    // (an empty array would vacuously pass the loop below).
    expect(reconnect.messages).toHaveLength(2)
    for (const m of reconnect.messages) {
      expect(m.displayName).toBe('Former player')
      expect(m.characterName).toBe('')
    }
    // The departed participant degrades too, and mode defaults to exploration.
    expect(reconnect.participants[0]?.displayName).toBe('Former player')
    expect(reconnect.mode).toBe('exploration')
  })

  it('MYT-70 §8: ledger replay — ok:false skipped silently (no warn); corrupt blob dropped + warned', async () => {
    const sessionState = makeStubSessionState()
    const okTrue = JSON.stringify({
      toolCallId: 'tc-ok',
      input: {},
      output: {
        ok: true,
        payload: { characterName: 'Aila', kind: 'gold', summary: 'Aila now has 12 gold.', gold: 12 },
      },
    })
    const okFalse = JSON.stringify({
      toolCallId: 'tc-rej',
      input: {},
      output: { ok: false, binding: true, found: true, constraint: 'No gold to spend.' },
    })
    const { repo } = makeStubRepo({
      sessionMessages: {
        append: vi.fn().mockResolvedValue(undefined),
        listAfterSeq: vi.fn().mockResolvedValue([
          { seq: 1, userId: null, content: okTrue, messageType: 'acquire_resource', turnId: 't1' },
          // ok:false rejection — EXPECTED, not corrupt → skipped with NO warn.
          { seq: 2, userId: null, content: okFalse, messageType: 'spend_resource', turnId: 't1' },
          // Corrupt blob — non-JSON → dropped + warned.
          { seq: 3, userId: null, content: 'not-json{', messageType: 'cast_spell', turnId: 't1' },
        ]),
      },
    })
    const { handler, appLog } = await captureHandler(
      makeUnitDeps({ repo, sessionState, hub: makeStubHub() }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({ lastSeq: '0' }))
    await flush()

    const reconnect = socket.sent
      .map((s) => JSON.parse(s) as { type: string; messages?: { type: string; kind?: string }[] })
      .find((f) => f.type === 'session_reconnect')
    if (!reconnect?.messages) throw new Error('expected session_reconnect')
    // Only the ok:true row produced a frame; ok:false + corrupt yielded none.
    expect(reconnect.messages.map((m) => m.type)).toEqual(['ledger_update'])
    expect(reconnect.messages[0]).toMatchObject({ type: 'ledger_update', kind: 'gold' })

    const warnCalls = appLog.log.warn.mock.calls
    const corruptWarns = warnCalls.filter((c) =>
      c.some((a) => typeof a === 'string' && a.includes('dropped corrupt ledger_update')),
    )
    // Exactly ONE warn — the corrupt seq-3 row. The ok:false seq-2 row warns NOT.
    expect(corruptWarns).toHaveLength(1)
    expect(corruptWarns[0]?.[0]).toMatchObject({ seq: 3 })
  })

  it('connect fallbacks: a null user / null character resolve to empty display/character names', async () => {
    const hub = makeStubHub()
    const { repo } = makeStubRepo({
      users: { getById: vi.fn().mockResolvedValue(null) }, // user?.displayName ?? ''
      characters: {
        findUserCharacterForCampaign: vi.fn().mockResolvedValue(null), // character?.name ?? ''
        listForCampaign: vi.fn().mockResolvedValue([]),
      },
    })
    const { handler } = await captureHandler(
      makeUnitDeps({ repo, sessionState: makeStubSessionState(), hub }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()
    expect(hub.publish).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ type: 'player_joined', displayName: '', characterName: '' }),
    )
  })

  it('disconnect: each best-effort step is independently swallowed; suspend still scheduled', async () => {
    const sessionState = makeStubSessionState()
    sessionState.dropPresence.mockRejectedValue(new Error('drop transient'))
    sessionState.countPresence.mockRejectedValue(new Error('count transient')) // fail-safe → empty
    const hub = makeStubHub()
    // player_left publish rejects; player_joined (connect) must still resolve.
    hub.publish.mockImplementation((_c: string, frame: { type: string }) =>
      frame.type === 'player_left'
        ? Promise.reject(new Error('publish transient'))
        : Promise.resolve(undefined),
    )
    const deps = makeUnitDeps({ repo: makeStubRepo().repo, sessionState, hub })
    // clearTyping is also a best-effort disconnect step (§4.1) — make it reject too.
    ;(deps.triggerState.clearTyping as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('typing transient'))
    const suspendQueue = deps.suspendQueue as RecordingSuspendQueue
    const { handler, appLog } = await captureHandler(deps)
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()

    socket.emit('close')
    await flush()

    expect(appLog.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session clearTyping on disconnect failed (TTL will reap)',
    )
    expect(appLog.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session dropPresence failed (TTL will reap)',
    )
    expect(appLog.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session player_left publish failed',
    )
    expect(appLog.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session countPresence failed — scheduling suspend fail-safe',
    )
    // Fail-safe scheduled the suspend despite countPresence throwing.
    expect(suspendQueue.adds.map((a) => a.sessionId)).toContain('sess-1')
  })

  it('disconnect: a scheduleSuspend failure is logged (not floated)', async () => {
    const sessionState = makeStubSessionState()
    sessionState.countPresence.mockResolvedValue(0) // empty → schedule
    const deps = makeUnitDeps({
      repo: makeStubRepo().repo,
      sessionState,
      hub: makeStubHub(),
    })
    // Make the suspend queue's add throw so scheduleSuspend rejects.
    ;(deps.suspendQueue as RecordingSuspendQueue).add = (() =>
      Promise.reject(new Error('queue down'))) as SuspendQueueLike['add']
    const { handler, appLog } = await captureHandler(deps)
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()

    socket.emit('close')
    await flush()
    expect(appLog.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session scheduleSuspend failed',
    )
  })

  it('connect failure: best-effort cleanup runs and the socket is closed (1011, connect-failed)', async () => {
    const sessionState = makeStubSessionState()
    const { repo } = makeStubRepo({
      sessionParticipants: {
        join: vi.fn().mockRejectedValue(new Error('no character')), // throws inside the guard
        list: vi.fn().mockResolvedValue([]),
      },
    })
    const hub = makeStubHub()
    const { handler, appLog } = await captureHandler(
      makeUnitDeps({ repo, sessionState, hub }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()

    expect(appLog.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session connect failed — closing socket',
    )
    expect(hub.deregister).toHaveBeenCalledWith('c-1', 'u-1')
    expect(sessionState.dropPresence).toHaveBeenCalled()
    expect(socket.closes).toContainEqual({ code: 1011, reason: 'connect-failed' })
  })

  it('connect failure: a throwing socket.close in the cleanup path is swallowed', async () => {
    const { repo } = makeStubRepo({
      sessionParticipants: {
        join: vi.fn().mockRejectedValue(new Error('boom')),
        list: vi.fn().mockResolvedValue([]),
      },
    })
    const { handler } = await captureHandler(
      makeUnitDeps({ repo, sessionState: makeStubSessionState(), hub: makeStubHub() }),
    )
    // socket.close throws — the catch's inner try/catch swallows it.
    const socket = makeFakeWsSocket({ throwOnClose: true })
    expect(() => {
      handler(socket, fakeRequest({}))
    }).not.toThrow()
    await flush()
    // close was attempted (threw) — no unhandled rejection floats up.
    expect(socket.closes).toEqual([])
  })

  it('reconnect replay: mode reflects a written :state blob (not the default)', async () => {
    const sessionState = makeStubSessionState()
    sessionState.getState.mockResolvedValue({
      participants: [],
      mode: 'combat',
      status: 'active',
    })
    const { handler } = await captureHandler(
      makeUnitDeps({ repo: makeStubRepo().repo, sessionState, hub: makeStubHub() }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({ lastSeq: '0' }))
    await flush()
    const reconnect = socket.sent
      .map((s) => JSON.parse(s) as { type: string; mode?: string })
      .find((f) => f.type === 'session_reconnect')
    expect(reconnect?.mode).toBe('combat')
  })

  // --- The belt-and-suspenders outer .catch nets ---------------------------
  // Each lifecycle dispatch (handleConnection / handleInbound / handleDisconnect)
  // is void-dispatched with an outer `.catch` so NO rejection floats to the
  // process unhandledRejection escalation. These fire only when the inner guard
  // itself throws — we force exactly that.

  it('outer net: handleConnection rejecting (its own cleanup throws) is caught + logged', async () => {
    const { repo } = makeStubRepo({
      sessionParticipants: {
        join: vi.fn().mockRejectedValue(new Error('connect boom')), // enter the inner catch
        list: vi.fn().mockResolvedValue([]),
      },
    })
    const hub = makeStubHub()
    // deregister (called in the inner failure-cleanup) throws → the inner catch
    // re-throws → handleConnection's promise rejects → the outer .catch fires.
    hub.deregister.mockImplementation(() => {
      throw new Error('deregister boom')
    })
    const { handler, appLog } = await captureHandler(
      makeUnitDeps({ repo, sessionState: makeStubSessionState(), hub }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()
    expect(appLog.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session handleConnection escaped its own guard',
    )
    // The outer net's defensive socket.close ran.
    expect(socket.closes).toContainEqual({ code: 1011, reason: 'connect-failed' })
  })

  it('outer net: a throwing socket.close in the outer net is itself swallowed', async () => {
    const { repo } = makeStubRepo({
      sessionParticipants: {
        join: vi.fn().mockRejectedValue(new Error('connect boom')),
        list: vi.fn().mockResolvedValue([]),
      },
    })
    const hub = makeStubHub()
    hub.deregister.mockImplementation(() => {
      throw new Error('deregister boom') // inner catch re-throws → outer net runs
    })
    const { handler, appLog } = await captureHandler(
      makeUnitDeps({ repo, sessionState: makeStubSessionState(), hub }),
    )
    // socket.close throws too → the outer net's inner try/catch swallows it.
    const socket = makeFakeWsSocket({ throwOnClose: true })
    expect(() => {
      handler(socket, fakeRequest({}))
    }).not.toThrow()
    await flush()
    expect(appLog.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session handleConnection escaped its own guard',
    )
    // close threw on every attempt → nothing recorded; no rejection floated.
    expect(socket.closes).toEqual([])
  })

  it('outer net: handleInbound rejecting (its catch-time log throws once) is caught + logged', async () => {
    const sessionState = makeStubSessionState()
    const { repo, sessionMessages } = makeStubRepo()
    sessionMessages.append.mockRejectedValue(new Error('persist boom')) // enter inbound's catch
    const { handler, appLog } = await captureHandler(
      makeUnitDeps({ repo, sessionState, hub: makeStubHub() }),
    )
    // The FIRST log.error (inside handleInbound's catch) throws → handleInbound
    // rejects → the outer .catch's log.error (second call) succeeds.
    appLog.log.error.mockImplementationOnce(() => {
      throw new Error('logger boom')
    })
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'player_message', text: 'x' })))
    await flush()
    expect(appLog.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session handleInbound escaped its guard',
    )
  })

  it('outer net: handleDisconnect rejecting (deregister throws) is caught + logged', async () => {
    const hub = makeStubHub()
    const { handler, appLog } = await captureHandler(
      makeUnitDeps({ repo: makeStubRepo().repo, sessionState: makeStubSessionState(), hub }),
    )
    const socket = makeFakeWsSocket()
    handler(socket, fakeRequest({}))
    await flush()
    // hub.deregister is the FIRST (un-try'd) line of handleDisconnect — make it
    // throw so the whole promise rejects → the outer .catch fires.
    hub.deregister.mockImplementation(() => {
      throw new Error('deregister boom')
    })
    socket.emit('close')
    await flush()
    expect(appLog.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'ws-session handleDisconnect escaped its guard',
    )
  })
})
