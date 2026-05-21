// backend/dev-tool/src/components/campaign-archive-panel.ts
//
// myth-ukpc P6.A — POST /api/campaigns/:campaignId/archive.
// Rehomed from the old character-creation panel's "Other views"
// section. Action: confirm + submit. Feedback: 200 or error block.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountCampaignArchivePanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/archive',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Archive removes the campaign from active rosters but preserves the row + world snapshot.'
  actionEl.appendChild(note)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Archive'
  actionEl.appendChild(submitBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet submitted)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
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
    submitBtn.disabled = true

    const res = await apiCall(`/api/campaigns/${id}/archive`, { method: 'POST' })

    submitBtn.disabled = false

    if (res.status !== 200 && res.status !== 204) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Archive failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} archived`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void submit()
  }
  submitBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      submitBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('POST', '/api/campaigns/:campaignId/archive', mountCampaignArchivePanel)
