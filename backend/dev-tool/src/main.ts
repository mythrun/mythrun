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
import './components/health-panel.js'
import './components/status-panel.js'
import './components/campaign-create-panel.js'
import './components/campaign-details-panel.js'
import './components/credit-ledger-panel.js'
import './components/my-campaigns-panel.js'
import './components/live-events-panel.js'
import './components/users-panel.js'
import './components/invites-panel.js'
import './components/session-ticket-panel.js'
import './components/billing-panel.js'
import './components/world-snapshot-panel.js'
import './components/character-creation-panel.js'
// myth-ukpc P6.A — new CAMPAIGNS-section panels self-register on import.
import './components/campaign-rename-panel.js'
import './components/campaign-resume-panel.js'
import './components/campaign-archive-panel.js'
import './components/campaign-delete-panel.js'
// myth-rdwq P6.B — new WORLD-section panels self-register on import.
import './components/hierarchy-panel.js'
import './components/random-tables-panel.js'

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
