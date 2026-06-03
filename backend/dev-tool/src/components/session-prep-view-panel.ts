// backend/dev-tool/src/components/session-prep-view-panel.ts
//
// MYT-63 — GET /api/campaigns/:campaignId/session-preps/:prepId. Reads a single
// SafeSessionPrep by id (no sd_playbook on this surface).
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

export function mountSessionPrepViewPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/session-preps/:prepId',
  })

  const label = document.createElement('label')
  label.style.fontSize = '12px'
  label.style.color = 'var(--fg-muted)'
  label.textContent = 'prep id'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'prep uuid'
  input.style.marginLeft = '6px'
  input.style.width = '280px'
  label.appendChild(input)
  actionEl.appendChild(label)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Fetch prep'
  submitBtn.style.marginLeft = '8px'
  actionEl.appendChild(submitBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet loaded)'
  feedbackEl.appendChild(idle)
  setState('ready')

  async function fetchPrep(): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = '(no active campaign — pick one from My campaigns)'
      feedbackEl.appendChild(m)
      return
    }
    const prepId = input.value.trim()
    if (prepId === '') {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = '(enter a prep id — get one from the list panel)'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true
    const res = await apiCall(`/api/campaigns/${id}/session-preps/${prepId}`)
    submitBtn.disabled = false
    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, { status: res.status, code: readCode(res.body), message: 'Fetch failed', raw: res.body })
      return
    }
    setState('ready')
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => { void fetchPrep() }
  submitBtn.addEventListener('click', onClick)
  return {
    root,
    unmount: () => {
      submitBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId/session-preps/:prepId', mountSessionPrepViewPanel)
