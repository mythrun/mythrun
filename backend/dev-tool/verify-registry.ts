// backend/dev-tool/verify-registry.ts
//
// myth-0smu: workflow-page registry for the dev-tool verifier. After
// the sidebar reorg (route-per-panel → workflow-per-page), the verify
// harness's natural unit is the workflow page, not the individual
// panel. Each entry below declares one of the 6 entity-scoped pages,
// the panel ids it composes, and the post-mount steady-state marker
// the harness polls for.
//
// Four build-time invariants are enforced by __tests__/verify-registry.test.ts:
//   1. Forward coverage — every panel module exporting a `mount*`
//      function is composed by at least one page (or listed in
//      EXEMPT_PANELS).
//   2. Workflow coverage — every WorkflowId in workflow-registry has
//      a PAGE_REGISTRY entry, and every PAGE_REGISTRY key matches a
//      WorkflowId.
//   3. Reverse coverage — every page is imported by main.ts.
//   4. Route exhaustion — union(every panel referenced by every page,
//      via PANEL_EXERCISES) ∪ EXEMPT_ROUTES ⊇ BACKEND_ROUTES.
//
// EXEMPT_ROUTES carries routes that intentionally cannot have a UI
// panel — the Stripe webhook (signature-verified consumer, no human
// UI) and POST /api/users/register / GET /api/users/check-username
// (exercised by the harness's identity-bootstrap step + the dev tool's
// self-bootstrap, not standalone UI panels). Anything added here must
// be justified in a comment.

import type { BackendRoute } from '../src/contract/backend-routes.js'
import {
  WORKFLOWS,
  type WorkflowId,
} from './src/shell/workflow-registry.js'

import { mountCampaignsPage } from './src/pages/campaigns-page.js'
import { mountWorldPage } from './src/pages/world-page.js'
import { mountCharactersPage } from './src/pages/characters-page.js'
import { mountUsersPage } from './src/pages/users-page.js'
import { mountBillingPage } from './src/pages/billing-page.js'
import { mountSystemPage } from './src/pages/system-page.js'

export type PanelPattern = 'fetch-on-mount' | 'event-driven' | 'action-only'

