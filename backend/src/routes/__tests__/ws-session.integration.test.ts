// backend/src/routes/__tests__/ws-session.integration.test.ts
//
// MYT-65 Task 11 — the milestone's end-to-end "done when". This is the only
// test in the suite that boots a REAL app over a REAL TCP port (app.listen
// { port: 0 }) and drives REAL WebSocket clients through the full transport:
// the production buildApp wiring (the SessionHub on a dedicated PSUBSCRIBE'd
// duplicate of a real ioredis client, makeSessionState over the same client,
// the wsSessionRoutes plugin, @fastify/websocket), real Postgres (mythrun_test
// via the test pool), and the `ws` client lib.
//
// It is NOT a unit test of any one helper — those exist per-task. It proves
// the pieces COMPOSE: persist-then-broadcast with a server-assigned monotonic
// seq fanned out to BOTH connected sockets, ordered delivery, reconnect replay
// scoped to `?lastSeq`, and consistent session_messages + presence afterwards.
//
// Real Redis (realtime :6379) is required — the hub's pub/sub fan-out across
// two sockets is the property under test, and ioredis-mock's per-instance
// isolated pub/sub can't exercise it. A unique per-run key prefix keeps this
// test's :seq / presence / :state keys disjoint from dev + sibling tests on
// the shared cluster.
//
// Auth: AUTH_MODE=bypass, so each client mints its OWN ws-ticket via
// POST /api/sessions/:id/ws-ticket with a distinct `x-mythrun-dev-sub` header
// (the bypass plugin's per-request sub override). The WS upgrade itself reads
// the userId from the consumed ticket payload (the route is config.auth:public),
// so the two sockets carry the two seeded users' identities.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { createRepo } from '../../repo/index.js'
import { createRedisClient } from '../../redis/client.js'
import { buildApp } from '../../app.js'
import { makeStubEnv } from '../../__tests__/helpers/stub-env.js'
import { noopSessionSuspendQueue, noopSessionTurnQueue, noopWorldGenQueue, noopSessionPrepQueue } from '../../__tests__/helpers/stub-deps.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import type { ServerFrame } from '../../contract/session-events.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
// Per-run unique prefix so this test's transport keys (:seq, :conn:*, :state)
// don't collide with dev or sibling test runs on the shared realtime cluster.
const KEY_PREFIX = `test:ws-int-${uuidv7().slice(0, 8)}:`

interface SeededUser {
  readonly userId: string
  readonly devSub: string
}

async function seedUser(pool: Pool, scope: TestScope, index: number): Promise<SeededUser> {
  const userId = uuidv7()
  const devSub = scope.userSub(index)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, scope.displayName(index), scope.username(index)],
  )
  return { userId, devSub }
}

async function grantSessionCredits(pool: Pool, userId: string, amount: number): Promise<void> {
  await pool.query(
    `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
     VALUES ($1, $2, 'session', $3, 'gift', NULL)`,
    [uuidv7(), userId, amount],
  )
}

/** A character + its campaign_characters join row for `user` in `campaignId`.
 *  sessionParticipants.join (called on WS connect) resolves the character via
 *  findUserCharacterForCampaign and FK-binds the participant row to it, so a
 *  connecting member with no character would surface NoCharacterForParticipant-
 *  Error and the connect would close the socket. */
async function seedCharacter(
  pool: Pool,
  campaignId: string,
  user: SeededUser,
  name: string,
): Promise<void> {
  const characterId = uuidv7()
  await pool.query(
    `INSERT INTO characters
       (id, user_id, name, level, class, species, background,
        str, dex, con, int, wis, cha,
        hit_points, max_hit_points, armor_class, proficiency_bonus)
     VALUES ($1, $2, $3, 1, 'Fighter', 'Human', 'Soldier',
             10, 10, 10, 10, 10, 10, 10, 10, 12, 2)`,
    [characterId, user.userId, name],
  )
  await pool.query(
    `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
     VALUES ($1, $2, $3, $4)`,
    [uuidv7(), campaignId, characterId, user.userId],
  )
}

