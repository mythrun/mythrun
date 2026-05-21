// backend/dev-tool/src/components/session-ticket-panel.ts
//
// myth-hs6g P6.G — POST /api/sessions/:id/ws-ticket.
// Exercises the HTTP half of the WebSocket-ticket exchange. The dev
// tool doesn't speak WebSockets yet (the upgrade handler lands in the
// Session Runtime milestone), but the ticket-mint route needs an
// action surface so the route audit can confirm coverage.
//
// Pattern: action-only. Identity-sensitive — but the shell unmounts/
// remounts on identity switch, so the input clears naturally; no
// onIdentityChanged listener wired here.

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface TicketResponse {
  readonly ticket: string
  readonly expiresAt: string
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountSessionTicketPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/sessions/:id/ws-ticket',
  })

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'sessionId (paste a UUID)'
  input.style.width = '100%'
  input.style.marginBottom = '8px'
  actionEl.appendChild(input)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Mint ticket'
  actionEl.appendChild(submitBtn)

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginTop = '8px'
  note.textContent = 'HTTP half of the WS handshake; no socket is opened.'
  actionEl.appendChild(note)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(no ticket yet)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
    const id = input.value.trim()
    if (id.length === 0) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'paste a sessionId first'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall<TicketResponse>(`/api/sessions/${id}/ws-ticket`, {
      method: 'POST',
    })

    submitBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Mint ticket failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} — ticket=${res.body.ticket}`
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

registerPanelMount('POST', '/api/sessions/:id/ws-ticket', mountSessionTicketPanel)
