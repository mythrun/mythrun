// backend/dev-tool/src/shell/shell.ts
//
// myth-mbdc: composition root. Mounts header + banner + sidebar +
// main pane + drawer into <header> and <main>. Wires the
// identity-bridge to reset on switch. Holds the lazy-mounted active
// panel's handle for unmount-on-switch.

import { mountSidebar, type SidebarHandle } from './sidebar.js'
import { mountBanner, type BannerHandle } from './banner.js'
import { mountDrawer, type DrawerHandle } from './drawer/drawer.js'
import { createEventBus } from './drawer/event-bus.js'
import { createRingBuffer } from './drawer/buffer.js'
import { createSubscriptionManager, type DrawerEvent } from './drawer/subscriptions.js'
import { installIdentityBridge } from './identity-bridge.js'
import { getActiveCampaignId } from './active-campaign.js'

export interface ShellHandle {
  unmount(): void
}

export function mountShell(): ShellHandle {
  const header = document.querySelector('header')
  const main = document.querySelector('main')
  if (header === null || main === null) {
    throw new Error('mountShell: <header> or <main> not in document')
  }

  // Layout: main becomes a column with banner on top of a horizontal
  // row containing sidebar | mainPane | drawer.
  ;(main as HTMLElement).style.display = 'flex'
  ;(main as HTMLElement).style.padding = '0'
  ;(main as HTMLElement).style.margin = '0'
  ;(main as HTMLElement).style.maxWidth = 'unset'
  ;(main as HTMLElement).style.height = 'calc(100vh - 80px)'
  ;(main as HTMLElement).style.flexDirection = 'column'

  const bannerContainer = document.createElement('div')
  ;(main as HTMLElement).appendChild(bannerContainer)

  const flexRow = document.createElement('div')
  flexRow.style.display = 'flex'
  flexRow.style.flex = '1'
  flexRow.style.minHeight = '0'
  ;(main as HTMLElement).appendChild(flexRow)

  const bus = createEventBus<DrawerEvent>()
  const buffer = createRingBuffer<DrawerEvent>(500)
  const subscriptions = createSubscriptionManager({
    onEvent: (e) => bus.publish(e),
    urlFor: (id) => `/api/campaigns/${id}/status/stream`,
  })

  const banner: BannerHandle = mountBanner(bannerContainer, { getActiveCampaignId })
  const mainPane = document.createElement('div')
  mainPane.setAttribute('data-region', 'main')
  mainPane.style.flex = '1'
  mainPane.style.overflow = 'auto'

  const sidebar: SidebarHandle = mountSidebar(flexRow, {
    onSelect: (panel) => {
      // TODO P5.6: dispatch to the active panel mount. For now, just
      // mark the leaf as selected.
      sidebar.setSelected(panel)
    },
    getActiveCampaignId,
  })
  flexRow.appendChild(mainPane)
  const drawer: DrawerHandle = mountDrawer(flexRow, { subscriptions, bus, buffer })

  const dispose = installIdentityBridge({
    onIdentityChange: () => {
      subscriptions.closeAll()
      // Re-subscribe to active campaign if set.
      const active = getActiveCampaignId()
      if (active !== null) subscriptions.subscribe(active)
      sidebar.refresh()
    },
  })

  // Auto-subscribe to the active campaign on mount.
  const initialActive = getActiveCampaignId()
  if (initialActive !== null) subscriptions.subscribe(initialActive)

  return {
    unmount: () => {
      dispose()
      drawer.unmount()
      sidebar.unmount()
      banner.unmount()
      subscriptions.closeAll()
      bannerContainer.remove()
      flexRow.remove()
    },
  }
}
