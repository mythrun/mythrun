// backend/src/routes/sessions.ts
//
// Session-scoped routes:
//   - POST /api/sessions/:id/ws-ticket   — HTTP half of the WS ticket exchange.
//   - POST /api/sessions/:campaignId/start    — create a live session + debit a
//        session credit (the campaign OWNER pays). The WS transport connects
//        AFTER a session exists.
//   - GET  /api/sessions/:campaignId/active   — the active session row, or null.
//   - GET  /api/sessions/:sessionId/messages  — replay persisted transcript.
//
// The /start route's INSERT → debit → Redis-init ordering is load-bearing
// (MYT-65 design Hardening §): the session row lands first (the partial-unique
// idx_sessions_one_active closes the two-concurrent-/start race → 409), then
// the idempotent per-session debit, then Redis state. A debit failure (no
// credits) deletes the just-created row and returns 402.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §6
//       docs/superpowers/specs/2026-06-04-myt-65-ws-transport-design.md (lifecycle + Hardening §)

import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { createRepo, type Repo } from '../repo/index.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { mintWsTicket } from '../auth/ws-ticket.js'
import { makeSessionState, type SessionState } from '../redis/session-state.js'
import { makeTriggerState, type TriggerState } from '../session/trigger-state.js'
import { uuidv7 } from '../repo/uuidv7.js'

