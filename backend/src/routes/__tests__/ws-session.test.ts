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

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
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
import { mintWsTicket } from '../../auth/ws-ticket.js'
import type { ServerFrame } from '../../contract/session-events.js'
import type { SuspendQueueLike } from '../../session/session-suspend.js'
import { wsSessionRoutes, type WsSessionDeps } from '../ws-session.js'

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
      // A DM-turn frame type is NOT in CLIENT_FRAME_TYPES → dropped.
      ws.send(JSON.stringify({ type: 'dm_invoke', text: 'should be ignored' }))
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

    // Poll for the close handler to run (presence drop is async on the server
    // side after the socket's 'close' event).
    await vi.waitFor(
      async () => {
        expect(await sessionState.countPresence(campaignId)).toBe(0)
      },
      { timeout: 4000, interval: 50 },
    )
    expect(suspendQueue.adds.map((a) => a.sessionId)).toContain(sessionId)
    expect(suspendQueue.adds.map((a) => a.jobId)).toContain(`suspend-${sessionId}`)
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
})
