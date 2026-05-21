// backend/dev-tool/src/components/submit-character-concept-panel.ts
//
// myth-fn51 P6.C — POST /api/campaigns/:campaignId/characters.
// Long-running. Operator submits a free-form concept + situation-grounding
// text; backend enqueues the character-resolution pipeline. Same drawer-
// based progress story as start-character-creation — we do NOT open an
// EventSource from this panel.

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

export function mountSubmitCharacterConceptPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/characters',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Submit or re-submit your character concept for the active campaign.'
  actionEl.appendChild(note)

  const conceptLabel = document.createElement('label')
  conceptLabel.style.display = 'block'
  conceptLabel.style.fontFamily = 'var(--mono)'
  conceptLabel.style.fontSize = '12px'
  conceptLabel.style.color = 'var(--fg-muted)'
  conceptLabel.textContent = 'conceptText (20–4000 chars, optional on resubmit)'
  actionEl.appendChild(conceptLabel)

  const conceptInput = document.createElement('textarea')
  conceptInput.rows = 4
  conceptInput.style.width = '100%'
  conceptInput.style.fontFamily = 'var(--mono)'
  conceptInput.style.fontSize = '12px'
  conceptInput.style.marginBottom = '6px'
  actionEl.appendChild(conceptInput)

  const groundingLabel = document.createElement('label')
  groundingLabel.style.display = 'block'
  groundingLabel.style.fontFamily = 'var(--mono)'
  groundingLabel.style.fontSize = '12px'
  groundingLabel.style.color = 'var(--fg-muted)'
  groundingLabel.textContent = 'situationGroundingText (20–2000 chars)'
  actionEl.appendChild(groundingLabel)

  const groundingInput = document.createElement('textarea')
  groundingInput.rows = 3
  groundingInput.style.width = '100%'
  groundingInput.style.fontFamily = 'var(--mono)'
  groundingInput.style.fontSize = '12px'
  groundingInput.style.marginBottom = '6px'
  actionEl.appendChild(groundingInput)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Submit character'
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
    const conceptText = conceptInput.value
    const situationGroundingText = groundingInput.value
    // Body shape matches the old character-creation panel: groundingText
    // always sent; conceptText only when non-empty (resubmit-without-concept
    // is a supported backend flow).
    const body: Record<string, unknown> = { situationGroundingText }
    if (conceptText.length > 0) body.conceptText = conceptText

    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall(`/api/campaigns/${id}/characters`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    submitBtn.disabled = false

    if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Submit character concept failed',
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
  '/api/campaigns/:campaignId/characters',
  mountSubmitCharacterConceptPanel,
)
