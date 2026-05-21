// backend/dev-tool/src/components/start-character-creation-panel.ts
//
// myth-fn51 P6.C — POST /api/campaigns/:campaignId/start-character-creation.
// Long-running, owner-only. Kicks off the character-creation pipeline; live
// progress is read from the wire-log drawer (we do NOT open an EventSource
// from this panel — same pattern as campaign-resume in P6.A).

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

export function mountStartCharacterCreationPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/start-character-creation',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Owner-only. Opens the character-creation window for the active campaign.'
  actionEl.appendChild(note)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Start character creation'
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

    const res = await apiCall(
      `/api/campaigns/${id}/start-character-creation`,
      { method: 'POST' },
    )

    submitBtn.disabled = false

    if (res.status !== 200 && res.status !== 202) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Start character creation failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} — kicked off. See the wire-log drawer for live events.`
    feedbackEl.appendChild(summary)
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

registerPanelMount(
  'POST',
  '/api/campaigns/:campaignId/start-character-creation',
  mountStartCharacterCreationPanel,
)
