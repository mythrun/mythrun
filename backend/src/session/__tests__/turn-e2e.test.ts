// MYT-66 Task 10 — the enqueue → real Worker → real subscriber E2E (H7).
//
// This is the round-trip proof: a job enqueued on the REAL batch-Redis (6380)
// BullMQ queue is picked up by a REAL `Worker`, which runs `processTurnJob`
// against the stub tiers; the worker's `TurnPublisher` PUBLISHes the DM-turn
// frames to the per-campaign channel on the REAL realtime-Redis (6379); and a
// SECOND realtime client that PSUBSCRIBEd the channel pattern actually RECEIVES
// `dm_thinking` + `text_delta` + `turn_end` — all carrying the same turnId.
// That observed cross-process round-trip IS the H7 guarantee; no in-process
// stub can stand in for it.
//
// This file establishes the real-`Worker` pattern (no prior test builds one).
// It mirrors session-suspend.test.ts's real-broker block for the queue setup:
//   - unique `queueName` per run (Date.now()+pid) so concurrent suites / re-runs
//     never share jobs,
//   - the BullMQ connection via `createBullmqRedisClient` (maxRetriesPerRequest:
//     null — the Worker's blocking BRPOPLPUSH requires it),
//   - TARGETED `remove`/`close`/`quit` cleanup, NEVER `obliterate` (a full
//     keyspace SCAN that blows the hook timeout on CI's shared 6380).
//
// A per-test-file unique KEY_PREFIX scopes the pub/sub channel so parallel runs
// against the shared 6379 don't cross-deliver each other's frames.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Queue, Worker as BullmqWorker } from 'bullmq'
import type { Redis } from 'ioredis'
import { createBullmqRedisClient } from '../../redis/bullmq-client.js'
import { createRedisClient } from '../../redis/client.js'
import { sessionChannelPattern } from '../../contract/session-channel.js'
import type { ServerFrame } from '../../contract/session-events.js'
import { makeSessionState } from '../../redis/session-state.js'
import { createSessionLock } from '../session-lock.js'
import { makeTriggerState } from '../trigger-state.js'
import { createTurnPublisher } from '../turn-publisher.js'
import { StubFastThinker } from '../tiers/stubs.js'
import { processTurnJob, type TurnWorkerRepo } from '../turn-worker.js'
import { enqueueTurn, type TurnJobPayload, type TurnQueueLike } from '../turn-queue.js'
import type { LedgerOps } from '../../repo/characters-ledger.js'

// MYT-75 T7 — an inert `LedgerOps`/tx runner for the E2E (the StubFastThinker
// records no combat events, so `applyCombat` early-returns and the ledger is
// never dereferenced). Every method throws so an accidental call is loud.
function inertCombatLedger(): LedgerOps {
  const unsupported = (m: string): never => {
    throw new Error(`inert LedgerOps: ${m} called on the E2E path`)
  }
  return {
    findLedgerCharacterByName: () => unsupported('findLedgerCharacterByName'),
    readPartyLedgerSnapshot: () => unsupported('readPartyLedgerSnapshot'),
    writeHp: () => unsupported('writeHp'),
    findLedgerEvent: () => unsupported('findLedgerEvent'),
    writeLedgerEvent: () => unsupported('writeLedgerEvent'),
    debitGold: () => unsupported('debitGold'),
    creditGold: () => unsupported('creditGold'),
    debitItem: () => unsupported('debitItem'),
    acquireItem: () => unsupported('acquireItem'),
    debitFeatureUse: () => unsupported('debitFeatureUse'),
    debitSpellSlot: () => unsupported('debitSpellSlot'),
    readSpellSlots: () => unsupported('readSpellSlots'),
    readCharacterSpells: () => unsupported('readCharacterSpells'),
    applyCondition: () => unsupported('applyCondition'),
    clearCondition: () => unsupported('clearCondition'),
    shortRest: () => unsupported('shortRest'),
    longRest: () => unsupported('longRest'),
    readRestParticipants: () => unsupported('readRestParticipants'),
  }
}

