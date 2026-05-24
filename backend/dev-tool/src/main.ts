import { mountIdentitySwitcher } from './components/identity-switcher.js'
import { mountShell } from './shell/shell.js'
import { getCurrentDevSub, onIdentityChanged } from './identity.js'
import { apiCall } from './api-client.js'
import './styles.css'

// myth-0smu workflow-page reorg: side-effect imports of the 6 page
// composers so each page's registerWorkflowMount() call site runs at
// boot. Each page composer imports the panels it composes directly,
// so the dev-tool no longer needs per-panel side-effect imports here.
import './pages/campaigns-page.js'
import './pages/world-page.js'
import './pages/characters-page.js'
import './pages/users-page.js'
import './pages/billing-page.js'
import './pages/system-page.js'

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
