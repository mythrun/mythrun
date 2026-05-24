// backend/dev-tool/src/components/finalize-character-creation-panel.ts
//
// MYT-54 T16 — POST /api/campaigns/:campaignId/finalize-character-creation.
// Owner-only action panel: textarea for optional pre_integration_notes +
// Submit button. Returns 202 with { campaignId, jobId } when the
// finalize/integration pipeline is enqueued. Sibling of the other
// CHARACTERS-section action panels.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface FinalizeResponse {
  readonly campaignId: string
  readonly jobId: string
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountFinalizeCharacterCreationPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/finalize-character-creation',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Owner-only. Closes the character-creation window and kicks off the integration pipeline.'
  actionEl.appendChild(note)

  const notesLabel = document.createElement('label')
  notesLabel.style.display = 'block'
  notesLabel.style.fontFamily = 'var(--mono)'
  notesLabel.style.fontSize = '12px'
  notesLabel.style.color = 'var(--fg-muted)'
  notesLabel.textContent = 'pre_integration_notes (optional, ≤4000 chars)'
  actionEl.appendChild(notesLabel)

  const notesInput = document.createElement('textarea')
  notesInput.rows = 4
  notesInput.maxLength = 4000
  notesInput.placeholder =
    'Optional: any cross-PC relationships the integrator should know about?'
  notesInput.style.width = '100%'
  notesInput.style.fontFamily = 'var(--mono)'
  notesInput.style.fontSize = '12px'
  notesInput.style.marginBottom = '6px'
  actionEl.appendChild(notesInput)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Submit'
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
      m.textContent =
        '(this endpoint requires an active campaign — pick one in GET /api/campaigns/mine)'
      feedbackEl.appendChild(m)
      return
    }
    const raw = notesInput.value
    const pre_integration_notes = raw.length > 0 ? raw : null

    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall<FinalizeResponse>(
      `/api/campaigns/${id}/finalize-character-creation`,
      {
        method: 'POST',
        body: JSON.stringify({ pre_integration_notes }),
      },
    )

    submitBtn.disabled = false

    if (res.status !== 202 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Finalize character creation failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `202 — jobId=${res.body.jobId}`
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

registerPanelMount(
  'POST',
  '/api/campaigns/:campaignId/finalize-character-creation',
  mountFinalizeCharacterCreationPanel,
)
