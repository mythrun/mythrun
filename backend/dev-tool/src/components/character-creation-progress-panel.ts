// backend/dev-tool/src/components/character-creation-progress-panel.ts
//
// MYT-54 T15 (P-CHAR-INT) — GET /api/campaigns/:campaignId/character-creation-progress.
// Member-visible action-only refresh panel: shows per-PC concept status
// for every member of the active campaign, plus members who haven't yet
// submitted a concept. Sibling of the other CHARACTERS-section panels.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface ConceptRow {
  readonly userId: string
  readonly displayName: string
  readonly status: string
  readonly submittedAt: string
  readonly error?: unknown
}

interface MissingRow {
  readonly userId: string
  readonly displayName: string
}

interface ProgressResponse {
  readonly campaignId: string
  readonly totalMembers: number
  readonly concepts: readonly ConceptRow[]
  readonly missing: readonly MissingRow[]
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function countByStatus(concepts: readonly ConceptRow[], status: string): number {
  return concepts.filter((c) => c.status === status).length
}

function renderConcepts(
  parent: HTMLElement,
  data: ProgressResponse,
): void {
  if (data.concepts.length === 0) {
    const empty = document.createElement('div')
    empty.style.color = 'var(--fg-muted)'
    empty.style.fontSize = '12px'
    empty.textContent = '(no concepts submitted yet)'
    parent.appendChild(empty)
  } else {
    const ul = document.createElement('ul')
    ul.style.fontFamily = 'var(--mono)'
    ul.style.fontSize = '12px'
    ul.style.paddingLeft = '20px'
    ul.style.margin = '0'
    for (const c of data.concepts) {
      const li = document.createElement('li')
      li.style.marginBottom = '4px'
      li.textContent = `${c.displayName} — ${c.status}`
      ul.appendChild(li)
    }
    parent.appendChild(ul)
  }

  if (data.missing.length > 0) {
    const heading = document.createElement('div')
    heading.style.color = 'var(--fg-muted)'
    heading.style.fontSize = '12px'
    heading.style.marginTop = '8px'
    heading.textContent = 'Missing:'
    parent.appendChild(heading)

    const ul = document.createElement('ul')
    ul.style.fontFamily = 'var(--mono)'
    ul.style.fontSize = '12px'
    ul.style.paddingLeft = '20px'
    ul.style.margin = '0'
    for (const m of data.missing) {
      const li = document.createElement('li')
      li.style.marginBottom = '4px'
      li.textContent = m.displayName
      ul.appendChild(li)
    }
    parent.appendChild(ul)
  }
}

export function mountCharacterCreationProgressPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/character-creation-progress',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Per-PC concept status for every campaign member.'
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

    const res = await apiCall<ProgressResponse>(
      `/api/campaigns/${id}/character-creation-progress`,
    )

    refreshBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Character-creation progress fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const completed = countByStatus(res.body.concepts, 'completed')
    const processing = countByStatus(res.body.concepts, 'processing')
    const integrated = countByStatus(res.body.concepts, 'integrated')
    const failed = countByStatus(res.body.concepts, 'failed')
    const missing = res.body.missing.length

    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent =
      `${String(res.status)} — ${String(res.body.concepts.length)} concepts ` +
      `(${String(completed)} completed, ${String(processing)} processing, ` +
      `${String(integrated)} integrated, ${String(failed)} failed, ` +
      `${String(missing)} missing)`
    feedbackEl.appendChild(summary)
    renderConcepts(feedbackEl, res.body)
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
  '/api/campaigns/:campaignId/character-creation-progress',
  mountCharacterCreationProgressPanel,
)
