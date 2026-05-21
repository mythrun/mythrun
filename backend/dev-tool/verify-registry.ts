// backend/dev-tool/verify-registry.ts
//
// Panel registry for the dev-tool verifier (myth-e5mn). Each panel
// declares its interaction pattern + DOM markers; the verify harness
// (scripts/verify.ts) uses these to apply pattern-appropriate assertions.
//
// Three build-time invariants are enforced by __tests__/verify-registry.test.ts:
//   1. Forward coverage: every panel module exporting a mount* function
//      has a registry entry.
//   2. Reverse coverage: every registry key is imported by main.ts.
//   3. Route exhaustion: union(PANEL_REGISTRY.*.exercises) ∪ EXEMPT_ROUTES
//      ⊇ BACKEND_ROUTES.
//
// EXEMPT_ROUTES carries routes that intentionally cannot have a UI panel
// — the Stripe webhook (signature-verified consumer, no human UI) and
// POST /api/users/register (exercised by the harness's identity-bootstrap
// step, not a UI surface). Anything added here must be justified in a
// comment so future readers know why a panel wasn't authored.

import type { BackendRoute } from '../src/contract/backend-routes.js'

import { mountIdentitySwitcher } from './src/components/identity-switcher.js'
import { mountHealthPanel } from './src/components/health-panel.js'
import { mountCampaignCreatePanel } from './src/components/campaign-create-panel.js'
import { mountMyCampaignsPanel } from './src/components/my-campaigns-panel.js'
import { mountStatusPanel } from './src/components/status-panel.js'
import { mountLiveEventsPanel } from './src/components/live-events-panel.js'
import { mountCampaignDetailsPanel } from './src/components/campaign-details-panel.js'
import { mountCampaignRenamePanel } from './src/components/campaign-rename-panel.js'
import { mountCampaignResumePanel } from './src/components/campaign-resume-panel.js'
import { mountCampaignArchivePanel } from './src/components/campaign-archive-panel.js'
import { mountCampaignDeletePanel } from './src/components/campaign-delete-panel.js'
import { mountCreditLedgerPanel } from './src/components/credit-ledger-panel.js'
import { mountUsersPanel } from './src/components/users-panel.js'
import { mountInvitesPanel } from './src/components/invites-panel.js'
import { mountSessionTicketPanel } from './src/components/session-ticket-panel.js'
import { mountBillingPanel } from './src/components/billing-panel.js'
import { mountWorldSnapshotPanel } from './src/components/world-snapshot-panel.js'
import { mountHierarchyPanel } from './src/components/hierarchy-panel.js'
import { mountRandomTablesPanel } from './src/components/random-tables-panel.js'
import { mountCharacterCreationPanel } from './src/components/character-creation-panel.js'

export type PanelPattern = 'fetch-on-mount' | 'event-driven' | 'action-only'

export interface PanelRegistration {
  /** Interaction pattern; drives which assertions the harness applies. */
  readonly pattern: PanelPattern
  /** The panel's mount function. Called with a fresh <div> as parent.
   *  myth-mbdc panels return a PanelHandle (the lifecycle contract from
   *  spec §10); legacy panels return void; pre-mbdc identity-bootstrap
   *  helpers can be async. All three shapes are valid; the verifier
   *  discards the return value either way. */
  readonly mount: (parent: HTMLElement) => unknown
  /** CSS selector indicating the panel reached its expected post-mount
   *  state. For fetch-on-mount: data-state="loaded". For event-driven:
   *  data-state="idle". For action-only: data-state="ready". */
  readonly readySelector: string
  /** CSS selector indicating the panel rendered an error banner.
   *  Distinct from "loaded" so empty-but-healthy state isn't misread. */
  readonly errorSelector: string
  /** Max ms to wait for readySelector OR errorSelector after mount. */
  readonly readyTimeoutMs?: number
  /** console.error messages allowed during mount. Substring match. */
  readonly errorAllowlist?: readonly string[]
  /** Backend routes this panel exercises. Typed import prevents drift. */
  readonly exercises: readonly BackendRoute[]
}

// One route from BACKEND_ROUTES, picked by method+path. Helper for declaring
// `exercises` arrays without re-typing the route literal.
function route(method: BackendRoute['method'], path: string): BackendRoute {
  // The registry test (route exhaustion invariant) ensures every value
  // returned here is in BACKEND_ROUTES; if not, the test fails on union.
  return { method, path }
}

/**
 * Routes that intentionally have no UI panel. The route audit treats these
 * as covered. Adding to this list requires a short comment justifying why
 * a panel can't / shouldn't exist — the default is to author a panel.
 */
export const EXEMPT_ROUTES: readonly BackendRoute[] = [
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
]

