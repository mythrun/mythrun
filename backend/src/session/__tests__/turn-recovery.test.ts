// MYT-66 Task 11 — crash-recovery integration test (the done-when proof).
//
// Proves the recovery invariant END TO END against a REAL realtime Redis (6379)
// with a REAL `createSessionLock` and REAL lock-key deletion — no fake handle:
//
//   1. Worker A holds the session lock, then loses it mid-turn (its TTL expires
//      and a successor would re-acquire). The deterministic stand-in for that
//      race: A's Fast Thinker DELETES the real lock key at the start of its slow
//      `render`. With a 5ms heartbeat firing during the 60ms render, the lock's
//      `extend()` finds the key gone and returns false, flipping `lockLost`. The
//      post-`processDmTurn` checkpoint in `processTurnJob` then throws
//      `LockLostError` BEFORE `flushToRedis` — so A aborts WITHOUT flushing. The
//      never-flush-on-crash invariant leaves Redis at the pre-turn snapshot
//      (ftHistory empty), and A's compare-and-delete `release` (no-op — its
//      token no longer matches) leaves the lock key absent.
//
//   2. Worker B is the redelivered job: SAME turnId + triggerMessages (a BullMQ
//      redelivery carries the same payload), normal stub tiers, normal
//      heartbeat. It re-acquires the now-free lock and runs the turn to
//      completion from the clean pre-turn state. The end state is EXACTLY ONE
//      turn in ftHistory (the trigger user message + the single stub assistant
//      line) — NO double-append, proving B ran once from clean state rather than
//      on top of A's partial work — a `turn_end` is published for the turnId,
//      and the lock is free after B's `finally`-release.
//
// This is the deterministic variant the plan PREFERS over a two-competing-Worker
// race (§13 allows the force-expire form): it proves the identical properties
// (never-flush-on-crash, no double-append, lock-free-at-end) without a flaky
// inter-worker timing race. The lock-lost mechanics mirror turn-worker.test.ts's
// heartbeat-driven `lockLost` arm, but here with a real lock + real key deletion.

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Redis } from 'ioredis'
import { createRedisClient } from '../../redis/client.js'
import { sessionChannelPattern } from '../../contract/session-channel.js'
import type { ServerFrame } from '../../contract/session-events.js'
import { makeSessionState, type SessionState } from '../../redis/session-state.js'
import { createSessionLock, type SessionLock } from '../session-lock.js'
import { makeTriggerState, type TriggerState } from '../trigger-state.js'
import { createTurnPublisher, type TurnPublisher } from '../turn-publisher.js'
import { StubFastThinker } from '../tiers/stubs.js'
import type {
  AssistantMessage,
  FastThinker,
  FtTurnContext,
  TriggerMessage,
  TurnEmitter,
} from '../tiers/types.js'
import { processTurnJob, type TurnProcessorDeps, type TurnWorkerRepo } from '../turn-worker.js'
import type { LedgerOps } from '../../repo/characters-ledger.js'
import type { DmTriggerQueueLike } from '../dm-trigger-queue.js'
import type { StEvalQueueLike } from '../st-eval-queue.js'
import type { ScribeQueueLike } from '../scribe-queue.js'
import type { TurnJobPayload, TurnQueueLike } from '../turn-queue.js'

// A fresh-run in-memory repo: no durable rows (so both A and B take the
// fresh-run path), an empty transcript (the stub tiers don't read it), a no-op
// DM append, and stub roster/session/prep/character reads. The recovery
// invariant is asserted on Redis turn-state, not PG, so the append is inert.
const recoveryRepo: TurnWorkerRepo = {
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
  },
  sessionPreps: { getBy: () => Promise.resolve(null) },
  campaigns: { getWorldId: () => Promise.resolve('w-recovery'), listMembers: () => Promise.resolve([]) },
  characters: {
    findSessionParticipantCharacterByName: () => Promise.resolve({ outcome: 'not_found' }),
    listSessionParticipantCharacters: () => Promise.resolve([]),
    readPartyLedgerSnapshot: () => Promise.resolve([]),
  },
  // myth-dwyuw canon surface — empty by default (augment is a no-op here).
  entities: { listByWorld: () => Promise.resolve([]) },
  facts: { listByEntities: () => Promise.resolve([]) },
}