interface Opts {
  readonly pool: Pool
  readonly redisRealtime: Redis
  /** The BARE per-environment+region prefix, trailing colon, e.g.
   *  "production:use1:" (config/env.ts `redisKeyPrefix`). Per-feature
   *  sub-prefixes are appended by their callers — `makeSessionState` adds
   *  `session:…`, the ws-ticket store adds `ws:ticket:`. Pinned per
   *  environment+region (docs/specs/2026-04-10-infrastructure-devops.md)
   *  because staging+prod share one ElastiCache cluster. */
  readonly redisKeyPrefix: string
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only app.post is synchronous), matching the precedent
// in auth/require-onboarded.ts and other plugin files.
// eslint-disable-next-line @typescript-eslint/require-await
export const sessionsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)
  const sessionState = makeSessionState(opts.redisRealtime, opts.redisKeyPrefix)
  // MYT-69 §8: the session-start handler resets the ST-owned direction slots +
  // turns-since-ST counter at start so a same-campaign session begun within the
  // 2h state TTL isn't born inheriting a standing wind-down directive.
  const triggerState = makeTriggerState(opts.redisRealtime, opts.redisKeyPrefix)
  // The ws-ticket store lives under the `ws:ticket:` sub-prefix. This MUST
  // match routes/ws-session.ts's consume side (`${redisKeyPrefix}ws:ticket:`):
  // mint and consume key the same Redis slot, so a divergence 401s every WS
  // upgrade. (Before MYT-65 there was no consumer, so the missing sub-prefix
  // here was a latent no-op; the two-client integration test surfaced it.)
  const ticketKeyPrefix = `${opts.redisKeyPrefix}ws:ticket:`

  // Per-user rate-limit key: rate-limit's keyGenerator runs at onRequest,
  // BEFORE requireOnboarded (a preHandler) attaches request.dbUser. So a
  // keyGenerator that reaches for request.dbUser throws at onRequest → 500
  // before the route's preHandler ever runs (confirmed under the production
  // `@fastify/rate-limit { global: false }` wiring; the older mocked-repo
  // ws-ticket test never registered rate-limit, so it never surfaced). The
  // sub IS set at onRequest by the jwt/bypass plugins — key off that.
  // Mirrors routes/session-preps.ts perUserKey.
  const perUserKey = (req: FastifyRequest): string =>
    /* c8 ignore start — `?? req.ip` fallback: req.user.sub is always set by the
       jwt/bypass plugin at onRequest, so the fallback never fires in any tested
       boot. Mirrors session-preps.ts. */
    req.user?.sub ?? req.ip
  /* c8 ignore stop */

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/ws-ticket',
    {
      config: {
        // Per-USER (not per-IP) cap — CG-NAT pools would otherwise share
        // the cap. The global @fastify/rate-limit at app.ts is
        // `global: false`, so without this opt-in the route ships
        // uncapped. MYT-45 swaps the in-memory store for Redis-backed.
        rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: perUserKey },
      },
      preHandler: [
        // Step 1: resolve :id (sessionId) → its parent campaignId.
        async (request, reply) => {
          const session = await repo.sessions.getById(request.params.id)
          if (!session) {
            return reply.code(404).send({ code: 'session_not_found' })
          }
          // Set the typed augmentation field rather than mutating
          // request.params — keeps the route's typed Params shape
          // honest for type-introspection tools / future OpenAPI gen.
          request.resolvedCampaignId = session.campaignId
        },
        // Step 2: verify membership.
        requireCampaignMember(repo),
      ],
    },
    async (request) => {
      const sessionId = request.params.id
      const dbUser = requireDbUser(request)
      // resolvedCampaignId is set by the upstream preHandler. If it's
      // missing here, something has gone catastrophically wrong with the
      // hook chain — surface as 500 with a clear operator message rather
      // than continuing with a malformed payload.
      const campaignId = request.resolvedCampaignId
      /* c8 ignore start — defense-in-depth: the upstream preHandler chain
         sets resolvedCampaignId AND access-control.ts throws a 500 of its
         own before this handler runs if the chain is mis-wired. This
         throw exists to keep the type narrow without the `!` non-null
         assertion downstream; it is unreachable in practice. */
      if (campaignId === undefined) {
        throw new Error(
          'sessions ws-ticket: request.resolvedCampaignId missing — upstream preHandler did not run',
        )
      }
      /* c8 ignore stop */
      const { ticket, expiresAt } = await mintWsTicket(
        { redis: opts.redisRealtime, keyPrefix: ticketKeyPrefix },
        { userId: dbUser.id, sessionId, campaignId },
      )
      return { ticket, expiresAt }
    },
  )

  // POST /api/sessions/:campaignId/start — create a live session + debit a
  // session credit. Member-guarded; the campaign OWNER pays. The handler body
  // lives in handleSessionStart (below) to keep this plugin shell thin.
  app.post<{ Params: { campaignId: string } }>(
    '/api/sessions/:campaignId/start',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: perUserKey },
      },
      preHandler: requireCampaignMember(repo),
    },
    (request, reply) =>
      handleSessionStart(
        { repo, sessionState, triggerState, log: request.log },
        request.params.campaignId,
        reply,
      ),
  )

  // GET /api/sessions/:campaignId/active — the active session row, or null.
  app.get<{ Params: { campaignId: string } }>(
    '/api/sessions/:campaignId/active',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const session = await repo.sessions.getActiveByCampaign(request.params.campaignId)
      // §9 LEAK FIX: an explicit response allowlist. The full Session row carries
      // `stRunningSummary` (ST-authored, secret-adjacent) + checkpoint material
      // (`summary`, `handoff`); returning the whole row to any member is the
      // round-1 showstopper — the moment the ST writes rapport/ladder state,
      // players read it with one REST call after any suspend. Strip to exactly
      // the player-safe fields. (The deeper "member-guarded route returns whole
      // repo rows" landmine is noted for the API-hygiene sweep; the strip ships
      // here because MYT-69 is what arms it.)
      return reply.code(200).send({
        session:
          session === null
            ? null
            : {
                id: session.id,
                status: session.status,
                sessionNumber: session.sessionNumber,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
              },
      })
    },
  )

  // GET /api/sessions/:sessionId/messages?afterSeq=N — replay the transcript.
  // Resolves :sessionId → its parent campaignId for the membership check, the
  // same two-step preHandler shape as the ws-ticket route.
  app.get<{ Params: { sessionId: string }; Querystring: { afterSeq?: string } }>(
    '/api/sessions/:sessionId/messages',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [
        async (request, reply) => {
          const session = await repo.sessions.getById(request.params.sessionId)
          if (!session) {
            return reply.code(404).send({ code: 'session_not_found' })
          }
          request.resolvedCampaignId = session.campaignId
        },
        requireCampaignMember(repo),
      ],
    },
    async (request, reply) => {
      const raw = request.query.afterSeq
      // Default 0 when omitted. Otherwise require a STRICT non-negative
      // decimal integer: /^\d+$/ rejects '' (Number('')→0, a silent
      // full-history), '-1', '1.5', exponent '1e3', and hex '0x10' (all of
      // which Number() would otherwise coerce). 400 on anything malformed.
      const afterSeq = raw === undefined ? 0 : /^\d+$/.test(raw) ? Number(raw) : NaN
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        return reply.code(400).send({ code: 'bad_after_seq' })
      }
      const messages = await repo.sessionMessages.listAfterSeq(
        request.params.sessionId,
        afterSeq,
      )
      return reply.code(200).send({ messages })
    },
  )
}

