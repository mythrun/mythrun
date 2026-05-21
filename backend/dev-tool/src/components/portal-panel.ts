// backend/dev-tool/src/components/portal-panel.ts
//
// myth-6hi9 P6.F — POST /api/billing/portal.
// Action-only panel: single button to open a Stripe Customer Portal
// session. Stripe-bound — local dev may return 502 stripe_unavailable.

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
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function readPortalUrl(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'portalUrl' in body) {
    const u = (body as { portalUrl: unknown }).portalUrl
    if (typeof u === 'string') return u
  }
  return null
}

export function mountPortalPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/billing/portal',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Open a Stripe Customer Portal session for the active dev user.'
  actionEl.appendChild(note)

  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Open portal'
  actionEl.appendChild(submitBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not submitted)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function submit(): Promise<void> {
    setState('loading')
    feedbackEl.replaceChildren()
    submitBtn.disabled = true

    const res = await apiCall('/api/billing/portal', {
      method: 'POST',
      body: JSON.stringify({ return_url: 'http://127.0.0.1:5273/billing/return' }),
    })

    submitBtn.disabled = false

    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Portal failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const url = readPortalUrl(res.body)
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `200 — portalUrl=${url ?? '(missing)'}`
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

registerPanelMount('POST', '/api/billing/portal', mountPortalPanel)
