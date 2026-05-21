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
import type { PanelHandle } from '../components/_shared/panel-skeleton.js'
import { ROUTE_PANELS, type RoutePanel } from './route-registry.js'

type PanelMountFn = (parent: HTMLElement) => PanelHandle
const PANEL_MOUNTS = new Map<string, PanelMountFn>()

function leafKey(method: string, path: string): string {
  return `${method} ${path}`
}

export function registerPanelMount(method: string, path: string, fn: PanelMountFn): void {
  PANEL_MOUNTS.set(leafKey(method, path), fn)
}

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
  ;(main).style.display = 'flex'
  ;(main).style.padding = '0'
  ;(main).style.margin = '0'
  ;(main).style.maxWidth = 'unset'
  ;(main).style.height = 'calc(100vh - 80px)'
  ;(main).style.flexDirection = 'column'

  const bannerContainer = document.createElement('div')
  ;(main).appendChild(bannerContainer)

  const flexRow = document.createElement('div')
  flexRow.style.display = 'flex'
  flexRow.style.flex = '1'
  flexRow.style.minHeight = '0'
  ;(main).appendChild(flexRow)

  const bus = createEventBus<DrawerEvent>()
  const buffer = createRingBuffer<DrawerEvent>(500)
  const subscriptions = createSubscriptionManager({
    onEvent: (e) => { bus.publish(e); },
    urlFor: (id) => `/api/campaigns/${id}/status/stream`,
  })

  const banner: BannerHandle = mountBanner(bannerContainer, { getActiveCampaignId })
  const mainPane = document.createElement('div')
  mainPane.setAttribute('data-region', 'main')
  mainPane.style.flex = '1'
  mainPane.style.overflow = 'auto'

  let activePanel: PanelHandle | null = null
  function selectPanel(panel: RoutePanel): void {
    sidebar.setSelected(panel)
    localStorage.setItem('devtool.selectedPanel', leafKey(panel.method, panel.path))
    if (activePanel !== null) {
      activePanel.unmount()
      activePanel = null
    }
    mainPane.replaceChildren()
    const key = leafKey(panel.method, panel.path)
    const mountFn = PANEL_MOUNTS.get(key)
    if (mountFn === undefined) {
      const placeholder = document.createElement('div')
      placeholder.style.padding = '24px'
      placeholder.style.color = 'var(--fg-muted)'
      placeholder.textContent = `(panel not yet implemented — ${key})`
      mainPane.appendChild(placeholder)
      return
    }
    activePanel = mountFn(mainPane)
  }

  const sidebar: SidebarHandle = mountSidebar(flexRow, {
    onSelect: selectPanel,
    getActiveCampaignId,
  })
  flexRow.appendChild(mainPane)
  const drawer: DrawerHandle = mountDrawer(flexRow, { subscriptions, bus, buffer })

  // Restore last-selected sidebar leaf from localStorage.
  const persistedKey = localStorage.getItem('devtool.selectedPanel')
  if (persistedKey !== null) {
    const [pm, ...pPath] = persistedKey.split(' ')
    const persistedPath = pPath.join(' ')
    const persistedPanel = ROUTE_PANELS.find(
      (p) => p.method === pm && p.path === persistedPath,
    )
    if (persistedPanel !== undefined) {
      // Only restore if leaf is currently selectable (not dimmed by missing campaign).
      const needsCampaign = persistedPanel.requiresCampaign
      const hasActive = getActiveCampaignId() !== null
      if (!needsCampaign || hasActive) {
        selectPanel(persistedPanel)
      }
    }
  }

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
      if (activePanel !== null) activePanel.unmount()
      drawer.unmount()
      sidebar.unmount()
      banner.unmount()
      subscriptions.closeAll()
      bannerContainer.remove()
      flexRow.remove()
    },
  }
}
