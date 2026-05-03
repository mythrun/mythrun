// backend/src/routes/invites.ts
//
// MYT-38 invite endpoints. Six routes:
//   POST   /api/campaigns/:id/invites              — owner-only create
//   GET    /api/campaigns/:id/invites              — owner-only list
//   DELETE /api/campaigns/:id/invites/:inviteCode  — owner-only revoke
//   GET    /api/invites/:inviteCode/preview        — PUBLIC pre-OAuth lookup
//   POST   /api/invites/:inviteCode/accept         — any onboarded user
//   GET    /api/campaigns/:id/members              — any member
//
// requireOnboarded already gates default-auth routes; the preview route
// opts out via config.auth = 'public'. The preview route is PUBLIC, NOT
// jwt-no-db, and is intentionally not in the JWT_NO_DB_ALLOWLIST.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { createRepo, type Repo } from '../repo/index.js'
import {
  InviteCapReachedError,
  InviteCreationError,
  InviteTimeoutError,
} from '../repo/invites-errors.js'

interface Opts {
  readonly pool: Pool
  readonly frontendBaseUrl: string
}

interface CampaignIdParams {
  readonly id: string
}

interface InviteCodeParams {
  readonly inviteCode: string
}

interface CampaignAndInviteCodeParams {
  readonly id: string
  readonly inviteCode: string
}

function inviteUrlOf(frontendBaseUrl: string, inviteCode: string): string {
  return `${frontendBaseUrl}/join/${inviteCode}`
}

// Resolve the caller's users.id from request.user.sub. requireOnboarded
// has already verified the row exists, but TS doesn't know that — and the
// row could (theoretically) be deleted between the gate and the handler.
async function resolveUserId(
  repo: Repo,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  if (!request.user) {
    reply.code(401).send({ code: 'unauthenticated' })
    return null
  }
  const user = await repo.users.getByCognitoSub(request.user.sub)
  if (!user) {
    reply.code(403).send({ code: 'username_required' })
    return null
  }
  return user.id
}

// Owner-only authz. Returns true on success; on failure, writes the reply
// (404 campaign_not_found OR 403 not_campaign_owner) and returns false.
async function requireOwner(
  repo: Repo,
  campaignId: string,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const membership = await repo.campaigns.getMembership(campaignId, userId)
  if (membership === null) {
    const campaign = await repo.campaigns.getById(campaignId)
    if (campaign === null) {
      reply.code(404).send({ code: 'campaign_not_found' })
      return false
    }
    reply.code(403).send({ code: 'not_campaign_owner' })
    return false
  }
  if (membership.role !== 'owner') {
    reply.code(403).send({ code: 'not_campaign_owner' })
    return false
  }
  return true
}

