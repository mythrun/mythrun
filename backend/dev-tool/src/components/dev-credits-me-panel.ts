// backend/dev-tool/src/components/dev-credits-me-panel.ts
//
// myth-c1gr P6.E — GET /api/dev/credits/me.
// Action-only refresh panel: reads the active dev sub's current credit
// balances + last 20 ledger entries. Sibling of the credit-ledger
// (grant) panel, split out per spec §3 (one panel per route × action).

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface BalanceEntry {
  readonly credit_type: string
  readonly balance: number
}

interface DevCreditsMeResponse {
  readonly balances: readonly BalanceEntry[]
  readonly recent: readonly unknown[]
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountDevCreditsMePanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/dev/credits/me',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Current credit balances + last 20 ledger entries for the active dev sub.'
  actionEl.appendChild(note)

  const fetchBtn = document.createElement('button')
  fetchBtn.textContent = 'Fetch'
  actionEl.appendChild(fetchBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet fetched)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function refresh(): Promise<void> {
    setState('loading')
    feedbackEl.replaceChildren()
    fetchBtn.disabled = true

    const res = await apiCall<DevCreditsMeResponse>('/api/dev/credits/me')

    fetchBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Dev credits fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent =
      `${String(res.status)} — ${String(res.body.balances.length)} balance row(s), ${String(res.body.recent.length)} recent entry(ies)`
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

registerPanelMount('GET', '/api/dev/credits/me', mountDevCreditsMePanel)