// Per-panel route exercises. The page composition table (PAGE_REGISTRY
// below) lists panel ids; this map records which BACKEND_ROUTES each
// panel id covers. Keeping this separate from the page entries keeps
// the page entries readable and lets the route-exhaustion invariant be
// computed independently of page composition.
export const PANEL_EXERCISES: Readonly<Record<string, readonly BackendRoute[]>> = {
  // CAMPAIGNS-page panels
  'campaign-create': [
    { method: 'POST', path: '/api/campaigns' },
    // MYT-89 A5: the guided flow synthesizes+reworks a concept before commit.
    { method: 'POST', path: '/api/campaigns/synthesize-preview' },
    { method: 'POST', path: '/api/campaigns/preview/:previewId/rework' },
  ],
  'my-campaigns': [{ method: 'GET', path: '/api/campaigns/mine' }],
  'campaign-details': [{ method: 'GET', path: '/api/campaigns/:campaignId' }],
  'campaign-rename': [{ method: 'PATCH', path: '/api/campaigns/:campaignId/name' }],
  'campaign-resume': [{ method: 'POST', path: '/api/campaigns/:campaignId/resume' }],
  'campaign-archive': [{ method: 'POST', path: '/api/campaigns/:campaignId/archive' }],
  'campaign-delete': [{ method: 'DELETE', path: '/api/campaigns/:campaignId' }],

  // WORLD-page panels
  status: [
    { method: 'GET', path: '/api/campaigns/:campaignId/status' },
    { method: 'GET', path: '/api/campaigns/:campaignId/status/stream' },
  ],
  'live-events': [{ method: 'GET', path: '/api/campaigns/:campaignId/status/stream' }],
  'world-snapshot': [{ method: 'GET', path: '/api/campaigns/:campaignId/world-snapshot' }],
  hierarchy: [{ method: 'GET', path: '/api/campaigns/:campaignId/hierarchy' }],
  'random-tables': [{ method: 'GET', path: '/api/campaigns/:campaignId/random-tables' }],
  'session-prep-trigger': [{ method: 'POST', path: '/api/campaigns/:campaignId/session-prep' }],
  'session-prep-reset': [{ method: 'POST', path: '/api/campaigns/:campaignId/reset-prep' }],
  'session-preps-list': [{ method: 'GET', path: '/api/campaigns/:campaignId/session-preps' }],
  'session-prep-view': [{ method: 'GET', path: '/api/campaigns/:campaignId/session-preps/:prepId' }],

  // CHARACTERS-page panels
  'submit-character-concept': [{ method: 'POST', path: '/api/campaigns/:campaignId/characters' }],
  'characters-roster': [{ method: 'GET', path: '/api/campaigns/:campaignId/characters' }],
  'character-view': [{ method: 'GET', path: '/api/campaigns/:campaignId/characters/:charId' }],
  'starting-situations': [{ method: 'GET', path: '/api/campaigns/:campaignId/starting-situations' }],
  'situation-pick': [{ method: 'POST', path: '/api/campaigns/:campaignId/starting-situation' }],
  members: [{ method: 'GET', path: '/api/campaigns/:campaignId/members' }],
  'character-creation-progress': [
    { method: 'GET', path: '/api/campaigns/:campaignId/character-creation-progress' },
  ],
  'finalize-character-creation': [
    { method: 'POST', path: '/api/campaigns/:campaignId/finalize-character-creation' },
  ],

  // USERS & ACCESS-page panels
  users: [{ method: 'GET', path: '/api/users/me' }],
  invites: [{ method: 'POST', path: '/api/campaigns/:campaignId/invites' }],
  'invites-list': [{ method: 'GET', path: '/api/campaigns/:campaignId/invites' }],
  'invite-revoke': [
    { method: 'DELETE', path: '/api/campaigns/:campaignId/invites/:inviteCode' },
  ],
  'invite-preview': [{ method: 'GET', path: '/api/invites/:inviteCode/preview' }],
  'invite-accept': [{ method: 'POST', path: '/api/invites/:inviteCode/accept' }],

  // BILLING & CREDITS-page panels
  skus: [{ method: 'GET', path: '/api/billing/skus' }],
  subscription: [{ method: 'GET', path: '/api/billing/subscription' }],
  balance: [{ method: 'GET', path: '/api/billing/balance' }],
  history: [{ method: 'GET', path: '/api/billing/history' }],
  checkout: [{ method: 'POST', path: '/api/billing/checkout' }],
  portal: [{ method: 'POST', path: '/api/billing/portal' }],
  'upgrade-tier': [{ method: 'POST', path: '/api/billing/upgrade-tier' }],
  'dev-credits-grant': [{ method: 'POST', path: '/api/dev/credits/grant' }],
  'dev-credits-me': [{ method: 'GET', path: '/api/dev/credits/me' }],

  // SYSTEM-page panels
  'health-live': [{ method: 'GET', path: '/health' }],
  'health-ready': [{ method: 'GET', path: '/health/ready' }],
  'session-ticket': [{ method: 'POST', path: '/api/sessions/:id/ws-ticket' }],
  'session-start': [{ method: 'POST', path: '/api/sessions/:id/start' }],
  'session-active': [{ method: 'GET', path: '/api/sessions/:id/active' }],
  'session-messages': [{ method: 'GET', path: '/api/sessions/:id/messages' }],
  'fire-turn': [
    { method: 'POST', path: '/api/dev/campaigns/:campaignId/fire-turn' },
  ],
  // MYT-75 T10: combat L1 inspector. Exercises the WS session channel
  // (`GET /ws/session/:sessionId`) — formerly EXEMPT (no JSDOM socket
  // transport), now a REAL panel. It mounts to `ready` synchronously and
  // opens the live socket only on the Connect click, so the JSDOM verifier
  // never reaches the socket; the live combat-frame + resume_combat flow is
  // human / wire-smoke verified. The HTTP ticket-mint half stays covered by
  // the session-ticket panel.
  combat: [{ method: 'GET', path: '/ws/session/:sessionId' }],
}

// Panels that legitimately have a `mount*` export but are NOT composed
// by any page. Today: identity-switcher (mounted in header chrome, not
// part of any workflow page). Adding to this list requires a comment
// justifying why the panel isn't reachable from a page.
export const EXEMPT_PANELS: readonly string[] = [
  // identity-switcher: lives in the <header> chrome, not a workflow
  // page. mounted directly by main.ts via mountIdentitySwitcher.
  'identity-switcher',
]

