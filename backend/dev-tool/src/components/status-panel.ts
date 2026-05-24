// backend/dev-tool/src/components/status-panel.ts
//
// myth-rdwq P6.B — GET /api/campaigns/:campaignId/status.
// Refactored to the panel-skeleton shape (action pane + feedback pane,
// PanelHandle return).
//
// Action: Refresh button.
// Feedback: pipeline_runs status snapshot (phase + stage table +
// cumulative cost). The live SSE feed migrated to the wire-log drawer
// per spec §6; this panel just renders the polled snapshot.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface StageEntry {
  readonly stage: string
  readonly status: string
  readonly userId: string | null
  readonly costUsd: number
}

interface StatusSnapshot {
  readonly phase: string
  readonly stages: readonly StageEntry[]
  readonly cumulativeCostUsd: number
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function isSnapshot(body: unknown): body is StatusSnapshot {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return (
    typeof b.phase === 'string' &&
    Array.isArray(b.stages) &&
    typeof b.cumulativeCostUsd === 'number'
  )
}

function renderSnapshot(parent: HTMLElement, snap: StatusSnapshot): void {
  const phase = document.createElement('div')
  phase.style.fontFamily = 'var(--mono)'
  phase.textContent = `phase: ${snap.phase}`
  parent.appendChild(phase)

  const stagesEl = document.createElement('pre')
  stagesEl.style.fontFamily = 'var(--mono)'
  stagesEl.style.fontSize = '12px'
  stagesEl.style.marginTop = '8px'
  stagesEl.textContent = snap.stages
    .map(
      (s) =>
        `${s.stage.padEnd(28)} ${s.status.padEnd(10)} ${s.userId ?? '-'} $${s.costUsd.toFixed(4)}`,
    )
    .join('\n')
  parent.appendChild(stagesEl)

  const cost = document.createElement('div')
  cost.style.marginTop = '8px'
  cost.textContent = `cumulative cost: $${snap.cumulativeCostUsd.toFixed(4)}`
  parent.appendChild(cost)
}

export function mountStatusPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/status',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Polled snapshot of pipeline_runs. The live SSE feed lives in the wire-log drawer.'
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

    const res = await apiCall(`/api/campaigns/${id}/status`)

    refreshBtn.disabled = false

    if (res.status !== 200 || !isSnapshot(res.body)) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Status fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    renderSnapshot(feedbackEl, res.body)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void refresh()
  }
  refreshBtn.addEventListener('click', onClick)

  // myth-0nmz: auto-refresh on a 3s interval while the panel is mounted.
  // The drawer's SSE bus exists but no plumbing pipes events into per-
  // panel callbacks today (a known gap the workflow-page reorg will fix);
  // polling at 3s gives the user a live-ish view during world-gen without
  // re-architecting per-panel subscription plumbing.
  void refresh()
  const timer = setInterval(() => {
    void refresh()
  }, 3000)

  return {
    root,
    unmount: () => {
      clearInterval(timer)
      refreshBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId/status', mountStatusPanel)
