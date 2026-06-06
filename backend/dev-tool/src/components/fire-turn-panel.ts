// backend/dev-tool/src/components/fire-turn-panel.ts
//
// MYT-66 — POST /api/dev/campaigns/:campaignId/fire-turn.
// The dev-only turn trigger: enqueues ONE session-turn job for the
// campaign's active session so the enqueue → worker → broadcast
// round-trip can be smoked without the (MYT-67) player-chat trigger
// path. Bypass-only — the route is absent under AUTH_MODE=real. On
// success the response is 202 { turnId }; the common non-2xx outcome is
// 409 (no_active_session — fire POST /api/sessions/:id/start first) and
// 400 (invalid_body — empty triggerText).
//
// Pattern: action-only. Two inputs (campaignId + trigger text) + a Fire
// button. Identity-sensitive only insofar as the active-session lookup
// is campaign-scoped; the shell unmounts/remounts on identity switch so
// the inputs clear naturally — no onIdentityChanged listener wired
// (mirrors session-start-panel).

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface FireTurnResponse {
  readonly turnId: string
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = body.code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountFireTurnPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/dev/campaigns/:campaignId/fire-turn',
  })

  const campaignInput = document.createElement('input')
  campaignInput.type = 'text'
  campaignInput.placeholder = 'campaignId (paste a UUID)'
  campaignInput.style.width = '100%'
  campaignInput.style.marginBottom = '8px'
  actionEl.appendChild(campaignInput)

  const triggerInput = document.createElement('input')
  triggerInput.type = 'text'
  triggerInput.placeholder = 'triggerText (what the player says)'
  triggerInput.style.width = '100%'
  triggerInput.style.marginBottom = '8px'
  actionEl.appendChild(triggerInput)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Fire turn'
  actionEl.appendChild(submitBtn)

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginTop = '8px'
  note.textContent =
    'Enqueues one session-turn job for the campaign’s active session (dev-only). Requires an active session — start one first (409 otherwise).'
  actionEl.appendChild(note)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(no turn fired yet)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
    const campaignId = campaignInput.value.trim()
    const triggerText = triggerInput.value.trim()
    if (campaignId.length === 0 || triggerText.length === 0) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'paste a campaignId and a triggerText first'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall<FireTurnResponse>(
      `/api/dev/campaigns/${campaignId}/fire-turn`,
      {
        method: 'POST',
        body: JSON.stringify({ triggerText }),
      },
    )

    submitBtn.disabled = false

    if (res.status !== 202 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Fire turn failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} — turnId=${res.body.turnId}`
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

registerPanelMount('POST', '/api/dev/campaigns/:campaignId/fire-turn', mountFireTurnPanel)
