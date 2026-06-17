import { pathToFileURL } from 'node:url'
import { Worker as BullmqWorker, type Job } from 'bullmq'
import { waitFor } from './boot/wait-for.js'
import { probeVoyageAtBoot } from './boot/voyage-probe.js'
import { loadEnv } from './config/env.js'
import { createPgPool } from './db/postgres.js'
import { createBullmqRedisClient } from './redis/bullmq-client.js'
import { createRedisClient } from './redis/client.js'
import {
  CONCURRENCY_CAMPAIGN_SETUP,
  CONCURRENCY_SESSION_PREP,
  CONCURRENCY_WORLD_GEN,
  QUEUE_CAMPAIGN_SETUP,
  QUEUE_SESSION_PREP,
  QUEUE_WORLD_GEN,
} from './worker/bullmq-config.js'
import { startHealthServer } from './worker/health-server.js'
import { logger } from './llm/logger.js'
import { createVoyageEmbedder } from './llm/embed.js'
import { readCostCap, readCharacterCreationCostCap } from './llm/prep/cost-cap.js'
import { createWorldGenProcessor } from './llm/prep/world-gen-processor.js'
import {
  createCharacterCreationProcessor,
  type CharacterCreationJobPayload,
} from './llm/prep/character-creation-processor.js'
import {
  createCharacterIntegrationProcessor,
  type CharacterIntegrationJobPayload,
} from './llm/prep/character-integration-processor.js'
import { createSessionPrepProcessor } from './llm/prep/session-prep-processor.js'
import { buildSessionTurnWorker } from './session/turn-worker.js'
import { QUEUE_SESSION_TURN } from './session/turn-queue.js'
import { buildDmTriggerWorker } from './session/dm-trigger-worker.js'
import { buildStEvaluationWorker } from './session/st-evaluation-worker.js'
import { QUEUE_ST_EVAL } from './session/st-eval-queue.js'
import { buildScribeWorker } from './session/scribe-worker.js'
import { QUEUE_SCRIBE } from './session/scribe-queue.js'
import { buildReconcileWorker, QUEUE_SESSION_RECONCILE } from './session/session-reconcile.js'
import {
  buildPostSessionAnalysisWorker,
  QUEUE_SESSION_ANALYSIS,
} from './session/post-session-analysis.js'
import { finalizeEndedSession, type FinalizeEndedSessionDeps } from './session/session-end.js'
import { buildSessionTurnQueueEvents } from './session/session-turn-queue-events.js'
import { buildSessionReconcileQueue, buildSessionAnalysisQueue } from './server-queues.js'
import { createRepo } from './repo/index.js'
import { sessionChannel } from './contract/session-channel.js'
import { QUEUE_DM_TRIGGER } from './session/dm-trigger-config.js'
import { makePipelinePublishers } from './worker/publishers.js'

/** Default worker health-server port. Overridable via WORKER_HEALTH_PORT for
 *  local dev, where :3001 can collide with an unrelated process (the env var
 *  is read at main() time in resolveHealthPort, not module load). ECS keeps
 *  the default — no task-def change needed. */
const HEALTH_PORT = 3001

/** Local-dev escape hatch for the health-server bind (see HEALTH_PORT). */
export function resolveHealthPort(): number {
  const raw = process.env.WORKER_HEALTH_PORT
  return raw !== undefined && raw !== '' ? Number(raw) : HEALTH_PORT
}
const WORKER_PG_POOL_SIZE = 4
// Reserve ~20s headroom under ECS stopTimeout=120s for pg + Redis cleanup.
const WORKER_CLOSE_GRACE_MS = 100_000

