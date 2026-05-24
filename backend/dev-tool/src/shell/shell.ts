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
import { mountHeaderChrome } from './header-chrome.js'
import { getActiveCampaignId, onActiveCampaignChanged } from './active-campaign.js'
import { apiCall } from '../api-client.js'
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

  // myth-3lpf + myth-39ud: header chrome — global health pip + active
  // campaign dropdown sit above the banner. They live outside the
  // banner because the banner re-renders on every SSE event and we
  // don't want the dropdown's open state to thrash with it.
  const chrome = mountHeaderChrome(main as HTMLElement)

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

  // myth-0nmz: banner state cached so SSE-driven stage updates can
  // re-render with the last-known campaign name instead of '(unknown)'.
  let currentBannerName: string | null = null

  function deriveStageLabel(event: DrawerEvent): string | null {
    const data = event.data
    if (event.type === 'phase' && typeof data['phase'] === 'string') return data['phase']
    if (event.type === 'stage-started' && typeof data['stage'] === 'string') {
      return `${data['stage']} (running)`
    }
    if (event.type === 'stage-completed' && typeof data['stage'] === 'string') {
      return `${data['stage']} (complete)`
    }
    if (event.type === 'stage-failed' && typeof data['stage'] === 'string') {
      return `${data['stage']} (failed)`
    }
    return null
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
  if (initialActive !== null) {
    subscriptions.subscribe(initialActive)
    void refreshBannerName(initialActive)
  }

  // myth-a1ib: panels can dispatch a typed mythrun.navigate event to
  // ask the shell to switch the active sidebar leaf. Used by the
  // roster panel's View button (and prospectively any future
  // 'drill in' affordance).
  const onNavigate = (e: Event): void => {
    const ce = e as CustomEvent<{ method: string; path: string }>
    const target = ROUTE_PANELS.find(
      (p) => p.method === ce.detail.method && p.path === ce.detail.path,
    )
    if (target !== undefined) selectPanel(target)
  }
  window.addEventListener('mythrun.navigate', onNavigate)

  // myth-0nmz: wire active-campaign changes to drawer SSE + banner.
  // Before this fix, setActiveCampaignId from create/details panels
  // never told the drawer to open a stream, so wire log + banner +
  // stage panel all stayed silent during world-gen.
  const offActiveCampaign = onActiveCampaignChanged((newId) => {
    subscriptions.closeAll()
    if (newId !== null) {
      subscriptions.subscribe(newId)
      void refreshBannerName(newId)
    } else {
      banner.setCampaign(null)
    }
    sidebar.refresh()
  })

  // Forward SSE events into the banner's stage label so users see live
  // progress without manually refreshing any panel.
  const offBus = bus.subscribe((event) => {
    const active = getActiveCampaignId()
    if (active === null || event.campaignId !== active) return
    const stage = deriveStageLabel(event)
    if (stage === null) return
    const current = currentBannerName
    banner.setCampaign({ id: active, name: current ?? '(loading)', stage })
  })

  async function refreshBannerName(campaignId: string): Promise<void> {
    const res = await apiCall<{ campaign?: { name?: string } }>(
      `/api/campaigns/${campaignId}`,
    )
    if (res.status === 200 && res.body?.campaign?.name !== undefined) {
      currentBannerName = res.body.campaign.name
      banner.setCampaign({ id: campaignId, name: currentBannerName, stage: '(starting…)' })
    } else {
      currentBannerName = null
      banner.setCampaign({ id: campaignId, name: '(unknown)', stage: '(starting…)' })
    }
  }

  return {
    unmount: () => {
      chrome.unmount()
      window.removeEventListener('mythrun.navigate', onNavigate)
      offBus()
      offActiveCampaign()
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
