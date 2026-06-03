// backend/dev-tool/src/components/session-preps-list-panel.ts
//
// MYT-63 — GET /api/campaigns/:campaignId/session-preps. Lists SafeSessionPrep
// rows (no sd_playbook on this surface). Button-triggered.
import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import { buildSplitView, type PanelHandle } from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface SafePrep {
  id: string
  sessionNumber: number
  ftContext: string
  snapshotId: string | null
  createdAt: string
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountSessionPrepsListPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/session-preps',
  })
  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = 'List preps'
  actionEl.appendChild(refreshBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet loaded)'
  feedbackEl.appendChild(idle)
  setState('ready')

  async function refresh(): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = '(no active campaign — pick one from My campaigns)'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    const res = await apiCall<{ preps: SafePrep[] }>(`/api/campaigns/${id}/session-preps`)
    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, { status: res.status, code: readCode(res.body), message: 'List failed', raw: res.body })
      return
    }
    setState('ready')
    const preps = res.body?.preps ?? []
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(preps.length)} prep(s)`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => { void refresh() }
  refreshBtn.addEventListener('click', onClick)
  return {
    root,
    unmount: () => {
      refreshBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId/session-preps', mountSessionPrepsListPanel)
