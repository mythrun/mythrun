// backend/dev-tool/src/components/session-start-panel.ts
//
// MYT-65 — POST /api/sessions/:id/start.
// Creates a live multiplayer session for a campaign + debits one session
// credit from the campaign OWNER. The :id param is the campaignId (the
// contract normalizes the route's :campaignId to the canonical :id). On
// success the response is { sessionId }; the common non-2xx outcomes are
// 409 (campaign_not_active / prep_not_ready / session_already_active) and
// 402 (insufficient session credits).
//
// Pattern: action-only. Identity-sensitive — the OWNER pays, so the
// active dev sub must own (or be a member of) the campaign. The shell
// unmounts/remounts on identity switch, so the input clears naturally;
// no onIdentityChanged listener wired here (mirrors session-ticket-panel).

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface StartResponse {
  readonly sessionId: string
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountSessionStartPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/sessions/:id/start',
  })

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'campaignId (paste a UUID)'
  input.style.width = '100%'
  input.style.marginBottom = '8px'
  actionEl.appendChild(input)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Start session'
  actionEl.appendChild(submitBtn)

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginTop = '8px'
  note.textContent =
    'Creates an active session + debits a session credit from the campaign owner. Requires a prep for the next session number.'
  actionEl.appendChild(note)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(no session started yet)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
    const id = input.value.trim()
    if (id.length === 0) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'paste a campaignId first'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall<StartResponse>(`/api/sessions/${id}/start`, {
      method: 'POST',
    })

    submitBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Start session failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} — sessionId=${res.body.sessionId}`
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

registerPanelMount('POST', '/api/sessions/:id/start', mountSessionStartPanel)