// A fresh-run in-memory repo for the E2E: no durable rows, empty transcript, a
// no-op DM append (the round-trip is asserted on the published frames, not PG),
// and stub roster/session/prep/character reads.
const e2eRepo: TurnWorkerRepo = {
  sessionMessages: {
    turnRowsExist: () => Promise.resolve(false),
    listFtContextRows: () => Promise.resolve([]),
    appendDmTurn: () => Promise.resolve(),
    maxSeq: () => Promise.resolve(0),
    // No trailing rows → the post-turn re-mature never re-arms in this flow.
    listAfterSeq: () => Promise.resolve([]),
    // myth-aiiao — the corrected-turn replace push's row read (unused here).
    listByTurn: () => Promise.resolve([]),
  },
  sessions: {
    getById: () => Promise.resolve({ sessionNumber: 1 }),
    // No usage recorded in this flow → null → under budget → no auto-end.
    budgetSummary: () => Promise.resolve(null),
  },
  sessionPreps: { getBy: () => Promise.resolve(null) },
  campaigns: { getWorldId: () => Promise.resolve('w-e2e'), listMembers: () => Promise.resolve([]) },
  characters: {
    findSessionParticipantCharacterByName: () => Promise.resolve({ outcome: 'not_found' }),
    listSessionParticipantCharacters: () => Promise.resolve([]),
    readPartyLedgerSnapshot: () => Promise.resolve([]),
  },
  // myth-dwyuw canon surface — empty by default (augment is a no-op here).
  entities: { listByWorld: () => Promise.resolve([]) },
  facts: { listByEntities: () => Promise.resolve([]) },
}

const REDIS_BATCH_URL = process.env.REDIS_BATCH_URL ?? 'redis://127.0.0.1:6380'
const REDIS_REALTIME_URL = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'

// Unique per run so concurrent suites / re-runs never share delayed/active jobs.
const queueName = `test-turn-e2e-${String(Date.now())}-${String(process.pid)}`
// Unique per run so the pub/sub channel pattern never cross-delivers another
// run's frames on the shared realtime Redis.
const KEY_PREFIX = `test-e2e-${randomUUID()}:`
const SESSION_LOCK_TTL_MS = 45_000
const HEARTBEAT_MS = 15_000

const campaignId = 'c-e2e'
const sessionId = 's1'
const turnId = randomUUID()

// A pino-compatible no-op logger — the worker's processor only calls warn/error.
const logger = {
  warn: (): void => undefined,
  error: (): void => undefined,
}

interface CollectedFrame {
  readonly channel: string
  readonly frame: ServerFrame
}

