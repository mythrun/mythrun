import { mountIdentitySwitcher } from './components/identity-switcher.js'
import { mountHealthPanel } from './components/health-panel.js'
import { mountStatusPanel } from './components/status-panel.js'
import { mountCampaignCreatePanel } from './components/campaign-create-panel.js'
import { mountCampaignDetailsPanel } from './components/campaign-details-panel.js'
import { mountCreditLedgerPanel } from './components/credit-ledger-panel.js'
import { mountMyCampaignsPanel } from './components/my-campaigns-panel.js'
import { mountLiveEventsPanel } from './components/live-events-panel.js'
import { onIdentityChanged } from './identity.js'
import './styles.css'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

mountIdentitySwitcher(header)
mountHealthPanel(main)
mountCampaignCreatePanel(main)
mountMyCampaignsPanel(main)
mountStatusPanel(main)
mountLiveEventsPanel(main)
mountCampaignDetailsPanel(main)
mountCreditLedgerPanel(main)

// Identity-switcher state-clear (MYT-51 T13 Kraken-Imp6).
//
// When the acting identity changes, every panel that holds per-identity
// state must reset: the SSE watcher needs to close (otherwise the new
// identity's snapshot fetch will see the previous identity's stream),
// and the create/details/ledger inputs must clear so a stale campaignId
// or in-flight grant log doesn't bleed across the switch.
//
// Each panel listens for its own clear event. main.ts is the only place
// that knows about all of them; this keeps the per-panel files focused.
onIdentityChanged(() => {
  window.dispatchEvent(new CustomEvent('mythrun.closewatch'))
  window.dispatchEvent(new CustomEvent('mythrun.createpanel.clear'))
  window.dispatchEvent(new CustomEvent('mythrun.detailspanel.clear'))
  window.dispatchEvent(new CustomEvent('mythrun.ledgerpanel.clear'))
})
