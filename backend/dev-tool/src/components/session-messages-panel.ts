// backend/dev-tool/src/components/session-messages-panel.ts
//
// MYT-65 — GET /api/sessions/:id/messages?afterSeq=N.
// Replays the persisted session transcript. The :id param is the
// sessionId (the contract normalizes the route's :sessionId to the
// canonical :id). Optional afterSeq returns only messages with seq > N
// (the reconnection-replay cursor); omitting it replays from the start.
// Response shape is { messages }.
//
// Pattern: action-only. Identity-sensitive (member-guarded via the
// session's parent campaign); the shell unmounts/remounts on identity
// switch so the inputs clear naturally — no onIdentityChanged listener
// wired (mirrors session-ticket-panel).

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface MessagesResponse {
  readonly messages: readonly unknown[]
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountSessionMessagesPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/sessions/:id/messages',
  })

  const idInput = document.createElement('input')
  idInput.type = 'text'
  idInput.placeholder = 'sessionId (paste a UUID)'
  idInput.style.width = '100%'
  idInput.style.marginBottom = '8px'
  actionEl.appendChild(idInput)

  const afterSeqInput = document.createElement('input')
  afterSeqInput.type = 'text'
  afterSeqInput.placeholder = 'afterSeq (optional, non-negative integer)'
  afterSeqInput.style.width = '100%'
  afterSeqInput.style.marginBottom = '8px'
  actionEl.appendChild(afterSeqInput)

  const fetchBtn = document.createElement('button')
  fetchBtn.textContent = 'Fetch transcript'
  actionEl.appendChild(fetchBtn)

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginTop = '8px'
  note.textContent = 'Replays persisted messages. afterSeq returns only seq > N (the reconnect cursor).'
  actionEl.appendChild(note)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet fetched)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function refresh(): Promise<void> {
    const id = idInput.value.trim()
    if (id.length === 0) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'paste a sessionId first'
      feedbackEl.appendChild(m)
      return
    }
    const afterSeq = afterSeqInput.value.trim()
    const query = afterSeq.length > 0 ? `?afterSeq=${encodeURIComponent(afterSeq)}` : ''

    setState('loading')
    feedbackEl.replaceChildren()
    fetchBtn.disabled = true

    const res = await apiCall<MessagesResponse>(`/api/sessions/${id}/messages${query}`)

    fetchBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Fetch transcript failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `${String(res.status)} — ${String(res.body.messages.length)} message(s)`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void refresh()
  }
  fetchBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      fetchBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/sessions/:id/messages', mountSessionMessagesPanel)
