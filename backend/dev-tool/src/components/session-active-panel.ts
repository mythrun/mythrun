// backend/dev-tool/src/components/session-active-panel.ts
//
// MYT-65 — GET /api/sessions/:id/active.
// Reads the active session row for a campaign, or null when none is live.
// The :id param is the campaignId (the contract normalizes the route's
// :campaignId to the canonical :id). Response shape is { session } where
// session is the active row or null.
//
// Pattern: action-only. Identity-sensitive (member-guarded); the shell
// unmounts/remounts on identity switch, so the input clears naturally —
// no onIdentityChanged listener wired (mirrors session-ticket-panel).

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface ActiveResponse {
  // null when no session is live, otherwise the active session row.
  readonly session: unknown
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountSessionActivePanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/sessions/:id/active',
  })

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'campaignId (paste a UUID)'
  input.style.width = '100%'
  input.style.marginBottom = '8px'
  actionEl.appendChild(input)

  const fetchBtn = document.createElement('button')
  fetchBtn.textContent = 'Fetch active session'
  actionEl.appendChild(fetchBtn)

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginTop = '8px'
  note.textContent = 'Returns the campaign’s active session row, or null when none is live.'
  actionEl.appendChild(note)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet fetched)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function refresh(): Promise<void> {
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
    fetchBtn.disabled = true

    const res = await apiCall<ActiveResponse>(`/api/sessions/${id}/active`)

    fetchBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Fetch active session failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent =
      res.body.session === null
        ? `${String(res.status)} — no active session`
        : `${String(res.status)} — active session present`
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

registerPanelMount('GET', '/api/sessions/:id/active', mountSessionActivePanel)
