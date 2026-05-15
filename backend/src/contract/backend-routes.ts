// backend/src/contract/backend-routes.ts
//
// Full enumeration of every route the production Fastify app registers.
// The drift test in __tests__/backend-routes.test.ts boots the app and
// diffs app.printRoutes() against this list; adding a new route handler
// without updating this list fails the test.
//
// Pipeline routes (a subset) are also tracked separately in
// pipeline-routes.ts for the status surface. Both stay in sync via the
// drift test — anything in pipeline-routes that isn't here is a contract
// bug.

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
  { method: 'POST', path: '/api/campaigns/:campaignId/resume' },
  { method: 'GET', path: '/api/campaigns/:campaignId/status' },
  { method: 'GET', path: '/api/campaigns/:campaignId/status/stream' },

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