export const PANEL_REGISTRY: Readonly<Record<string, PanelRegistration>> = {
  'identity-switcher': {
    pattern: 'event-driven',
    mount: mountIdentitySwitcher,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [],
  },
  health: {
    pattern: 'fetch-on-mount',
    mount: mountHealthPanel,
    readySelector: '[data-state="loaded"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/health'), route('GET', '/health/ready')],
  },
  'campaign-create': {
    pattern: 'action-only',
    mount: mountCampaignCreatePanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('POST', '/api/campaigns')],
  },
  'my-campaigns': {
    pattern: 'fetch-on-mount',
    mount: mountMyCampaignsPanel,
    readySelector: '[data-state="loaded"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/mine')],
  },
  status: {
    // myth-rdwq P6.B refactor: action+feedback shape (Refresh button +
    // pipeline_runs snapshot). The SSE stream is owned by the wire-log
    // drawer; this panel polls the snapshot route.
    pattern: 'action-only',
    mount: mountStatusPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('GET', '/api/campaigns/:campaignId/status'),
      route('GET', '/api/campaigns/:campaignId/status/stream'),
    ],
  },
  'live-events': {
    // myth-rdwq P6.B refactor: minimal placeholder panel pointing at the
    // wire-log drawer (spec §6). The reducer helpers in the source file
    // are preserved for the drawer's future re-use.
    pattern: 'action-only',
    mount: mountLiveEventsPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/:campaignId/status/stream')],
  },
  'campaign-details': {
    pattern: 'event-driven',
    mount: mountCampaignDetailsPanel,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/:campaignId')],
  },
  'campaign-rename': {
    pattern: 'action-only',
    mount: mountCampaignRenamePanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('PATCH', '/api/campaigns/:campaignId/name')],
  },
  'campaign-resume': {
    pattern: 'action-only',
    mount: mountCampaignResumePanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('POST', '/api/campaigns/:campaignId/resume')],
  },
  'campaign-archive': {
    pattern: 'action-only',
    mount: mountCampaignArchivePanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('POST', '/api/campaigns/:campaignId/archive')],
  },
  'campaign-delete': {
    pattern: 'action-only',
    mount: mountCampaignDeletePanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('DELETE', '/api/campaigns/:campaignId')],
  },
  'world-snapshot': {
    // myth-rdwq P6.B refactor: action+feedback shape (Refresh button +
    // tree/detail/glossary feedback). Post-mount steady state is 'ready'.
    // SSE delta application migrated to the wire-log drawer.
    pattern: 'fetch-on-mount',
    mount: mountWorldSnapshotPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/:campaignId/world-snapshot')],
  },
  hierarchy: {
    pattern: 'fetch-on-mount',
    mount: mountHierarchyPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/:campaignId/hierarchy')],
  },
  'random-tables': {
    pattern: 'fetch-on-mount',
    mount: mountRandomTablesPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/:campaignId/random-tables')],
  },
  'character-creation': {
    // MYT-53 T23. Idle until the user clicks Watch on my-campaigns; the
    // mythrun.watchcampaign event hands us the campaignId and triggers the
    // initial roster + starting-situations fetch. All other routes hang off
    // click handlers (action-only sub-pattern within an event-driven mount),
    // matching the world-snapshot panel's idle steady state.
    pattern: 'event-driven',
    mount: mountCharacterCreationPanel,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('POST', '/api/campaigns/:campaignId/starting-situation'),
      route('POST', '/api/campaigns/:campaignId/start-character-creation'),
      route('POST', '/api/campaigns/:campaignId/archive'),
      route('POST', '/api/campaigns/:campaignId/characters'),
      route('GET', '/api/campaigns/:campaignId/starting-situations'),
      route('GET', '/api/campaigns/:campaignId/characters'),
      route('GET', '/api/campaigns/:campaignId/characters/:charId'),
      route('GET', '/api/campaigns/:campaignId/hierarchy'),
      route('GET', '/api/campaigns/:campaignId/random-tables'),
    ],
  },
  'credit-ledger': {
    pattern: 'action-only',
    mount: mountCreditLedgerPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('POST', '/api/dev/credits/grant'),
      route('GET', '/api/dev/credits/me'),
    ],
  },
  users: {
    pattern: 'fetch-on-mount',
    mount: mountUsersPanel,
    readySelector: '[data-state="loaded"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('GET', '/api/users/me'),
      route('GET', '/api/users/check-username'),
    ],
  },
  invites: {
    pattern: 'action-only',
    mount: mountInvitesPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('POST', '/api/campaigns/:campaignId/invites'),
      route('GET', '/api/campaigns/:campaignId/invites'),
      route('DELETE', '/api/campaigns/:campaignId/invites/:inviteCode'),
      route('GET', '/api/invites/:inviteCode/preview'),
      route('POST', '/api/invites/:inviteCode/accept'),
      route('GET', '/api/campaigns/:campaignId/members'),
    ],
  },
  'session-ticket': {
    pattern: 'action-only',
    mount: mountSessionTicketPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('POST', '/api/sessions/:id/ws-ticket')],
  },
  billing: {
    pattern: 'action-only',
    mount: mountBillingPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('GET', '/api/billing/skus'),
      route('GET', '/api/billing/balance'),
      route('GET', '/api/billing/subscription'),
      route('GET', '/api/billing/history'),
      route('POST', '/api/billing/checkout'),
      route('POST', '/api/billing/portal'),
      route('POST', '/api/billing/upgrade-tier'),
    ],
  },
}
