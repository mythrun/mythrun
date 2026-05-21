// myth-rdwq P6.B — world-snapshot-panel.
//
// Refactored from the original event-driven SSE-subscribing panel to the
// split-view action/feedback shape. The active campaign id is read from
// the shell's active-campaign store; the user clicks Refresh to fetch
// GET /api/campaigns/:campaignId/world-snapshot and the feedback pane
// renders the tree + detail + glossary using the pre-existing helpers
// from world-snapshot-render.ts.
//
// Live SSE delta application (phase/finalized/entity-updated/edge-*)
// migrated to the wire-log drawer per spec §6. The pure rendering +
// delta-application helpers in world-snapshot-render.ts are preserved
// for the drawer's future re-use; only the controller wiring changed.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'
import {
  renderDetail,
  renderGlossarySection,
  renderTree,
  renderWorldHeading,
} from './world-snapshot-render.js'
import {
  toMutableSnapshot,
  type LocalSnapshot,
  type WorldSnapshotResponse,
} from './world-snapshot-types.js'

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

interface FeedbackRefs {
  readonly worldHeading: HTMLElement
  readonly tree: HTMLElement
  readonly detail: HTMLElement
  readonly glossary: HTMLElement
}

function buildFeedbackRegions(parent: HTMLElement): FeedbackRefs {
  const worldHeading = document.createElement('div')
  worldHeading.style.fontFamily = 'var(--mono)'
  worldHeading.style.fontSize = '13px'
  worldHeading.style.marginTop = '4px'

  const splitRow = document.createElement('div')
  splitRow.style.display = 'flex'
  splitRow.style.gap = '12px'
  splitRow.style.marginTop = '12px'
  splitRow.style.alignItems = 'stretch'

  const tree = document.createElement('div')
  tree.style.flex = '0 0 240px'
  tree.style.fontFamily = 'var(--mono)'
  tree.style.fontSize = '12px'
  tree.style.maxHeight = '420px'
  tree.style.overflowY = 'auto'
  tree.style.border = '1px solid var(--border-soft)'
  tree.style.padding = '8px'
  tree.setAttribute('data-region', 'entity-tree')

  const detail = document.createElement('div')
  detail.style.flex = '1 1 auto'
  detail.style.fontFamily = 'var(--mono)'
  detail.style.fontSize = '12px'
  detail.style.maxHeight = '420px'
  detail.style.overflowY = 'auto'
  detail.style.border = '1px solid var(--border-soft)'
  detail.style.padding = '8px'
  detail.setAttribute('data-region', 'entity-detail')
  detail.textContent = '(select an entity)'

  splitRow.appendChild(tree)
  splitRow.appendChild(detail)

  const glossary = document.createElement('div')
  glossary.style.fontFamily = 'var(--mono)'
  glossary.style.fontSize = '12px'
  glossary.style.marginTop = '12px'
  glossary.style.border = '1px solid var(--border-soft)'
  glossary.style.padding = '8px'
  glossary.setAttribute('data-region', 'glossary')

  parent.appendChild(worldHeading)
  parent.appendChild(splitRow)
  parent.appendChild(glossary)

  return { worldHeading, tree, detail, glossary }
}

export function mountWorldSnapshotPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/world-snapshot',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Fetch the persisted world snapshot (entities, facts, relationships, glossary).'
  actionEl.appendChild(note)

  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = 'Refresh'
  actionEl.appendChild(refreshBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet fetched)'
  feedbackEl.appendChild(idle)

  setState('ready')

  let snapshot: LocalSnapshot | null = null
  let selectedEntityId: string | null = null
  let regions: FeedbackRefs | null = null

  function renderAll(): void {
    if (regions === null || snapshot === null) return
    renderWorldHeading(regions.worldHeading, snapshot)
    renderTree(regions.tree, snapshot, selectedEntityId, (eid) => {
      selectedEntityId = eid
      if (regions !== null && snapshot !== null) {
        renderTree(regions.tree, snapshot, selectedEntityId, (next) => {
          selectedEntityId = next
          renderAll()
        })
        renderDetail(regions.detail, snapshot, selectedEntityId)
      }
    })
    renderDetail(regions.detail, snapshot, selectedEntityId)
    renderGlossarySection(regions.glossary, snapshot.world.vocabularyRegistry)
  }

  async function refresh(): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent =
        '(this endpoint requires an active campaign — pick one in GET /api/campaigns/mine)'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    refreshBtn.disabled = true

    const res = await apiCall<WorldSnapshotResponse>(`/api/campaigns/${id}/world-snapshot`)

    refreshBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Snapshot fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    snapshot = toMutableSnapshot(res.body)
    selectedEntityId = null
    regions = buildFeedbackRegions(feedbackEl)
    renderAll()
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void refresh()
  }
  refreshBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      refreshBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId/world-snapshot', mountWorldSnapshotPanel)
