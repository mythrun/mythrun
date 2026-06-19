// backend/scripts/smoke/myt-75-combat-turn-smoke.ts
//
// MYT-75 T9 — Smoke B: gated real-Anthropic + real-PG end-to-end smoke for the
// FULL combat turn through the turn worker. Proves the whole shipped combat flow
// against the REAL Fast Thinker (Sonnet), the REAL Haiku combat-outcome table,
// the REAL party-ledger ledger writes (real PG), the REAL CombatState blob +
// mode flip (real Redis), the REAL combat frames (captured via a real Redis
// PSUBSCRIBE), and the REAL resume path. Mocked unit tests already pass; this is
// the validation gate that proves the REAL plumbing works.
//
// What runs REAL:
//   - the Sonnet Fast Thinker (drives initiate_combat / resolve_combat),
//   - the Haiku combat-outcome DC table (inside resolveCombat),
//   - the PG transcript persist (assistantToRows → appendDmTurn — proves the T1
//     codec: the combat_initiate / combat_resolve rows land clean, no
//     TranscriptCorruptError),
//   - the shared-ledger HP write (applyToLedger → real adjust_hp through one PG
//     transaction + a ledger_events journal row),
//   - the CombatState blob + mode flip (real Redis session-state),
//   - the combat frames over a real Redis pub/sub channel,
//   - the resume path (the SAME ops the WS handler runs: tryMarkResumed →
//     setState exploration → clearCombatState).
//
// This is the natural-FT path. If the FT does NOT call initiate_combat on a run
// (Sonnet variance — a forceful "I attack" should reliably trigger it, but the
// model is not deterministic), the smoke logs the miss and FALLS BACK to a
// CONSTRUCTED variant: it seeds the SAME initiate/resolve combatEvents and drives
// `applyCombat` directly with real PG + real Redis, so the apply/persist/emit/
// ledger/resume plumbing is STILL proven end-to-end. The log clearly states which
// parts ran real-FT vs constructed.
//
// This is a SMOKE, not an EVAL (feedback_smoke_vs_eval): the assertions are
// deterministic plumbing — the combat rows persisted, the ledger HP changed, the
// CombatState is resolved with a summary, the mode flipped, the frames emitted,
// the resume cleared. We LOG (not assert) the combat narration QUALITY.
//
// Gated on ANTHROPIC_API_KEY + VOYAGE_API_KEY: skips cleanly (exit 0) when either
// is absent (the FT's lookup tools build a real embedder). Seeds + tears down its
// own scratch world/campaign/session in mythrun_dev (DATABASE_URL via the
// env-file flags). Inspected at the WIRE LEVEL — real PG rows, real Redis blob,
// real pub/sub frames.
//
// Run:  pnpm smoke:combat-turn

import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import pino from 'pino'
import { loadEnv } from '../../src/config/env.js'
import { createRepo, expectCommitted } from '../../src/repo/index.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { createRedisClient } from '../../src/redis/client.js'
import { makeSessionState } from '../../src/redis/session-state.js'
import { makeWorkingSetRepo } from '../../src/redis/working-set.js'
import { createVoyageEmbedder } from '../../src/llm/embed.js'
import { sessionChannelPattern } from '../../src/contract/session-channel.js'
import type { ServerFrame } from '../../src/contract/session-events.js'
import { createSessionLock } from '../../src/session/session-lock.js'
import { makeTriggerState } from '../../src/session/trigger-state.js'
import { createTurnPublisher } from '../../src/session/turn-publisher.js'
import { SonnetFastThinker } from '../../src/session/tiers/fast-thinker.js'
import { buildFtTools } from '../../src/session/tiers/ft-tools.js'
import { buildLookupDeps } from '../../src/session/tiers/lookup-wiring.js'
import { processTurnJob, applyCombat, type TurnProcessorDeps } from '../../src/session/turn-worker.js'
import type { TurnJobPayload } from '../../src/session/turn-queue.js'
import type { CombatEvent, CombatPartyMember, InitiateCombatEvent } from '../../src/session/combat/events.js'
import { reconcileDeltas } from '../../src/session/combat/apply.js'
import { resolveCombat } from '../../src/session/combat/outcome.js'
import type { MechanicalReads } from '../../src/session/skill-check.js'
import type { LedgerOps } from '../../src/repo/characters-ledger.js'
import type { LedgerTxRunner } from '../../src/session/rules-lawyer.js'
import type { WorkingSetItem, WorkingSetProposal } from '../../src/session/working-set/types.js'
import type { Redis } from 'ioredis'

