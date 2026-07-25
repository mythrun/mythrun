import { pathToFileURL } from 'node:url'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
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
import { startHealthServer, type WorkerHealthServer } from './worker/health-server.js'
import { logger } from './llm/logger.js'
import { createVoyageEmbedder } from './llm/embed.js'
import { readCostCap, readCharacterCreationCostCap } from './llm/prep/cost-cap.js'
import { createWorldGenProcessor } from './llm/prep/world-gen-processor.js'
import {
  createCharacterCreationProcessor,
  handleCharacterCreationJobFailure,
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
import { makeSessionState } from './redis/session-state.js'
import { buildSessionTurnQueueEvents } from './session/session-turn-queue-events.js'
import { buildSessionReconcileQueue, buildSessionAnalysisQueue } from './server-queues.js'
import { createRepo } from './repo/index.js'
import { sessionChannel } from './contract/session-channel.js'
import { QUEUE_DM_TRIGGER } from './session/dm-trigger-config.js'
import { makePipelinePublishers } from './worker/publishers.js'
import {
  containProcessor,
  createProcessEscapeGuard,
  describeErrorForLog,
} from './queue/job-containment.js'

/** Default worker health-server port. Overridable via WORKER_HEALTH_PORT for
 *  local dev, where :3001 can collide with an unrelated process (the env var
 *  is read at main() time in resolveHealthPort, not module load). ECS keeps
 *  the default — no task-def change needed. */
const HEALTH_PORT = 3001

/** Local-dev escape hatch for the health-server bind (see HEALTH_PORT). */
function resolveHealthPort(): number {
  const raw = process.env.WORKER_HEALTH_PORT
  return raw !== undefined && raw !== '' ? Number(raw) : HEALTH_PORT
}
const WORKER_PG_POOL_SIZE = 4
// Reserve ~20s headroom under ECS stopTimeout=120s for pg + Redis cleanup.
const WORKER_CLOSE_GRACE_MS = 100_000

/** myth-jykft: bind the worker's health port, failing hard (with a clear,
 *  actionable log on EADDRINUSE) if it is already taken. Called BEFORE any
 *  BullMQ worker is registered — so a second worker on the same host can never
 *  fall through into a hidden competing consumer of the shared queues. The
 *  throw lands in main()'s boot gate (myth-ha6qr), which closes the partials
 *  and exits non-zero. The failure mode this closes: a stray second
 *  `pnpm dev:worker` quietly takes half the session turns, and its tsx-watch
 *  reloads kill them mid-run.
 *
 *  This is deliberately a SAME-HOST guard, not a distributed lock. Production
 *  runs the worker as an ECS service (`aws_ecs_service.worker`, CI pins
 *  desired-count 1) whose rolling deploys run old + new tasks concurrently at
 *  `deployment_maximum_percent = 200`, and BullMQ competing consumers are the
 *  intended scale-out story — so a Redis single-instance lock would break both
 *  deploys and any future replica bump. Under awsvpc each task has its own
 *  loopback, so this bind never sees a sibling replica.
 *
 *  Mirrors `listenOrFail` in server.ts. WORKER_HEALTH_PORT remains the escape
 *  hatch for a deliberate second local instance. */
async function bindHealthOrFail(port: number): Promise<WorkerHealthServer> {
  try {
    return await startHealthServer(port)
  } catch (bindErr) {
    if ((bindErr as { code?: string }).code === 'EADDRINUSE') {
      logger.error(
        { event: 'worker.health_port_in_use', healthPort: port },
        `✗ Worker health port ${String(port)} is already in use — another worker ` +
          `is already running on this host. Refusing to start: a second worker ` +
          `would become a competing consumer on the shared BullMQ queues and ` +
          `steal jobs from it. Stop the other worker, or set WORKER_HEALTH_PORT ` +
          `to run a deliberate second instance.`,
      )
    }
    throw bindErr
  }
}

/** myth-ha6qr: the handles `bootWorker` has brought up so far. Registered one
 *  by one as boot proceeds so a failure at ANY step can close whatever exists
 *  before exiting. Mirrors server.ts's `closePartials(pg, rTR, rTB)`; the extra
 *  members are the worker's own (the bound health socket, whose release lets a
 *  restart rebind it, and the escape-guard disposer). */
interface BootPartials {
  health?: WorkerHealthServer
  pg?: Pool
  redisBatch?: Redis
  redisRealtime?: Redis
  removeEscapeGuard?: () => void
}

/** Close every partially-constructed client, best-effort. `allSettled` so one
 *  failed close can't mask the others (and can't mask the boot error itself). */
async function closeBootPartials(partials: BootPartials): Promise<void> {
  partials.removeEscapeGuard?.()
  await Promise.allSettled([
    partials.health?.close() ?? Promise.resolve(),
    partials.pg?.end() ?? Promise.resolve(),
    partials.redisBatch?.quit() ?? Promise.resolve(),
    partials.redisRealtime?.quit() ?? Promise.resolve(),
  ])
}

/**
 * myth-ha6qr: the worker's boot gate — the counterpart to server.ts's
 * `catch (err) { ...closePartials...; exit non-zero }`.
 *
 * A boot-phase failure is ALWAYS fatal: a bad Voyage key, an unreachable
 * Redis, an unreadable cost-cap row. There is no degraded worker worth
 * running — one that boots without its queues consumes nothing, so the only
 * honest signal is a non-zero exit that ECS turns into a visible crash-loop
 * (and that a local `pnpm dev:worker` surfaces immediately instead of hanging
 * half-live and silent). Classification config-vs-transient happens INSIDE the
 * individual probes (see boot/voyage-probe.ts, boot/wait-for.ts); by the time a
 * throw reaches here the verdict is already "do not run".
 */
async function failBoot(err: unknown, partials: BootPartials): Promise<void> {
  logger.error(
    { component: 'worker', event: 'worker.boot_failed', err: describeErrorForLog(err) },
    'worker boot failed — closing partial clients and exiting non-zero',
  )
  await closeBootPartials(partials)
  process.exit(1)
}

export async function main(): Promise<void> {
  const partials: BootPartials = {}
  try {
    await bootWorker(partials)
  } catch (err) {
    await failBoot(err, partials)
    return
  }
  // Steady state. The signal handlers registered by bootWorker own the exit
  // from here on; nothing else settles this promise.
  await new Promise<never>(() => undefined)
}

async function bootWorker(partials: BootPartials): Promise<void> {
  const env = loadEnv()

  // Bind the health port FIRST — it doubles as the same-host duplicate-worker
  // guard (see bindHealthOrFail). Nothing below may register a queue consumer
  // before this resolves. The server answers 503 until `health.arm(...)` runs
  // at the end of boot, so an un-armed worker never reports green.
  const healthPort = resolveHealthPort()
  const health = await bindHealthOrFail(healthPort)
  partials.health = health

  // Establish connections. Each probe is wrapped in waitFor() (200/500/
  // 1000/2000ms backoff, 5 attempts total) to mirror the API's boot
  // pattern in server.ts — without it, ioredis with
  // `maxRetriesPerRequest: null` (BullMQ requirement) throws
  // "Stream isn't writeable" on the first ping if the TCP socket isn't
  // writable yet. Boot still fails fast on a real outage; it just
  // tolerates the normal connection-establishment race.
  const redisBatch = createBullmqRedisClient(env.redisBatchUrl, { label: 'worker-redis-batch' })
  partials.redisBatch = redisBatch
  await waitFor({ label: 'Redis (batch)', probe: () => redisBatch.ping() })
  // redisRealtime uses the regular client — only used for PUBLISH later
  // (MYT-52); BullMQ constraints don't apply.
  const redisRealtime = createRedisClient(env.redisRealtimeUrl, { label: 'worker-redis-realtime' })
  partials.redisRealtime = redisRealtime
  await waitFor({ label: 'Redis (realtime)', probe: () => redisRealtime.ping() })
  const pg = createPgPool(env.databaseUrl, { max: WORKER_PG_POOL_SIZE })
  partials.pg = pg
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

  // myth-y2qfi + myth-ha6qr: install the process-level escape guard HERE —
  // after every boot probe has passed, and immediately before the first queue
  // consumer is registered. Both halves of that placement are load-bearing:
  //
  //   * It COVERS STEADY STATE. From the next line on a job can run, so a
  //     FLOATING unhandled rejection from ANY job (the 2026-07-19 session-prep
  //     crash: an AI_NoObjectGeneratedError re-thrown from a detached
  //     streaming-repair `.then` chain) is contained and the process SURVIVES,
  //     keeping all nine queues alive. The crash-loop-vs-zombie decision lives
  //     in createProcessEscapeGuard: keep-alive for isolated escapes, fail-fast
  //     on a storm.
  //   * It does NOT COVER BOOT. The guard is keep-alive by default, so
  //     installing it at the top of boot (as it was) turned every boot failure —
  //     bad Voyage key, unreachable Redis — into a swallowed rejection and a
  //     half-live, silent process: health bound but never armed, zero
  //     consumers, no crash. Boot failures now propagate to main()'s boot gate,
  //     which closes the partials and exits non-zero (see failBoot).
  //
  // Nothing between here and health.arm() awaits, so no job can interleave into
  // the window that the guard does not cover — the two phases are disjoint.
  //
  // `shuttingDown` is declared here (hoisted from the shutdown block below) so
  // the guard no-ops during graceful teardown — a teardown-race rejection must
  // not re-trigger the fail-fast exit.
  let shuttingDown = false
  const escapeGuard = createProcessEscapeGuard({
    logger,
    isShuttingDown: () => shuttingDown,
    onStorm: () => {
      // A storm of escapes is a systemic defect, not one bad job: exit non-zero
      // so ECS restarts with a clean slate and the crash-loop surfaces to ops,
      // instead of a health-green zombie that silently fails every job.
      process.exit(1)
    },
  })
  const removeEscapeGuard = escapeGuard.install()
  partials.removeEscapeGuard = removeEscapeGuard

  // World-gen — real processor wired here. MYT-51 landed the non-streaming
  // stages, MYT-52 the streaming stages + coherence pass. The API container
  // (server.ts:buildWorldGenWorker) wires the same processor; both compete
  // for jobs on the same QUEUE_WORLD_GEN. The smoke surfaced that this
  // worker.ts entrypoint was never updated alongside server.ts.
  // myth-y2qfi: every processor constructed HERE is wrapped in containProcessor
  // — the processor-boundary layer that turns any in-chain throw (sync or async)
  // into a logged, contained job failure (BullMQ still fails + retries the job).
  // It complements the process-level guard above: the boundary catches throws in
  // the await path; the guard catches floating rejections that escape it.
  const worldGenWorker = new BullmqWorker(
    QUEUE_WORLD_GEN,
    containProcessor(
      QUEUE_WORLD_GEN,
      createWorldGenProcessor({
        pool: pg,
        redisRealtime,
        redisKeyPrefix: env.redisKeyPrefix,
        logger,
        costCapUsd: worldGenCostCapUsd,
        voyageApiKey: env.voyageApiKey,
      }),
      logger,
    ),
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

  const campaignSetupWorker = new BullmqWorker(
    QUEUE_CAMPAIGN_SETUP,
    containProcessor(QUEUE_CAMPAIGN_SETUP, campaignSetupRouter, logger),
    {
      connection: redisBatch,
      concurrency: CONCURRENCY_CAMPAIGN_SETUP,
    },
  )

  // MYT-102 A2: exhausted-transient surfacing. A transient stage failure
  // rethrows so BullMQ retries (attempts:2) — but the FINAL failed attempt
  // used to leave character_concepts at 'processing' forever (markFailed only
  // ran on terminal errors; no producer existed for a job-level failure).
  // The handler acts only when attemptsMade >= attempts: it flips the concept
  // to 'failed', publishes a terminal stage-failed (errorCode, willRetry:false)
  // on the pipeline channel, and logs loud. It never throws (internal
  // catch-and-log), so the bare `void` here is safe for BullMQ's emitter.
  campaignSetupWorker.on('failed', (job, err) => {
    void handleCharacterCreationJobFailure({ pool: pg, publishEvent, logger }, job, err)
  })

  // Session-prep (MYT-61) — one job per (campaign, session_number), enqueued
  // by MYT-63 with jobId `sp-${campaignId}-${sessionNumber}`. Streams two prose
  // docs through Opus; the processor owns the per-session pipeline_runs
  // (`session-prep:${n}`) lifecycle. A prep failure is session-scoped and never
  // fails the campaign. The API container (server.ts) wires the same processor.
  const sessionPrepWorker = new BullmqWorker(
    QUEUE_SESSION_PREP,
    containProcessor(
      QUEUE_SESSION_PREP,
      createSessionPrepProcessor({ pool: pg, publishEvent, publishProse }),
      logger,
    ),
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
  // myth-x4ca4 — the finalize needs the `:ending` fence release; bind a
  // SessionState on the realtime client (the fence lives there).
  const finalizeSessionState = makeSessionState(redisRealtime, env.redisKeyPrefix)
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
    clearEnding: (campaignId) => finalizeSessionState.clearEnding(campaignId),
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

  // Arm the (already bound) health server last — only marks healthy once
  // everything else is up. The socket itself was claimed at the top of main()
  // as the duplicate-worker guard; this is the phase that supplies the probes.
  health.arm({
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

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // Detach the escape guard: teardown is short and every step below has its
    // own .catch, so we no longer need (or want) the process-level net racing
    // the graceful exit. `isShuttingDown` already no-ops it; this removes the
    // listeners so they don't leak across a hot-reload in tests.
    removeEscapeGuard()
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
