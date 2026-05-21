// backend/dev-tool/src/components/upgrade-tier-panel.ts
//
// myth-6hi9 P6.F — POST /api/billing/upgrade-tier.
// Action-only panel: target_tier_lookup_key input + submit; feedback
// shows the 200 response or a renderErrorBlock on non-2xx. Stripe-bound
// — local dev may return 502 stripe_unavailable.

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

export function mountUpgradeTierPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/billing/upgrade-tier',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Monotonic subscription tier upgrade for the active dev user.'
  actionEl.appendChild(note)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'target_tier_lookup_key'
  input.style.width = '100%'
  input.style.marginBottom = '8px'
  actionEl.appendChild(input)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Submit upgrade'
  actionEl.appendChild(submitBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not submitted)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
    const targetTierLookupKey = input.value.trim()
    if (targetTierLookupKey.length === 0) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'target_tier_lookup_key is required'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall('/api/billing/upgrade-tier', {
      method: 'POST',
      body: JSON.stringify({ target_tier_lookup_key: targetTierLookupKey }),
    })

    submitBtn.disabled = false

    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Upgrade failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `200 — upgraded to ${targetTierLookupKey}`
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

registerPanelMount('POST', '/api/billing/upgrade-tier', mountUpgradeTierPanel)
