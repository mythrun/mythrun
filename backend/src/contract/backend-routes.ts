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
  // MYT-89 A3 — guided world-creation preview (synthesize + gate + park in
  // Redis; NON-charging). Not a pipeline route (no status surface).
  { method: 'POST', path: '/api/campaigns/synthesize-preview' },
  // MYT-89 A4 — single-shot rework of a parked preview (revise + re-gate;
  // gate-pass-only overwrite, single-rework budget). NON-charging, not a
  // pipeline route.
  { method: 'POST', path: '/api/campaigns/preview/:previewId/rework' },
  { method: 'GET', path: '/api/campaigns/mine' },
  { method: 'GET', path: '/api/campaigns/:campaignId' },
  { method: 'DELETE', path: '/api/campaigns/:campaignId' },
  { method: 'PATCH', path: '/api/campaigns/:campaignId/name' },
  { method: 'POST', path: '/api/campaigns/:campaignId/resume' },
  { method: 'GET', path: '/api/campaigns/:campaignId/status' },
  { method: 'GET', path: '/api/campaigns/:campaignId/status/stream' },
  // MYT-62 T6 — player-facing "DM is preparing tonight's session…" SSE feed.
  // Phase-only by construction (rides pipeline:campaign:, no prose).
  { method: 'GET', path: '/api/campaigns/:campaignId/prep-status' },
  { method: 'GET', path: '/api/campaigns/:campaignId/world-snapshot' }, // myth-exac
  { method: 'GET', path: '/api/campaigns/:campaignId/wiki' }, // MYT-74c
  { method: 'GET', path: '/api/campaigns/:campaignId/transcript/search' }, // MYT-74d
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
  // MYT-63 — session-prep trigger / list / read / reset
  { method: 'POST', path: '/api/campaigns/:campaignId/session-prep' },
  { method: 'GET', path: '/api/campaigns/:campaignId/session-preps' },
  { method: 'GET', path: '/api/campaigns/:campaignId/session-preps/:prepId' },
  { method: 'POST', path: '/api/campaigns/:campaignId/reset-prep' },

  // Sessions. All four share one radix param node, which Fastify prints as
  // the 3-way merge `:id|:campaignId|:sessionId` (the routes name the param
  // differently: ws-ticket :id, start/active :campaignId, messages
  // :sessionId). The drift test normalizes that printed node to the single
  // canonical name `:id`, so every session route is keyed `:id` here.
  { method: 'POST', path: '/api/sessions/:id/ws-ticket' },
  { method: 'POST', path: '/api/sessions/:id/start' },
  { method: 'GET', path: '/api/sessions/:id/active' },
  { method: 'GET', path: '/api/sessions/:id/messages' },

  // WebSocket transport (MYT-65 Task 11) — `GET /ws/session/:sessionId`, the
  // websocket-upgrade route registered by wsSessionRoutes in app.ts. It prints
  // as a standalone radix subtree under `/ws/` (no merge with the
  // `/api/sessions/:id` node), so the param token `:sessionId` stands alone and
  // needs no normalization. @fastify/websocket attaches the handler as a plain
  // GET, so a single GET entry mirrors printRoutes() exactly.
  { method: 'GET', path: '/ws/session/:sessionId' },

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

  // Dev fire-turn (AUTH_MODE=bypass only). MYT-66 T10 — enqueues one
  // session-turn job so the enqueue → worker → broadcast round-trip can be
  // smoked without the (MYT-67) player-chat trigger path. Absent in production
  // (the dev block is gated on authMode === 'bypass').
  { method: 'POST', path: '/api/dev/campaigns/:campaignId/fire-turn' },

  // Dev prep-prose SSE (AUTH_MODE=bypass only). MYT-62 T5 — the structural
  // enforced-ignorance control: the only route that streams sd_playbook
  // prose (off the separate prep:campaign: channel), and it is absent in
  // production (the dev block is gated on authMode === 'bypass').
  { method: 'GET', path: '/api/dev/campaigns/:campaignId/prep-prose' },

  // Dev/staging API-cost ticker (dev-tooling). Registered when mythrunEnv !==
  // 'production' (NOT gated on authMode — staging is authMode='real'), so it is
  // present in this bypass-mode drift boot (makeStubEnv → mythrunEnv
  // 'development'). Absent in a production boot. Serves the process-level
  // cumulative approx Anthropic spend the DevCostTicker widget polls.
  { method: 'GET', path: '/api/dev/api-cost' },

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
