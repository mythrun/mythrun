// backend/dev-tool/src/components/campaign-delete-panel.ts
//
// myth-ukpc P6.A — DELETE /api/campaigns/:campaignId.
// Confirmation-required action: operator must type `delete <name>`
// where <name> is the active campaign's id (we don't fetch the
// campaign here; using the id as the confirm token keeps the panel
// dependency-free). Feedback: 204 or renderErrorBlock.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId, setActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountCampaignDeletePanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'DELETE /api/campaigns/:campaignId',
  })

  const id = getActiveCampaignId()

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    id === null
      ? '(no active campaign — pick one from My campaigns)'
      : `Type "delete ${id}" to confirm. Permanent — no undo.`
  actionEl.appendChild(note)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = `delete <campaign-id>`
  input.style.width = '100%'
  input.style.marginBottom = '8px'
  input.disabled = id === null
  actionEl.appendChild(input)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Delete'
  submitBtn.disabled = id === null
  actionEl.appendChild(submitBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet submitted)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
    const currentId = getActiveCampaignId()
    if (currentId === null) return
    const expected = `delete ${currentId}`
    if (input.value.trim() !== expected) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--danger)'
      m.textContent = `confirmation mismatch — must type exactly: ${expected}`
      feedbackEl.appendChild(m)
      return
    }

    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall(`/api/campaigns/${currentId}`, { method: 'DELETE' })

    submitBtn.disabled = false

    if (res.status !== 204 && res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Delete failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    // Clear the deleted campaign as the active one so dependent panels
    // can fall back to their empty-state hint.
    setActiveCampaignId(null)
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} deleted`
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

registerPanelMount('DELETE', '/api/campaigns/:campaignId', mountCampaignDeletePanel)