async function seedActiveCampaign(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
): Promise<string> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'a long enough concept', 'complete')`,
    [worldId, owner.userId, scope.worldName(0)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [campaignId, worldId, owner.userId, scope.campaignName(0)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return campaignId
}

async function addMember(pool: Pool, campaignId: string, user: SeededUser): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'player', true)`,
    [uuidv7(), campaignId, user.userId],
  )
}

/** Two members (owner + player), each with a character, an active campaign, a
 *  prep for session 1, and the owner funded with session credits so /start
 *  succeeds. Returns both users + the campaignId. */
async function seedReadyCampaign(
  pool: Pool,
  scope: TestScope,
): Promise<{ owner: SeededUser; player: SeededUser; campaignId: string }> {
  const owner = await seedUser(pool, scope, 0)
  const player = await seedUser(pool, scope, 1)
  await grantSessionCredits(pool, owner.userId, 5)
  const campaignId = await seedActiveCampaign(pool, scope, owner)
  await addMember(pool, campaignId, player)
  await seedCharacter(pool, campaignId, owner, 'Aldric')
  await seedCharacter(pool, campaignId, player, 'Brenna')
  await createRepo(pool).sessionPreps.insert({
    campaignId,
    sessionNumber: 1,
    ftContext: 'FT-CONTEXT',
    sdPlaybook: 'SD-PLAYBOOK',
  })
  return { owner, player, campaignId }
}

/** POST /start → sessionId (asserts 200). */
async function startSession(app: FastifyInstance, campaignId: string, devSub: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/sessions/${campaignId}/start`,
    headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
    payload: {},
  })
  if (res.statusCode !== 200) {
    throw new Error(`/start expected 200, got ${String(res.statusCode)}: ${res.body}`)
  }
  return res.json<{ sessionId: string }>().sessionId
}

/** POST /ws-ticket → single-use ticket (asserts 200). */
async function mintTicket(app: FastifyInstance, sessionId: string, devSub: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/ws-ticket`,
    headers: { 'x-mythrun-dev-sub': devSub },
  })
  if (res.statusCode !== 200) {
    throw new Error(`/ws-ticket expected 200, got ${String(res.statusCode)}: ${res.body}`)
  }
  return res.json<{ ticket: string }>().ticket
}

/** A small queue-backed frame reader over a WebSocket: every JSON frame the
 *  socket receives is parsed + buffered, and `next` resolves with the first
 *  frame whose `type` matches (draining buffered frames first). This lets the
 *  test assert on specific frames regardless of the interleaving of presence
 *  frames (player_joined/left) that ride the same channel. */
function frameReader(ws: WebSocket): {
  next: (type: ServerFrame['type'], timeoutMs?: number) => Promise<ServerFrame>
  all: () => ServerFrame[]
} {
  const buffer: ServerFrame[] = []
  const waiters: { type: ServerFrame['type']; resolve: (f: ServerFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = []

  ws.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as ServerFrame
    const idx = waiters.findIndex((w) => w.type === frame.type)
    if (idx !== -1) {
      // A waiter is already parked on this type — hand the frame straight to it
      // and do NOT buffer (buffering it too would double-count it on the next
      // next() call, replaying an already-consumed frame).
      const w = waiters[idx]
      if (w) {
        clearTimeout(w.timer)
        waiters.splice(idx, 1)
        w.resolve(frame)
        return
      }
    }
    buffer.push(frame)
  })

  return {
    next: (type, timeoutMs = 5000) =>
      new Promise<ServerFrame>((resolve, reject) => {
        const existing = buffer.findIndex((f) => f.type === type)
        if (existing !== -1) {
          const [f] = buffer.splice(existing, 1)
          if (f) {
            resolve(f)
            return
          }
        }
        const timer = setTimeout(() => {
          reject(new Error(`timeout waiting for frame type=${type}; saw=${JSON.stringify(buffer.map((b) => b.type))}`))
        }, timeoutMs)
        waiters.push({ type, resolve, reject, timer })
      }),
    all: () => [...buffer],
  }
}