const logger = pino({ level: 'info' })
function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

const SMOKE_USER_SUB = 'smoke-combat-1'
const WORLD_TONE = 'grim and rain-soaked, weathered and terse'
const SESSION_NUMBER = 1
const CHAR_NAME = 'Thornwood'
const PLAYER_TEXT =
  'I draw my blade and attack the bandit captain head-on — no mercy, no hesitation. ' +
  'I charge straight at him and try to cut him down before his men can react.'

interface Seeded {
  worldId: string
  campaignId: string
  sessionId: string
  userId: string
  characterId: string
  playerSeq: number
}

async function seedWorld(pool: Pool): Promise<Seeded> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()
  const characterId = uuidv7()

  await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, SMOKE_USER_SUB, 'Combat Smoke User', 'smoke-combat-user'],
  )
  await pool.query(
    `INSERT INTO worlds
       (id, created_by, name, concept, tone, themes, key_tensions,
        world_overview, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'complete')`,
    [worldId, userId, 'SMOKE: combat', 'A rain-soaked road and a band of cutthroats.',
      WORLD_TONE, 'banditry, the road, survival', 'a bandit captain bleeds the toll road',
      'A weathered toll road through fog and rain, harried by bandits.'],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [campaignId, worldId, userId, 'SMOKE: combat campaign'],
  )
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status)
     VALUES ($1, $2, $3, 'active')`,
    [sessionId, campaignId, SESSION_NUMBER],
  )
  // The prep row carries the enforced-ignorance-safe ft_context. A combat trigger
  // doesn't need a secret playbook; an empty-ish sd_playbook is fine (the lookup
  // vet reads it but the FT never sees it).
  await pool.query(
    `INSERT INTO session_preps (id, campaign_id, session_number, ft_context, sd_playbook)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), campaignId, SESSION_NUMBER,
      'A rain-lashed toll road at dusk. A scarred bandit captain and three cutthroats block the way, ' +
        'demanding coin. The captain rests a hand on his scimitar. The mud is slick; the light is failing.',
      'The bandit captain is named Garrick. He has no deeper secret in this scene.'],
  )

  // A level-4 fighter with real HP — readPartyLedgerSnapshot reads hit_points /
  // max_hit_points (current 28/34 so a damage write is observable).
  await pool.query(
    `INSERT INTO characters
       (id, user_id, name, level, class, species, background,
        str, dex, con, int, wis, cha,
        hit_points, max_hit_points, armor_class, proficiency_bonus,
        gold, hit_die, hit_dice_remaining, spellcasting_progression)
     VALUES ($1, $2, $3, 4, 'fighter', 'human', 'soldier',
             16, 13, 15, 10, 12, 9,
             28, 34, 17, 2,
             40, 10, 4, 'none')`,
    [characterId, userId, CHAR_NAME],
  )
  await pool.query(
    `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
     VALUES ($1, $2, $3, $4)`,
    [uuidv7(), campaignId, characterId, userId],
  )
  await pool.query(
    `INSERT INTO session_participants (id, session_id, user_id, character_id)
     VALUES ($1, $2, $3, $4)`,
    [uuidv7(), sessionId, userId, characterId],
  )

  // The player message that triggers combat — persisted to session_messages with
  // seq=1 so the FT reconstructs it from the transcript (processDmTurn reads
  // listFtContextRows(sessionId, maxConsumedSeq) → player rows with seq <= 1).
  const playerSeq = 1
  await pool.query(
    `INSERT INTO session_messages (id, session_id, seq, user_id, message_type, content)
     VALUES ($1, $2, $3, $4, 'player_message', $5)`,
    [uuidv7(), sessionId, playerSeq, userId, PLAYER_TEXT],
  )
  // Reseed the Redis :seq counter is done by the caller (after building
  // sessionState) so the DM rows' seqs continue above the player seq.

  return { worldId, campaignId, sessionId, userId, characterId, playerSeq }
}

