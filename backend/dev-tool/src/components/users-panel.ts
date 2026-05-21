// backend/dev-tool/src/components/users-panel.ts
//
// myth-6uu1 P6.D — GET /api/users/me.
// Action-only panel: fetch button → user JSON.
// The current dev sub's user row (id, username, displayName,
// freeTrialUsed, stripeCustomerId) is what backs every authenticated
// route in the bypass auth mode. /api/users/check-username has been
// moved to EXEMPT_ROUTES in verify-registry (already EXEMPT in the
// sidebar route-registry — it's a probe-helper, not a sidebar leaf).
// POST /api/users/register is exercised by main.ts's identity-bootstrap
// step and is likewise EXEMPT.

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface UserRow {
  readonly id: string
  readonly cognitoSub: string
  readonly username: string
  readonly displayName: string
  readonly stripeCustomerId: string | null
  readonly freeTrialUsed: boolean
}

interface MeResponse {
  readonly user: UserRow
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function renderUser(parent: HTMLElement, row: UserRow): void {
  const dl = document.createElement('dl')
  dl.style.fontFamily = 'var(--mono)'
  dl.style.fontSize = '12px'
  dl.style.margin = '0'
  dl.style.display = 'grid'
  dl.style.gridTemplateColumns = 'max-content 1fr'
  dl.style.columnGap = '12px'
  dl.style.rowGap = '2px'

  const rows: ReadonlyArray<readonly [string, string]> = [
    ['id', row.id],
    ['cognitoSub', row.cognitoSub],
    ['username', row.username],
    ['displayName', row.displayName],
    ['stripeCustomerId', row.stripeCustomerId ?? '(none)'],
    ['freeTrialUsed', String(row.freeTrialUsed)],
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

export function mountUsersPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/users/me',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'The user row that backs the active dev sub.'
  actionEl.appendChild(note)

  const fetchBtn = document.createElement('button')
  fetchBtn.textContent = 'Fetch'
  actionEl.appendChild(fetchBtn)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet fetched)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function fetchMe(): Promise<void> {
    setState('loading')
    feedbackEl.replaceChildren()
    fetchBtn.disabled = true

    const res = await apiCall<MeResponse>('/api/users/me')

    fetchBtn.disabled = false

    if (res.status === 403) {
      // username_required — the active sub has no user row. Surface as
      // a readable "no row" state rather than an error block; the dev
      // tool's bootstrap (main.ts) usually registers the sub on first
      // load, so this fires only on a fresh DB or a swapped sub.
      setState('ready')
      const msg = document.createElement('div')
      msg.style.color = 'var(--fg-muted)'
      msg.style.fontSize = '12px'
      msg.textContent =
        '(no user row for the active sub — 403 username_required. Switch identity or wait for bootstrap.)'
      feedbackEl.appendChild(msg)
      appendJsonDisclosure(feedbackEl, res.body)
      return
    }

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Failed to fetch /api/users/me',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.style.marginBottom = '6px'
    summary.textContent = `200 — ${res.body.user.username}`
    feedbackEl.appendChild(summary)
    renderUser(feedbackEl, res.body.user)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void fetchMe()
  }
  fetchBtn.addEventListener('click', onClick)

  return {
    root,
    unmount: () => {
      fetchBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/users/me', mountUsersPanel)
