// backend/dev-tool/src/components/invite-revoke-panel.ts
//
// myth-6uu1 P6.D — DELETE /api/campaigns/:campaignId/invites/:inviteCode.
// Action-only panel: invite-code input + revoke button. The campaign
// scope comes from the active-campaign store; the operator pastes the
// invite code (owner-only revoke). 204 is the happy path.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
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

export function mountInviteRevokePanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'DELETE /api/campaigns/:campaignId/invites/:inviteCode',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Revoke an invite on the active campaign (owner-only).'
  actionEl.appendChild(note)

  const codeInput = document.createElement('input')
  codeInput.type = 'text'
  codeInput.placeholder = 'inviteCode'
  codeInput.style.width = '100%'
  codeInput.style.marginBottom = '8px'
  actionEl.appendChild(codeInput)

  const revokeBtn = document.createElement('button')
  revokeBtn.textContent = 'Revoke'
  actionEl.appendChild(revokeBtn)

  const empty = document.createElement('div')
  empty.style.color = 'var(--fg-muted)'
  empty.style.fontSize = '12px'
  empty.textContent = '(no active campaign — pick one from My campaigns)'
  feedbackEl.appendChild(empty)

  setState('ready')

  async function revoke(): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent =
        '(this endpoint requires an active campaign — pick one in GET /api/campaigns/mine)'
      feedbackEl.appendChild(m)
      return
    }
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
    revokeBtn.disabled = true

    const res = await apiCall(`/api/campaigns/${id}/invites/${code}`, {
      method: 'DELETE',
    })

    revokeBtn.disabled = false

    if (res.status !== 204) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Invite revoke failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `204 revoked — ${code}`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void revoke()
  }
  revokeBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      revokeBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount(
  'DELETE',
  '/api/campaigns/:campaignId/invites/:inviteCode',
  mountInviteRevokePanel,
)
