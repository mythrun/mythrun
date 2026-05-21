// backend/dev-tool/src/components/invites-panel.ts
//
// myth-6uu1 P6.D — POST /api/campaigns/:campaignId/invites.
// Action-only single-purpose panel: creates a new invite on the active
// campaign and shows the inviteCode + inviteUrl in the feedback pane.
// The list/revoke/preview/accept actions have moved to their own
// sibling panels (invites-list, invite-revoke, invite-preview,
// invite-accept) per the dev-tool reorg spec §3.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface InviteRow {
  readonly inviteCode: string
  readonly inviteUrl: string
  readonly uses: number
  readonly expiresAt: string | null
  readonly createdAt: string
  readonly primary?: boolean
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountInvitesPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/invites',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Creates a new invite on the active campaign (owner-only).'
  actionEl.appendChild(note)

  const createBtn = document.createElement('button')
  createBtn.textContent = 'Create invite'
  actionEl.appendChild(createBtn)

  const empty = document.createElement('div')
  empty.style.color = 'var(--fg-muted)'
  empty.style.fontSize = '12px'
  empty.textContent = '(no active campaign — pick one from My campaigns)'
  feedbackEl.appendChild(empty)

  setState('ready')

  async function createInvite(): Promise<void> {
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
    setState('loading')
    feedbackEl.replaceChildren()
    createBtn.disabled = true

    const res = await apiCall<InviteRow>(`/api/campaigns/${id}/invites`, {
      method: 'POST',
    })

    createBtn.disabled = false

    if (res.status !== 201 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Invite creation failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `201 created — ${res.body.inviteCode}`
    feedbackEl.appendChild(summary)

    const codeRow = document.createElement('div')
    codeRow.style.fontFamily = 'var(--mono)'
    codeRow.style.fontSize = '12px'
    codeRow.textContent = `code: ${res.body.inviteCode}`
    feedbackEl.appendChild(codeRow)

    const urlRow = document.createElement('div')
    urlRow.style.fontFamily = 'var(--mono)'
    urlRow.style.fontSize = '12px'
    urlRow.style.wordBreak = 'break-all'
    urlRow.textContent = `url:  ${res.body.inviteUrl}`
    feedbackEl.appendChild(urlRow)

    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void createInvite()
  }
  createBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      createBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('POST', '/api/campaigns/:campaignId/invites', mountInvitesPanel)
