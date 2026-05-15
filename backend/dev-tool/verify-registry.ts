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
//   3. Route exhaustion: union(PANEL_REGISTRY.*.exercises) ⊇ BACKEND_ROUTES.

import type { BackendRoute } from '../src/contract/backend-routes.js'

import { mountIdentitySwitcher } from './src/components/identity-switcher.js'
import { mountHealthPanel } from './src/components/health-panel.js'
import { mountCampaignCreatePanel } from './src/components/campaign-create-panel.js'
import { mountMyCampaignsPanel } from './src/components/my-campaigns-panel.js'
import { mountStatusPanel } from './src/components/status-panel.js'
import { mountLiveEventsPanel } from './src/components/live-events-panel.js'
import { mountCampaignDetailsPanel } from './src/components/campaign-details-panel.js'
import { mountCreditLedgerPanel } from './src/components/credit-ledger-panel.js'

export type PanelPattern = 'fetch-on-mount' | 'event-driven' | 'action-only'

export interface PanelRegistration {
  /** Interaction pattern; drives which assertions the harness applies. */
  readonly pattern: PanelPattern
  /** The panel's mount function. Called with a fresh <div> as parent. */
  readonly mount: (parent: HTMLElement) => void | Promise<void>
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
    exercises: [route('GET', '/health')],
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
    pattern: 'event-driven',
    mount: mountStatusPanel,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('GET', '/api/campaigns/:campaignId/status'),
      route('GET', '/api/campaigns/:campaignId/status/stream'),
    ],
  },
  'live-events': {
    pattern: 'event-driven',
    mount: mountLiveEventsPanel,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/:campaignId/status/stream')],
  },
  'campaign-details': {
    pattern: 'event-driven',
    mount: mountCampaignDetailsPanel,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('GET', '/api/campaigns/:campaignId'),
      route('DELETE', '/api/campaigns/:campaignId'),
      route('POST', '/api/campaigns/:campaignId/resume'),
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
}
