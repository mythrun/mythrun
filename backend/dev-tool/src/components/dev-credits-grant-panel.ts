// backend/dev-tool/src/components/dev-credits-grant-panel.ts
//
// myth-6hi9 P6.F — POST /api/dev/credits/grant.
// Action-only panel: credit_type select (world_gen | session) +
// amount number (1..100) + submit; feedback shows the 201 response
// (ledgerId + newBalance) or a renderErrorBlock on non-2xx.
//
// AUTH_MODE=bypass-gated. The route always grants to the canonical
// bypass:dev-1 identity, regardless of the dev-tool's identity-switcher
// selection — see credit-ledger spec D13.
//
// Listens on SCROLL_TO_GRANT_EVENT (dispatched by campaign-create-panel's
// 403 insufficient_credits branch) to scroll itself into view + focus
// the submit button. Inherited from the deleted credit-ledger-panel.

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'
import { SCROLL_TO_GRANT_EVENT } from './campaign-create-panel.js'

interface GrantResponse {
  readonly ledgerId: string
  readonly newBalance: number
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountDevCreditsGrantPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/dev/credits/grant',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Force-grant credits to bypass:dev-1 (AUTH_MODE=bypass only). Identity-switcher selection is ignored.'
  actionEl.appendChild(note)

  const typeSelect = document.createElement('select')
  typeSelect.style.marginRight = '6px'
  for (const t of ['world_gen', 'session']) {
    const opt = document.createElement('option')
    opt.value = t
    opt.textContent = t
    typeSelect.appendChild(opt)
  }
  actionEl.appendChild(typeSelect)

  const amountInput = document.createElement('input')
  amountInput.type = 'number'
  amountInput.min = '1'
  amountInput.max = '100'
  amountInput.value = '5'
  amountInput.style.width = '80px'
  amountInput.style.marginRight = '6px'
  actionEl.appendChild(amountInput)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Force grant'
  actionEl.appendChild(submitBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not submitted)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
    const creditType = typeSelect.value === 'session' ? 'session' : 'world_gen'
    const amount = Number.parseInt(amountInput.value, 10)
    if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'amount must be an integer 1..100'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall<GrantResponse>('/api/dev/credits/grant', {
      method: 'POST',
      body: JSON.stringify({ creditType, amount }),
    })

    submitBtn.disabled = false

    if (res.status !== 201 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Grant failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent =
      `201 — ledgerId=${res.body.ledgerId}, newBalance=${String(res.body.newBalance)}`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void submit()
  }
  submitBtn.addEventListener('click', onClick)

  const onScroll = (): void => {
    root.scrollIntoView({ behavior: 'smooth', block: 'center' })
    submitBtn.focus()
  }
  window.addEventListener(SCROLL_TO_GRANT_EVENT, onScroll)

  return {
    root,
    unmount: () => {
      submitBtn.removeEventListener('click', onClick)
      window.removeEventListener(SCROLL_TO_GRANT_EVENT, onScroll)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('POST', '/api/dev/credits/grant', mountDevCreditsGrantPanel)
