// backend/dev-tool/src/components/session-recap-panel.ts
//
// myth-lhp99 — GET /api/sessions/:id/recap.
// Reads the player-facing close-out of a campaign's most-recent ENDED
// session. The :id param is the campaignId (the contract normalizes the
// route's :campaignId to the canonical :id under the /api/sessions/:id
// node). Response shape is { recap } where recap is:
//   - null                         → no ended session yet (none state)
//   - { sessionNumber, endedAt, status: 'pending' }
//       → the session ended but the async Opus post-session analysis
//         hasn't landed; the recap surface polls until it flips to ready.
//   - { sessionNumber, endedAt, status: 'ready', summary, emergingThreads }
//       → the SECRET-FREE recap prose is available.
//
// Pattern: action-only. Identity-sensitive (member-guarded via the
// campaign); the shell unmounts/remounts on identity switch so the input
// clears naturally — no onIdentityChanged listener wired (mirrors
// session-active-panel).

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface RecapResponse {
  // null when the campaign has no ended session, otherwise the recap.
  readonly recap: {
    readonly sessionNumber: number
    readonly endedAt: string | null
    readonly status: 'pending' | 'ready'
    readonly summary?: string
    readonly emergingThreads?: readonly string[]
  } | null
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function summarize(recap: RecapResponse['recap']): string {
  if (recap === null) return 'no ended session yet'
  const n = String(recap.sessionNumber)
  return recap.status === 'pending'
    ? `session ${n} ended — analysis pending`
    : `session ${n} ended — recap ready`
}

export function mountSessionRecapPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/sessions/:id/recap',
  })

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'campaignId (paste a UUID)'
  input.style.width = '100%'
  input.style.marginBottom = '8px'
  actionEl.appendChild(input)

  const fetchBtn = document.createElement('button')
  fetchBtn.textContent = 'Fetch recap'
  actionEl.appendChild(fetchBtn)

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginTop = '8px'
  note.textContent =
    'Most-recent ended session’s recap. null when none has ended; pending until the async analysis lands, then ready.'
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

    const res = await apiCall<RecapResponse>(`/api/sessions/${id}/recap`)

    fetchBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Fetch recap failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `${String(res.status)} — ${summarize(res.body.recap)}`
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

registerPanelMount('GET', '/api/sessions/:id/recap', mountSessionRecapPanel)
