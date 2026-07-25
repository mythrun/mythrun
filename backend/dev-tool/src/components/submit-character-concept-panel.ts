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
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

// The panel's three inputs share one visual shape: a muted mono label over a
// full-width mono textarea.
function appendLabeledTextarea(
  parent: HTMLElement,
  opts: { label: string; rows: number; placeholder?: string },
): HTMLTextAreaElement {
  const label = document.createElement('label')
  label.style.display = 'block'
  label.style.fontFamily = 'var(--mono)'
  label.style.fontSize = '12px'
  label.style.color = 'var(--fg-muted)'
  label.textContent = opts.label
  parent.appendChild(label)

  const input = document.createElement('textarea')
  input.rows = opts.rows
  input.style.width = '100%'
  input.style.fontFamily = 'var(--mono)'
  input.style.fontSize = '12px'
  input.style.marginBottom = '6px'
  if (opts.placeholder !== undefined) input.placeholder = opts.placeholder
  parent.appendChild(input)
  return input
}

// Panel-side rejection for an unparseable guidedChoices field (never sent —
// the backend would 400 bad_body anyway).
function renderBadGuidedJson(feedbackEl: HTMLElement, raw: string): void {
  feedbackEl.replaceChildren()
  renderErrorBlock(feedbackEl, {
    status: 0,
    code: 'bad_guided_choices_json',
    message: 'guidedChoices is not valid JSON — fix it or clear the field',
    raw,
  })
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

  const conceptInput = appendLabeledTextarea(actionEl, {
    label: 'conceptText (20–4000 chars, optional on resubmit)',
    rows: 4,
  })

  const groundingInput = appendLabeledTextarea(actionEl, {
    label: 'situationGroundingText (20–2000 chars)',
    rows: 3,
  })

  // myth-4jhrk: the guided-builder structured picks — optional JSON object
  // mirroring GuidedChoicesSchema ({class, subclass, species, background},
  // each optional). Sent only when non-empty; the placeholder shows a
  // working example body.
  const guidedInput = appendLabeledTextarea(actionEl, {
    label: 'guidedChoices (optional JSON — guided-builder picks)',
    rows: 2,
    placeholder:
      '{"class":"Cleric","subclass":"Life Domain","species":"Human","background":"Hermit"}',
  })

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
    // guidedChoices only when the operator typed one.
    const guidedRaw = guidedInput.value.trim()
    if (guidedRaw.length > 0) {
      try {
        body.guidedChoices = JSON.parse(guidedRaw)
      } catch {
        setState('error')
        renderBadGuidedJson(feedbackEl, guidedRaw)
        return
      }
    }

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
