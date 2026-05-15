import { mountIdentitySwitcher } from './components/identity-switcher.js'
import { mountHealthPanel } from './components/health-panel.js'
import { mountStatusPanel } from './components/status-panel.js'
import { mountCampaignCreatePanel } from './components/campaign-create-panel.js'
import { mountCampaignDetailsPanel } from './components/campaign-details-panel.js'
import { mountCreditLedgerPanel } from './components/credit-ledger-panel.js'
import { mountMyCampaignsPanel } from './components/my-campaigns-panel.js'
import { mountLiveEventsPanel } from './components/live-events-panel.js'
import { mountUsersPanel } from './components/users-panel.js'
import { mountInvitesPanel } from './components/invites-panel.js'
import { mountSessionTicketPanel } from './components/session-ticket-panel.js'
import { mountBillingPanel } from './components/billing-panel.js'
import { getCurrentDevSub, onIdentityChanged } from './identity.js'
import { apiCall } from './api-client.js'
import './styles.css'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

// Principle 3 (bring-up self-bootstraps). On first load the active dev sub
// might not yet have a users row — without one, /api/users/me + /api/users/
// :sub-scoped routes return 403 username_required, and panels that fetch on
// mount (my-campaigns, users) flip into the error state. The verify
// harness's identity-bootstrap step handles this server-side; the in-
// browser path needs the same safety net so a developer landing on the page
// against a clean DB sees working panels without manual setup.
//
// The bootstrap is best-effort + idempotent:
//   - 201 = first time, row created
//   - 200 = already_onboarded_same, no-op
//   - 400/409 = unrecoverable in this layer (profanity? mismatched
//     username?), surfaced via the users panel's error state and a
//     console.warn rather than blocking the page render.
async function bootstrapIdentity(sub: string): Promise<void> {
  // Skip if /api/users/me succeeds — the user is already onboarded. We do
  // this probe before register because /register triggers a profanity LLM
  // call on every request and we don't want to thrash it.
  const meRes = await apiCall('/api/users/me')
  if (meRes.status === 200) return
  if (meRes.status !== 403) {
    console.warn(`[bootstrap] /api/users/me returned ${String(meRes.status)}; skipping register`)
    return
  }
  // Compute a deterministic-but-valid username from the sub. `dev-user-1`
  // is 10 chars — fits the 3-20 char regex. We strip non-alphanumeric just
  // in case a future DEV_SUB carries a hyphen the regex wouldn't accept
  // (hyphens aren't in [a-zA-Z0-9_]).
  const username = sub.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
  const displayName = `Dev ${sub}`
  const registerRes = await apiCall('/api/users/register', {
    method: 'POST',
    body: JSON.stringify({ username, displayName }),
  })
  if (registerRes.status === 201 || registerRes.status === 200) {
    console.log(`[bootstrap] ${sub} ${registerRes.status === 201 ? 'registered' : 'pre-existing'}`)
    // Notify panels that depend on /me — they re-fetch on identity-changed.
    window.dispatchEvent(new CustomEvent('mythrun.identitychanged', { detail: sub }))
    return
  }
  console.warn(
    `[bootstrap] register ${sub} returned ${String(registerRes.status)}: ${JSON.stringify(registerRes.body)}`,
  )
}

mountIdentitySwitcher(header)
mountHealthPanel(main)
mountUsersPanel(main)
mountCampaignCreatePanel(main)
mountMyCampaignsPanel(main)
mountStatusPanel(main)
mountLiveEventsPanel(main)
mountCampaignDetailsPanel(main)
mountCreditLedgerPanel(main)
mountInvitesPanel(main)
mountSessionTicketPanel(main)
mountBillingPanel(main)

// Fire the bootstrap after all panels are mounted so the identity-changed
// event re-triggers their per-sub fetches once the row exists. Best-effort:
// we don't await it; the panels' own loading states cover the gap.
void bootstrapIdentity(getCurrentDevSub())

// Identity-switcher state-clear (MYT-51 T13 Kraken-Imp6).
//
// When the acting identity changes, every panel that holds per-identity
// state must reset: the SSE watcher needs to close (otherwise the new
// identity's snapshot fetch will see the previous identity's stream),
// and the create/details/ledger inputs must clear so a stale campaignId
// or in-flight grant log doesn't bleed across the switch. The bootstrap
// also re-runs against the new sub so a developer can swap to a previously
// unused identity and have it onboarded transparently.
//
// Each panel listens for its own clear event. main.ts is the only place
// that knows about all of them; this keeps the per-panel files focused.
onIdentityChanged((sub) => {
  window.dispatchEvent(new CustomEvent('mythrun.closewatch'))
  window.dispatchEvent(new CustomEvent('mythrun.createpanel.clear'))
  window.dispatchEvent(new CustomEvent('mythrun.detailspanel.clear'))
  window.dispatchEvent(new CustomEvent('mythrun.ledgerpanel.clear'))
  void bootstrapIdentity(sub)
})
