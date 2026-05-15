// Invites + members panel.
//
// Exercises:
//   POST   /api/campaigns/:id/invites                — create
//   GET    /api/campaigns/:id/invites                — list
//   DELETE /api/campaigns/:id/invites/:inviteCode    — revoke
//   GET    /api/invites/:inviteCode/preview          — public preview
//   POST   /api/invites/:inviteCode/accept           — accept
//   GET    /api/campaigns/:id/members                — list members
//
// Two action surfaces share a campaignId input (paste a UUID): the
// invite manager (create/list/revoke + members) and the invite accept
// flow (paste a code, preview/accept). The accept flow doesn't take a
// campaignId; it reads the code directly. The preview route is public
// (no auth header required) but the dev tool sends the header anyway —
// the bypass plugin tolerates extra headers on public routes.
//
// Pattern: action-only — the panel renders forms + buttons on mount;
// fetches happen only on click.

import { apiCall } from '../api-client.js'
import { onIdentityChanged } from '../identity.js'

interface InviteRow {
  readonly inviteCode: string
  readonly inviteUrl: string
  readonly uses: number
  readonly expiresAt: string | null
  readonly createdAt: string
  readonly primary?: boolean
}

interface MemberRow {
  readonly id: string
  readonly userId: string
  readonly role: 'owner' | 'player'
  readonly inviteAccepted: boolean
  readonly joinedAt: string
}

function renderInvites(rows: readonly InviteRow[]): string {
  if (rows.length === 0) return '(no invites)'
  return rows
    .map(
      (r) =>
        `${r.inviteCode}  uses=${String(r.uses)}  primary=${String(r.primary ?? false)}  expires=${r.expiresAt ?? '(never)'}`,
    )
    .join('\n')
}

function renderMembers(rows: readonly MemberRow[]): string {
  if (rows.length === 0) return '(no members)'
  return rows
    .map((r) => `${r.role.padEnd(8)} ${r.userId}  accepted=${String(r.inviteAccepted)}`)
    .join('\n')
}

interface ManagerDom {
  readonly wrap: HTMLElement
  readonly campaignInput: HTMLInputElement
  readonly createBtn: HTMLButtonElement
  readonly listBtn: HTMLButtonElement
  readonly membersBtn: HTMLButtonElement
  readonly invitesResult: HTMLElement
  readonly membersResult: HTMLElement
}

function buildManager(): ManagerDom {
  const wrap = document.createElement('div')

  const heading = document.createElement('h3')
  heading.style.margin = '0 0 6px 0'
  heading.style.fontSize = '13px'
  heading.textContent = 'Manage invites (owner-only)'

  const campaignInput = document.createElement('input')
  campaignInput.type = 'text'
  campaignInput.placeholder = 'campaignId (paste a UUID)'
  campaignInput.style.width = '320px'

  const buttonRow = document.createElement('div')
  buttonRow.style.display = 'flex'
  buttonRow.style.gap = '8px'
  buttonRow.style.marginTop = '6px'
  buttonRow.style.marginBottom = '8px'

  const createBtn = document.createElement('button')
  createBtn.textContent = 'Create invite'
  const listBtn = document.createElement('button')
  listBtn.textContent = 'List invites'
  const membersBtn = document.createElement('button')
  membersBtn.textContent = 'List members'

  buttonRow.appendChild(createBtn)
  buttonRow.appendChild(listBtn)
  buttonRow.appendChild(membersBtn)

  const invitesResult = document.createElement('pre')
  invitesResult.className = 'result'
  invitesResult.textContent = '(no invites loaded)'

  const membersResult = document.createElement('pre')
  membersResult.className = 'result'
  membersResult.textContent = '(no members loaded)'

  wrap.appendChild(heading)
  wrap.appendChild(campaignInput)
  wrap.appendChild(buttonRow)
  wrap.appendChild(invitesResult)
  wrap.appendChild(membersResult)

  return { wrap, campaignInput, createBtn, listBtn, membersBtn, invitesResult, membersResult }
}