/** Build the per-turn tiers factory — the REAL Sonnet FT with the combat tools,
 *  mirroring the production `makeTiers` in buildSessionTurnWorker. Returns a
 *  closure capturing the per-run combatEvents array so the smoke can inspect what
 *  the FT recorded. */
function makeTiersFactory(
  pool: Pool,
  embedder: ReturnType<typeof createVoyageEmbedder>,
  redisRealtime: Redis,
  keyPrefix: string,
): TurnProcessorDeps['makeTiers'] {
  const repo = createRepo(pool)
  const workingSetRepo = makeWorkingSetRepo(redisRealtime, keyPrefix)
  return ({ sessionId, turnId, worldTone, worldId, campaignId, recentNarrative, recordInjection, partyLedger }) => {
    const mech: MechanicalReads = {
      findSessionParticipantCharacterByName: (sid, name) =>
        repo.characters.findSessionParticipantCharacterByName(sid, name),
    }
    const combatEvents: CombatEvent[] = []
    const combatParty = (): Promise<readonly CombatPartyMember[]> =>
      Promise.resolve(
        partyLedger.map((c) => ({
          characterId: c.characterId,
          name: c.name,
          level: c.level,
          hp: c.hitPoints,
          maxHp: c.maxHitPoints,
        })),
      )
    const pendingInitiate = (): InitiateCombatEvent | null =>
      [...combatEvents].reverse().find((e) => e.kind === 'initiate') ?? null
    const ledger: LedgerOps = repo.characters
    const runInTx: LedgerTxRunner = (fn) =>
      repo.transaction((tx) => fn(tx.characters)).then(expectCommitted)
    const workingSet = (): Promise<WorkingSetItem[]> => workingSetRepo.load(campaignId)
    const lookup = buildLookupDeps(
      { repo, embedder, logger },
      { worldId, campaignId, sessionId, recentNarrative, recordInjection, workingSet },
    )
    return {
      ft: new SonnetFastThinker({
        tools: buildFtTools(
          {
            mech,
            ledger,
            runInTx,
            sessionId,
            turnId,
            worldTone,
            logger,
            ...lookup,
            combatParty,
            recordCombat: (e) => combatEvents.push(e),
            pendingInitiate,
          },
          undefined,
        ),
        logger,
      }),
      combatEvents,
    }
  }
}

/** Capture frames off the real Redis pub/sub channel for this run's key prefix. */
interface FrameCapture {
  readonly frames: ServerFrame[]
  close(): Promise<void>
}

