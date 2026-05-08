// backend/src/auth/access-control.ts
//
// Per-resource access-control middleware factories. Returned hooks read
// request.dbUser (attached by requireOnboarded) and either request.params
// or request.resolvedCampaignId set by an upstream resolver.
//
// Param-name convention: campaign-rooted routes use :campaignId; world-
// rooted routes use :worldId; sessions resolve their parent campaign via
// an upstream preHandler that sets request.resolvedCampaignId.
//
// The boot-time accessControlAllowlist plugin (sibling file) ensures
// these factories are never wired onto a route with config.auth: 'public'
// or 'jwt-no-db' — that would short-circuit requireOnboarded and leave
// request.dbUser undefined. The plugin identifies guarded routes by
// inspecting `handler.name`, so the inner functions returned here are
// declared as `async function requireCampaignMember/...` (named) rather
// than arrow functions.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §4

import type { preHandlerHookHandler } from 'fastify'
import type { Repo } from '../repo/index.js'
import type { CampaignMemberRole } from '../repo/types.js'
import { requireDbUser } from './require-db-user.js'

export function requireCampaignMember(
  repo: Repo,
  role?: CampaignMemberRole,
): preHandlerHookHandler {
  return async function requireCampaignMember(request, reply) {
    const dbUser = requireDbUser(request)
    const campaignId =
      request.resolvedCampaignId ??
      (request.params as { campaignId?: string }).campaignId
    if (!campaignId) {
      throw new Error(
        'requireCampaignMember: route has no :campaignId param and no request.resolvedCampaignId',
      )
    }
    const member = await repo.campaigns.getMembership(campaignId, dbUser.id)
    if (!member || !member.inviteAccepted) {
      return reply.code(403).send({ code: 'not_campaign_member' })
    }
    if (role && member.role !== role) {
      return reply.code(403).send({ code: `not_campaign_${role}` })
    }
    request.campaignMember = member
  }
}

export function requireWorldCreator(repo: Repo): preHandlerHookHandler {
  return async function requireWorldCreator(request, reply) {
    const dbUser = requireDbUser(request)
    const worldId = (request.params as { worldId?: string }).worldId
    if (!worldId) {
      throw new Error('requireWorldCreator: route has no :worldId param')
    }
    const world = await repo.worlds.getById(worldId)
    if (!world) {
      return reply.code(404).send({ code: 'world_not_found' })
    }
    if (world.createdBy !== dbUser.id) {
      return reply.code(403).send({ code: 'not_world_creator' })
    }
    request.world = world
  }
}