interface AcceptDom {
  readonly wrap: HTMLElement
  readonly codeInput: HTMLInputElement
  readonly previewBtn: HTMLButtonElement
  readonly acceptBtn: HTMLButtonElement
  readonly result: HTMLElement
}

function buildAccept(): AcceptDom {
  const wrap = document.createElement('div')
  wrap.style.marginTop = '16px'
  wrap.style.borderTop = '1px solid var(--border)'
  wrap.style.paddingTop = '12px'

  const heading = document.createElement('h3')
  heading.style.margin = '0 0 6px 0'
  heading.style.fontSize = '13px'
  heading.textContent = 'Preview / accept an invite'

  const codeInput = document.createElement('input')
  codeInput.type = 'text'
  codeInput.placeholder = 'inviteCode'
  codeInput.style.width = '240px'

  const buttonRow = document.createElement('div')
  buttonRow.style.display = 'flex'
  buttonRow.style.gap = '8px'
  buttonRow.style.marginTop = '6px'
  buttonRow.style.marginBottom = '8px'

  const previewBtn = document.createElement('button')
  previewBtn.textContent = 'Preview'
  const acceptBtn = document.createElement('button')
  acceptBtn.textContent = 'Accept'

  buttonRow.appendChild(previewBtn)
  buttonRow.appendChild(acceptBtn)

  const result = document.createElement('pre')
  result.className = 'result'
  result.textContent = '(no code submitted)'

  wrap.appendChild(heading)
  wrap.appendChild(codeInput)
  wrap.appendChild(buttonRow)
  wrap.appendChild(result)

  return { wrap, codeInput, previewBtn, acceptBtn, result }
}

function bindManager(dom: ManagerDom): void {
  let lastInviteCode: string | null = null

  async function createInvite(): Promise<void> {
    const id = dom.campaignInput.value.trim()
    if (id.length === 0) {
      dom.invitesResult.textContent = 'paste a campaignId first'
      return
    }
    dom.createBtn.disabled = true
    dom.invitesResult.textContent = 'creating...'
    const res = await apiCall<InviteRow>(`/api/campaigns/${id}/invites`, { method: 'POST' })
    if (res.status === 201 && res.body !== null) {
      lastInviteCode = res.body.inviteCode
      dom.invitesResult.textContent = `created: ${res.body.inviteCode}\nurl: ${res.body.inviteUrl}`
    } else {
      dom.invitesResult.textContent = `error ${String(res.status)}: ${JSON.stringify(res.body)}`
    }
    dom.createBtn.disabled = false
  }

  async function listInvites(): Promise<void> {
    const id = dom.campaignInput.value.trim()
    if (id.length === 0) {
      dom.invitesResult.textContent = 'paste a campaignId first'
      return
    }
    dom.listBtn.disabled = true
    dom.invitesResult.textContent = 'loading...'
    const res = await apiCall<{ invites: readonly InviteRow[] }>(`/api/campaigns/${id}/invites`)
    if (res.status === 200 && res.body !== null) {
      dom.invitesResult.textContent = renderInvites(res.body.invites)
    } else {
      dom.invitesResult.textContent = `error ${String(res.status)}: ${JSON.stringify(res.body)}`
    }
    dom.listBtn.disabled = false
  }

  async function listMembers(): Promise<void> {
    const id = dom.campaignInput.value.trim()
    if (id.length === 0) {
      dom.membersResult.textContent = 'paste a campaignId first'
      return
    }
    dom.membersBtn.disabled = true
    dom.membersResult.textContent = 'loading...'
    const res = await apiCall<{ members: readonly MemberRow[] }>(`/api/campaigns/${id}/members`)
    if (res.status === 200 && res.body !== null) {
      dom.membersResult.textContent = renderMembers(res.body.members)
    } else {
      dom.membersResult.textContent = `error ${String(res.status)}: ${JSON.stringify(res.body)}`
    }
    dom.membersBtn.disabled = false
  }

  // Reveal a synthetic Revoke button when the user runs Create — keeps the
  // DELETE route covered by an action surface without sprouting a full per-
  // row button list. The button operates on the last-created invite.
  const revokeBtn = document.createElement('button')
  revokeBtn.textContent = 'Revoke last-created'
  revokeBtn.style.marginLeft = '8px'
  revokeBtn.addEventListener('click', () => {
    void revokeInvite()
  })

  async function revokeInvite(): Promise<void> {
    const id = dom.campaignInput.value.trim()
    if (id.length === 0 || lastInviteCode === null) {
      dom.invitesResult.textContent = 'create an invite first'
      return
    }
    revokeBtn.disabled = true
    const res = await apiCall(`/api/campaigns/${id}/invites/${lastInviteCode}`, {
      method: 'DELETE',
    })
    if (res.status === 204) {
      dom.invitesResult.textContent = `revoked ${lastInviteCode}`
      lastInviteCode = null
    } else {
      dom.invitesResult.textContent = `error ${String(res.status)}: ${JSON.stringify(res.body)}`
    }
    revokeBtn.disabled = false
  }

  // Wedge the revoke button into the existing button row.
  dom.membersBtn.parentElement?.appendChild(revokeBtn)

  dom.createBtn.addEventListener('click', () => {
    void createInvite()
  })
  dom.listBtn.addEventListener('click', () => {
    void listInvites()
  })
  dom.membersBtn.addEventListener('click', () => {
    void listMembers()
  })
}

