// backend/src/routes/campaigns.ts
//
// Campaign-scoped HTTP routes.
//
// MYT-50 landed GET /status + GET /status/stream.
// MYT-51 Task 9 extends the plugin with POST /api/campaigns — the world-gen
// create route. The status routes stay; subsequent issues add details /
// member-mgmt / character-creation routes here.
//
// Spec: docs/superpowers/specs/2026-05-12-myt-50-pipeline-status-surface.md §3
//       docs/superpowers/specs/2026-05-12-myt-51-world-gen-non-streaming-design.md
//         D2 (body shape), D3-D5 (synth + gate), D11 (cost cap),
//         §"POST /api/campaigns flow" (the full step sequence).
//
// SSE attach-then-snapshot ordering matters: openSseConnection's onClose is
// composed so that subscriber.attach()'s detach() runs BEFORE the counter
// decrements. Snapshot is computed AFTER attach so any pipeline events
// published during the gap are queued on the sink rather than lost.
//
// `app.ts` (T12) registers this plugin and constructs the worldGenQueue
// from BullMQ at app boot.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Logger as PinoLogger } from 'pino'
import { z } from 'zod'
import type { CampaignSummary, MyCampaignsResponse } from '@mythrun/contract/rest'
import { WorldColorPairSchema } from '@mythrun/contract/rest'
import { createRepo, type Repo } from '../repo/index.js'
import type { HubCardRow } from '../repo/campaigns.js'
import { createPipelineRunsRepo, type PipelineRunsRepo } from '../repo/pipeline-runs.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { requireUser } from '../auth/require-user.js'
import { worldSnapshotView } from '../repo/world-snapshot-view.js'
import { genSeedView, type GenSeed } from '../repo/gen-seed-view.js'
import { campaignWikiView } from '../repo/campaign-wiki-view.js'
import { resolveSpeaker } from '../session/attribution.js'
import {
  derivePhase,
  deriveCardPhase,
  type PhaseAndStages,
  type PipelinePhase,
} from '../sse/derive-phase.js'
import { openSseConnection } from '../sse/sse-connection.js'
import type { PipelineSubscriber } from '../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../sse/connection-counter.js'
import { uuidv7 } from '../repo/uuidv7.js'
import { runInputGate } from '../llm/prep/input-gate.js'
import { getPreview } from '../preview/preview-store.js'
import { createRejectionStormCounter } from '../auth/rejection-storm.js'
// MYT-89 A3: the read-only storm check + the 422 gate-rejection emitter were
// extracted to concept-gate.ts (shared verbatim by the create route here, the
// synthesize-preview route, and the A4 rework route). Behavior-identical.
import { checkRejectionStorm, handleGateRejection } from './concept-gate.js'

// Minimal contract for the world-gen BullMQ queue. Declared here (not
// imported from BullMQ directly) so the plugin's Opts shape isn't coupled
// to the queue's generic-heavy class type; tests inject a hand-rolled spy.
//
// The `getJob` shape (used by POST /resume's not_started recovery branch)
// mirrors the bits of BullMQ's Job<T> class that resume actually reads —
// `isCompleted()` and `isFailed()` — so the runtime check survives a
// minor BullMQ-typing churn without touching this file.
export interface WorldGenJobLike {
  isCompleted(): Promise<boolean> | boolean
  isFailed(): Promise<boolean> | boolean
}

export interface WorldGenQueueLike {
  add(name: string, data: { campaignId: string }, opts?: { jobId?: string }): Promise<unknown>
  getJobCounts(states: readonly string[]): Promise<Record<string, number>>
  getJob(jobId: string): Promise<WorldGenJobLike | null | undefined>
}

export interface Opts {
  readonly pool: Pool
  readonly subscriber: PipelineSubscriber
  readonly counter: ConnectionCounter
  /** The single allowlisted CORS origin (config.env.frontendBaseUrl, the value
   *  @fastify/cors is registered with). Threaded to openSseConnection so the
   *  hijacked SSE responses (/status/stream, /prep-status) echo the CORS header
   *  @fastify/cors's onSend hook can't set on a hijacked reply. */
  readonly frontendBaseUrl: string
  // The MYT-51 T9 fields below are typed as optional so app.ts's existing
  // (MYT-50-era) registration still typechecks before T12 wires the new
  // dependencies in. The POST /api/campaigns handler runtime-asserts they
  // are present at request time — T12 turns the runtime assert into a
  // boot-time invariant by always passing them. New code paths in T10/T11
  // that need these fields MUST runtime-check (this plugin's own checks
  // are the canonical pattern).
  /** Redis client for the rejection-storm counter. Required by POST /api/campaigns. */
  readonly redis?: Redis
  /** Environment-pinned key prefix — e.g. "production:use1:". Required by POST. */
  readonly redisKeyPrefix?: string
  /** BullMQ queue handle for `world-gen-non-streaming`. Required by POST. */
  readonly worldGenQueue?: WorldGenQueueLike
}

interface Params {
  readonly campaignId: string
}

// MVP: session 1 only (MYT-59 scope); session-runtime resolves the current
// session later. Used by GET /prep-status's ready/generating snapshot.
const PREP_SESSION_NUMBER = 1

// ---------------------------------------------------------------------------
// Body schema (MYT-51 D2). Discriminated union; only the `'new'` arm is
// functional at launch — `'existing'` is an additive future addition.
// Unknown `kind` produces a standard 400 from Zod (not 501).
// ---------------------------------------------------------------------------

// myth-4lhr: campaign + world names are auto-generated by concept_intake's
// LLM call from the synthesized world.name field. The CREATE body no longer
// accepts a name — campaigns are inserted with a 'Untitled' placeholder and
// the worker UPDATEs both campaigns.name and worlds.name once stage 1
// completes. Users rename later via PATCH /api/campaigns/:campaignId/name.
const CreateCampaignBodySchema = z.object({
  world: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('new'),
      source: z.discriminatedUnion('mode', [
        z.object({
          mode: z.literal('freeform'),
          // Roc-C3 length cap. Lower bound 20 keeps trivially-empty inputs
          // out (an empty concept is a body-shape bug, not a gate concern).
          concept: z.string().min(20).max(4000),
        }),
        // MYT-89 A5: guided create now COMMITS an already-gated preview.
        // Synthesis + the input gate moved to POST /synthesize-preview (and
        // /rework), which park the gated concept in Redis under this opaque
        // previewId. The commit loads it by (authUser, previewId) — no picks,
        // no re-synth, no re-gate. `z.string()` (not `z.uuid()`) keeps the
        // 400-vs-410 split clean: a malformed body 400s here at Zod; a
        // well-formed-but-absent/expired previewId 410s at the store load.
        z.object({
          mode: z.literal('guided'),
          previewId: z.string(),
        }),
      ]),
    }),
  ]),
  // myth-exac T21: dev-tool opt-in for the world's persisted bypass flag.
  // Gated server-side to {bypass-auth} ∩ {NODE_ENV ∈ {development,test}};
  // production callers cannot set this. When true the world's snapshot
  // endpoint widens to include discoverable + secret tiers (still
  // intersected with a per-request bypass-scope check at read time).
  devBypassAccessFilter: z.boolean().optional(),
})

