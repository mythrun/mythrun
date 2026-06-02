// backend/src/contract/backend-routes.ts
//
// Enumeration of every route the Fastify app registers when booted under
// AUTH_MODE=bypass — i.e. the bypass-mode-boot SUPERSET. The drift test in
// __tests__/backend-routes.test.ts boots the app under bypass and diffs
// app.printRoutes() against this list; adding a new route handler without
// updating this list fails the test.
//
// `/api/dev/*` routes (dev credits, prep-prose) are BYPASS-ONLY: they are
// registered solely inside app.ts's `if (config.env.authMode === 'bypass')`
// block and are LITERALLY ABSENT in production (authMode='real' skips the
// block entirely). They appear here because the drift test boots under
// bypass. The prep-prose route in particular is the structural enforced-
// ignorance control — the only route that serves sd_playbook prose, and it
// never exists in a prod boot.
//
// Pipeline routes (a subset) are also tracked separately in
// pipeline-routes.ts for the status surface. Both stay in sync via the
// drift test — anything in pipeline-routes that isn't here is a contract
// bug. (The /api/dev/* routes are NOT pipeline routes.)

export interface BackendRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  readonly path: string
}

export const BACKEND_ROUTES: readonly BackendRoute[] = [
  // Health
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/ready' },

  // Users
  { method: 'POST', path: '/api/users/register' },
  { method: 'GET', path: '/api/users/check-username' },
  { method: 'GET', path: '/api/users/me' },

  // Campaigns (pipeline + non-pipeline)
  { method: 'POST', path: '/api/campaigns' },
  { method: 'GET', path: '/api/campaigns/mine' },
  { method: 'GET', path: '/api/campaigns/:campaignId' },
  { method: 'DELETE', path: '/api/campaigns/:campaignId' },
  { method: 'PATCH', path: '/api/campaigns/:campaignId/name' },
  { method: 'POST', path: '/api/campaigns/:campaignId/resume' },
  { method: 'GET', path: '/api/campaigns/:campaignId/status' },
  { method: 'GET', path: '/api/campaigns/:campaignId/status/stream' },
  { method: 'GET', path: '/api/campaigns/:campaignId/world-snapshot' }, // myth-exac
  // MYT-53 — per-player parallel character creation
  { method: 'POST', path: '/api/campaigns/:campaignId/starting-situation' },
  { method: 'POST', path: '/api/campaigns/:campaignId/archive' },
  { method: 'POST', path: '/api/campaigns/:campaignId/characters' },
  { method: 'GET', path: '/api/campaigns/:campaignId/starting-situations' },
  { method: 'GET', path: '/api/campaigns/:campaignId/characters' },
  { method: 'GET', path: '/api/campaigns/:campaignId/characters/:charId' },
  { method: 'GET', path: '/api/campaigns/:campaignId/hierarchy' },
  { method: 'GET', path: '/api/campaigns/:campaignId/random-tables' },
  // MYT-54 — per-PC character-creation progress board (any member can view)
  { method: 'GET', path: '/api/campaigns/:campaignId/character-creation-progress' },
  // MYT-54 T13 — owner fan-in trigger that flips campaigns.pre_integration_notes
  // and enqueues the singleton `ci-${campaignId}` character-integration job.
  { method: 'POST', path: '/api/campaigns/:campaignId/finalize-character-creation' },

  // Sessions
  { method: 'POST', path: '/api/sessions/:id/ws-ticket' },

  // Invites
  { method: 'POST', path: '/api/campaigns/:campaignId/invites' },
  { method: 'GET', path: '/api/campaigns/:campaignId/invites' },
  { method: 'DELETE', path: '/api/campaigns/:campaignId/invites/:inviteCode' },
  { method: 'GET', path: '/api/invites/:inviteCode/preview' },
  { method: 'POST', path: '/api/invites/:inviteCode/accept' },
  { method: 'GET', path: '/api/campaigns/:campaignId/members' },

  // Dev credits (AUTH_MODE=bypass only)
  { method: 'POST', path: '/api/dev/credits/grant' },
  { method: 'GET', path: '/api/dev/credits/me' },

  // Dev prep-prose SSE (AUTH_MODE=bypass only). MYT-62 T5 — the structural
  // enforced-ignorance control: the only route that streams sd_playbook
  // prose (off the separate prep:campaign: channel), and it is absent in
  // production (the dev block is gated on authMode === 'bypass').
  { method: 'GET', path: '/api/dev/campaigns/:campaignId/prep-prose' },

  // Stripe webhook (raw-body, public, signature-verified)
  { method: 'POST', path: '/webhooks/stripe' },

  // Billing
  { method: 'GET', path: '/api/billing/skus' },
  { method: 'GET', path: '/api/billing/subscription' },
  { method: 'GET', path: '/api/billing/balance' },
  { method: 'GET', path: '/api/billing/history' },
  { method: 'POST', path: '/api/billing/checkout' },
  { method: 'POST', path: '/api/billing/portal' },
  { method: 'POST', path: '/api/billing/upgrade-tier' },
]
