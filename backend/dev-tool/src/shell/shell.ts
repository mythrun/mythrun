// backend/dev-tool/src/shell/shell.ts
//
// myth-0smu: workflow-per-page composition root. Mounts header + banner
// + sidebar + main pane + drawer. The sidebar drives the active workflow
// page, where each page composes the existing single-purpose panel mount
// fns into a single scrolling column.

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
import {
  WORKFLOWS,
  getWorkflowMount,
  type WorkflowDescriptor,
  type WorkflowId,
} from './workflow-registry.js'

// Per-panel mount registration kept for backward-compat with panel
// modules that still call registerPanelMount on import. The sidebar no
// longer drives per-panel selection; pages compose panels directly. The
// map is retained because removing the function would force a churn-y
// edit across every panel file, and the call site is cheap. May be
// pruned in a later pass once panel files migrate away from it.
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

const PERSISTED_WORKFLOW_KEY = 'devtool.selectedWorkflow'
const DEFAULT_WORKFLOW: WorkflowId = 'campaigns'

function readPersistedWorkflow(): WorkflowId | null {
  const v = localStorage.getItem(PERSISTED_WORKFLOW_KEY)
  if (v === null) return null
  const found = WORKFLOWS.find((w) => w.id === v)
  return found === undefined ? null : found.id
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
  const chrome = mountHeaderChrome(main)

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

  let activePage: PanelHandle | null = null

  function selectWorkflow(workflow: WorkflowDescriptor): void {
    sidebar.setSelected(workflow)
    localStorage.setItem(PERSISTED_WORKFLOW_KEY, workflow.id)
    if (activePage !== null) {
      activePage.unmount()
      activePage = null
    }
    mainPane.replaceChildren()
    const mountFn = getWorkflowMount(workflow.id)
    if (mountFn === undefined) {
      const placeholder = document.createElement('div')
      placeholder.style.padding = '24px'
      placeholder.style.color = 'var(--fg-muted)'
      placeholder.textContent = `(workflow page not yet mounted — ${workflow.id})`
      mainPane.appendChild(placeholder)
      return
    }
    activePage = mountFn(mainPane)
  }

  const sidebar: SidebarHandle = mountSidebar(flexRow, {
    onSelect: selectWorkflow,
    getActiveCampaignId,
  })
  flexRow.appendChild(mainPane)
  const drawer: DrawerHandle = mountDrawer(flexRow, { subscriptions, bus, buffer })

  // Restore last-selected workflow from localStorage, or fall back to
  // the default Campaigns page. Active-campaign-required pages fall
  // back to Campaigns when no campaign is set.
  function pickInitialWorkflow(): WorkflowDescriptor {
    const persistedId = readPersistedWorkflow()
    const candidate =
      persistedId === null
        ? WORKFLOWS.find((w) => w.id === DEFAULT_WORKFLOW)
        : WORKFLOWS.find((w) => w.id === persistedId)
    const target = candidate ?? WORKFLOWS[0]
    if (target === undefined) {
      throw new Error('mountShell: WORKFLOWS is empty')
    }
    if (target.requiresCampaign && getActiveCampaignId() === null) {
      const fallback = WORKFLOWS.find((w) => w.id === DEFAULT_WORKFLOW) ?? WORKFLOWS[0]
      if (fallback === undefined) {
        throw new Error('mountShell: WORKFLOWS is empty')
      }
      return fallback
    }
    return target
  }
  selectWorkflow(pickInitialWorkflow())

  // myth-0nmz: banner state cached so SSE-driven stage updates can
  // re-render with the last-known campaign name instead of '(unknown)'.
  let currentBannerName: string | null = null

  function deriveStageLabel(event: DrawerEvent): string | null {
    const data = event.data
    if (event.type === 'phase' && typeof data.phase === 'string') return data.phase
    if (event.type === 'stage-started' && typeof data.stage === 'string') {
      return `${data.stage} (running)`
    }
    if (event.type === 'stage-completed' && typeof data.stage === 'string') {
      return `${data.stage} (complete)`
    }
    if (event.type === 'stage-failed' && typeof data.stage === 'string') {
      return `${data.stage} (failed)`
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
  // ask the shell to switch to a specific endpoint × method panel.
  // myth-0smu: with the workflow reorg, the per-route mounting is no
  // longer the primary navigation model. The handler resolves the
  // request to the workflow that *composes* that endpoint and switches
  // to that page; the page itself shows the panel inline alongside
  // siblings. (Used by characters-roster-panel's View button.)
  const onLegacyNavigate = (e: Event): void => {
    const ce = e as CustomEvent<{ method: string; path: string }>
    const targetId = resolveWorkflowForRoute(ce.detail.method, ce.detail.path)
    if (targetId === null) return
    const target = WORKFLOWS.find((w) => w.id === targetId)
    if (target !== undefined) selectWorkflow(target)
  }
  window.addEventListener('mythrun.navigate', onLegacyNavigate)

  // myth-0smu: panels can dispatch mythrun.navigate-workflow with a
  // workflowId to switch the sidebar directly. Used by the post-create
  // "Watch progress →" link in campaign-create-panel.
  const onWorkflowNavigate = (e: Event): void => {
    const ce = e as CustomEvent<{ workflowId: string }>
    const target = WORKFLOWS.find((w) => w.id === ce.detail.workflowId)
    if (target === undefined) return
    if (target.requiresCampaign && getActiveCampaignId() === null) return
    selectWorkflow(target)
  }
  window.addEventListener('mythrun.navigate-workflow', onWorkflowNavigate)

  // myth-0nmz: wire active-campaign changes to drawer SSE + banner.
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
      window.removeEventListener('mythrun.navigate', onLegacyNavigate)
      window.removeEventListener('mythrun.navigate-workflow', onWorkflowNavigate)
      offBus()
      offActiveCampaign()
      dispose()
      if (activePage !== null) activePage.unmount()
      drawer.unmount()
      sidebar.unmount()
      banner.unmount()
      subscriptions.closeAll()
      bannerContainer.remove()
      flexRow.remove()
    },
  }
}