const REDIS_REALTIME_URL = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'

// Unique per run so the lock key, turn-state keys, and pub/sub channel never
// collide with a concurrent suite / re-run on the shared realtime Redis.
const KEY_PREFIX = `test-recovery-${randomUUID()}:`
const SESSION_LOCK_TTL_MS = 45_000

const CAMPAIGN = 'c-recovery'
const SESSION = 's-recovery'
// STABLE across the redelivery (H2): A and B carry the identical turnId, exactly
// as a re-run BullMQ job would.
const TURN = randomUUID()
const TRIGGER: TriggerMessage = { userId: 'u1', characterName: 'Mara', text: 'I open the door' }

// A pino-compatible no-op logger — the processor only calls warn/error.
const silentLogger = {
  warn: (): void => undefined,
  error: (): void => undefined,
}

// The explicit-drain producer. No `@dm` is pending in this recovery flow, so the
// worker's `takeExplicitPending` is always false → `add` is never called; an
// inert no-op stub satisfies the dep without a broker.
const inertTurnQueue: TurnQueueLike = {
  add: () => Promise.resolve(undefined as never),
}

// The §4.7 post-turn re-mature producer. recoveryRepo has no trailing player
// rows, so the worker never reschedules — an inert no-op satisfies the dep.
const inertDmTriggerQueue: DmTriggerQueueLike = {
  add: () => Promise.resolve(undefined as never),
}

// The post-hoc ST eval producer (MYT-69) — runs off the turn path in its own
// worker; this recovery flow never asserts on it, so an inert no-op satisfies
// the dep without a broker.
const inertStEvalQueue: StEvalQueueLike = {
  add: () => Promise.resolve(undefined as never),
}

// The post-turn Scribe producer (MYT-73) — the recovery flow never asserts on it
// (and B's flushed-success enqueue is best-effort), so an inert no-op satisfies
// the dep without a broker.
const inertScribeQueue: ScribeQueueLike = {
  add: () => Promise.resolve(undefined as never),
}

// MYT-74a T12 — recoveryRepo reports no usage (budgetSummary → null), so the
// budget auto-end is never reached in these lock-loss recovery flows; inert.
const inertEndSession: TurnProcessorDeps['endSession'] = () => Promise.resolve()
// MYT-74b §1.3 — these lock-loss recovery flows never run a farewell turn, so the
// unconditional finalize is never reached; inert.
const inertFinalize: TurnProcessorDeps['finalizeEndedSession'] = () => Promise.resolve()
// MYT-75 T7 — these recovery flows never apply combat (the LockKillingFastThinker
// aborts before the post-flush block; the StubFastThinker records no combat
// events). Every ledger method throws so an accidental call is loud.
const inertCombatLedger: LedgerOps = {
  findLedgerCharacterByName: () => unsupportedLedgerOp('findLedgerCharacterByName'),
  readPartyLedgerSnapshot: () => unsupportedLedgerOp('readPartyLedgerSnapshot'),
  readConditions: () => unsupportedLedgerOp('readConditions'),
  writeHp: () => unsupportedLedgerOp('writeHp'),
  findLedgerEvent: () => unsupportedLedgerOp('findLedgerEvent'),
  writeLedgerEvent: () => unsupportedLedgerOp('writeLedgerEvent'),
  debitGold: () => unsupportedLedgerOp('debitGold'),
  creditGold: () => unsupportedLedgerOp('creditGold'),
  debitItem: () => unsupportedLedgerOp('debitItem'),
  acquireItem: () => unsupportedLedgerOp('acquireItem'),
  debitFeatureUse: () => unsupportedLedgerOp('debitFeatureUse'),
  debitSpellSlot: () => unsupportedLedgerOp('debitSpellSlot'),
  readSpellSlots: () => unsupportedLedgerOp('readSpellSlots'),
  readCharacterSpells: () => unsupportedLedgerOp('readCharacterSpells'),
  applyCondition: () => unsupportedLedgerOp('applyCondition'),
  clearCondition: () => unsupportedLedgerOp('clearCondition'),
  shortRest: () => unsupportedLedgerOp('shortRest'),
  longRest: () => unsupportedLedgerOp('longRest'),
  readRestParticipants: () => unsupportedLedgerOp('readRestParticipants'),
}
function unsupportedLedgerOp(m: string): never {
  throw new Error(`inert LedgerOps: ${m} called on a recovery path`)
}
const inertLedgerTx: TurnProcessorDeps['ledgerTx'] = (fn) => fn(inertCombatLedger)

