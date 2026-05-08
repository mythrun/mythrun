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
// reading the ACCESS_CONTROL_MARKER property on each hook in the
// preHandler array (more robust than reflecting on `function.name`,
// which TS emit can disambiguate by appending a numeric suffix when an
// inner named-function-expression shares the outer factory's name).
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §4

import type { preHandlerAsyncHookHandler } from 'fastify'
import type { Repo } from '../repo/index.js'
import type { CampaignMemberRole } from '../repo/types.js'
import { requireDbUser } from './require-db-user.js'

/** Marker property the boot-time `accessControlAllowlist` plugin reads
 *  to identify access-control-guarded routes. Set on the hook returned
 *  by each factory. Symbol-keyed so it can't collide with anything
 *  Fastify internally puts on the function. */
export const ACCESS_CONTROL_MARKER = Symbol('mythrun.access-control')

/** Discriminant on the marker — lets the allowlist message a useful
 *  offender identifier even though the hook itself is the same shape. */
export type AccessControlKind = 'requireCampaignMember' | 'requireWorldCreator'

type MarkedHook = preHandlerAsyncHookHandler & {
  [ACCESS_CONTROL_MARKER]?: AccessControlKind
}

function markHook(
  hook: preHandlerAsyncHookHandler,
  kind: AccessControlKind,
): preHandlerAsyncHookHandler {
  ;(hook as MarkedHook)[ACCESS_CONTROL_MARKER] = kind
  return hook
}

export function requireCampaignMember(
  repo: Repo,
  role?: CampaignMemberRole,
): preHandlerAsyncHookHandler {
  const hook: preHandlerAsyncHookHandler = async (request, reply) => {
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
    if (!member?.inviteAccepted) {
      return reply.code(403).send({ code: 'not_campaign_member' })
    }
    if (role && member.role !== role) {
      return reply.code(403).send({ code: `not_campaign_${role}` })
    }
    request.campaignMember = member
  }
  return markHook(hook, 'requireCampaignMember')
}

export function requireWorldCreator(repo: Repo): preHandlerAsyncHookHandler {
  const hook: preHandlerAsyncHookHandler = async (request, reply) => {
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
  return markHook(hook, 'requireWorldCreator')
}
