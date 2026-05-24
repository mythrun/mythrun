// backend/dev-tool/src/pages/billing-page.ts
//
// myth-0smu: Billing & Credits workflow page. Order is read-first
// (SKUs catalog + current balance + subscription + history) then
// write-actions (checkout, portal, upgrade-tier) then dev-only
// (grant + my credits) so the operator sees state before acting.

import type { PanelHandle } from '../components/_shared/panel-skeleton.js'
import { registerWorkflowMount } from '../shell/workflow-registry.js'
import { buildPageBody } from './_shared/page-skeleton.js'

import { mountSkusPanel } from '../components/skus-panel.js'
import { mountBalancePanel } from '../components/balance-panel.js'
import { mountSubscriptionPanel } from '../components/subscription-panel.js'
import { mountHistoryPanel } from '../components/history-panel.js'
import { mountCheckoutPanel } from '../components/checkout-panel.js'
import { mountPortalPanel } from '../components/portal-panel.js'
import { mountUpgradeTierPanel } from '../components/upgrade-tier-panel.js'
import { mountDevCreditsGrantPanel } from '../components/dev-credits-grant-panel.js'
import { mountDevCreditsMePanel } from '../components/dev-credits-me-panel.js'

const SECTIONS: readonly {
  readonly id: string
  readonly mount: (parent: HTMLElement) => PanelHandle
}[] = [
  { id: 'skus', mount: mountSkusPanel },
  { id: 'balance', mount: mountBalancePanel },
  { id: 'subscription', mount: mountSubscriptionPanel },
  { id: 'history', mount: mountHistoryPanel },
  { id: 'checkout', mount: mountCheckoutPanel },
  { id: 'portal', mount: mountPortalPanel },
  { id: 'upgrade-tier', mount: mountUpgradeTierPanel },
  { id: 'dev-credits-grant', mount: mountDevCreditsGrantPanel },
  { id: 'dev-credits-me', mount: mountDevCreditsMePanel },
]

export function mountBillingPage(parent: HTMLElement): PanelHandle {
  const body = buildPageBody(parent, 'Billing & Credits')
  for (const s of SECTIONS) {
    body.mountSection(s.id, s.mount)
  }
  return {
    root: body.root,
    unmount: () => {
      body.unmountAll()
      if (body.root.parentNode !== null) body.root.parentNode.removeChild(body.root)
    },
  }
}

registerWorkflowMount('billing', mountBillingPage)
