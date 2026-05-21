// backend/dev-tool/src/components/invite-preview-panel.ts
//
// myth-6uu1 P6.D — GET /api/invites/:inviteCode/preview.
// Action-only panel: invite-code input + preview button → invite
// preview JSON. Identity-less endpoint — does NOT require an active
// campaign; the invite code is the address. The bypass plugin tolerates
// the x-mythrun-dev-sub header even on public routes.

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface PreviewResponse {
  readonly campaignName: string
  readonly ownerUsername: string
  readonly ownerDisplayName: string
  readonly valid: boolean
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function renderPreview(parent: HTMLElement, data: PreviewResponse): void {
  const dl = document.createElement('dl')
  dl.style.fontFamily = 'var(--mono)'
  dl.style.fontSize = '12px'
  dl.style.margin = '0'
  dl.style.display = 'grid'
  dl.style.gridTemplateColumns = 'max-content 1fr'
  dl.style.columnGap = '12px'
  dl.style.rowGap = '2px'

  const rows: readonly (readonly [string, string])[] = [
    ['campaign', data.campaignName],
    ['owner', `${data.ownerDisplayName} (@${data.ownerUsername})`],
    ['valid', String(data.valid)],
  ]
  for (const [k, v] of rows) {
    const dt = document.createElement('dt')
    dt.style.color = 'var(--fg-muted)'
    dt.textContent = k
    const dd = document.createElement('dd')
    dd.style.margin = '0'
    dd.textContent = v
    dl.appendChild(dt)
    dl.appendChild(dd)
  }
  parent.appendChild(dl)
}

export function mountInvitePreviewPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/invites/:inviteCode/preview',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Public preview of an invite (no campaign membership required).'
  actionEl.appendChild(note)

  const codeInput = document.createElement('input')
  codeInput.type = 'text'
  codeInput.placeholder = 'inviteCode'
  codeInput.style.width = '100%'
  codeInput.style.marginBottom = '8px'
  actionEl.appendChild(codeInput)

  const previewBtn = document.createElement('button')
  previewBtn.textContent = 'Preview'
  actionEl.appendChild(previewBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet fetched)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function preview(): Promise<void> {
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
    previewBtn.disabled = true

    const res = await apiCall<PreviewResponse>(`/api/invites/${code}/preview`)

    previewBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Invite preview failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `200 — ${res.body.campaignName}`
    feedbackEl.appendChild(summary)
    renderPreview(feedbackEl, res.body)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void preview()
  }
  previewBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      previewBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/invites/:inviteCode/preview', mountInvitePreviewPanel)