async function startFrameCapture(realtimeUrl: string, keyPrefix: string): Promise<FrameCapture> {
  const subscriber = createRedisClient(realtimeUrl)
  await subscriber.connect()
  const frames: ServerFrame[] = []
  subscriber.on('pmessage', (_pattern: string, _channel: string, payload: string) => {
    frames.push(JSON.parse(payload) as ServerFrame)
  })
  await subscriber.psubscribe(sessionChannelPattern(keyPrefix))
  return {
    frames,
    close: async () => {
      await subscriber.quit()
    },
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.VOYAGE_API_KEY) {
    log('skipped: ANTHROPIC_API_KEY or VOYAGE_API_KEY absent (gated real-LLM combat-turn smoke)')
    return
  }
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  const embedder = createVoyageEmbedder({ apiKey: env.voyageApiKey })
  const keyPrefix = `smoke-combat-${randomUUID()}:`

  // The realtime Redis carries session-state, the lock, trigger-state, the
  // publisher, and the working set. A SEPARATE subscriber client captures frames.
  const realtime = createRedisClient(env.redisRealtimeUrl)
  await realtime.connect()
  const sessionState = makeSessionState(realtime, keyPrefix)
  const lock = createSessionLock(realtime, keyPrefix, 45_000)
  const triggerState = makeTriggerState(realtime, keyPrefix)
  const publisher = createTurnPublisher(realtime, keyPrefix)
  const repo = createRepo(pool)
  const capture = await startFrameCapture(env.redisRealtimeUrl, keyPrefix)

  try {
    const seeded = await seedWorld(pool)
    log('seeded scratch world/campaign/session/character + player message', { ...seeded })

    // Seed the live :state blob (the worker reads worldTone / ftContext off it,
    // and applyCombat reads it to flip the mode). Reseed the :seq counter above
    // the persisted player seq so DM rows get fresh, higher seqs.
    await sessionState.setState(seeded.campaignId, {
      participants: [seeded.userId],
      mode: 'exploration',
      status: 'active',
      worldTone: WORLD_TONE,
      worldId: seeded.worldId,
    })
    await sessionState.reseedSeq(seeded.campaignId, seeded.playerSeq)

    // Capture the FT's recorded combat events by reaching into the tiers factory.
    // We wrap makeTiers so the smoke keeps a handle on the per-turn combatEvents.
    const innerMakeTiers = makeTiersFactory(pool, embedder, realtime, keyPrefix)
    let capturedCombatEvents: CombatEvent[] = []
    const makeTiers: TurnProcessorDeps['makeTiers'] = (turn) => {
      const tiers = innerMakeTiers(turn)
      capturedCombatEvents = tiers.combatEvents
      return tiers
    }

    // Inert producers (no second worker / broker in the smoke) — the post-flush
    // tail enqueues st-eval / scribe / re-mature; all are best-effort and wrapped
    // in their own try/catch in the worker, so a no-op add is safe and never masks
    // the combat assertions we care about.
    const inertAdd = (): Promise<never> => Promise.resolve(undefined as never)
    const recordedInjections: WorkingSetProposal[] = []

    const turnId = randomUUID()
    const job: { data: TurnJobPayload } = {
      data: {
        campaignId: seeded.campaignId,
        sessionId: seeded.sessionId,
        turnId,
        triggerMessages: [{ userId: seeded.userId, characterName: CHAR_NAME, text: PLAYER_TEXT }],
        maxConsumedSeq: seeded.playerSeq,
        trigger: { kind: 'explicit' },
      },
    }

    const deps: TurnProcessorDeps = {
      lock,
      sessionState,
      repo,
      triggerState,
      sessionTurnQueue: { add: inertAdd },
      stEvalQueue: { add: inertAdd },
      scribeQueue: { add: inertAdd },
      dmTriggerQueue: { add: inertAdd },
      publisher,
      makeTiers,
      combatLedger: repo.characters,
      ledgerTx: (fn) => repo.transaction((tx) => fn(tx.characters)).then(expectCommitted),
      endSession: () => Promise.resolve(),
      finalizeEndedSession: () => Promise.resolve(),
      heartbeatMs: 15_000,
      logger,
    }
    void recordedInjections // kept for parity with production injection sink; unused in this smoke

    // ── HP before the turn (the ledger source of truth). ──
    const hpBefore = await readHp(pool, seeded.characterId)
    log('HP before the combat turn', { character: CHAR_NAME, ...hpBefore })

    // ── Drive the REAL turn (real Sonnet FT + real PG persist + real apply). ──
    log('driving real FT combat turn…', { turnId, playerText: PLAYER_TEXT })
    const ran = await processTurnJob(deps, job)
    log('processTurnJob returned', { ran: ran.ran })

    // Did the FT actually initiate combat?
    const ftInitiated = capturedCombatEvents.some((e) => e.kind === 'initiate')
    const ftResolved = capturedCombatEvents.some((e) => e.kind === 'resolve')
    log('FT combat events recorded this turn', {
      ftInitiated,
      ftResolved,
      kinds: capturedCombatEvents.map((e) => e.kind),
    })

    let mode: 'real-ft' | 'constructed' = 'real-ft'
    if (!ftInitiated) {
      // LLM variance: the FT narrated without calling initiate_combat. Fall back to
      // the CONSTRUCTED variant so the apply/persist/emit/ledger/resume plumbing is
      // still proven end-to-end with real PG + real Redis + real Haiku outcome.
      mode = 'constructed'
      log('FT did NOT call initiate_combat (LLM variance) — falling back to CONSTRUCTED apply variant')
      await runConstructedApply(deps, pool, seeded, turnId, publisher, sessionState)
    }

    // ── ASSERT: the REAL end state (identical for both paths). ──

    // (a) The combat rows landed in session_messages (proves the T1 codec — a
    //     TranscriptCorruptError would have thrown out of persistTurn). For the
    //     real-FT path we expect combat_initiate (+ ideally combat_resolve). For
    //     the constructed path the FT may have persisted a normal turn; we assert
    //     the combat ROWS only on the real-FT path.
    const rows = await pool.query<{ message_type: string; turn_id: string | null }>(
      `SELECT message_type, turn_id FROM session_messages
        WHERE session_id = $1 AND message_type IN ('combat_initiate', 'combat_resolve')
        ORDER BY seq ASC`,
      [seeded.sessionId],
    )
    log('combat rows in session_messages', {
      types: rows.rows.map((r) => r.message_type),
    })
    if (mode === 'real-ft') {
      if (!rows.rows.some((r) => r.message_type === 'combat_initiate')) {
        throw new Error('ASSERT(real-ft): no combat_initiate row persisted — T1 codec / persist broken')
      }
      log('PASS — combat_initiate row persisted (T1 codec clean, no TranscriptCorruptError)', {
        combatResolvePersisted: rows.rows.some((r) => r.message_type === 'combat_resolve'),
      })
    }

    // (b) The shared-ledger HP changed for the PC (the reconciled damage applied).
    const hpAfter = await readHp(pool, seeded.characterId)
    log('HP after the combat turn', { character: CHAR_NAME, ...hpAfter })
    if (hpAfter.hp >= hpBefore.hp) {
      throw new Error(
        `ASSERT: PC HP did not decrease (before ${String(hpBefore.hp)}, after ${String(hpAfter.hp)}) — the reconciled combat damage did not apply to the ledger`,
      )
    }
    log('PASS — shared-ledger HP decreased (reconciled combat damage applied)', {
      hpBefore: hpBefore.hp,
      hpAfter: hpAfter.hp,
      damageApplied: hpBefore.hp - hpAfter.hp,
    })

    // (b2) A ledger_events journal row landed under the synthetic combat toolCallId
    //      (proves idempotency keying — a re-run would replay as a no-op).
    const journal = await pool.query<{ tool_call_id: string }>(
      `SELECT tool_call_id FROM ledger_events WHERE character_id = $1 AND tool_call_id = $2`,
      [seeded.characterId, `combat-resolve:${turnId}`],
    )
    if (journal.rows.length === 0) {
      throw new Error('ASSERT: no ledger_events journal row under combat-resolve:<turnId> — apply idempotency key missing')
    }
    log('PASS — ledger_events journal row written under the synthetic combat toolCallId', {
      toolCallId: `combat-resolve:${turnId}`,
    })

    // (c) getCombatState is status:'resolved' with a result.summary.
    const combat = await sessionState.getCombatState(seeded.campaignId)
    if (combat === null) {
      throw new Error('ASSERT: getCombatState returned null — the CombatState blob was not persisted')
    }
    if (combat.status !== 'resolved') {
      throw new Error(`ASSERT: CombatState status is "${combat.status}", expected "resolved"`)
    }
    if (combat.result === null || typeof combat.result.summary.outcomeDescription !== 'string') {
      throw new Error('ASSERT: CombatState.result.summary missing — the summary was not assembled')
    }
    log('PASS — CombatState resolved with a result summary', {
      status: combat.status,
      outcome: combat.result.summary.outcome,
      outcomeDescription: combat.result.summary.outcomeDescription,
      casualties: combat.result.summary.casualties,
      hpChanges: combat.result.summary.hpChanges,
      enemies: combat.enemies.map((e) => `${String(e.count)}x ${e.name}`),
      dc: combat.outcome.dc,
      roll: combat.outcome.roll,
      total: combat.outcome.total,
      tier: combat.outcome.tier,
    })

    // (d) The session mode flipped to 'combat'.
    const stateAfter = await sessionState.getState(seeded.campaignId)
    if (stateAfter?.mode !== 'combat') {
      throw new Error(`ASSERT: session mode is "${String(stateAfter?.mode)}", expected "combat"`)
    }
    log('PASS — session :state mode flipped to combat')

    // (e) The frames were emitted (captured off real Redis pub/sub).
    //     mode_change(→combat) + combat_started come from the FT consume loop on
    //     initiate; combat_resolved comes from the post-turn applyCombat. On the
    //     constructed path the FT did not initiate, so mode_change/combat_started
    //     may be absent — we always require combat_resolved (applyCombat emits it).
    await waitForFrame(capture, (f) => f.type === 'combat_resolved', 5_000)
    const combatResolvedFrame = capture.frames.find((f) => f.type === 'combat_resolved')
    const modeChangeToCombat = capture.frames.find(
      (f) => f.type === 'mode_change' && f.to === 'combat',
    )
    const combatStarted = capture.frames.find((f) => f.type === 'combat_started')
    log('captured frames over real Redis pub/sub', {
      types: capture.frames.map((f) => f.type),
      combatResolved: combatResolvedFrame !== undefined,
      modeChangeToCombat: modeChangeToCombat !== undefined,
      combatStarted: combatStarted !== undefined,
    })
    if (combatResolvedFrame === undefined) {
      throw new Error('ASSERT: no combat_resolved frame emitted on the real pub/sub channel')
    }
    if (mode === 'real-ft' && (modeChangeToCombat === undefined || combatStarted === undefined)) {
      throw new Error('ASSERT(real-ft): the FT-initiated turn did not emit mode_change(→combat) + combat_started')
    }
    // `.find(f => f.type === 'combat_resolved')` already narrows the union member,
    // so the fields are directly accessible.
    log('PASS — combat frames emitted', {
      narration: combatResolvedFrame.narration,
      outcome: combatResolvedFrame.outcome,
      casualties: combatResolvedFrame.casualties,
      hpChanges: combatResolvedFrame.hpChanges,
    })

    // (f) RESUME: flip back to exploration. Drive the SAME ops the WS handler runs
    //     for a `resume_combat` frame (the resume path is inline in ws-session.ts):
    //     tryMarkResumed (once-only) → setState mode=exploration → clearCombatState
    //     → broadcast mode_change(combat→exploration).
    const stateForResume = await sessionState.getState(seeded.campaignId)
    if (stateForResume === null) throw new Error('resume: state blob vanished before resume')
    const claimed = await sessionState.tryMarkResumed(seeded.campaignId)
    if (!claimed) throw new Error('ASSERT: tryMarkResumed lost the once-only claim on first call')
    await sessionState.setState(seeded.campaignId, { ...stateForResume, mode: 'exploration' })
    await sessionState.clearCombatState(seeded.campaignId)
    await publisher.modeChange(seeded.campaignId, turnId, { from: 'combat', to: 'exploration', reason: 'resume' })

    const stateResumed = await sessionState.getState(seeded.campaignId)
    if (stateResumed?.mode !== 'exploration') {
      throw new Error(`ASSERT: after resume, mode is "${String(stateResumed?.mode)}", expected "exploration"`)
    }
    const combatCleared = await sessionState.getCombatState(seeded.campaignId)
    if (combatCleared !== null) {
      throw new Error('ASSERT: :combat blob still present after clearCombatState — resume did not clear it')
    }
    log('PASS — resume: mode back to exploration, :combat blob cleared')

    log(`ALL PASS — full combat turn proven end-to-end (mode=${mode})`, {
      ranRealFt: mode === 'real-ft',
      note:
        mode === 'real-ft'
          ? 'the real Sonnet FT initiated + resolved combat; everything below it ran real'
          : 'the FT did not initiate this run (LLM variance); apply/persist/emit/ledger/resume proven via the CONSTRUCTED variant with real PG + real Redis + real Haiku outcome',
    })
  } finally {
    await capture.close()
    // SMOKE_KEEP=1 leaves the scratch rows in place for post-run inspection (the
    // NEXT run's seed deletes the stale smoke user up front, so this never leaks
    // across runs). Default: clean up.
    if (process.env.SMOKE_KEEP === '1') {
      log('SMOKE_KEEP=1 — leaving scratch rows in place for inspection (next run cleans up)')
    } else {
      // Teardown order matters (FK constraints):
      //   1. worlds delete FIRST — it cascades campaigns → sessions →
      //      session_participants + session_messages + campaign_characters, which
      //      otherwise RESTRICT-reference characters (session_participants.character_id)
      //      and the world (worlds.created_by RESTRICT-references users).
      //   2. characters next — they RESTRICT-FK to users, but only after the
      //      session_participants referencing them are gone (step 1).
      //   3. users last.
      await pool.query(
        `DELETE FROM worlds WHERE created_by IN (SELECT id FROM users WHERE cognito_sub = $1)`,
        [SMOKE_USER_SUB],
      )
      await pool.query(
        `DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE cognito_sub = $1)`,
        [SMOKE_USER_SUB],
      )
      await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
    }
    // Best-effort Redis key cleanup for this run's prefix.
    await realtime.quit()
    await pool.end()
  }
}

