// backend/dev-tool/src/components/members-panel.ts
//
// myth-fn51 P6.C — GET /api/campaigns/:campaignId/members.
// Lists members of the active campaign (userId, displayName, role).
// Read-only sibling of the invites panel, but scoped to membership
// rather than invite lifecycle.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface MemberRow {
  readonly userId: string
  readonly role: string
  readonly username: string
  readonly displayName: string
  readonly characterId: string | null
  readonly joinedAt: string
}

interface MembersResponse {
  readonly members: readonly MemberRow[]
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function renderMembers(parent: HTMLElement, data: MembersResponse): void {
  if (data.members.length === 0) {
    const empty = document.createElement('div')
    empty.style.color = 'var(--fg-muted)'
    empty.style.fontSize = '12px'
    empty.textContent = '(no members)'
    parent.appendChild(empty)
    return
  }
  const ul = document.createElement('ul')
  ul.style.fontFamily = 'var(--mono)'
  ul.style.fontSize = '12px'
  ul.style.paddingLeft = '20px'
  ul.style.margin = '0'
  for (const m of data.members) {
    const li = document.createElement('li')
    li.style.marginBottom = '4px'
    const nameEl = document.createElement('strong')
    // textContent — displayName is user-provided.
    nameEl.textContent = m.displayName
    li.appendChild(nameEl)
    const meta = document.createElement('span')
    meta.style.color = 'var(--fg-muted)'
    meta.textContent = `  role=${m.role}  userId=${m.userId}`
    li.appendChild(meta)
    ul.appendChild(li)
  }
  parent.appendChild(ul)
}

export function mountMembersPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/members',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Members of the active campaign (id, displayName, role).'
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

    const res = await apiCall<MembersResponse>(`/api/campaigns/${id}/members`)

    refreshBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Members fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `${String(res.status)} — ${String(res.body.members.length)} member(s)`
    feedbackEl.appendChild(summary)
    renderMembers(feedbackEl, res.body)
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

registerPanelMount(
  'GET',
  '/api/campaigns/:campaignId/members',
  mountMembersPanel,
)
