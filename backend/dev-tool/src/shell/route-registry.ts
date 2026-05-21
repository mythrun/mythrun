// backend/dev-tool/src/shell/route-registry.ts
//
// myth-mbdc: the sidebar's source of truth. Each entry maps one
// BACKEND_ROUTES route to a section + label + (later) a panel mount fn.
// The invariant test (__tests__/route-registry.test.ts) enforces
// coverage: every backend route is either here or in EXEMPT_ROUTES.

import type { BackendRoute } from '../../../src/contract/backend-routes.js'

export type SidebarSection = 'CAMPAIGNS' | 'WORLD' | 'CHARACTERS' | 'USERS' | 'BILLING' | 'SYSTEM'

export interface RoutePanel {
  readonly method: BackendRoute['method']
  readonly path: string
  readonly section: SidebarSection
  readonly label: string         // friendly secondary label e.g. "Roster"
  readonly requiresCampaign: boolean
  readonly longRunning: boolean  // true for endpoints that kick off async pipelines
}

export const EXEMPT_ROUTES: readonly BackendRoute[] = [
  // Webhook — Stripe-signed, no UI surface.
  { method: 'POST', path: '/webhooks/stripe' },
  // Register is exercised via the verifier's identity-bootstrap step;
  // embedded as a probe-helper inside the users panel rather than its
  // own sidebar leaf.
  { method: 'POST', path: '/api/users/register' },
  // Check-username is embedded inside register's panel (probe-helper).
  { method: 'GET', path: '/api/users/check-username' },
]

export const ROUTE_PANELS: readonly RoutePanel[] = [
  // CAMPAIGNS
  { method: 'POST',   path: '/api/campaigns',                                        section: 'CAMPAIGNS', label: 'Create',           requiresCampaign: false, longRunning: true  },
  { method: 'GET',    path: '/api/campaigns/mine',                                   section: 'CAMPAIGNS', label: 'My campaigns',     requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId',                            section: 'CAMPAIGNS', label: 'Details',          requiresCampaign: true,  longRunning: false },
  { method: 'PATCH',  path: '/api/campaigns/:campaignId/name',                       section: 'CAMPAIGNS', label: 'Rename',           requiresCampaign: true,  longRunning: false },
  { method: 'POST',   path: '/api/campaigns/:campaignId/resume',                     section: 'CAMPAIGNS', label: 'Resume',           requiresCampaign: true,  longRunning: true  },
  { method: 'POST',   path: '/api/campaigns/:campaignId/archive',                    section: 'CAMPAIGNS', label: 'Archive',          requiresCampaign: true,  longRunning: false },
  { method: 'DELETE', path: '/api/campaigns/:campaignId',                            section: 'CAMPAIGNS', label: 'Delete',           requiresCampaign: true,  longRunning: false },

  // WORLD
  { method: 'GET',    path: '/api/campaigns/:campaignId/status',                     section: 'WORLD',     label: 'Status',           requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/status/stream',              section: 'WORLD',     label: 'Live events',      requiresCampaign: true,  longRunning: true  },
  { method: 'GET',    path: '/api/campaigns/:campaignId/world-snapshot',             section: 'WORLD',     label: 'Snapshot',         requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/hierarchy',                  section: 'WORLD',     label: 'Hierarchy',        requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/random-tables',              section: 'WORLD',     label: 'Random tables',    requiresCampaign: true,  longRunning: false },

  // CHARACTERS
  { method: 'POST',   path: '/api/campaigns/:campaignId/start-character-creation',   section: 'CHARACTERS', label: 'Start (owner)',   requiresCampaign: true,  longRunning: true  },
  { method: 'POST',   path: '/api/campaigns/:campaignId/characters',                 section: 'CHARACTERS', label: 'Submit concept',  requiresCampaign: true,  longRunning: true  },
  { method: 'GET',    path: '/api/campaigns/:campaignId/characters',                 section: 'CHARACTERS', label: 'Roster',          requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/characters/:charId',         section: 'CHARACTERS', label: 'Character',       requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/starting-situations',        section: 'CHARACTERS', label: 'Situations (list)', requiresCampaign: true, longRunning: false },
  { method: 'POST',   path: '/api/campaigns/:campaignId/starting-situation',         section: 'CHARACTERS', label: 'Situation (pick)', requiresCampaign: true, longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/members',                    section: 'CHARACTERS', label: 'Members',         requiresCampaign: true,  longRunning: false },

  // USERS & ACCESS
  { method: 'GET',    path: '/api/users/me',                                         section: 'USERS',     label: 'Me',               requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/campaigns/:campaignId/invites',                    section: 'USERS',     label: 'Create invite',    requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/invites',                    section: 'USERS',     label: 'List invites',     requiresCampaign: true,  longRunning: false },
  { method: 'DELETE', path: '/api/campaigns/:campaignId/invites/:inviteCode',        section: 'USERS',     label: 'Revoke invite',    requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/invites/:inviteCode/preview',                      section: 'USERS',     label: 'Preview invite',   requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/invites/:inviteCode/accept',                       section: 'USERS',     label: 'Accept invite',    requiresCampaign: false, longRunning: false },

  // BILLING & CREDITS
  { method: 'GET',    path: '/api/billing/skus',                                     section: 'BILLING',   label: 'SKUs',             requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/billing/subscription',                             section: 'BILLING',   label: 'Subscription',     requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/billing/balance',                                  section: 'BILLING',   label: 'Balance',          requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/billing/history',                                  section: 'BILLING',   label: 'History',          requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/billing/checkout',                                 section: 'BILLING',   label: 'Checkout',         requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/billing/portal',                                   section: 'BILLING',   label: 'Portal',           requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/billing/upgrade-tier',                             section: 'BILLING',   label: 'Upgrade tier',     requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/dev/credits/grant',                                section: 'BILLING',   label: 'Grant credits',    requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/dev/credits/me',                                   section: 'BILLING',   label: 'My credits',       requiresCampaign: false, longRunning: false },

  // SYSTEM
  { method: 'GET',    path: '/health',                                                section: 'SYSTEM',    label: 'Health',           requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/health/ready',                                          section: 'SYSTEM',    label: 'Ready',            requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/sessions/:id/ws-ticket',                            section: 'SYSTEM',    label: 'WS ticket',        requiresCampaign: false, longRunning: false },
]