// Maps a legacy (method, path) navigate event onto the workflow page
// that composes that panel. Used by the back-compat mythrun.navigate
// handler so existing in-panel "drill in" buttons (the roster View
// button) keep working without changing their dispatch shape.
function resolveWorkflowForRoute(method: string, path: string): WorkflowId | null {
  const key = `${method} ${path}`
  // Built from the current page composition. Anything not listed falls
  // through to null; the new way to navigate is mythrun.navigate-workflow.
  const ROUTE_TO_WORKFLOW: Readonly<Record<string, WorkflowId>> = {
    'POST /api/campaigns': 'campaigns',
    'GET /api/campaigns/mine': 'campaigns',
    'GET /api/campaigns/:campaignId': 'campaigns',
    'PATCH /api/campaigns/:campaignId/name': 'campaigns',
    'POST /api/campaigns/:campaignId/resume': 'campaigns',
    'POST /api/campaigns/:campaignId/archive': 'campaigns',
    'DELETE /api/campaigns/:campaignId': 'campaigns',
    'GET /api/campaigns/:campaignId/status': 'world',
    'GET /api/campaigns/:campaignId/status/stream': 'world',
    'GET /api/campaigns/:campaignId/world-snapshot': 'world',
    'GET /api/campaigns/:campaignId/hierarchy': 'world',
    'GET /api/campaigns/:campaignId/random-tables': 'world',
    'POST /api/campaigns/:campaignId/characters': 'characters',
    'GET /api/campaigns/:campaignId/characters': 'characters',
    'GET /api/campaigns/:campaignId/characters/:charId': 'characters',
    'GET /api/campaigns/:campaignId/starting-situations': 'characters',
    'POST /api/campaigns/:campaignId/starting-situation': 'characters',
    'GET /api/campaigns/:campaignId/members': 'characters',
    'GET /api/campaigns/:campaignId/character-creation-progress': 'characters',
    'POST /api/campaigns/:campaignId/finalize-character-creation': 'characters',
    'GET /api/users/me': 'users',
    'POST /api/campaigns/:campaignId/invites': 'users',
    'GET /api/campaigns/:campaignId/invites': 'users',
    'DELETE /api/campaigns/:campaignId/invites/:inviteCode': 'users',
    'GET /api/invites/:inviteCode/preview': 'users',
    'POST /api/invites/:inviteCode/accept': 'users',
    'GET /api/billing/skus': 'billing',
    'GET /api/billing/subscription': 'billing',
    'GET /api/billing/balance': 'billing',
    'GET /api/billing/history': 'billing',
    'POST /api/billing/checkout': 'billing',
    'POST /api/billing/portal': 'billing',
    'POST /api/billing/upgrade-tier': 'billing',
    'POST /api/dev/credits/grant': 'billing',
    'GET /api/dev/credits/me': 'billing',
    'GET /health': 'system',
    'GET /health/ready': 'system',
    'POST /api/sessions/:id/ws-ticket': 'system',
  }
  return ROUTE_TO_WORKFLOW[key] ?? null
}