interface SessionStartDeps {
  readonly repo: Repo
  readonly sessionState: SessionState
  readonly triggerState: TriggerState
  readonly log: FastifyBaseLogger
}

/**
 * POST /:campaignId/start handler body. Extracted from the plugin shell so the
 * shell stays thin. Preconditions (active campaign → prep exists → no active
 * session) then the atomicity-critical INSERT → debit → Redis-init sequence
 * (MYT-65 Hardening §). Returns the reply it sends.
 */
async function handleSessionStart(
  deps: SessionStartDeps,
  campaignId: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { repo, sessionState, triggerState, log } = deps
  // Precondition 1: the campaign is active.
  const campaign = await repo.campaigns.getById(campaignId)
  /* c8 ignore start — requireCampaignMember already 403s for a campaign with no
     membership row; a member of a non-existent campaign is unreachable. The
     null-guard keeps the type narrow. */
  if (!campaign) {
    return reply.code(409).send({ code: 'campaign_not_active' })
  }
  /* c8 ignore stop */
  if (campaign.status !== 'active') {
    return reply.code(409).send({ code: 'campaign_not_active' })
  }

  // Next session number = max existing + 1 (1 when none), mirroring how the
  // session-prep pipeline numbers preps.
  const sessionNumber = (await repo.sessions.maxSessionNumber(campaignId)) + 1

  // Precondition 2: a session prep exists for that number.
  if (!(await repo.sessionPreps.existsFor(campaignId, sessionNumber))) {
    return reply.code(409).send({ code: 'prep_not_ready' })
  }

  // Precondition 3: no active session already.
  if (await repo.sessions.getActiveByCampaign(campaignId)) {
    return reply.code(409).send({ code: 'session_already_active' })
  }

  // Precondition 4 (MYT-74a §4 start interlock): the prior session must be
  // fully reconciled. The most-recent session is "ended-but-unreconciled" iff
  // it ended (endedAt set) but the reconcile worker hasn't yet stamped
  // reconciledAt. In that window its improvised working set is still uncleared
  // and its canon uncommitted — starting a new session on the same campaign
  // would collide with the pending reconcile. The interlock holds until the
  // reconcile worker sets reconciled_at. (An ACTIVE most-recent session has
  // endedAt = NULL, so it never trips here — precondition 3 already owns it.)
  const mostRecent = await repo.sessions.getMostRecentByCampaign(campaignId)
  if (mostRecent !== null && mostRecent.endedAt !== null && mostRecent.reconciledAt === null) {
    return reply.code(409).send({ code: 'reconcile_pending' })
  }

  // Precondition 5 (MYT-74b §1 C3): a session-end is in progress. The status flip
  // lands at finalize (AFTER the farewell render), so during the render the row is
  // still 'active' with ended_at NULL — the reconcile_pending interlock can't see
  // it. The `ending` flag (SET-NX, ~1h TTL) fences this window: a new /start must
  // wait until the farewell renders + the finalize flips + reconcile clears.
  if (await sessionState.isEnding(campaignId)) {
    return reply.code(409).send({ code: 'session_ending' })
  }

  // Resolve the OWNER — the owner pays, not the (possibly non-owner) caller.
  const owner = await repo.campaigns.getOwner(campaignId)
  /* c8 ignore start — every campaign carries exactly one owner membership
     (written at POST /api/campaigns). A campaign with no owner row is a
     data-integrity violation, not a reachable runtime state. */
  if (!owner) {
    return reply.code(409).send({ code: 'campaign_not_active' })
  }
  /* c8 ignore stop */

  // ── ATOMICITY-CRITICAL SEQUENCE (MYT-65 Hardening §) ──────────────────────
  // 1. Mint the sessionId up front so the debit idempotency key (= sessionId)
  //    is known before either the INSERT or the debit.
  const sessionId = uuidv7()

  // 2. INSERT the session row first. A concurrent /start that already won the
  //    idx_sessions_one_active slot surfaces here as a 23505 on that partial-
  //    unique index → 409 (closes the race; never 500).
  try {
    await repo.sessions.create({ id: sessionId, campaignId, sessionNumber, status: 'active' })
  } catch (err) {
    if (isOneActiveViolation(err)) {
      return reply.code(409).send({ code: 'session_already_active' })
    }
    /* c8 ignore start — re-throw of non-23505 pg errors: a broken connection /
       protocol error propagates to the error handler. The unique-violation arm
       above is the only mapped case. */
    throw err
    /* c8 ignore stop */
  }

  // 3. Debit one session credit from the OWNER. Self-managing (own tx) +
  //    idempotent on sessionId. Insufficient credits → delete the row we just
  //    created (it must not occupy the one-active slot unpaid) → 402.
  const debit = await repo.credits.tryDebitForSession(owner.userId, sessionId)
  if (!debit.ok) {
    // Roll back the just-created (unpaid) session row so it doesn't wedge the
    // campaign's idx_sessions_one_active slot. A cleanup failure must NOT turn
    // the clean 402 into a 500: the money invariant already holds (no debit
    // happened; the active-session guard above blocks a double-charge on
    // retry), so we log-and-continue. The wedged row is the only fallout, and
    // it's diagnosable from this log line.
    try {
      await repo.sessions.deleteById(sessionId)
    } catch (err) {
      /* c8 ignore start — deleteById failure on a freshly-INSERTed row is a
         broken-connection edge; the natural smoke can't reach it. The catch
         exists so the 402 is returned regardless. */
      log.error(
        { err, sessionId, campaignId, ownerId: owner.userId },
        'session_start.rollback_failed',
      )
      /* c8 ignore stop */
    }
    return reply
      .code(402)
      .send({ code: debit.code, available: debit.available, required: debit.required })
  }

  // 4. Initialize Redis session state. A new session starts fresh: the `:seq`
  //    counter is unset (nextSeq returns 1), so no reseed. Park the FT's prep
  //    context + the world tone on the blob (MYT-68 §3.10) so a turn worker
  //    reads them without a PG round-trip.
  //
  //    FAIL-SOFT on a missing prep: a session whose prep stage never ran (or
  //    whose row was deleted) must still START — the FastThinker degrades to
  //    transcript-only grounding. We log LOUDLY at WARN rather than 409, since
  //    precondition 2 (existsFor) already guards the normal flow; this read is
  //    a second, narrower window (the row could vanish between the two reads).
  const prep = await repo.sessionPreps.getBy(campaignId, sessionNumber)
  /* c8 ignore start — precondition 2 (`existsFor`) 409s before this read on a
     missing prep, so `prep === null` is only reachable in the narrow race where
     the row is deleted between existsFor and getBy. The fail-soft warn is the
     defensive net for that window; unreachable through the HTTP flow. */
  if (prep === null) {
    log.warn({ campaignId, sessionId, sessionNumber }, 'session_start.no_prep_ft_context')
  }
  /* c8 ignore stop */
  // World tone is a non-plot, player-facing field — `getToneAndEra` is the
  // tier-neutral minimal read (NOT `worlds.getById`, which re-exposes the
  // plot-bearing columns the enforced-ignorance boundary forbids in a
  // turn-worker-facing path). Absent world / null tone → ''.
  const worldId = await repo.campaigns.getWorldId(campaignId)
  /* c8 ignore start — `worldId === null` is unreachable: precondition 1 loaded
     the campaign row, and campaigns.world_id is NOT NULL (migration 001). The
     guard keeps the type narrow without a non-null assertion. */
  const world = worldId === null ? null : await repo.worlds.getToneAndEra(worldId)
  /* c8 ignore stop */
  await sessionState.setState(campaignId, {
    participants: [],
    mode: 'exploration',
    status: 'active',
    /* c8 ignore start — the `: {}` arm pairs with the narrow-race warn above:
       precondition 2 (`existsFor`) guarantees the prep row through the HTTP
       flow, so `prep === null` here is only the vanished-between-reads window. */
    ...(prep !== null ? { ftContext: prep.ftContext } : {}),
    /* c8 ignore stop */
    worldTone: world?.tone ?? '',
  })

  // §8 session-boundary hygiene: a same-campaign session started within the 2h
  // state TTL must NOT inherit the prior session's usage, summary, or a standing
  // wind-down directive (it would be born dying). Reset both spend keys + the
  // ST-owned direction slots + counter at start.
  // resetSessionSpend lands with T12 (pinned sibling symbol; typecheck
  // converges when session-state.ts gains it).
  await sessionState.resetSessionSpend(campaignId)
  await triggerState.resetSessionKeys(campaignId)

  return reply.code(200).send({ sessionId })
}

/** True when `err` is the Postgres 23505 unique-violation raised by the
 *  `idx_sessions_one_active` partial-unique index — i.e. a concurrent /start
 *  already holds the campaign's one-active slot. Mirrors the 23505 +
 *  constraint-name detection in repo/invites.ts + repo/characters.ts. */
function isOneActiveViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505' &&
    (err as { constraint?: string }).constraint === 'idx_sessions_one_active'
  )
}