// Member authz. Same pattern as requireOwner but accepts any role.
async function requireMember(
  repo: Repo,
  campaignId: string,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const membership = await repo.campaigns.getMembership(campaignId, userId)
  if (membership === null) {
    const campaign = await repo.campaigns.getById(campaignId)
    if (campaign === null) {
      reply.code(404).send({ code: 'campaign_not_found' })
      return false
    }
    reply.code(403).send({ code: 'not_campaign_member' })
    return false
  }
  return true
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (route registration is synchronous), so the rule is
// disabled here per existing precedent in auth/bypass-plugin.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const invitesRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)
  const { frontendBaseUrl } = opts

  // ── POST /api/campaigns/:id/invites — owner-only create ──────────────────
  app.post<{ Params: CampaignIdParams }>(
    '/api/campaigns/:id/invites',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = await resolveUserId(repo, request, reply)
      if (userId === null) return reply
      const campaignId = request.params.id
      if (!(await requireOwner(repo, campaignId, userId, reply))) return reply

      try {
        const invite = await repo.invites.create({ campaignId, createdBy: userId })
        return await reply
          .header('Location', `/api/invites/${invite.inviteCode}/preview`)
          .code(201)
          .send({
            inviteCode: invite.inviteCode,
            inviteUrl: inviteUrlOf(frontendBaseUrl, invite.inviteCode),
            uses: invite.uses,
            expiresAt: invite.expiresAt,
            createdAt: invite.createdAt,
          })
      } catch (err) {
        if (err instanceof InviteCapReachedError) {
          return reply.code(409).send({
            code: 'invite_cap_reached',
            activeInvites: err.activeInvites,
          })
        }
        if (err instanceof InviteCreationError) {
          return reply.code(500).send({ code: 'invite_creation_error' })
        }
        throw err
      }
    },
  )

  // ── GET /api/campaigns/:id/invites — owner-only list ─────────────────────
  app.get<{ Params: CampaignIdParams }>(
    '/api/campaigns/:id/invites',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = await resolveUserId(repo, request, reply)
      if (userId === null) return reply
      const campaignId = request.params.id
      if (!(await requireOwner(repo, campaignId, userId, reply))) return reply

      const invites = await repo.invites.listForCampaign(campaignId)
      return reply.code(200).send({
        invites: invites.map((inv) => ({
          inviteCode: inv.inviteCode,
          inviteUrl: inviteUrlOf(frontendBaseUrl, inv.inviteCode),
          uses: inv.uses,
          expiresAt: inv.expiresAt,
          createdAt: inv.createdAt,
          primary: inv.primary,
        })),
      })
    },
  )

  // ── DELETE /api/campaigns/:id/invites/:inviteCode — owner-only revoke ────
  app.delete<{ Params: CampaignAndInviteCodeParams }>(
    '/api/campaigns/:id/invites/:inviteCode',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = await resolveUserId(repo, request, reply)
      if (userId === null) return reply
      const { id: campaignId, inviteCode } = request.params
      if (!(await requireOwner(repo, campaignId, userId, reply))) return reply

      const result = await repo.invites.revoke(inviteCode, campaignId)
      if ('revoked' in result) {
        return reply.code(204).send()
      }
      return reply.code(404).send({ code: 'invite_not_found' })
    },
  )

  // ── GET /api/invites/:inviteCode/preview — PUBLIC ────────────────────────
  app.get<{ Params: InviteCodeParams }>(
    '/api/invites/:inviteCode/preview',
    {
      config: {
        auth: 'public',
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const { inviteCode } = request.params
      const preview = await repo.invites.getCodePreview(inviteCode)
      if (preview === null) {
        return reply.code(404).send({ code: 'invite_not_found' })
      }
      return reply.code(200).send({
        campaignName: preview.campaignName,
        ownerUsername: preview.ownerUsername,
        ownerDisplayName: preview.ownerDisplayName,
        valid: preview.valid,
      })
    },
  )

  // ── POST /api/invites/:inviteCode/accept — any onboarded user ────────────
  app.post<{ Params: InviteCodeParams }>(
    '/api/invites/:inviteCode/accept',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          // Per-cognito-sub bucket; falls back to IP if request.user is
          // somehow absent (defensive — requireOnboarded gated us here).
          keyGenerator: (req: FastifyRequest): string => req.user?.sub ?? req.ip,
        },
      },
    },
    async (request, reply) => {
      const userId = await resolveUserId(repo, request, reply)
      if (userId === null) return reply
      const { inviteCode } = request.params

      try {
        const result = await repo.invites.acceptInvite({ code: inviteCode, userId })
        if ('campaignId' in result) {
          if (result.alreadyMember) {
            return await reply.code(200).send({
              campaignId: result.campaignId,
              alreadyMember: true,
            })
          }
          return await reply
            .header('Location', `/api/campaigns/${result.campaignId}`)
            .code(201)
            .send({ campaignId: result.campaignId, alreadyMember: false })
        }
        if ('notFound' in result) {
          return await reply.code(404).send({ code: 'invite_not_found' })
        }
        if ('revoked' in result) {
          return await reply.code(410).send({ code: 'invite_revoked' })
        }
        if ('campaignGone' in result) {
          return await reply.code(410).send({ code: 'campaign_gone' })
        }
        // campaignFull
        return await reply.code(409).send({
          code: 'campaign_full',
          activeMembers: result.activeMembers,
        })
      } catch (err) {
        if (err instanceof InviteTimeoutError) {
          return await reply
            .header('Retry-After', '1')
            .code(503)
            .send({ code: 'invite_timeout', retryAfterSec: 1 })
        }
        throw err
      }
    },
  )

  // ── GET /api/campaigns/:id/members — any member ──────────────────────────
  app.get<{ Params: CampaignIdParams }>(
    '/api/campaigns/:id/members',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = await resolveUserId(repo, request, reply)
      if (userId === null) return reply
      const campaignId = request.params.id
      if (!(await requireMember(repo, campaignId, userId, reply))) return reply

      const members = await repo.campaigns.listMembers(campaignId)
      return reply.code(200).send({ members })
    },
  )
}