export interface PageRegistration {
  /** Interaction pattern; drives which assertions the harness applies.
   *  Pages aggregate many panels — the page is `event-driven` because
   *  it doesn't fetch on its own; its composed panels do. */
  readonly pattern: PanelPattern
  /** The page's mount function. Called with a fresh <div> as parent. */
  readonly mount: (parent: HTMLElement) => unknown
  /** CSS selector indicating the page reached its expected post-mount
   *  state. Pages mount their composed panels synchronously then return,
   *  so the page itself is "ready" once its data-page attribute is set. */
  readonly readySelector: string
  /** CSS selector indicating the page rendered an error banner. */
  readonly errorSelector: string
  /** Max ms to wait for readySelector OR errorSelector after mount. */
  readonly readyTimeoutMs?: number
  /** console.error messages allowed during mount. Substring match. */
  readonly errorAllowlist?: readonly string[]
  /** Panel ids composed by this page, in mount order. The route
   *  exhaustion invariant unions PANEL_EXERCISES[panelId] across every
   *  page entry's panels list. */
  readonly panels: readonly string[]
}

/**
 * Routes that intentionally have no UI panel. The route audit treats these
 * as covered. Adding to this list requires a short comment justifying why
 * a panel can't / shouldn't exist — the default is to author a panel.
 */
export const EXEMPT_ROUTES: readonly BackendRoute[] = [
  // GET /api/campaigns/:campaignId/wiki (MYT-74c): the PLAYER-facing campaign
  // wiki (member-readable, narrow known-tier). Not a dev-tool inspector surface —
  // the owner-only world-snapshot panel already covers world inspection; this
  // route exists for the player UI (a Frontend ticket), so it has no dev-tool panel.
  { method: 'GET', path: '/api/campaigns/:campaignId/wiki' },

  // GET /api/campaigns/:campaignId/transcript/search (MYT-74d): player-facing
  // FTS lookback over the transcript. Member-readable; no dev-tool inspector
  // surface (the player UI owns the search box, a Frontend ticket).
  { method: 'GET', path: '/api/campaigns/:campaignId/transcript/search' },

  // POST /webhooks/stripe: signature-verified consumer of Stripe events.
  // The HMAC over the raw body would reject any request not signed with
  // Stripe's webhook secret — there's no useful UI surface a human could
  // drive. Coverage of the webhook dispatch logic is enforced by the
  // backend's billing/webhook tests.
  { method: 'POST', path: '/webhooks/stripe' },

  // POST /api/users/register: exercised by the verify harness's identity
  // bootstrap step (scripts/verify.ts) AND the dev tool's main.ts
  // self-bootstrap on first load. A standalone UI panel would only be
  // useful for adversarial edge-case tests (profanity, mismatched
  // sub-username, etc.), which the backend routes test suite already
  // covers in depth.
  { method: 'POST', path: '/api/users/register' },

  // GET /api/users/check-username: probe-helper for the register flow.
  // No standalone UI surface — exercised server-side by tests +
  // identity bootstrap.
  { method: 'GET', path: '/api/users/check-username' },

  // GET /api/dev/campaigns/:campaignId/prep-prose: live prose SSE consumed
  // by the dev-tool wire-log drawer — header chrome, not a JSDOM-mountable
  // page panel; exercised E2E by MYT-64. (MYT-62 T5.)
  { method: 'GET', path: '/api/dev/campaigns/:campaignId/prep-prose' },

  // GET /api/campaigns/:campaignId/prep-status: phase-only prep SSE;
  // consumed by the frontend loading screen + dev-tool drawer, no JSDOM
  // page panel; E2E via MYT-64. (MYT-62 T6.)
  { method: 'GET', path: '/api/campaigns/:campaignId/prep-status' },

  // GET /api/dev/api-cost: the dev/staging-only API-cost ticker endpoint. Its
  // consumer is the floating DevCostTicker widget in the MAIN WEB APP
  // (frontend/src/dev/), not a dev-tool inspector panel — so it has no page
  // panel here. Never registered in production (mythrunEnv gate).
  { method: 'GET', path: '/api/dev/api-cost' },

  // GET /api/worldgen/stage-timings (MYT-89 audit ③): global historical
  // avg-per-stage durations for the generation loading-bar ETA. Its consumer is
  // the generation status card in the MAIN WEB APP (a Frontend ticket), not a
  // dev-tool inspector panel — so it has no page panel here. The averaging SQL +
  // cold-start [] path are covered by the backend repo + route tests.
  { method: 'GET', path: '/api/worldgen/stage-timings' },

  // NOTE (MYT-75 T10): GET /ws/session/:sessionId is NO LONGER exempt — the
  // combat L1 inspector (`combat` panel, System page) is a real panel that
  // exercises it. The panel mounts to `ready` synchronously and opens the live
  // WebSocket only on the Connect click (the ticket carries identity, so the
  // header-less browser socket authenticates), so the JSDOM verify harness —
  // which has no socket transport — never reaches the connect path; the live
  // combat-frame + resume_combat flow is human / wire-smoke verified. The HTTP
  // ticket-mint half stays covered by the session-ticket panel. See
  // PANEL_EXERCISES['combat'] above.

]