interface PreviewResp {
  readonly campaignName: string
  readonly ownerUsername: string
  readonly ownerDisplayName: string
  readonly valid: boolean
}

function bindAccept(dom: AcceptDom): void {
  async function preview(): Promise<void> {
    const code = dom.codeInput.value.trim()
    if (code.length === 0) {
      dom.result.textContent = 'paste an inviteCode first'
      return
    }
    dom.previewBtn.disabled = true
    dom.result.textContent = 'fetching preview...'
    const res = await apiCall<PreviewResp>(`/api/invites/${code}/preview`)
    if (res.status === 200 && res.body !== null) {
      const p = res.body
      dom.result.textContent = [
        `campaign:   ${p.campaignName}`,
        `owner:      ${p.ownerDisplayName} (@${p.ownerUsername})`,
        `valid:      ${String(p.valid)}`,
      ].join('\n')
    } else {
      dom.result.textContent = `error ${String(res.status)}: ${JSON.stringify(res.body)}`
    }
    dom.previewBtn.disabled = false
  }

  async function accept(): Promise<void> {
    const code = dom.codeInput.value.trim()
    if (code.length === 0) {
      dom.result.textContent = 'paste an inviteCode first'
      return
    }
    dom.acceptBtn.disabled = true
    dom.result.textContent = 'accepting...'
    const res = await apiCall<{ campaignId: string; alreadyMember: boolean }>(
      `/api/invites/${code}/accept`,
      { method: 'POST' },
    )
    if ((res.status === 200 || res.status === 201) && res.body !== null) {
      dom.result.textContent =
        `${String(res.status)} accepted\n` +
        `campaignId:    ${res.body.campaignId}\n` +
        `alreadyMember: ${String(res.body.alreadyMember)}`
    } else {
      dom.result.textContent = `error ${String(res.status)}: ${JSON.stringify(res.body)}`
    }
    dom.acceptBtn.disabled = false
  }

  dom.previewBtn.addEventListener('click', () => {
    void preview()
  })
  dom.acceptBtn.addEventListener('click', () => {
    void accept()
  })
}

export function mountInvitesPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'
  // Action-only — the form is the steady state.
  card.setAttribute('data-state', 'ready')

  const title = document.createElement('h2')
  title.textContent = 'Invites + members'

  const manager = buildManager()
  const accept = buildAccept()
  bindManager(manager)
  bindAccept(accept)

  card.appendChild(title)
  card.appendChild(manager.wrap)
  card.appendChild(accept.wrap)
  parent.appendChild(card)

  // Identity switch resets the panel (campaignId may be owned by a
  // different sub; the invite codes are sub-scoped via accept).
  onIdentityChanged(() => {
    manager.campaignInput.value = ''
    manager.invitesResult.textContent = '(no invites loaded)'
    manager.membersResult.textContent = '(no members loaded)'
    accept.codeInput.value = ''
    accept.result.textContent = '(no code submitted)'
  })
}