/** Read a character's current/max HP straight from the ledger source of truth. */
async function readHp(pool: Pool, characterId: string): Promise<{ hp: number; maxHp: number }> {
  const r = await pool.query<{ hit_points: number; max_hit_points: number }>(
    `SELECT hit_points, max_hit_points FROM characters WHERE id = $1`,
    [characterId],
  )
  const row = r.rows[0]
  if (row === undefined) throw new Error('readHp: character row not found')
  return { hp: row.hit_points, maxHp: row.max_hit_points }
}

/** CONSTRUCTED fallback: when the FT didn't initiate, seed the SAME initiate +
 *  resolve combatEvents (with a REAL Haiku outcome table) and drive applyCombat
 *  directly — proving the apply/persist/emit/ledger plumbing with real PG + real
 *  Redis. The emitter writes to the real publisher (same channel the smoke
 *  captures). */
async function runConstructedApply(
  deps: TurnProcessorDeps,
  pool: Pool,
  seeded: Seeded,
  turnId: string,
  publisher: ReturnType<typeof createTurnPublisher>,
  sessionState: ReturnType<typeof makeSessionState>,
): Promise<void> {
  const repo = createRepo(pool)
  const partyLedger = await repo.characters.readPartyLedgerSnapshot(seeded.sessionId)
  const enemies = [
    { name: 'Garrick the bandit captain', description: 'a scarred mercenary with a notched scimitar', count: 1 },
    { name: 'cutthroat', description: 'a road-worn bandit with a shortbow', count: 3 },
  ]
  // REAL Haiku outcome table + REAL d20.
  const outcome = await resolveCombat({ worldTone: WORLD_TONE }, enemies, partyLedger.map((c) => ({
    level: c.level,
    hp: c.hitPoints,
    maxHp: c.maxHitPoints,
  })))
  log('constructed: REAL Haiku outcome for the seeded fight', {
    dc: outcome.dc,
    roll: outcome.roll,
    total: outcome.total,
    tier: outcome.tier,
    tierProse: outcome.tierProse,
  })
  const party = partyLedger.map((c) => ({
    characterId: c.characterId,
    name: c.name,
    hp: c.hitPoints,
    maxHp: c.maxHitPoints,
  }))
  // The FT's deltas: the captain falls; the PC takes a real wound (the envelope
  // floors enforce the rest). Use the PC's real character name.
  const pcName = party[0]?.name ?? CHAR_NAME
  const reconciled = reconcileDeltas(
    outcome,
    {
      hp_changes: [{ combatant_name: pcName, damage: 9, healing: 0 }],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [{ combatant_name: 'Garrick the bandit captain', fate: 'dead' }],
    },
    party,
    enemies.map((e) => e.name),
  )
  const combatEvents: CombatEvent[] = [
    {
      kind: 'initiate',
      outcome,
      enemies,
      environment: 'a rain-slicked toll road at dusk',
      surprise: 'none',
      initiative: [
        ...party.map((p) => ({ combatant: p.name, roll: 14 })),
        ...enemies.map((e) => ({ combatant: e.name, roll: 9 })),
      ],
    },
    {
      kind: 'resolve',
      reconciled,
      narration:
        'Thornwood drives forward through the rain and takes Garrick off his feet with a single brutal cut; ' +
        'the cutthroats break and scatter into the fog. A scimitar caught him across the ribs along the way.',
    },
  ]
  const emitter = publisher.emitFor(seeded.campaignId, turnId)
  await applyCombat(deps, combatEvents, partyLedger, emitter, {
    campaignId: seeded.campaignId,
    sessionId: seeded.sessionId,
    turnId,
  })
  void sessionState // mode flip + blob write happen inside applyCombat via deps.sessionState
}

/** Poll the captured frames until `pred` matches or the deadline passes. The
 *  publisher's PUBLISH is fire-and-forget over pub/sub, so a small wait covers
 *  the in-process delivery lag (mirrors turn-e2e.test.ts's vi.waitFor). */
async function waitForFrame(
  capture: FrameCapture,
  pred: (f: ServerFrame) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (capture.frames.some(pred)) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

main().catch((err: unknown) => {
  log('FAIL — real-LLM combat-turn smoke errored', {
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  process.exitCode = 1
})