export async function main(): Promise<void> {
  const env = loadEnv()

  // Establish connections. Each probe is wrapped in waitFor() (200/500/
  // 1000/2000ms backoff, 5 attempts total) to mirror the API's boot
  // pattern in server.ts — without it, ioredis with
  // `maxRetriesPerRequest: null` (BullMQ requirement) throws
  // "Stream isn't writeable" on the first ping if the TCP socket isn't
  // writable yet. Boot still fails fast on a real outage; it just
  // tolerates the normal connection-establishment race.
  const redisBatch = createBullmqRedisClient(env.redisBatchUrl)
  await waitFor({ label: 'Redis (batch)', probe: () => redisBatch.ping() })
  // redisRealtime uses the regular client — only used for PUBLISH later
  // (MYT-52); BullMQ constraints don't apply.
  const redisRealtime = createRedisClient(env.redisRealtimeUrl)
  await waitFor({ label: 'Redis (realtime)', probe: () => redisRealtime.ping() })
  const pg = createPgPool(env.databaseUrl, { max: WORKER_PG_POOL_SIZE })
  await waitFor({ label: 'Postgres', probe: () => pg.query('SELECT 1') })

  // Voyage (embeddings). A misconfigured key would otherwise make every world
  // silently un-embedded — so the probe crashloops on a config error (auth/
  // bad-request/dim) so a bad key can't ship, and boots DEGRADED (loud error
  // log, not crashloop) on a transient Voyage outage. See boot/voyage-probe.ts.
  const embedder = createVoyageEmbedder({ apiKey: env.voyageApiKey })
  await probeVoyageAtBoot(embedder, logger)

  // Cost caps come from the settings table — pulled at boot so the worker
  // operates on the same values the API uses (server.ts:readCostCapsAtBoot).
  // The cap is enforced per-stage inside the processors; a change to the
  // settings row requires a worker restart, matching the API's lifecycle.
  const [worldGenCostCapUsd, characterCreationCostCapUsd] = await Promise.all([
    readCostCap(pg),
    readCharacterCreationCostCap(pg),
  ])

  // Shared publishers (MYT-62). publishEvent → pipeline:campaign:{id} is the
  // single SSE channel for all worker-emitted lifecycle events (MYT-50); all
  // three processors publish there so the API's SSE subscriber sees one ordered
  // stream per campaign. publishProse → prep:campaign:{id} is the SEPARATE
  // dev-only channel for session-prep prose (sd_playbook may carry secrets).
  // Both channel formulas are single-sourced in worker/publishers.ts.
  const { publishEvent, publishProse } = makePipelinePublishers(
    redisRealtime,
    env.redisKeyPrefix,
  )

  // World-gen — real processor wired here. MYT-51 landed the non-streaming
  // stages, MYT-52 the streaming stages + coherence pass. The API container
  // (server.ts:buildWorldGenWorker) wires the same processor; both compete
  // for jobs on the same QUEUE_WORLD_GEN. The smoke surfaced that this
  // worker.ts entrypoint was never updated alongside server.ts.
  const worldGenWorker = new BullmqWorker(
    QUEUE_WORLD_GEN,
    createWorldGenProcessor({
      pool: pg,
      redisRealtime,
      redisKeyPrefix: env.redisKeyPrefix,
      logger,
      costCapUsd: worldGenCostCapUsd,
      voyageApiKey: env.voyageApiKey,
    }),
    { connection: redisBatch, concurrency: CONCURRENCY_WORLD_GEN },
  )

  // Campaign-setup is a router on job.name (MYT-54 T20 fix). Both arms get
  // the real processor — no stub fallthrough.
  const characterCreationProcessor = createCharacterCreationProcessor({
    pool: pg,
    costCapUsd: characterCreationCostCapUsd,
    publishEvent,
  })
  const integrationProcessor = createCharacterIntegrationProcessor({
    pool: pg,
    publishEvent,
    voyageApiKey: env.voyageApiKey,
  })

  const campaignSetupRouter = async (job: Job): Promise<void> => {
    if (job.name === 'character-integration') {
      await integrationProcessor(job as Job<CharacterIntegrationJobPayload>)
      return
    }
    await characterCreationProcessor(job as Job<CharacterCreationJobPayload>)
  }

  const campaignSetupWorker = new BullmqWorker(QUEUE_CAMPAIGN_SETUP, campaignSetupRouter, {
    connection: redisBatch,
    concurrency: CONCURRENCY_CAMPAIGN_SETUP,
  })

  // Session-prep (MYT-61) — one job per (campaign, session_number), enqueued
  // by MYT-63 with jobId `sp-${campaignId}-${sessionNumber}`. Streams two prose
  // docs through Opus; the processor owns the per-session pipeline_runs
  // (`session-prep:${n}`) lifecycle. A prep failure is session-scoped and never
  // fails the campaign. The API container (server.ts) wires the same processor.
  const sessionPrepWorker = new BullmqWorker(
    QUEUE_SESSION_PREP,
    createSessionPrepProcessor({ pool: pg, publishEvent, publishProse }),
    { connection: redisBatch, concurrency: CONCURRENCY_SESSION_PREP },
  )

  // Session-turn (MYT-66) — the lock-fenced DM-turn conductor. Wired HERE in the
  // dedicated worker process (NOT the API server, which only enqueues turns).
  // Reuses the already-probed `redisBatch` for BullMQ and constructs its lock /
  // session-state / publisher on `redisRealtime`. The builder owns the H1 timing
  // inequality + the H8 terminal-turn_error `failed` handler.
  const sessionTurnWorker = buildSessionTurnWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    logger,
    pg,
    // The boot-probed Voyage embedder (MYT-72) — the SHARED, validated instance
    // the FT's world-knowledge lookup tools embed queries through. Passing the
    // probed instance (not the raw key) avoids per-turn embedder construction,
    // which would silently degrade on a transient key blip the boot probe caught.
    embedder,
  )

  // DM-trigger (MYT-67 §4.3) — the ordered decision shell that runs when the
  // quiet-window debounce matures and enqueues at most one `session-turn`. Wired
  // HERE in the dedicated worker process. Takes the pg `Pool` (it builds its own
  // repo internally) plus both Redis connections; its `Queue` producers ride the
  // shared `redisBatch`, so they need no extra teardown beyond `redisBatch.quit()`.
  const dmTriggerWorker = buildDmTriggerWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    pg,
    logger,
  )

  // ST-evaluation (MYT-69) — the post-hoc narrative director, OFF the hot path.
  // Wired HERE in the dedicated worker process. Takes the pg Pool (builds its
  // own repo) + both Redis connections; its Queue producer rides redisBatch.
  const stEvaluationWorker = buildStEvaluationWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    pg,
    logger,
  )

  // Scribe (MYT-73) — the post-turn reconciler, OFF the hot path. For each
  // completed turn it appends the turn's proposed facts to the working set, runs
  // the secret tripwire (Haiku) over the FT prose, and on a breach authors (Opus)
  // + delivers a secret-preserving retcon. Wired HERE in the dedicated worker
  // process. Takes both Redis connections (batch for the BullMQ queues, realtime
  // for the working-set), the pg Pool (builds its own narrow secret-bearing
  // repo), and the boot-probed Voyage embedder (the working-set embed-on-append).
  const scribeWorker = buildScribeWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    pg,
    embedder,
    logger,
  )

  // Session-reconcile (MYT-74a) — the END-OF-SESSION reconciler that folds a
  // closed session's improvised working set into durable canon (load working set
  // → retrieve canon candidates → Opus reconcile → PURE validate → Voyage embed →
  // one gated commit tx). NOT total: it THROWS on transient failure so BullMQ
  // retries (the §4 markReconciled gate keeps a retry idempotent). Wired HERE in
  // the dedicated worker process. Takes both Redis connections, the pg Pool
  // (builds its own narrow repo), and the boot-probed Voyage embedder.
  const sessionReconcileWorker = buildReconcileWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    pg,
    embedder,
    logger,
  )

  // Session-analysis (MYT-74b) — the END-OF-SESSION narrative closeout that folds a
  // closed session's transcript into durable narrative state (transcript tail + prep
  // sd_playbook + ST running summary + PC roster → ONE Opus call → containment-verify
  // verbatim excerpts → conditional `writeAnalysis` gate). Like reconcile it is NOT
  // total: it THROWS on transient failure so BullMQ retries (the `summary IS NULL`
  // write gate keeps a retry idempotent). Takes NO embedder (analysis doesn't embed).
  // Wired HERE in the dedicated worker process; builds its own repo from the Pool.
  const sessionAnalysisWorker = buildPostSessionAnalysisWorker(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    pg,
    logger,
  )

  // MYT-74b T14 — the QueueEvents BACKSTOP finalize closure. The session-turn
  // QueueEvents subscriber runs `finalizeEndedSession` from the broker side when the
  // farewell turn's in-worker `finally` couldn't (e.g. the worker died mid-finalize).
  // finalizeEndedSession is IDEMPOTENT (the conditional markEnded flip broadcasts
  // exactly once; the per-session reconcile/analysis jobIds collapse a re-enqueue),
  // so the backstop firing after a successful in-worker finalize is harmless. The
  // reconcile + analysis producers go through the POLICY builders so the backstop's
  // enqueues carry the same `attempts: 5` retry policy as the turn-worker's. The
  // producer handles are constructed ONCE here and closed at shutdown so they don't
  // leak (they `add` on redisBatch but are distinct Queue objects).
  const repoForFinalize = createRepo(pg)
  const { bullmqQueue: finalizeReconcileBullQueue, sessionReconcileQueue: finalizeReconcileQueue } =
    buildSessionReconcileQueue(redisBatch)
  const { bullmqQueue: finalizeAnalysisBullQueue, sessionAnalysisQueue: finalizeAnalysisQueue } =
    buildSessionAnalysisQueue(redisBatch)
  const finalizeDeps: FinalizeEndedSessionDeps = {
    sessions: repoForFinalize.sessions,
    reconcileQueue: finalizeReconcileQueue,
    analysisQueue: finalizeAnalysisQueue,
    publish: async (campaignId, frame): Promise<void> => {
      await redisRealtime.publish(
        sessionChannel(env.redisKeyPrefix, campaignId),
        JSON.stringify(frame),
      )
    },
    logger,
  }

  // Session-turn QueueEvents subscriber (MYT-67 §4.8) — the broker-side terminal
  // `turn_error` publisher that closes the `maxStalledCount`-exhaustion gap the
  // per-worker `on('failed')` listener can't see. It `duplicate()`s `redisBatch`
  // for a dedicated BRPOP blocking connection, so its `close()` MUST run on
  // shutdown (handled below) — that connection is NOT torn down by
  // `redisBatch.quit()`. The 5th arg (MYT-74b T13) is the finalize backstop above.
  const sessionTurnEvents = buildSessionTurnQueueEvents(
    redisBatch,
    redisRealtime,
    env.redisKeyPrefix,
    logger,
    (args) => finalizeEndedSession(finalizeDeps, args),
  )

  // Start health server last — only marks healthy once everything else is up.
  const healthPort = resolveHealthPort()
  const health = await startHealthServer(healthPort, {
    pg,
    redisBatch,
    redisRealtime,
    workers: [
      worldGenWorker,
      campaignSetupWorker,
      sessionPrepWorker,
      sessionTurnWorker,
      dmTriggerWorker,
      stEvaluationWorker,
      scribeWorker,
      sessionReconcileWorker,
      sessionAnalysisWorker,
    ],
  })

  logger.info(
    {
      event: 'worker.started',
      healthPort,
      queues: [
        QUEUE_WORLD_GEN,
        QUEUE_CAMPAIGN_SETUP,
        QUEUE_SESSION_PREP,
        QUEUE_SESSION_TURN,
        QUEUE_DM_TRIGGER,
        QUEUE_ST_EVAL,
        QUEUE_SCRIBE,
        QUEUE_SESSION_RECONCILE,
        QUEUE_SESSION_ANALYSIS,
      ],
    },
    'worker started',
  )

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ event: 'worker.shutting_down', signal }, 'worker stopping')

    await health.close().catch((err: unknown) => {
      logger.error({ err }, 'health server close failed')
    })

    await Promise.all([
      closeWithDeadline(worldGenWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(campaignSetupWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(sessionPrepWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(sessionTurnWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(dmTriggerWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(stEvaluationWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(scribeWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(sessionReconcileWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(sessionAnalysisWorker, WORKER_CLOSE_GRACE_MS),
    ])

    // Tear down the session-turn QueueEvents subscriber's dedicated blocking
    // connection (the duplicate()d redisBatch) — it is NOT covered by
    // redisBatch.quit() below, so skipping this leaks a connection per deploy.
    await sessionTurnEvents.close().catch((err: unknown) => {
      logger.error({ err }, 'session-turn queue-events close failed')
    })

    // Close the QueueEvents-backstop finalize producers (MYT-74b T14). They `add`
    // on redisBatch but are distinct Queue objects, so redisBatch.quit() below does
    // NOT close them — skipping this leaks two Queue clients per deploy. Closed after
    // the workers drain so an in-flight finalize backstop can still enqueue.
    await finalizeReconcileBullQueue.close().catch((err: unknown) => {
      logger.error({ err }, 'finalize reconcile queue close failed')
    })
    await finalizeAnalysisBullQueue.close().catch((err: unknown) => {
      logger.error({ err }, 'finalize analysis queue close failed')
    })

    await pg.end().catch((err: unknown) => {
      logger.error({ err }, 'pg pool end failed')
    })

    await redisBatch.quit().catch(() => undefined)
    await redisRealtime.quit().catch(() => undefined)

    process.exit(0)
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal)
    })
  }

  await new Promise<never>(() => undefined)
}

async function closeWithDeadline(worker: BullmqWorker, deadlineMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      worker.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`worker ${worker.name} close exceeded ${String(deadlineMs)}ms`))
        }, deadlineMs)
      }),
    ])
  } catch (err) {
    logger.error(
      { event: 'worker.close.deadline_exceeded', worker: worker.name, err },
      'worker close deadline exceeded; forcing close — in-flight jobs left as stalled',
    )
    await worker.close(true).catch(() => undefined)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  await main()
}