function payload(): { data: TurnJobPayload } {
  return {
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      triggerMessages: [TRIGGER],
      maxConsumedSeq: 0,
      trigger: { kind: 'explicit' },
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Worker A's Fast Thinker: the deterministic crash. At the start of `render` it
 * DELETES the real lock key (simulating the holder's lock TTL expiring), then
 * renders slowly (60ms) so A's 5ms heartbeat fires during the render, observes
 * the key gone (`extend()` → false), and flips `lockLost`. A then aborts at the
 * post-`processDmTurn` checkpoint — BEFORE the flush — so it NEVER flushes.
 *
 * MYT-68 §5: A renders WITHOUT emitting any player-visible frame before it
 * aborts. This models the crash-recovery case where the holder dies BEFORE
 * streaming anything — so the §5 emitted-anything latch (`markTurnEmitted`)
 * stays UNSET and the redelivered B takes the clean fresh-run recovery path
 * rather than the latch-terminal (no-divergent-re-stream) path. A turn that DID
 * stream a frame before dying is the latch-terminal case, covered directly in
 * turn-worker.test.ts.
 */
class LockKillingFastThinker implements FastThinker {
  constructor(
    private readonly realtime: Redis,
    private readonly lockKey: string,
  ) {}

  async render(_ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage> {
    void _ctx
    void emit
    // Simulate the holder's lock expiring mid-turn: drop the real lock key so
    // A's next heartbeat extend() finds nothing to refresh.
    await this.realtime.del(this.lockKey)
    // Slow render so the 5ms heartbeat fires (and flips lockLost) before render
    // returns. A would have flushed had it completed; it must not get there. No
    // emit() before the abort → the §5 latch stays unset → B recovers cleanly.
    await sleep(60)
    return { role: 'assistant', parts: [{ kind: 'text', text: '(A would have responded.)' }] }
  }
}

function lockKeyFor(campaignId: string): string {
  return `${KEY_PREFIX}session:lock:${campaignId}`
}

interface CollectedFrame {
  readonly channel: string
  readonly frame: ServerFrame
}

/** Narrow a collected frame to a turn_end for `turnId` — a typed predicate so
 *  no `as` is needed at the assertion site. */
function isTurnEndFor(frame: ServerFrame, turnId: string): boolean {
  return frame.type === 'turn_end' && frame.turnId === turnId
}

describe('turn crash-recovery — A loses lock mid-turn, B completes from clean state', () => {
  let realtime: Redis
  let subscriber: Redis
  let sessionState: SessionState
  let publisher: TurnPublisher
  let lock: SessionLock
  let triggerState: TriggerState
  const received: CollectedFrame[] = []

  beforeAll(async () => {
    realtime = createRedisClient(REDIS_REALTIME_URL)
    await realtime.connect()
    sessionState = makeSessionState(realtime, KEY_PREFIX)
    publisher = createTurnPublisher(realtime, KEY_PREFIX)
    lock = createSessionLock(realtime, KEY_PREFIX, SESSION_LOCK_TTL_MS)
    triggerState = makeTriggerState(realtime, KEY_PREFIX)

    // A second realtime client PSUBSCRIBEs the channel pattern and records every
    // frame the publisher emits, so the turn_end assertion is a genuine
    // cross-process observation (`pmessage` fires (pattern, channel, payload)).
    subscriber = createRedisClient(REDIS_REALTIME_URL)
    await subscriber.connect()
    subscriber.on('pmessage', (_pattern: string, channel: string, raw: string) => {
      const frame = JSON.parse(raw) as ServerFrame
      received.push({ channel, frame })
    })
    await subscriber.psubscribe(sessionChannelPattern(KEY_PREFIX))

    // Seed the :state blob so loadFromRedis hydrates a participant roster.
    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })
  })

  afterAll(async () => {
    await subscriber.quit()
    await realtime.quit()
  })

  afterEach(async () => {
    // Drop every key this test seeds/writes so a re-run starts clean.
    await realtime.del(
      lockKeyFor(CAMPAIGN),
      `${KEY_PREFIX}session:${CAMPAIGN}:state`,
      `${KEY_PREFIX}session:${CAMPAIGN}:ft_history`,
      `${KEY_PREFIX}session:${CAMPAIGN}:summary`,
      `${KEY_PREFIX}session:${CAMPAIGN}:usage`,
      // MYT-67 §4.7 keys the worker now writes.
      `${KEY_PREFIX}session:${CAMPAIGN}:dm_responding`,
      `${KEY_PREFIX}session:${CAMPAIGN}:responded-seq`,
    )
  })

  it('A aborts without flushing on lock loss; B recovers — no double-append, lock free', async () => {
    // --- Worker A: the crashing holder. Loses its lock mid-render. ---
    const depsA: TurnProcessorDeps = {
      lock,
      sessionState,
      repo: recoveryRepo,
      triggerState,
      sessionTurnQueue: inertTurnQueue,
      dmTriggerQueue: inertDmTriggerQueue,
      stEvalQueue: inertStEvalQueue,
      scribeQueue: inertScribeQueue,
      endSession: inertEndSession,
      finalizeEndedSession: inertFinalize,
      combatLedger: inertCombatLedger,
      ledgerTx: inertLedgerTx,
      publisher,
      makeTiers: () => ({
        ft: new LockKillingFastThinker(realtime, lockKeyFor(CAMPAIGN)),
        combatEvents: [],
      }),
      // Tiny heartbeat so extend() fires during the 60ms render and flips
      // lockLost before the post-processDmTurn checkpoint.
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const resultA = await processTurnJob(depsA, payload())

    // A ran (it acquired the lock) but aborted on lock loss: it returns {ran:true}.
    expect(resultA).toEqual({ ran: true })

    // The never-flush-on-crash invariant: A never reached flushToRedis, so the
    // turn state is still at the pre-turn snapshot — empty.
    // (ft_history retired — PG-direct (MYT-68 §3.7); the invariant now reads on
    // summary/usage, the turn-state that still flushes through Redis.)
    const afterA = await sessionState.loadTurnState(CAMPAIGN)
    expect(afterA.summary).toBe('')
    expect(afterA.usage).toEqual({ input: 0, output: 0 })

    // The lock key is free: A killed it mid-turn and its compare-and-delete
    // release was a no-op (token mismatch), so nothing holds it now.
    expect(await realtime.exists(lockKeyFor(CAMPAIGN))).toBe(0)

    // --- Worker B: the redelivered job. SAME turnId + triggerMessages. ---
    const depsB: TurnProcessorDeps = {
      lock,
      sessionState,
      repo: recoveryRepo,
      triggerState,
      sessionTurnQueue: inertTurnQueue,
      dmTriggerQueue: inertDmTriggerQueue,
      stEvalQueue: inertStEvalQueue,
      scribeQueue: inertScribeQueue,
      endSession: inertEndSession,
      finalizeEndedSession: inertFinalize,
      combatLedger: inertCombatLedger,
      ledgerTx: inertLedgerTx,
      publisher,
      makeTiers: () => ({
        ft: new StubFastThinker(),
        combatEvents: [],
      }),
      heartbeatMs: 15_000,
      logger: silentLogger,
    }

    const resultB = await processTurnJob(depsB, payload())

    expect(resultB).toEqual({ ran: true })

    // The turn completed exactly ONCE from the clean pre-turn state — B did not
    // build on top of A's partial work (A flushed nothing). ft_history retired
    // — PG-direct (MYT-68 §3.7), so the once-only completion is read on the
    // turn_end signal below rather than a reloaded transcript.

    // B published a turn_end for THIS turnId — the cross-process completion
    // signal a subscribed client would observe.
    const turnEnd = received.find((c) => isTurnEndFor(c.frame, TURN))
    expect(turnEnd).toBeDefined()

    // The lock is free at the end: B released it in `finally`, so a fresh acquire
    // succeeds (release the probe handle so teardown's del is the only residue).
    const probe = await lock.tryAcquire(CAMPAIGN)
    expect(probe).not.toBeNull()
    if (probe !== null) await probe.release()
  })
})
