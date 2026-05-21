// backend/dev-tool/src/components/invite-accept-panel.ts
//
// myth-6uu1 P6.D — POST /api/invites/:inviteCode/accept.
// Action-only panel: invite-code input + accept button. Identity-less
// route — does NOT require an active campaign; the invite code carries
// the campaign association, and the accepting sub comes from the
// x-mythrun-dev-sub header (the active identity). 200 = already member;
// 201 = newly joined.

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface AcceptResponse {
  readonly campaignId: string
  readonly alreadyMember: boolean
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountInviteAcceptPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/invites/:inviteCode/accept',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Accept an invite as the active dev sub (joins the campaign).'
  actionEl.appendChild(note)

  const codeInput = document.createElement('input')
  codeInput.type = 'text'
  codeInput.placeholder = 'inviteCode'
  codeInput.style.width = '100%'
  codeInput.style.marginBottom = '8px'
  actionEl.appendChild(codeInput)

  const acceptBtn = document.createElement('button')
  acceptBtn.textContent = 'Accept'
  actionEl.appendChild(acceptBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet submitted)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function accept(): Promise<void> {
    const code = codeInput.value.trim()
    if (code.length === 0) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'paste an invite code first'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    acceptBtn.disabled = true

    const res = await apiCall<AcceptResponse>(`/api/invites/${code}/accept`, {
      method: 'POST',
    })

    acceptBtn.disabled = false

    if ((res.status !== 200 && res.status !== 201) || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Invite accept failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `${String(res.status)} accepted — alreadyMember=${String(res.body.alreadyMember)}`
    feedbackEl.appendChild(summary)

    const campaignRow = document.createElement('div')
    campaignRow.style.fontFamily = 'var(--mono)'
    campaignRow.style.fontSize = '12px'
    campaignRow.textContent = `campaignId: ${res.body.campaignId}`
    feedbackEl.appendChild(campaignRow)

    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void accept()
  }
  acceptBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      acceptBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('POST', '/api/invites/:inviteCode/accept', mountInviteAcceptPanel)
