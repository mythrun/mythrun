// backend/dev-tool/src/components/balance-panel.ts
//
// myth-c1gr P6.E — GET /api/billing/balance.
// Action-only refresh panel: fetches the active dev sub's credit
// balances (world_gen + session) plus the active subscription summary.
// Per-identity, not per-campaign. Replaces one slice of the old
// billing-panel.

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface BalanceResponse {
  readonly world_gen: number
  readonly session: number
  readonly active_subscription: {
    readonly tier_lookup_key: string
    readonly status: string
  } | null
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountBalancePanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/billing/balance',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Credit balances + active subscription summary for the current identity.'
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

    const res = await apiCall<BalanceResponse>('/api/billing/balance')

    fetchBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Balance fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent =
      `${String(res.status)} — balance=${String(res.body.world_gen)} world_gen + ${String(res.body.session)} session`
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

registerPanelMount('GET', '/api/billing/balance', mountBalancePanel)
