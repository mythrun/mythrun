// backend/dev-tool/src/components/starting-situations-panel.ts
//
// myth-fn51 P6.C — GET /api/campaigns/:campaignId/starting-situations.
// Lists the three starting-situation candidates + which one the owner
// picked (chosenIndex). Pick action lives in a separate panel
// (situation-pick-panel) — this one is read-only.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface SituationEntry {
  readonly index: number
  readonly locationEntityId: string
  readonly prose: string
}

interface SituationsResponse {
  readonly situations: readonly SituationEntry[]
  readonly chosenIndex: number | null
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function renderSituations(parent: HTMLElement, data: SituationsResponse): void {
  if (data.situations.length === 0) {
    const empty = document.createElement('div')
    empty.style.color = 'var(--fg-muted)'
    empty.style.fontSize = '12px'
    empty.textContent = '(no situations available — world gen may still be running)'
    parent.appendChild(empty)
    return
  }
  const list = document.createElement('ol')
  list.style.fontFamily = 'var(--mono)'
  list.style.fontSize = '12px'
  list.style.paddingLeft = '20px'
  list.style.margin = '0'
  for (const s of data.situations) {
    const item = document.createElement('li')
    item.style.marginBottom = '8px'
    const head = document.createElement('div')
    head.style.color = data.chosenIndex === s.index ? 'var(--accent)' : 'var(--fg-muted)'
    head.textContent =
      data.chosenIndex === s.index
        ? `index ${String(s.index)}  PICKED  locationEntityId=${s.locationEntityId}`
        : `index ${String(s.index)}  locationEntityId=${s.locationEntityId}`
    item.appendChild(head)
    const proseEl = document.createElement('div')
    proseEl.style.whiteSpace = 'pre-wrap'
    proseEl.style.marginTop = '2px'
    // textContent — situation prose is LLM-authored.
    proseEl.textContent = s.prose
    item.appendChild(proseEl)
    list.appendChild(item)
  }
  parent.appendChild(list)
}

export function mountStartingSituationsPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/starting-situations',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'The three starting-situation candidates + which one is picked.'
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

    const res = await apiCall<SituationsResponse>(
      `/api/campaigns/${id}/starting-situations`,
    )

    refreshBtn.disabled = false

    // 404 world_not_ready is a known transient — render inline and stay
    // 'ready' so the operator can retry without the panel screaming error.
    if (res.status === 404) {
      setState('ready')
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent =
        '404 world_not_ready — starting_situation_entries empty (world gen may still be running)'
      feedbackEl.appendChild(m)
      appendJsonDisclosure(feedbackEl, res.body)
      return
    }

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Starting situations fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const picked =
      res.body.chosenIndex === null ? 'none picked' : `picked index ${String(res.body.chosenIndex)}`
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `${String(res.status)} — ${String(res.body.situations.length)} situation(s), ${picked}`
    feedbackEl.appendChild(summary)
    renderSituations(feedbackEl, res.body)
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

registerPanelMount(
  'GET',
  '/api/campaigns/:campaignId/starting-situations',
  mountStartingSituationsPanel,
)