export const PAGE_REGISTRY: Readonly<Record<WorkflowId, PageRegistration>> = {
  campaigns: {
    pattern: 'event-driven',
    mount: mountCampaignsPage,
    // Pages set data-page on their root synchronously, so the marker is
    // present the moment the mount fn returns. Verifier polls for this.
    readySelector: '[data-page]',
    errorSelector: '[data-state="error"]',
    panels: [
      'campaign-create',
      'my-campaigns',
      // Below five are active-campaign-only; the verifier's identity
      // bootstrap step sets up a user but doesn't create a campaign, so
      // they may not be present in the first boot. The route-exhaustion
      // invariant still credits them — they're part of this page's
      // declared composition.
      'campaign-details',
      'campaign-rename',
      'campaign-resume',
      'campaign-archive',
      'campaign-delete',
    ],
  },
  world: {
    pattern: 'event-driven',
    mount: mountWorldPage,
    readySelector: '[data-page]',
    errorSelector: '[data-state="error"]',
    panels: [
      'status',
      'live-events',
      'world-snapshot',
      'hierarchy',
      'random-tables',
      'session-prep-trigger',
      'session-prep-reset',
      'session-preps-list',
      'session-prep-view',
    ],
  },
  characters: {
    pattern: 'event-driven',
    mount: mountCharactersPage,
    readySelector: '[data-page]',
    errorSelector: '[data-state="error"]',
    panels: [
      'starting-situations',
      'situation-pick',
      'submit-character-concept',
      'character-creation-progress',
      'characters-roster',
      'character-view',
      'members',
      'finalize-character-creation',
    ],
  },
  users: {
    pattern: 'event-driven',
    mount: mountUsersPage,
    readySelector: '[data-page]',
    errorSelector: '[data-state="error"]',
    panels: [
      'users',
      'invites',
      'invites-list',
      'invite-revoke',
      'invite-preview',
      'invite-accept',
    ],
  },
  billing: {
    pattern: 'event-driven',
    mount: mountBillingPage,
    readySelector: '[data-page]',
    errorSelector: '[data-state="error"]',
    panels: [
      'skus',
      'balance',
      'subscription',
      'history',
      'checkout',
      'portal',
      'upgrade-tier',
      'dev-credits-grant',
      'dev-credits-me',
    ],
  },
  system: {
    pattern: 'event-driven',
    mount: mountSystemPage,
    readySelector: '[data-page]',
    errorSelector: '[data-state="error"]',
    panels: [
      'health-live',
      'health-ready',
      'session-ticket',
      'session-start',
      'session-active',
      'session-messages',
      'fire-turn',
      'combat',
    ],
  },
}

// Back-compat alias for any external reader still expecting the old
// shape. The runtime verify harness in scripts/verify.ts has been
// updated to enumerate PAGE_REGISTRY directly.
export const PANEL_REGISTRY = PAGE_REGISTRY

// Sanity: every WorkflowId in WORKFLOWS has an entry above. Verified
// by the invariant test; this comment documents the contract.
void WORKFLOWS
