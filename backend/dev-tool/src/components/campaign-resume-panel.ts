// backend/dev-tool/src/components/campaign-resume-panel.ts
//
// myth-ukpc P6.A — POST /api/campaigns/:campaignId/resume.
// Long-running endpoint. Per the task's "option (B)" guidance: we
// don't subscribe to the drawer bus from this panel; the operator
// reads live events from the wire-log drawer. We show the 202/409/422
// response shape and a progress strip placeholder that just indicates
// "kicked off".

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'
import { createProgressStrip } from './_shared/progress-strip.js'

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountCampaignResumePanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/resume',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Re-enqueue a stuck or failed world-gen pipeline for the active campaign.'
  actionEl.appendChild(note)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Resume'
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

    const res = await apiCall(`/api/campaigns/${id}/resume`, { method: 'POST' })

    submitBtn.disabled = false

    if (res.status !== 202) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Resume failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `202 — re-enqueued. See the wire-log drawer for live events.`
    feedbackEl.appendChild(summary)
    // Show a placeholder progress strip; bus-subscribed wiring lands later.
    createProgressStrip(feedbackEl, { total: 1 }).update({ current: 0, label: 'kicked off' })
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

registerPanelMount('POST', '/api/campaigns/:campaignId/resume', mountCampaignResumePanel)
