// backend/dev-tool/src/components/checkout-panel.ts
//
// myth-6hi9 P6.F — POST /api/billing/checkout.
// Action-only panel: lookup_key input + submit; feedback shows the
// 200 response (Stripe Checkout Session URL) or a renderErrorBlock
// on non-2xx. Stripe-bound — local dev may return 502 stripe_unavailable.

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function readSessionUrl(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'sessionUrl' in body) {
    const u = (body).sessionUrl
    if (typeof u === 'string') return u
  }
  return null
}

export function mountCheckoutPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/billing/checkout',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Open a Stripe Checkout Session for a one-item cart (quantity 1).'
  actionEl.appendChild(note)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'lookup_key (e.g. sku_session)'
  input.style.width = '100%'
  input.style.marginBottom = '8px'
  actionEl.appendChild(input)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Submit checkout'
  actionEl.appendChild(submitBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not submitted)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
    const lookupKey = input.value.trim()
    if (lookupKey.length === 0) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'lookup_key is required'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ lookup_key: lookupKey, quantity: 1 }],
        success_url: 'http://127.0.0.1:5273/billing/success',
        cancel_url: 'http://127.0.0.1:5273/billing/cancel',
      }),
    })

    submitBtn.disabled = false

    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Checkout failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const url = readSessionUrl(res.body)
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `200 — sessionUrl=${url ?? '(missing)'}`
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

registerPanelMount('POST', '/api/billing/checkout', mountCheckoutPanel)
