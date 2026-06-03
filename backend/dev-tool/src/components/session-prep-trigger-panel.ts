// backend/dev-tool/src/components/session-prep-trigger-panel.ts
//
// MYT-63 — POST /api/campaigns/:campaignId/session-prep. Action: enqueue the
// session-prep job for a session number (default 1). 202 = accepted.
import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import { buildSplitView, type PanelHandle } from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountSessionPrepTriggerPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/session-prep',
  })

  const label = document.createElement('label')
  label.style.fontSize = '12px'
  label.style.color = 'var(--fg-muted)'
  label.textContent = 'session number'
  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.value = '1'
  input.style.marginLeft = '6px'
  input.style.width = '64px'
  label.appendChild(input)
  actionEl.appendChild(label)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Enqueue prep'
  submitBtn.style.marginLeft = '8px'
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
    const sessionNumber = Number(input.value) || 1
    const res = await apiCall(`/api/campaigns/${id}/session-prep`, {
      method: 'POST',
      body: JSON.stringify({ sessionNumber }),
    })
    submitBtn.disabled = false
    if (res.status !== 202) {
      setState('error')
      renderErrorBlock(feedbackEl, { status: res.status, code: readCode(res.body), message: 'Trigger failed', raw: res.body })
      return
    }
    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} accepted`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => { void submit() }
  submitBtn.addEventListener('click', onClick)
  return {
    root,
    unmount: () => {
      submitBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('POST', '/api/campaigns/:campaignId/session-prep', mountSessionPrepTriggerPanel)
