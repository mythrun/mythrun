// backend/src/routes/session-preps.ts
//
// MYT-63: session-prep CRUD/trigger HTTP routes (trigger / list / read / reset).
// This task (T3) lands the producer queue surface only; the four routes +
// the SafeSessionPrep projection land in T4 below the interface.
//
// Enforced ignorance: the HTTP surface NEVER serves sd_playbook (see
// SafeSessionPrep in T4). The persisted prep row carries ft_context (FT-safe)
// + sd_playbook (Slow-Thinker, may contain secrets); only Session Runtime reads
// sd_playbook in-process via repo.sessionPreps, and the dev-tool inspects it live
// via the MYT-62 prep-prose stream.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import { createRepo } from '../repo/index.js'
import { requireCampaignMember } from '../auth/access-control.js'
import type { SessionPrepRow } from '../repo/types.js'

// Minimal producer surface for the session-prep BullMQ queue. Declared here
// (not BullMQ's Queue class) so AppDeps + tests inject a hand-rolled spy —
// exactly like WorldGenQueueLike (routes/campaigns.ts).
export interface SessionPrepQueueLike {
  add(
    name: 'session-prep',
    data: { campaignId: string; sessionNumber: number },
    opts?: { jobId?: string },
  ): Promise<unknown>
}

export interface Opts {
  readonly pool: Pool
  // Optional + a request-time guard, mirroring campaigns.ts's worldGenQueue:
  // AppDeps makes it required (boot invariant) and app.ts forwards it
  // unconditionally, but the plugin tolerates a missing queue for the
  // read/reset-only paths — only the trigger route 500s without it. Typed
  // `| undefined` (not `?`) so a caller can forward an explicit-undefined
  // queue under exactOptionalPropertyTypes — the campaign-characters.ts
  // `characterCreationQueue` precedent.
  readonly sessionPrepQueue: SessionPrepQueueLike | undefined
}

interface Params {
  readonly campaignId: string
}
interface PrepParams {
  readonly campaignId: string
  readonly prepId: string
}

// MVP: session 1 only (MYT-59 scope). Body default for trigger + reset.
const SessionPrepBodySchema = z.object({
  sessionNumber: z.number().int().positive().default(1),
})

// Enforced ignorance: the HTTP surface NEVER serves sd_playbook. This is the
// ENTIRE runtime gate — the backend uses no Fastify response schemas, so
// reply.send serializes every own-enumerable property. toSafeSessionPrep MUST
// build an explicit field-by-field literal, NEVER `{ ...row }` (a spread
// type-checks under structural typing AND carries sd_playbook to the wire).
interface SafeSessionPrep {
  id: string
  sessionNumber: number
  ftContext: string
  snapshotId: string | null
  createdAt: string
}

function toSafeSessionPrep(row: SessionPrepRow): SafeSessionPrep {
  return {
    id: row.id,
    sessionNumber: row.sessionNumber,
    ftContext: row.ftContext,
    snapshotId: row.snapshotId,
    createdAt: row.createdAt.toISOString(),
  }
}