/** Open a WS to the listening app with the given ticket (+ optional lastSeq),
 *  resolving once the socket is OPEN. */
function connect(baseWsUrl: string, sessionId: string, ticket: string, lastSeq?: number): Promise<WebSocket> {
  const q = new URLSearchParams({ ticket })
  if (lastSeq !== undefined) q.set('lastSeq', String(lastSeq))
  const ws = new WebSocket(`${baseWsUrl}/ws/session/${sessionId}?${q.toString()}`)
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => {
      resolve(ws)
    })
    ws.once('error', (err) => {
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    ws.once('close', () => {
      resolve()
    })
    ws.close()
  })
}

describe('MYT-65 WS transport — end-to-end (two clients + reconnect)', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance
  let scope: TestScope
  let baseWsUrl: string

  // Characters are user-owned (migration 009 dropped characters.campaign_id), so
  // cleanupTestScope's campaign-CASCADE doesn't reach them — they'd block the
  // users delete on characters_user_id_fkey. And session_participants.character_id
  // FK→characters would block the character delete. Tear down in FK order:
  // participants (FK→sessions + characters) → characters (FK→users) → then
  // cleanupTestScope (campaigns CASCADE sessions/members; users last).
  async function cleanupScope(): Promise<void> {
    const idPrefix = `${scope.id}%`
    await pool.query(
      `DELETE FROM session_participants
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
      [idPrefix],
    )
    await pool.query(
      `DELETE FROM characters
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
      [idPrefix],
    )
    await cleanupTestScope(pool, scope)
  }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('ws-integration')
  })

  afterAll(async () => {
    await cleanupScope()
    await pool.end()
  })

  beforeEach(async () => {
    process.env.AUTH_MODE = 'bypass'
    process.env.NODE_ENV = 'test'
    await cleanupScope()
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
    // A real ioredis client against the realtime cluster (:6379). The hub
    // duplicate()s it for its PSUBSCRIBE; makeSessionState + the ws-ticket
    // store use it directly. The suspend queue is a noop (no broker needed —
    // the reconnect scenario never empties presence, so scheduleSuspend never
    // fires; and a noop satisfies cancelSuspend on connect).
    //
    // createRedisClient uses lazyConnect + enableOfflineQueue:false (server.ts
    // gates real use behind a waitFor ping-probe). The test has no boot probe,
    // so we connect explicitly + await ready before any command — otherwise the
    // first /start → setState fires "Stream isn't writeable".
    redis = createRedisClient(process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379')
    await redis.connect()
    app = await buildApp(
      {
        pg: pool,
        redisRealtime: redis,
        redisBatch: redis,
        redisKeyPrefix: KEY_PREFIX,
        repo: createRepo(pool),
        worldGenQueue: noopWorldGenQueue(),
        sessionPrepQueue: noopSessionPrepQueue(),
        sessionSuspendQueue: noopSessionSuspendQueue(),
        sessionTurnQueue: noopSessionTurnQueue(),
      },
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv({ redisKeyPrefix: KEY_PREFIX }) },
    )
    await app.listen({ port: 0, host: '127.0.0.1' })
    const addr = app.server.address() as AddressInfo
    baseWsUrl = `ws://127.0.0.1:${String(addr.port)}`
  })

  afterEach(async () => {
    // Close the hub FIRST (PUNSUBSCRIBE + QUIT its dedicated duplicate), then
    // the app (drops sockets), then quit the shared realtime client — the same
    // order createShutdown uses in server.ts. Wrapped so a beforeEach
    // buildApp/connect failure (leaving app/redis unset) doesn't mask the real
    // error with an afterEach throw.
    try {
      await app.mythrunSessionHub.close()
      await app.close()
      await redis.quit()
    } catch {
      /* teardown best-effort — the failing beforeEach is the real signal */
    }
  })

  it('two clients exchange ordered, server-seq messages; B reconnects + replays only newer', async () => {
    const { owner, player, campaignId } = await seedReadyCampaign(pool, scope)
    const sessionId = await startSession(app, campaignId, owner.devSub)

    // Each client mints its own ticket with its own dev-sub.
    const ticketA = await mintTicket(app, sessionId, owner.devSub)
    const ticketB = await mintTicket(app, sessionId, player.devSub)

    const wsA = await connect(baseWsUrl, sessionId, ticketA)
    const readerA = frameReader(wsA)
    await readerA.next('session_ready')

    const wsB = await connect(baseWsUrl, sessionId, ticketB)
    const readerB = frameReader(wsB)
    await readerB.next('session_ready')

    // ── A sends player_message #1 → BOTH see it with the SAME server seq ──────
    wsA.send(JSON.stringify({ type: 'player_message', text: 'hello from A' }))
    const a1 = await readerA.next('player_message')
    const b1 = await readerB.next('player_message')
    expect(a1.type).toBe('player_message')
    expect(b1.type).toBe('player_message')
    if (a1.type !== 'player_message' || b1.type !== 'player_message') throw new Error('type narrow')
    expect(a1.seq).toBe(1)
    expect(b1.seq).toBe(1)
    expect(a1.text).toBe('hello from A')
    expect(b1.text).toBe('hello from A')
    expect(a1.userId).toBe(owner.userId)
    expect(a1.characterName).toBe('Aldric')

    // ── A sends #2 → seq increments to 2, ordered + delivered to both ────────
    wsA.send(JSON.stringify({ type: 'player_message', text: 'second from A' }))
    const a2 = await readerA.next('player_message')
    const b2 = await readerB.next('player_message')
    if (a2.type !== 'player_message' || b2.type !== 'player_message') throw new Error('type narrow')
    expect(a2.seq).toBe(2)
    expect(b2.seq).toBe(2)

    // ── B disconnects, then reconnects with lastSeq=1 → session_reconnect ────
    //    replays ONLY seq>1 (i.e. seq 2), not seq 1.
    await closeWs(wsB)

    const ticketB2 = await mintTicket(app, sessionId, player.devSub)
    const wsB2 = await connect(baseWsUrl, sessionId, ticketB2, 1)
    const readerB2 = frameReader(wsB2)
    const reconnect = await readerB2.next('session_reconnect')
    if (reconnect.type !== 'session_reconnect') throw new Error('type narrow')
    const replayedSeqs = reconnect.messages
      .filter((m): m is Extract<ServerFrame, { type: 'player_message' }> => m.type === 'player_message')
      .map((m) => m.seq)
    expect(replayedSeqs).toEqual([2]) // ONLY seq>1
    expect(reconnect.mode).toBe('exploration')
    // Both members appear in the participant snapshot.
    expect(reconnect.participants.map((p) => p.userId).sort()).toEqual(
      [owner.userId, player.userId].sort(),
    )

    // ── A sends #3 AFTER B's reconnect → B2 (and A) see seq 3, monotonic ─────
    wsA.send(JSON.stringify({ type: 'player_message', text: 'third from A' }))
    const a3 = await readerA.next('player_message')
    const b2_3 = await readerB2.next('player_message')
    if (a3.type !== 'player_message' || b2_3.type !== 'player_message') throw new Error('type narrow')
    expect(a3.seq).toBe(3)
    expect(b2_3.seq).toBe(3)

    // ── Persistence: session_messages holds exactly seq 1,2,3 in order ───────
    const persisted = await createRepo(pool).sessionMessages.listAfterSeq(sessionId, 0)
    expect(persisted.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(persisted.map((m) => m.content)).toEqual([
      'hello from A',
      'second from A',
      'third from A',
    ])
    expect(persisted.every((m) => m.messageType === 'player_message')).toBe(true)

    // ── Presence: two live connections (A + B2) on the campaign ──────────────
    const presenceKeys = await redis.keys(`${KEY_PREFIX}session:${campaignId}:conn:*`)
    expect(presenceKeys.length).toBe(2)

    await closeWs(wsA)
    await closeWs(wsB2)
  })
})
