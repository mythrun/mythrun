// backend/dev-tool/src/components/invites-list-panel.ts
//
// myth-6uu1 P6.D — GET /api/campaigns/:campaignId/invites.
// Action-only refresh panel: lists all invites on the active campaign
// (owner-only). Sibling of invites-panel (POST create) and
// invite-revoke-panel (DELETE).

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

interface InvitesResponse {
  readonly invites: readonly InviteRow[]
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function renderInvites(parent: HTMLElement, data: InvitesResponse): void {
  if (data.invites.length === 0) {
    const empty = document.createElement('div')
    empty.style.color = 'var(--fg-muted)'
    empty.style.fontSize = '12px'
    empty.textContent = '(no invites)'
    parent.appendChild(empty)
    return
  }
  const ul = document.createElement('ul')
  ul.style.fontFamily = 'var(--mono)'
  ul.style.fontSize = '12px'
  ul.style.paddingLeft = '20px'
  ul.style.margin = '0'
  for (const r of data.invites) {
    const li = document.createElement('li')
    li.style.marginBottom = '4px'
    const codeEl = document.createElement('strong')
    codeEl.textContent = r.inviteCode
    li.appendChild(codeEl)
    const meta = document.createElement('span')
    meta.style.color = 'var(--fg-muted)'
    meta.textContent =
      `  uses=${String(r.uses)}  primary=${String(r.primary ?? false)}  expires=${r.expiresAt ?? '(never)'}`
    li.appendChild(meta)
    ul.appendChild(li)
  }
  parent.appendChild(ul)
}

export function mountInvitesListPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/invites',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'All invites on the active campaign (owner-only).'
  actionEl.appendChild(note)

  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = 'Refresh'
  actionEl.appendChild(refreshBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet fetched)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function refresh(): Promise<void> {
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
    refreshBtn.disabled = true

    const res = await apiCall<InvitesResponse>(`/api/campaigns/${id}/invites`)

    refreshBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Invites fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `${String(res.status)} — ${String(res.body.invites.length)} invite(s)`
    feedbackEl.appendChild(summary)
    renderInvites(feedbackEl, res.body)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void refresh()
  }
  refreshBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      refreshBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId/invites', mountInvitesListPanel)