// FastifyPluginAsync requires an async shape; the body has no top-level await.
// eslint-disable-next-line @typescript-eslint/require-await
export const sessionPrepsPlugin: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  function requireSessionPrepRouteDeps(): { sessionPrepQueue: SessionPrepQueueLike } {
    /* c8 ignore start — boot-time invariant: AppDeps.sessionPrepQueue is
       required and app.ts forwards it unconditionally, so this never throws in
       a real boot. Mirrors requireCreateRouteDeps (campaigns.ts). */
    if (!opts.sessionPrepQueue) {
      throw new Error(
        'sessionPrepsPlugin: POST /session-prep requires sessionPrepQueue in Opts (wired by app.ts)',
      )
    }
    /* c8 ignore stop */
    return { sessionPrepQueue: opts.sessionPrepQueue }
  }

  // Per-user rate-limit key: rate-limit runs at onRequest, BEFORE requireOnboarded
  // attaches request.dbUser (a preHandler). request.user (sub) IS attached at
  // onRequest by the jwt/bypass plugins — use it for genuine per-user keying.
  // ?? req.ip is a defensive fallback only (the routes/users.ts register precedent).
  const perUserKey = (req: FastifyRequest): string =>
    /* c8 ignore start — `?? req.ip` fallback: req.user.sub is always set by the
       jwt/bypass plugin at onRequest, so the fallback never fires in any tested
       boot. Mirrors the `catch { return req.ip }` fallback in campaigns.ts. */
    req.user?.sub ?? req.ip
  /* c8 ignore stop */

  // 4.1 POST /session-prep — trigger (owner)
  app.post<{ Params: Params; Body: z.infer<typeof SessionPrepBodySchema> }>(
    '/api/campaigns/:campaignId/session-prep',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: perUserKey } },
    },
    async (req, reply) => {
      // safeParse(req.body): an empty-object `{}` body resolves to sessionNumber 1
      // via Zod's `.default(1)`; a non-positive/non-int sessionNumber — or a
      // body-less request (req.body null, which Zod's object schema rejects) — → 400.
      const parsed = SessionPrepBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ code: 'bad_body' })
      const { sessionPrepQueue } = requireSessionPrepRouteDeps()
      const { campaignId } = req.params
      const { sessionNumber } = parsed.data
      await sessionPrepQueue.add(
        'session-prep',
        { campaignId, sessionNumber },
        { jobId: `sp-${campaignId}-${String(sessionNumber)}` },
      )
      return reply.code(202).send({ campaignId, sessionNumber })
    },
  )

  // 4.2 GET /session-preps — list (member)
  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/session-preps',
    {
      preHandler: requireCampaignMember(repo),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const rows = await repo.sessionPreps.listFor(req.params.campaignId)
      return reply.code(200).send({ preps: rows.map(toSafeSessionPrep) })
    },
  )

  // 4.3 GET /session-preps/:prepId — read (member)
  app.get<{ Params: PrepParams }>(
    '/api/campaigns/:campaignId/session-preps/:prepId',
    {
      preHandler: requireCampaignMember(repo),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const row = await repo.sessionPreps.getById(req.params.prepId)
      // 404 for absent OR cross-campaign — don't leak cross-campaign existence.
      // `row?.campaignId` is undefined when the row is absent, so the !==
      // comparison covers both the not-found and the cross-campaign cases.
      if (row?.campaignId !== req.params.campaignId) {
        return reply.code(404).send({ code: 'prep_not_found' })
      }
      return reply.code(200).send(toSafeSessionPrep(row))
    },
  )

  // 4.4 POST /reset-prep — reset (owner)
  app.post<{ Params: Params; Body: z.infer<typeof SessionPrepBodySchema> }>(
    '/api/campaigns/:campaignId/reset-prep',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: perUserKey } },
    },
    async (req, reply) => {
      // safeParse(req.body): an empty-object `{}` body resolves to sessionNumber 1
      // via Zod's `.default(1)`; a non-positive/non-int sessionNumber — or a
      // body-less request (req.body null, which Zod's object schema rejects) — → 400.
      const parsed = SessionPrepBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ code: 'bad_body' })
      const { campaignId } = req.params
      const { sessionNumber } = parsed.data
      // Atomic: delete the prep row + re-arm the session-prep:<n> stage so a
      // subsequent trigger regenerates cleanly. Both binders are on bindTx.
      await repo.transaction(async (tx) => {
        await tx.sessionPreps.deleteFor(campaignId, sessionNumber)
        await tx.pipelineRuns.resetStage({
          kind: 'campaign',
          campaignId,
          stage: `session-prep:${String(sessionNumber)}`,
        })
      })
      return reply.code(200).send({ campaignId, sessionNumber, reset: true })
    },
  )
}