describe('turn E2E — enqueue → real Worker → real subscriber round-trip (H7)', () => {
  let connection: Redis
  let queue: Queue<TurnJobPayload>
  let worker: BullmqWorker<TurnJobPayload>
  let realtime: Redis
  let subscriber: Redis
  let publishedJobId: string | undefined
  const received: CollectedFrame[] = []

  beforeAll(async () => {
    // --- realtime side (6379): session-state, publisher, lock, subscriber ---
    realtime = createRedisClient(REDIS_REALTIME_URL)
    await realtime.connect()
    const sessionState = makeSessionState(realtime, KEY_PREFIX)
    const publisher = createTurnPublisher(realtime, KEY_PREFIX)
    const lock = createSessionLock(realtime, KEY_PREFIX, SESSION_LOCK_TTL_MS)
    const triggerState = makeTriggerState(realtime, KEY_PREFIX)

    // Second realtime client PSUBSCRIBEs the channel pattern and collects the
    // frames the worker's publisher emits. `pmessage` fires (pattern, channel,
    // payload); the payload is a JSON-encoded ServerFrame.
    subscriber = createRedisClient(REDIS_REALTIME_URL)
    await subscriber.connect()
    subscriber.on('pmessage', (_pattern: string, channel: string, payload: string) => {
      received.push({ channel, frame: JSON.parse(payload) as ServerFrame })
    })
    await subscriber.psubscribe(sessionChannelPattern(KEY_PREFIX))

    // Seed the :state blob so the controller's loadFromRedis hydrates a
    // participant roster (the FT/ST context is otherwise empty).
    await sessionState.setState(campaignId, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    // --- batch side (6380): the BullMQ queue + the REAL Worker ---
    connection = createBullmqRedisClient(REDIS_BATCH_URL)
    queue = new Queue<TurnJobPayload>(queueName, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    })

    worker = new BullmqWorker<TurnJobPayload>(
      queueName,
      (job) =>
        processTurnJob(
          {
            lock,
            sessionState,
            repo: e2eRepo,
            triggerState,
            // The explicit-drain producer — references the same `queue` built
            // below in this `beforeAll` (resolved lazily at job-run time).
            sessionTurnQueue: { add: (name, data, opts) => queue.add(name, data, opts) },
            // §4.7 post-turn re-mature producer. e2eRepo has no trailing player
            // rows, so the worker never reschedules — an inert no-op suffices.
            dmTriggerQueue: { add: () => Promise.resolve(undefined as never) },
            // Post-hoc ST eval producer (MYT-69) — runs off this path; inert here.
            stEvalQueue: { add: () => Promise.resolve(undefined as never) },
            // Post-turn Scribe producer (MYT-73) — runs off this path; inert here.
            scribeQueue: { add: () => Promise.resolve(undefined as never) },
            // Budget-100% auto-end (MYT-74a T12) — e2eRepo reports no usage
            // (budgetSummary → null), so this is never reached; inert here.
            endSession: () => Promise.resolve(),
            // Unconditional farewell finalize (MYT-74b §1.3) — no farewell turn
            // runs on this path, so it is never reached; inert here.
            finalizeEndedSession: () => Promise.resolve(),
            // Post-turn combat application (MYT-75 T7) — the StubFastThinker
            // records no combat events, so applyCombat early-returns; inert here.
            combatLedger: inertCombatLedger(),
            ledgerTx: (fn) => fn(inertCombatLedger()),
            publisher,
            makeTiers: () => ({
              ft: new StubFastThinker(),
              combatEvents: [],
            }),
            heartbeatMs: HEARTBEAT_MS,
            logger,
          },
          job,
        ),
      { connection },
    )
    await worker.waitUntilReady()
  })

  afterAll(async () => {
    // Targeted teardown — NEVER obliterate (full-keyspace SCAN blows the hook
    // timeout on CI's shared 6380). Close the worker first so it stops pulling
    // jobs, then drop the single enqueued job by id (best-effort: removeOnComplete
    // may already have pruned it), close the queue handle, and quit every client.
    await worker.close()
    if (publishedJobId !== undefined) {
      await queue.remove(publishedJobId).catch(() => undefined)
    }
    await queue.close()
    await connection.quit()
    // Clean up the seeded realtime keys so a re-run starts clean.
    await realtime.del(
      `${KEY_PREFIX}session:${campaignId}:state`,
      `${KEY_PREFIX}session:${campaignId}:ft_history`,
      `${KEY_PREFIX}session:${campaignId}:summary`,
      `${KEY_PREFIX}session:${campaignId}:usage`,
      // MYT-67 §4.7 keys the worker now writes.
      `${KEY_PREFIX}session:${campaignId}:dm_responding`,
      `${KEY_PREFIX}session:${campaignId}:responded-seq`,
    )
    await subscriber.quit()
    await realtime.quit()
  })

  it('a worker-published frame reaches a real subscriber; turn-state is appended', async () => {
    const queueAdapter: TurnQueueLike = {
      add: (name, data, opts) => queue.add(name, data, opts),
    }

    const job = await enqueueTurn(queueAdapter, {
      campaignId,
      sessionId,
      turnId,
      triggerMessages: [{ userId: 'u1', characterName: 'Mara', text: 'I look around' }],
      maxConsumedSeq: 0,
      trigger: { kind: 'explicit' },
    })
    publishedJobId = (job as { id?: string }).id

    // The real Worker picks up the job, runs the stub turn, and PUBLISHes the
    // frames; the real subscriber must observe all three control frames, each
    // carrying THIS turnId.
    await vi.waitFor(
      () => {
        const frames = received.map((m) => m.frame)
        const dmThinking = frames.find(
          (f): f is Extract<ServerFrame, { type: 'dm_thinking' }> =>
            f.type === 'dm_thinking' && f.turnId === turnId,
        )
        const textDelta = frames.find(
          (f): f is Extract<ServerFrame, { type: 'text_delta' }> =>
            f.type === 'text_delta' && f.turnId === turnId,
        )
        const turnEnd = frames.find(
          (f): f is Extract<ServerFrame, { type: 'turn_end' }> =>
            f.type === 'turn_end' && f.turnId === turnId,
        )
        expect(dmThinking).toBeDefined()
        expect(textDelta).toBeDefined()
        expect(turnEnd).toBeDefined()
        // The stub FT emits exactly one canned delta before its assistant line.
        expect(textDelta?.text).toBe('(the DM considers the scene…)')
      },
      { timeout: 5000, interval: 50 },
    )

    // The flush ran: turn-state summary/usage round-trip cleanly. ft_history
    // retired — PG-direct (MYT-68 §3.7), so the appended transcript is no
    // longer observable here; the turn_end + text_delta frames above are the
    // turn-completed signal.
    const sessionState = makeSessionState(realtime, KEY_PREFIX)
    const turnState = await sessionState.loadTurnState(campaignId)
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })
  })
})