// ---------------------------------------------------------------------------
// Query schema for GET /api/campaigns/:campaignId/transcript/search (MYT-74d).
// `q` is the player's raw search; trimmed-min(1) rejects whitespace-only
// queries with a 400. limit/offset are paginated reads with hard caps so a
// crafted request can't ask for an unbounded page.
// ---------------------------------------------------------------------------

const TranscriptSearchQuerySchema = z.object({
  q: z.string().trim().min(1),
  sessionId: z.uuid().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
  offset: z.coerce.number().int().min(0).max(500).default(0),
})

interface TranscriptSearchQuerystring {
  q?: string
  sessionId?: string
  limit?: string
  offset?: string
}

// ---------------------------------------------------------------------------
// Errors raised by the create transaction (typed so the route can map
// them to HTTP codes without leaking internal failure shape into prose).
// ---------------------------------------------------------------------------

class InsufficientCreditsError extends Error {
  constructor() {
    super('insufficient_credits')
  }
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only synchronous app.get/post registrations).
// eslint-disable-next-line @typescript-eslint/require-await
export const campaignsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)
  const pipelineRunsRepo = createPipelineRunsRepo(opts.pool)

  // POST /api/campaigns (T9) depends on redis + worldGenQueue. T12 will
  // make these required in Opts; until then, runtime-assert at the post-
  // registration boundary so a misconfigured app boot fails loudly rather
  // than 500ing on the first request.
  function requireCreateRouteDeps(): {
    redis: Redis
    redisKeyPrefix: string
    worldGenQueue: WorldGenQueueLike
  } {
    /* c8 ignore start — boot-time invariant assert: T12 made these
     * required in Opts, so the app builder always passes them. This
     * assertion is a belt-and-suspenders second layer; tests build
     * with the full Opts so the throw is unreachable. */
    if (!opts.redis || opts.redisKeyPrefix === undefined || !opts.worldGenQueue) {
      throw new Error(
        'campaignsRoutes: POST /api/campaigns requires {redis, redisKeyPrefix, worldGenQueue} ' +
          'in Opts (wired by T12). Missing: ' +
          [
            opts.redis ? null : 'redis',
            opts.redisKeyPrefix === undefined ? 'redisKeyPrefix' : null,
            opts.worldGenQueue ? null : 'worldGenQueue',
          ]
            .filter(Boolean)
            .join(', '),
      )
    }
    /* c8 ignore stop */
    return {
      redis: opts.redis,
      redisKeyPrefix: opts.redisKeyPrefix,
      worldGenQueue: opts.worldGenQueue,
    }
  }

  // POST /api/campaigns/:campaignId/resume (T10) depends only on the
  // BullMQ queue handle — no redis / redisKeyPrefix, because the
  // rejection-storm counter doesn't fire on resume. Narrower than the
  // create-route assert so resume can run in environments that wire the
  // queue but not the storm counter (a thin-deployment future option).
  function requireResumeRouteDeps(): { worldGenQueue: WorldGenQueueLike } {
    /* c8 ignore start — boot-time invariant assert (same as
     * requireCreateRouteDeps): T12 made worldGenQueue required, so the
     * assertion is unreachable in any tested boot. */
    if (!opts.worldGenQueue) {
      throw new Error(
        'campaignsRoutes: POST /api/campaigns/:campaignId/resume requires worldGenQueue ' +
          'in Opts (wired by T12).',
      )
    }
    /* c8 ignore stop */
    return { worldGenQueue: opts.worldGenQueue }
  }

  async function loadSnapshot(campaignId: string): Promise<PhaseAndStages | null> {
    const campaign = await repo.campaigns.getById(campaignId)
    /* c8 ignore start — `!campaign` arm: requireCampaignMember has
     * already verified the row exists in this scope; deletion-mid-flight
     * is the race condition this guard protects against. */
    if (!campaign) return null
    /* c8 ignore stop */
    const world = await repo.worlds.getById(campaign.worldId)
    /* c8 ignore start — same: world rows aren't deleted while campaigns
     * reference them (FK + soft-delete invariants). */
    if (!world) return null
    /* c8 ignore stop */
    const runs = await pipelineRunsRepo.listLatestForCampaign(campaignId)
    return derivePhase({
      campaign: { id: campaign.id, status: campaign.status, world_id: campaign.worldId },
      world: { id: world.id, status: world.status },
      runs,
    })
  }

  // myth-gcsp1: the phases where the generating GRAPH renders AND committed
  // entities can exist — the window where a mid-gen refresh needs the connect
  // frame widened with a rehydration seed. `not_started` (no entities yet) and
  // the failure phase (retry surface, not a graph) are excluded, so no wasted
  // reads outside the window.
  const GEN_SEED_PHASES: ReadonlySet<PipelinePhase> = new Set<PipelinePhase>([
    'world_gen',
    'world_snapshot_ready',
  ])

  // The gen-time graph seed for the SSE connect frame (myth-gcsp1). Empty ({}) for
  // any non-generating phase; otherwise the known-tier entities/relationships so
  // far (genSeedView) so a refresh rehydrates the graph. Known-tier only — exactly
  // what the live stream already delivered to this member. The 409-gated
  // world-snapshot route is untouched.
  async function loadGraphSeed(
    campaignId: string,
    phase: PipelinePhase,
  ): Promise<GenSeed | Record<string, never>> {
    if (!GEN_SEED_PHASES.has(phase)) return {}
    const campaign = await repo.campaigns.getById(campaignId)
    /* c8 ignore start — `!campaign` arm: requireCampaignMember has already
     * verified the row; deletion-mid-flight is the race this guards. */
    if (!campaign) return {}
    /* c8 ignore stop */
    return genSeedView.fetch(opts.pool, campaign.worldId)
  }

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/status (MYT-50)
  // -------------------------------------------------------------------------

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/status',
    {
      config: {
        // Per-IP cap. Snapshot fetch is cheap; the 60/min ceiling protects
        // against runaway client polling that would otherwise hammer the DB.
        rateLimit: { max: 60, timeWindow: '1 minute' },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const snapshot = await loadSnapshot(request.params.campaignId)
      /* c8 ignore start — `!snapshot` arm: requireCampaignMember
       * has already verified membership; deletion-between-check is
       * the race this guard handles. */
      if (!snapshot) return reply.code(404).send({ code: 'campaign_not_found' })
      /* c8 ignore stop */
      return reply.send(snapshot)
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/status/stream (MYT-50)
  // -------------------------------------------------------------------------

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/status/stream',
    {
      config: {
        // Per-USER (not per-IP) cap on stream opens.
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const campaignId = request.params.campaignId
      opts.counter.increment()

      let detach: (() => void) | null = null
      const sink = openSseConnection({
        request,
        reply,
        logger: request.log as PinoLogger,
        allowedOrigin: opts.frontendBaseUrl,
        onClose: () => {
          if (detach) detach()
          opts.counter.decrement()
        },
      })
      detach = opts.subscriber.attach(campaignId, sink)

      const snapshot = await loadSnapshot(campaignId)
      /* c8 ignore start — `!snapshot` arm fires when the campaign is
       * deleted between the membership check and the snapshot load — a
       * tiny race window that test fixtures don't reliably reproduce.
       * The behavior (close the sink with 'unknown') is exercised by the
       * direct snapshot-loader unit tests; this is the SSE-route arm. */
      if (!snapshot) {
        sink.close('unknown')
        return reply
      }
      /* c8 ignore stop */
      // myth-gcsp1: widen the connect frame with the gen-time graph seed so a
      // mid-gen refresh/reconnect rehydrates a populated graph. Known-tier only
      // (genSeedView) = exactly what the live entity/edge stream already gave this
      // member — no new exposure. {} for a non-generating phase. Footprint here is
      // deliberately minimal (a follow-up task owns this file).
      const seed = await loadGraphSeed(campaignId, snapshot.phase)
      sink.write(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot, ...seed })}\n\n`)
      return reply
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/prep-status (MYT-62 T6)
  //
  // Player-facing SSE feed for the "DM is preparing tonight's session…"
  // loading screen. Phase-ONLY by construction: it rides the same
  // `pipeline:campaign:{id}` channel as the status stream, where the
  // prep-started / prep-ready / prep-failed phase events are published.
  // The Task-2 tripwire in pipeline-subscriber.ts drops any event whose
  // `type` is not in PIPELINE_SSE_EVENTS — so a stray prose `prep-delta`
  // (sd_playbook secrets) published on this channel can never reach a
  // player sink. That is the structural enforced-ignorance guarantee:
  // NO prose, by construction.
  //
  // The snapshot is a single ready/generating bit derived from whether a
  // session_preps row exists for the session — distinct from the status
  // stream's world-gen phase snapshot, but the SSE wiring is identical.
  // -------------------------------------------------------------------------

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/prep-status',
    {
      config: {
        // Per-USER cap on stream opens (mirrors status/stream).
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const campaignId = request.params.campaignId
      opts.counter.increment()

      let detach: (() => void) | null = null
      const sink = openSseConnection({
        request,
        reply,
        logger: request.log as PinoLogger,
        allowedOrigin: opts.frontendBaseUrl,
        onClose: () => {
          if (detach) detach()
          opts.counter.decrement()
        },
      })
      detach = opts.subscriber.attach(campaignId, sink)

      const exists = await repo.sessionPreps.existsFor(campaignId, PREP_SESSION_NUMBER)
      sink.write(
        `event: snapshot\ndata: ${JSON.stringify({ status: exists ? 'ready' : 'generating' })}\n\n`,
      )
      return reply
    },
  )

  // -------------------------------------------------------------------------
  // POST /api/campaigns (MYT-51 T9)
  //
  // Flow (spec § "POST /api/campaigns flow", revised after the round-1
  // blind review fixes Wyvern-Min7 / Kraken-Imp5 / Phoenix-Imp1 / etc.):
  //   1. Zod body parse                                        → 400
  //   2a. Rate-limit (Fastify @fastify/rate-limit, route-level) → 429
  //   2b. Concurrent-generation guard                           → 409
  //   2c. Rejection-storm cooldown                              → 429
  //   2d. Credit balance peek                                   → 403
  //   2e. Queue-depth admission                                 → 503
  //   3. Concept source:
  //        freeform → passthrough concept
  //        guided   → load already-gated preview (authUser, previewId) → 410
  //   4. Input gate (Sonnet) — FREEFORM ONLY                    → 422
  //        (guided was gated at synthesize-preview / rework; no re-gate)
  //   5. Locked transaction (advisory lock, debit, rows)
  //   6. Reset rejection-storm counter
  //   7. Enqueue world-gen job
  //   8. 201 { campaignId }                                     ← Phoenix-Min7
  // -------------------------------------------------------------------------

  app.post(
    '/api/campaigns',
    {
      config: {
        // Per-USER cap: 5 creates/min. Far below what the queue-depth + cost
        // controls would tolerate, but enough to block adversarial Sonnet-burn
        // loops that try to slip past the rejection-storm cooldown.
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
        pipelineRoute: true,
      },
    },
    async (request, reply) => {
      const createDeps = requireCreateRouteDeps()
      const stormCounter = createRejectionStormCounter(createDeps.redis, createDeps.redisKeyPrefix)

      // Step 1: body validation.
      const parsed = CreateCampaignBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'invalid_body',
          issues: parsed.error.issues,
        })
      }
      const body = parsed.data
      const dbUser = requireDbUser(request)

      // myth-exac T21: gate the dev-bypass field to bypass-auth + dev/test
      // env. Production callers never carry the 'bypass' scope (the bypass
      // plugin doesn't load in NODE_ENV=production), and the NODE_ENV check
      // is defense-in-depth in case a misconfigured deploy ever inherits a
      // bypass-attached token. Either layer alone would suffice; the AND
      // matches the per-request defense-in-depth shape used by the
      // world-snapshot read at line 544.
      if (body.devBypassAccessFilter === true) {
        const authUser = requireUser(request)
        const isBypassAuth = authUser.scopes.includes('bypass')
        const nodeEnv = process.env.NODE_ENV
        const isDevEnv = nodeEnv === 'development' || nodeEnv === 'test'
        if (!isBypassAuth || !isDevEnv) {
          return reply.code(400).send({ code: 'bypass_not_permitted' })
        }
      }
      const devBypassAccessFilter = body.devBypassAccessFilter ?? false

      // Step 2b: concurrent-generation guard.
      const inFlight = await repo.campaigns.findInFlightGenerationForUser(dbUser.id)
      if (inFlight) {
        return reply.code(409).send({ code: 'concurrent_generation_in_progress' })
      }

      // Step 2c: rejection-storm cooldown (read-only check; increment only
      // on a later 422).
      const stormCheck = await checkRejectionStorm(
        createDeps.redis,
        createDeps.redisKeyPrefix,
        dbUser.id,
      )
      if (stormCheck.cooldownActive) {
        reply.header('Retry-After', String(stormCheck.retryAfterSeconds))
        return reply.code(429).send({ code: 'rejection_storm_cooldown' })
      }

      // Step 2d: credit balance peek (no advisory lock).
      const peekBalance = await repo.credits.getWorldGenBalance(dbUser.id)
      if (peekBalance < 1) {
        return reply.code(403).send({ code: 'insufficient_credits', creditType: 'world_gen' })
      }

      // Step 2e: queue-depth admission.
      const counts = await createDeps.worldGenQueue.getJobCounts(['waiting', 'active', 'delayed'])
      const queueDepth = sumQueueCounts(counts)
      if (queueDepth > 20) {
        reply.header('Retry-After', '60')
        return reply.code(503).send({ code: 'queue_full' })
      }

      // Step 3+4: resolve the concept to commit.
      //  - FREEFORM (unchanged): passthrough the user's concept → input gate,
      //    422 on reject.
      //  - GUIDED (MYT-89 A5): load the ALREADY-GATED preview by
      //    (authUser, previewId). 410 if absent/expired/cross-user — the userId
      //    is baked into the Redis key, so a cross-user previewId simply misses
      //    (no IDOR surface). NO re-synthesis, NO re-gate: the stored concept
      //    was synthesized AND gated at synthesize-preview / rework and is
      //    server-authored (the client only ever holds the opaque previewId,
      //    never the concept), so re-gating would burn Sonnet on an input the
      //    caller cannot have altered.
      const source = body.world.source
      let concept: string
      if (source.mode === 'freeform') {
        const gate = await runInputGate({ concept: source.concept, intentSummary: null })
        if (gate.verdict === 'reject') {
          return handleGateRejection({
            reply,
            gate,
            userId: dbUser.id,
            mode: 'freeform',
            synthesizedConcept: source.concept,
            stormIncrementer: () => stormCounter.incrementAndCheck(dbUser.id),
            logger: request.log as PinoLogger,
          })
        }
        concept = source.concept
      } else {
        const preview = await getPreview(
          createDeps.redis,
          createDeps.redisKeyPrefix,
          dbUser.id,
          source.previewId,
        )
        if (preview === null) {
          return reply.code(410).send({ code: 'preview_expired' })
        }
        concept = preview.concept
      }

      // Step 5: locked transaction (debit + worlds + campaigns + member +
      // pipeline_runs seed row).
      let txResult: { campaignId: string; worldId: string }
      try {
        txResult = await executeCreateTransaction(repo, {
          userId: dbUser.id,
          concept,
          devBypassAccessFilter,
        })
        /* c8 ignore start — v8 branch-coverage quirk on the catch-arm
         * if-block closing brace; both truthy (403) and falsy (rethrow
         * to global handler) arms ARE exercised by the
         * "insufficient_credits" tests + the "rethrows non-
         * InsufficientCreditsError" test, but v8 flags line 417 as a
         * partial branch regardless. */
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return reply.code(403).send({ code: 'insufficient_credits', creditType: 'world_gen' })
        }
        throw err
      }
      /* c8 ignore stop */

      // myth-exac T21: audit-log dev-bypass opt-in for every world it
      // applies to. Logged AFTER the insert commits so the line implies a
      // persisted state (a 5xx between commit and log would still leave the
      // flag on the world; an absent log line means the row didn't land).
      if (devBypassAccessFilter) {
        request.log.info(
          {
            event: 'world.dev_bypass_access_filter.enabled',
            campaignId: txResult.campaignId,
            userId: dbUser.id,
          },
          'dev-mode access tier bypass enabled for new world',
        )
      }

      // Step 6: reset rejection-storm counter — user produced a passing
      // concept, so the slate is clean.
      await stormCounter.reset(dbUser.id)

      // Step 7: enqueue. `jobId: campaignId` gives BullMQ-side dedupe.
      await createDeps.worldGenQueue.add(
        'world-gen',
        { campaignId: txResult.campaignId },
        { jobId: txResult.campaignId },
      )

      // Step 8: 201 with campaignId only (Phoenix-Min7 — worldId is not
      // a user-facing identifier).
      return reply.code(201).send({ campaignId: txResult.campaignId })
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId (MYT-51 T10)
  //
  // Member-only campaign detail surface. Returns the campaign row, the
  // world row, and the member list. Used by the dev tool's
  // campaign-details panel + a future user-facing campaign dashboard.
  // -------------------------------------------------------------------------

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId',
    {
      config: {
        // Per-IP. Member-list + world fields are cheap reads; 60/min
        // matches the status-fetch ceiling so a UI that fans out both
        // calls on a tick doesn't trip its own limit on either axis.
        rateLimit: { max: 60, timeWindow: '1 minute' },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const campaign = await repo.campaigns.getById(request.params.campaignId)
      /* c8 ignore start — `!campaign` arm: same defense-in-depth as
       * loadSnapshot's null return. */
      if (!campaign) return reply.code(404).send({ code: 'campaign_not_found' })
      /* c8 ignore stop */
      const world = await repo.worlds.getById(campaign.worldId)
      /* c8 ignore start — `!world` arm: world rows aren't deleted while
       * campaigns reference them; defense-in-depth. */
      if (!world) return reply.code(404).send({ code: 'world_not_found' })
      /* c8 ignore stop */
      const members = await repo.campaigns.listMembers(campaign.id)
      // MYT-53 T20: surface the campaign's persisted PCs (one row per
      // completed character_concept). The concept→join→character chain
      // is the ground truth — a `campaign_characters` row without a
      // matching completed concept would be a worker bug, so we filter
      // on the concept status to avoid surfacing half-built rows.
      // MYT-54 T14: 'integrated' is the terminal state after cross-PC
      // integration; both 'completed' (post-MYT-53) and 'integrated'
      // (post-MYT-54) mean the PC entity exists and the character row
      // is in its final shape.
      const charactersResult = await repo.characters.listCampaignCharacters(campaign.id)
      const characters = charactersResult.map((r) => ({
        userId: r.user_id,
        characterId: r.character_id,
        name: r.name,
        class: r.class,
        level: r.level,
      }))
      return reply.send({ campaign, world, members, characters })
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/world-snapshot (myth-exac)
  //
  // Returns the known-tier slice of a world's persisted content — the reveal's
  // data source, incl. the introduction page. Owner-only. 409 until
  // world_introduction (the reveal boundary, myth-zaqxh) completes: the intro
  // is written there, and entities + facts + relationships are all committed by
  // then, so any earlier read would surface a partial world (or a missing
  // intro).
  //
  // Dev-mode bypass widens the projection to include the `discoverable`
  // and `secret` tiers, but ONLY when the requester is also in bypass-auth
  // (defense in depth: a dev-tool-created world's secrets must NOT leak
  // via a prod-auth-user request, even if the world's dev_bypass_access_
  // filter column says yes).
  // -------------------------------------------------------------------------

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/world-snapshot',
    {
      config: {
        // Per-IP. Snapshot composition is heavier than the status route
        // (7 read queries) so we cap tighter — 30/min is plenty for the
        // dev tool's polling cadence + manual inspection workflow.
        rateLimit: { max: 30, timeWindow: '1 minute' },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo, 'owner'),
    },
    async (request, reply) => {
      const campaign = await repo.campaigns.getById(request.params.campaignId)
      /* c8 ignore start — `!campaign` arm: requireCampaignMember has
       * already verified the row exists; deletion-mid-flight is the
       * race this guard protects against. */
      if (!campaign) return reply.code(404).send({ code: 'campaign_not_found' })
      /* c8 ignore stop */

      // Pre-readiness gate: world_introduction (the reveal boundary) must have
      // committed for the snapshot to be coherent AND carry the intro page.
      // Earlier stages leave the entity/relationships tables partial and have no
      // intro yet.
      const ready = await pipelineRunsRepo.isStageCompleted(
        campaign.worldId,
        'world_introduction',
      )
      if (!ready) return reply.code(409).send({ code: 'snapshot_not_ready' })

      const world = await repo.worlds.getById(campaign.worldId)
      /* c8 ignore start — `!world` arm: campaigns.world_id is a FK with
       * ON DELETE CASCADE; if the world is gone the campaign would be
       * gone too and requireCampaignMember would have 403'd. */
      if (!world) return reply.code(404).send({ code: 'world_not_found' })
      /* c8 ignore stop */

      // Bypass requires BOTH the per-world flag AND the requester being
      // in bypass-auth (the bypass plugin attaches scopes: ['bypass']).
      // jwt-mode users have scopes from the access token; production
      // users never get the bypass scope so this branch can't fire
      // outside dev/test.
      const user = requireUser(request)
      const bypass = world.devBypassAccessFilter && user.scopes.includes('bypass')

      const snapshot = await worldSnapshotView.fetch(opts.pool, campaign.worldId, { bypass })
      return reply.send(snapshot)
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/wiki (MYT-74c T10)
  //
  // The PLAYER-facing campaign wiki: any campaign member (not owner-only)
  // reads the narrow `known`-tier projection. Always known-tier — players
  // never get the discoverable/secret content, so unlike world-snapshot
  // there is no bypass widening. Same 409-until-stage-4 readiness gate
  // (entities + facts + relationships are only fully written once
  // entity_relationships commits), but the `wiki_not_ready` code.
  // -------------------------------------------------------------------------

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/wiki',
    {
      config: {
        // Member-read surface (every party member, likely UI-fanned) → per-user
        // key, 60/min — the `status` member-poll precedent, not the owner
        // snapshot's 30/IP.
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const campaign = await repo.campaigns.getById(request.params.campaignId)
      /* c8 ignore start — `!campaign` arm: requireCampaignMember has already
       * verified the row exists; deletion-mid-flight is the race this guards. */
      if (!campaign) return reply.code(404).send({ code: 'campaign_not_found' })
      /* c8 ignore stop */

      const ready = await pipelineRunsRepo.isStageCompleted(
        campaign.worldId,
        'entity_relationships',
      )
      if (!ready) return reply.code(409).send({ code: 'wiki_not_ready' })

      const wiki = await campaignWikiView.fetch(opts.pool, campaign.worldId)
      return reply.send(wiki)
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/transcript/search (MYT-74d)
  //
  // Player-facing in-session lookback: FTS over the prose-bearing transcript
  // (dm_text + player_message), campaign-scoped, session-filterable. Public by
  // construction (the FT never narrates secrets); the only structural guard is
  // the campaign_id join (inside searchTranscript) + requireCampaignMember.
  // NOT a pipelineRoute — session-runtime data, no stage gate.
  // -------------------------------------------------------------------------

  app.get<{ Params: Params; Querystring: TranscriptSearchQuerystring }>(
    '/api/campaigns/:campaignId/transcript/search',
    {
      config: {
        // Member-read, per-user (UI-fanned). 30/min — heavier than the 60/min
        // status/wiki polls (an O(matches) rank-sort + per-row ts_headline).
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const parsed = TranscriptSearchQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_query', issues: parsed.error.issues })
      }
      const { q, sessionId, limit, offset } = parsed.data
      const campaignId = request.params.campaignId

      const characters = await repo.characters.listForCampaign(campaignId)
      const characterByUser = new Map(characters.map((ch) => [ch.userId, ch.name]))

      const hits = await repo.transcriptSearch.searchTranscript({
        campaignId,
        query: q,
        sessionId,
        limit,
        offset,
      })

      const shaped = hits.map((h) => ({
        sessionId: h.sessionId,
        sessionNumber: h.sessionNumber,
        seq: h.seq,
        messageType: h.messageType,
        speaker: resolveSpeaker(h.userId, characterByUser),
        content: h.content,
        snippet: h.snippet,
        createdAt: h.createdAt,
      }))

      return reply.send({ hits: shaped, query: q, limit, offset })
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/campaigns/mine (MYT-51 T10 → MYT-87 T11 hub-card expansion)
  //
  // List the caller's campaigns — owned or any role where they are a member
  // with invite_accepted = true — as the full home-hub card payload. The
  // repo's `listHubCardsForUser` joins campaign_members with that filter (so
  // owned + joined collapse into one ordered list), filters archived, and
  // batches the world / session / party reads with no fanout. The handler
  // projects each row to the `CampaignSummary` wire shape: derives the
  // per-viewer `cardPhase`, validates the colour pair, and serializes the
  // `Date` columns to ISO strings.
  // -------------------------------------------------------------------------

  app.get(
    '/api/campaigns/mine',
    {
      config: {
        // Per-IP. List endpoint; 30/min is plenty for any reasonable UI
        // refresh cadence (and stops a buggy poll loop from hammering DB).
        rateLimit: { max: 30, timeWindow: '1 minute' },
        pipelineRoute: true,
      },
    },
    async (request, reply) => {
      const dbUser = requireDbUser(request)
      const cards = await repo.campaigns.listHubCardsForUser(dbUser.id)
      const summaries: CampaignSummary[] = cards.map((card) =>
        toHubCardSummary(card, dbUser.id),
      )
      const body: MyCampaignsResponse = { campaigns: summaries }
      return reply.send(body)
    },
  )

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:campaignId/resume (MYT-51 T10)
  //
  // Owner-only. Full polymorphic switch over PipelinePhase's 8 arms with
  // assertNever (Phoenix-C1). The per-arm behavior is documented in spec
  // lines 554–607 — most arms 409 with a code; world_gen_failed and
  // not_started have the recovery / re-enqueue paths.
  //
  // Per-sub rate limit (5/min) is much tighter than the GET endpoints —
  // a resume is a real state-changing operation that triggers a queue
  // add, so we cap retries to protect both the queue and the cost cap.
  // -------------------------------------------------------------------------

  app.post<{ Params: Params }>(
    '/api/campaigns/:campaignId/resume',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo, 'owner'),
    },
    async (request, reply) => {
      const resumeDeps = requireResumeRouteDeps()
      const campaignId = request.params.campaignId
      const campaign = await repo.campaigns.getById(campaignId)
      // requireCampaignMember already 403'd if the row was missing, but
      // load it again to read world_id (the membership row is keyed on
      // campaign_id, not on the campaign object).
      /* c8 ignore start — `!campaign` arm: same defense-in-depth as
       * loadSnapshot's null return. */
      if (!campaign) return reply.code(404).send({ code: 'campaign_not_found' })
      /* c8 ignore stop */

      const snapshot = await loadSnapshot(campaignId)
      /* c8 ignore start — `!snapshot` arm: requireCampaignMember
       * has already verified membership; deletion-between-check is
       * the race this guard handles. */
      if (!snapshot) return reply.code(404).send({ code: 'campaign_not_found' })
      /* c8 ignore stop */

      return dispatchResume({
        reply,
        phase: snapshot.phase,
        campaignId,
        worldId: campaign.worldId,
        queue: resumeDeps.worldGenQueue,
        pipelineRunsRepo,
        logger: request.log as PinoLogger,
      })
    },
  )

  // DELETE /api/campaigns/:campaignId — owner-only hard delete.
  //
  // Cascades: campaigns.world_id REFERENCES worlds(id) ON DELETE CASCADE,
  // and every dependent table (pipeline_runs, campaign_members, entities,
  // prose_kernels, facts, relationships, random_tables, random_table_entries,
  // characters via campaign_characters, etc.) cascades from either side.
  // So a single `DELETE FROM worlds WHERE id = $1` removes the campaign +
  // every descendant in one statement.
  //
  // Refuses (409 world_gen_in_progress) when the world is mid-generation —
  // deleting the row while a worker holds a stage open produces noisy
  // BullMQ retry failures and orphans the in-flight LLM call's cost.
  // Resume can mark it failed first if the user wants to abort.
  app.delete<{ Params: Params }>(
    '/api/campaigns/:campaignId',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo, 'owner'),
    },
    async (request, reply) => {
      const campaignId = request.params.campaignId
      const campaign = await repo.campaigns.getById(campaignId)
      /* c8 ignore start — `!campaign` arm: same defense-in-depth as
       * loadSnapshot's null return. */
      if (!campaign) return reply.code(404).send({ code: 'campaign_not_found' })
      /* c8 ignore stop */

      const worldStatus = await repo.worlds.getStatus(campaign.worldId)
      if (worldStatus === 'generating') {
        reply.header('Retry-After', '30')
        return reply.code(409).send({ code: 'world_gen_in_progress' })
      }

      await repo.worlds.deleteById(campaign.worldId)
      return reply.code(204).send()
    },
  )

  // myth-4lhr: rename a campaign. Owner-only. POST /api/campaigns no
  // longer accepts a name (concept_intake auto-names from the
  // synthesized world.name); this is the path for the user to override.
  // Affects campaigns.name only — worlds.name stays as the synthesized
  // value since the world is a separable concept (forkable in the
  // future) whose identity shouldn't drift with each campaign rename.
  app.patch<{ Params: Params; Body: { name: string } }>(
    '/api/campaigns/:campaignId/name',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
        pipelineRoute: true,
      },
      preHandler: requireCampaignMember(repo, 'owner'),
    },
    async (request, reply) => {
      const parsed = RenameCampaignBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_body', issues: parsed.error.issues })
      }
      const campaignId = request.params.campaignId
      const renamed = await repo.campaigns.renameById(campaignId, parsed.data.name)
      /* c8 ignore start — `!renamed` arm: requireCampaignMember
       * runs first and 403s the caller before reaching here when the
       * campaign doesn't exist, so this defensive 404 is unreachable in
       * normal flow. */
      if (!renamed) {
        return reply.code(404).send({ code: 'campaign_not_found' })
      }
      /* c8 ignore stop */
      return reply.code(200).send({ campaignId, name: parsed.data.name })
    },
  )
}

const RenameCampaignBodySchema = z.object({
  name: z.string().min(1).max(200).trim(),
})

// ---------------------------------------------------------------------------
// Helpers (extracted to keep the handler under the lint length budget).
// ---------------------------------------------------------------------------

/**
 * MYT-87 T11: project one repo `HubCardRow` to the `CampaignSummary` wire shape
 * for the given viewer. Derives the per-viewer `cardPhase`
 * (`viewerHasCharacter` from the viewer's own roster row; `partyAllReady` when
 * every accepted member has a character), validates the persisted colour pair
 * against the curated WorldColor set (an invalid / half-set pair collapses to
 * null — migration 030 keeps the column un-CHECKed), and serializes the `Date`
 * columns to ISO strings (the contract models the wire, not the row).
 */
function toHubCardSummary(card: HubCardRow, viewerId: string): CampaignSummary {
  const viewerRow = card.party.find((p) => p.userId === viewerId)
  // The `?? false` arm is defensive: the viewer is always in their own /mine card's
  // party (they own it or are an accepted member — /mine never returns a card they're
  // absent from), so a viewer-not-in-party row is unreachable. The truthy path
  // (viewer has / lacks a PC) is exercised by the phase tests.
  /* c8 ignore next */
  const viewerHasCharacter = viewerRow?.hasCharacter ?? false
  const partyAllReady = card.party.length > 0 && card.party.every((p) => p.hasCharacter)
  const cardPhase = deriveCardPhase({
    campaign: { status: card.status, sessionCount: card.sessionCount },
    world: { status: card.worldStatus },
    viewerHasCharacter,
    partyAllReady,
  })
  const worldColors =
    card.colorFrom !== null && card.colorTo !== null
      ? (WorldColorPairSchema.safeParse({ from: card.colorFrom, to: card.colorTo }).data ?? null)
      : null
  return {
    id: card.id,
    worldId: card.worldId,
    name: card.name,
    status: card.status,
    language: card.language,
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
    worldName: card.worldName,
    worldColors,
    creator: card.creator,
    party: card.party.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      hasCharacter: p.hasCharacter,
    })),
    sessionCount: card.sessionCount,
    lastPlayedAt: card.lastPlayedAt === null ? null : card.lastPlayedAt.toISOString(),
    cardPhase,
  }
}

/** Sum the values of a getJobCounts() response across all requested states. */
function sumQueueCounts(counts: Record<string, number>): number {
  let total = 0
  for (const v of Object.values(counts)) total += v
  return total
}

/**
 * Step 5 of the POST flow — the locked transaction.
 *
 * Runs the create footprint through `repo.transaction` (one tx client,
 * writes-only — slow I/O stays OUTSIDE the callback; the enqueue side-effect
 * runs AFTER this returns, off the returned value). The hand-managed
 * connect/BEGIN/SET LOCAL/COMMIT recipe was replaced by repo.transaction +
 * the Cluster-A composable binders; the SQL moved verbatim into those binders.
 *
 * Sequence (Roc-Imp1 UUID-cast fix + Hydra-Imp1 / Phoenix-Imp4 seeded-row
 * recovery contract):
 *   - BEGIN + lock_timeout 5s + statement_timeout 10s (TxOpts)
 *   - acquireUserCreditLock → pg_advisory_xact_lock(hashtextextended(userId, 0))
 *   - getWorldGenBalance under lock; throw InsufficientCreditsError if < 1
 *     (rolls back + propagates to the route's 403 mapping)
 *   - insertGenerating (worlds, status='generating')
 *   - insertSetup (campaigns, status='setup')
 *   - insertOwnerMember (campaign_members, role='owner', invite_accepted=true)
 *   - insertWorldGenDebit (credit_ledger -1; source_id = worldId for the
 *     migration 004 debit-has-source check)
 *   - insertSeedRow (pipeline_runs concept_intake, status='pending',
 *     started_at=NULL) — a missed enqueue (Redis blip between COMMIT and the
 *     queue.add call) presents as `world_gen_failed` via derivePhase instead
 *     of `not_started`, so the resume route can recover from it (Hydra-Imp1,
 *     Phoenix-Imp4)
 *   - COMMIT
 *
 * myth-4lhr: 'Untitled' placeholder for both worlds.name and campaigns.name
 * (the binders default `name` to 'Untitled'). Concept_intake's worker pass
 * UPDATEs both to the LLM-synthesized name on completion. myth-exac T21:
 * dev_bypass_access_filter is passed explicitly (false-by-default at the route
 * handler) rather than relying on the migration's column default.
 */
async function executeCreateTransaction(
  repo: Repo,
  args: { userId: string; concept: string; devBypassAccessFilter: boolean },
): Promise<{ campaignId: string; worldId: string }> {
  // ids generated up-front (uuidv7) so they can be threaded as FKs + returned.
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const memberId = uuidv7()
  const ledgerId = uuidv7()
  const runId = uuidv7()

  const result = await repo.transaction(
    async (tx) => {
      // hashtextextended produces a stable bigint from any text input,
      // sidestepping pg's lack of a direct uuid→bigint cast (Roc-Imp1).
      await tx.credits.acquireUserCreditLock(args.userId)
      const lockedBalance = await tx.credits.getWorldGenBalance(args.userId)
      if (lockedBalance < 1) {
        throw new InsufficientCreditsError()
      }
      await tx.worlds.insertGenerating({
        id: worldId,
        createdBy: args.userId,
        concept: args.concept,
        devBypassAccessFilter: args.devBypassAccessFilter,
      })
      await tx.campaigns.insertSetup({ id: campaignId, worldId, createdBy: args.userId })
      await tx.campaigns.insertOwnerMember({ id: memberId, campaignId, userId: args.userId })
      await tx.credits.insertWorldGenDebit({ id: ledgerId, userId: args.userId, worldId })
      await tx.pipelineRuns.insertSeedRow({ id: runId, worldId })
      return { campaignId, worldId }
    },
    { lockTimeoutMs: 5000, statementTimeoutMs: 10000 },
  )
  /* c8 ignore start — the callback never returns ROLLBACK (it throws on the
   * insufficient-credits path instead), so `result` is always the value;
   * the narrowing is for TS, never exercised at runtime. */
  if (typeof result === 'symbol') {
    throw new Error('unreachable: create transaction does not return ROLLBACK')
  }
  /* c8 ignore stop */
  return result
}

// ---------------------------------------------------------------------------
// Resume route helpers (MYT-51 T10).
//
// dispatchResume's job is an exhaustive polymorphic switch over
// PipelinePhase (8 arms + assertNever per Phoenix-C1). To keep the handler
// under the 50-line lint budget, each non-trivial arm (world_gen_failed,
// not_started) is extracted into its own small helper.
// ---------------------------------------------------------------------------

interface ResumeContext {
  reply: FastifyReply
  phase: PipelinePhase
  campaignId: string
  worldId: string
  queue: WorldGenQueueLike
  pipelineRunsRepo: PipelineRunsRepo
  logger: PinoLogger
}

/* c8 ignore start — TypeScript exhaustiveness assertion. If the
   PipelinePhase union grows and a new arm isn't added to dispatchResume's
   switch, this function turns a silent miss into a runtime throw. It is
   structurally unreachable for any valid PipelinePhase. */
function assertNever(x: never): never {
  throw new Error(`resume: unreachable phase ${String(x)}`)
}
/* c8 ignore stop */

async function dispatchResume(ctx: ResumeContext): Promise<FastifyReply> {
  switch (ctx.phase) {
    case 'world_gen':
      ctx.reply.header('Retry-After', '30')
      return ctx.reply.code(409).send({ code: 'world_gen_in_progress' })
    /* c8 ignore start — phase is computed from pipeline_runs;
     * world_snapshot_ready is only observable while the worker holds
     * the campaign mid-pipeline. Reaching this arm via a user-driven
     * POST /resume race against stage-5 start is possible but narrow;
     * behavior mirrors the world_gen arm above which is already covered. */
    case 'world_snapshot_ready':
      // myth-exac T18: stage 4 has committed (snapshot is fetchable) but
      // stages 5-7 are still pending — world-gen is still in progress from
      // the resume-policy perspective. Mirror the `world_gen` arm so the
      // client retries in 30s rather than treating the snapshot-ready
      // signal as a terminal "resumable" state.
      ctx.reply.header('Retry-After', '30')
      return ctx.reply.code(409).send({ code: 'world_gen_in_progress' })
    /* c8 ignore stop */
    case 'world_gen_failed':
      return resumeFromWorldGenFailed(ctx)
    case 'world_ready':
      return ctx.reply.code(409).send({ code: 'nothing_to_resume' })
    case 'character_creation':
      // Phoenix-Imp3: 422 (not 501). Downstream ticket ID logged
      // server-side, NOT in the response (Roc-Imp6).
      ctx.logger.info(
        {
          event: 'resume_phase_not_yet_implemented',
          phase: 'character_creation',
          downstreamTicket: 'MYT-52',
          campaignId: ctx.campaignId,
        },
        'resume requested for not-yet-implemented phase',
      )
      return ctx.reply.code(422).send({
        code: 'phase_resume_not_yet_implemented',
        phase: 'character_creation',
      })
    case 'post_creation':
      ctx.logger.info(
        {
          event: 'resume_phase_not_yet_implemented',
          phase: 'post_creation',
          downstreamTicket: 'MYT-53',
          campaignId: ctx.campaignId,
        },
        'resume requested for not-yet-implemented phase',
      )
      return ctx.reply.code(422).send({
        code: 'phase_resume_not_yet_implemented',
        phase: 'post_creation',
      })
    case 'complete':
      return ctx.reply.code(409).send({ code: 'already_complete' })
    case 'failed':
      return ctx.reply.code(409).send({ code: 'terminal_failure' })
    case 'not_started':
      return resumeFromNotStarted(ctx)
    /* c8 ignore next 2 — exhaustiveness default; see assertNever above. */
    default:
      return assertNever(ctx.phase)
  }
}

/**
 * `world_gen_failed` arm — spec lines 561–576.
 *
 * Inspect the latest failed pipeline_runs.error. Two terminal classes
 * (stage_not_implemented + cost-cap-fired) 409; everything else is
 * treated as a transient infra failure and the world-gen job is
 * re-enqueued so the user can recover from a Redis blip / DB hiccup /
 * etc. Kraken-Imp4: explicitly never re-enqueue a guaranteed-fail loop.
 */
async function resumeFromWorldGenFailed(ctx: ResumeContext): Promise<FastifyReply> {
  const stuckRun = await ctx.pipelineRunsRepo.getLatestFailedForWorld(ctx.worldId)
  /* c8 ignore start — `?? ''` and `?? 'unknown'` fallbacks fire when
   * the failed-run row has no error / stage text; tests always populate
   * the error column. */
  const errText = stuckRun?.error ?? ''
  if (errText.includes('stage_not_implemented')) {
    return ctx.reply.code(409).send({
      code: 'phase_not_yet_implementable',
      stuckAtStage: stuckRun?.stage ?? 'unknown',
    })
  }
  /* c8 ignore stop */
  if (errText.includes('world_gen_cost_cap_exceeded')) {
    return ctx.reply.code(409).send({ code: 'world_gen_capped' })
  }
  await ctx.queue.add('world-gen', { campaignId: ctx.campaignId }, { jobId: ctx.campaignId })
  return ctx.reply.code(202).send({ campaignId: ctx.campaignId, action: 'world-gen-re-enqueued' })
}

/**
 * `not_started` arm — Redis-blip orphan recovery (Phoenix-Imp4 +
 * Hydra-Imp1). Spec lines 578–588.
 *
 * The create transaction seeds a pending pipeline_runs row, so reaching
 * this branch is rare in practice — it requires the worker to have
 * never picked up the job AND the seeded row to have been wiped/never
 * persisted. Defensive: if a job with the same id is still alive on
 * the queue, 409 rather than enqueue a duplicate; otherwise enqueue
 * with the standard jobId-deduplication contract.
 */
async function resumeFromNotStarted(ctx: ResumeContext): Promise<FastifyReply> {
  const existingJob = await ctx.queue.getJob(ctx.campaignId)
  if (existingJob) {
    const completed = await existingJob.isCompleted()
    const failed = await existingJob.isFailed()
    if (!completed && !failed) {
      return ctx.reply.code(409).send({ code: 'world_gen_in_progress' })
    }
  }
  await ctx.queue.add('world-gen', { campaignId: ctx.campaignId }, { jobId: ctx.campaignId })
  return ctx.reply.code(202).send({
    campaignId: ctx.campaignId,
    action: 'world-gen-enqueued-after-orphan-recovery',
  })
}
