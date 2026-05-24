import { mountIdentitySwitcher } from './components/identity-switcher.js'
import { mountShell } from './shell/shell.js'
import { getCurrentDevSub, onIdentityChanged } from './identity.js'
import { apiCall } from './api-client.js'
import './styles.css'

// myth-mbdc migration: side-effect imports of existing panels so the
// verify-registry's reverse-coverage invariant (every registered panel
// must be imported by main.ts) keeps passing during Phase 6's panel-by-
// panel refactor. Each Phase 6 group removes the import for its panels
// once they self-register via the registerPanelMount mechanism. When
// the last side-effect import disappears, the verify-registry rule
// should be updated to look at registerPanelMount call sites instead.
import './components/status-panel.js'
import './components/campaign-create-panel.js'
import './components/campaign-details-panel.js'
import './components/my-campaigns-panel.js'
import './components/live-events-panel.js'
import './components/users-panel.js'
import './components/invites-panel.js'
import './components/world-snapshot-panel.js'
// myth-ukpc P6.A — new CAMPAIGNS-section panels self-register on import.
import './components/campaign-rename-panel.js'
import './components/campaign-resume-panel.js'
import './components/campaign-archive-panel.js'
import './components/campaign-delete-panel.js'
// myth-rdwq P6.B — new WORLD-section panels self-register on import.
import './components/hierarchy-panel.js'
import './components/random-tables-panel.js'
// myth-fn51 P6.C — new CHARACTERS-section panels self-register on import.
// These replace the old multi-purpose character-creation-panel (one panel
// per endpoint × action, per the dev-tool reorg spec §3).
import './components/submit-character-concept-panel.js'
import './components/characters-roster-panel.js'
import './components/character-view-panel.js'
import './components/starting-situations-panel.js'
import './components/situation-pick-panel.js'
import './components/members-panel.js'
// myth-6uu1 P6.D — new USERS & ACCESS-section panels self-register on
// import. users-panel + invites-panel still ship as side-effect imports
// above; this wave splits the old invites-panel into 4 single-purpose
// siblings (one per route × action).
import './components/invites-list-panel.js'
import './components/invite-revoke-panel.js'
import './components/invite-preview-panel.js'
import './components/invite-accept-panel.js'
// myth-c1gr P6.E — new BILLING-section GET panels self-register on
// import. One panel per route × action per spec §3.
import './components/skus-panel.js'
import './components/subscription-panel.js'
import './components/balance-panel.js'
import './components/history-panel.js'
import './components/dev-credits-me-panel.js'
// myth-6hi9 P6.F — new BILLING-section POST panels self-register on
// import. Replace the deleted billing-panel + credit-ledger-panel; the
// last side-effect imports for those legacy panels have been removed
// above. One panel per route × action per spec §3.
import './components/checkout-panel.js'
import './components/portal-panel.js'
import './components/upgrade-tier-panel.js'
import './components/dev-credits-grant-panel.js'
// myth-hs6g P6.G — new SYSTEM-section panels self-register on import.
// Replace the deleted composite health-panel with two single-purpose
// liveness/readiness probes; rewrite session-ticket-panel in place to
// the PanelHandle + split-view shape (it kept its file name).
import './components/health-live-panel.js'
import './components/health-ready-panel.js'
import './components/session-ticket-panel.js'
// MYT-54 T15 — campaign-scoped character-integration progress panel.
import './components/character-creation-progress-panel.js'
import './components/finalize-character-creation-panel.js'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

// Principle 3 (bring-up self-bootstraps). On first load the active dev sub
// might not yet have a users row — without one, /api/users/me + /api/users/
// :sub-scoped routes return 403 username_required, and panels that fetch on
// mount flip into the error state. The verify harness's identity-bootstrap
// step handles this server-side; the in-browser path needs the same safety
// net so a developer landing on the page against a clean DB sees working
// panels without manual setup.
async function bootstrapIdentity(sub: string): Promise<void> {
  const meRes = await apiCall('/api/users/me')
  if (meRes.status === 200) return
  if (meRes.status !== 403) {
    console.warn(`[bootstrap] /api/users/me returned ${String(meRes.status)}; skipping register`)
    return
  }
  const username = sub.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
  const displayName = `Dev ${sub}`
  const registerRes = await apiCall('/api/users/register', {
    method: 'POST',
    body: JSON.stringify({ username, displayName }),
  })
  if (registerRes.status === 201 || registerRes.status === 200) {
    console.log(`[bootstrap] ${sub} ${registerRes.status === 201 ? 'registered' : 'pre-existing'}`)
    window.dispatchEvent(new CustomEvent('mythrun.identitychanged', { detail: sub }))
    return
  }
  console.warn(
    `[bootstrap] register ${sub} returned ${String(registerRes.status)}: ${JSON.stringify(registerRes.body)}`,
  )
}

mountIdentitySwitcher(header)
mountShell()

void bootstrapIdentity(getCurrentDevSub())

onIdentityChanged((sub) => {
  void bootstrapIdentity(sub)
})
