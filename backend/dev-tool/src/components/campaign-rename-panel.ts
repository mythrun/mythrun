// backend/dev-tool/src/components/campaign-rename-panel.ts
//
// myth-ukpc P6.A — PATCH /api/campaigns/:campaignId/name.
// Action-only panel: input for new name + submit; feedback shows the
// 200 response or a renderErrorBlock on non-2xx. Reads the active
// campaign id from the shell's active-campaign store; if none, shows
// an empty-state hint.

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

export function mountCampaignRenamePanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'PATCH /api/campaigns/:campaignId/name',
  })

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'new campaign name'
  input.style.width = '100%'
  input.style.marginBottom = '8px'
  actionEl.appendChild(input)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Rename'
  actionEl.appendChild(submitBtn)

  const empty = document.createElement('div')
  empty.style.color = 'var(--fg-muted)'
  empty.style.fontSize = '12px'
  empty.textContent = '(no active campaign — pick one from My campaigns)'
  feedbackEl.appendChild(empty)

  setState('ready')

  async function submit(): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      empty.textContent = '(no active campaign — pick one from My campaigns)'
      return
    }
    const newName = input.value.trim()
    if (newName.length === 0) {
      empty.textContent = 'name is required'
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall(`/api/campaigns/${id}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    })

    submitBtn.disabled = false

    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Rename failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `200 renamed to: ${newName}`
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

registerPanelMount('PATCH', '/api/campaigns/:campaignId/name', mountCampaignRenamePanel)
