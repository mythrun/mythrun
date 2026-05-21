// backend/dev-tool/src/components/characters-roster-panel.ts
//
// myth-fn51 P6.C — GET /api/campaigns/:campaignId/characters.
// Roster of campaign members + their concept resolution status. Rows
// whose conceptStatus === 'completed' AND have a characterId get a
// "view" button that sets the active character id (persisted via
// localStorage) and refreshes the sidebar so the operator can jump
// to GET /characters/:charId.

import { apiCall } from '../api-client.js'
import {
  getActiveCampaignId,
  setActiveCharacterId,
} from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface RosterMember {
  readonly userId: string
  readonly displayName: string
  readonly conceptStatus: string
  readonly characterId?: string
}

interface RosterResponse {
  readonly members: readonly RosterMember[]
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function renderRoster(parent: HTMLElement, roster: RosterResponse): void {
  if (roster.members.length === 0) {
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
  for (const m of roster.members) {
    const li = document.createElement('li')
    li.style.marginBottom = '4px'
    const nameEl = document.createElement('strong')
    // textContent — displayName is user-provided.
    nameEl.textContent = m.displayName
    li.appendChild(nameEl)
    const statusEl = document.createElement('span')
    statusEl.style.color = 'var(--fg-muted)'
    statusEl.textContent = `  userId=${m.userId}  status=${m.conceptStatus}`
    li.appendChild(statusEl)
    if (m.conceptStatus === 'completed' && m.characterId !== undefined) {
      const sep = document.createTextNode('  ')
      li.appendChild(sep)
      const viewBtn = document.createElement('button')
      viewBtn.textContent = 'view'
      const charId = m.characterId
      viewBtn.addEventListener('click', () => {
        setActiveCharacterId(charId)
        // Trigger sidebar refresh so the operator sees the active-
        // character state reflected (and so any future sidebar
        // gating on activeCharacterId picks it up). The shell
        // listens via the identitychanged bridge; broadcasting that
        // event is the cleapest existing handle the panel has into
        // the shell from inside a panel.
        window.dispatchEvent(
          new CustomEvent<string>('mythrun.identitychanged', {
            detail: 'character-pick',
          }),
        )
      })
      li.appendChild(viewBtn)
    }
    ul.appendChild(li)
  }
  parent.appendChild(ul)
}

export function mountCharactersRosterPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/characters',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Roster + concept resolution status for the active campaign. Click "view" on a completed row to pick that character.'
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

    const res = await apiCall<RosterResponse>(`/api/campaigns/${id}/characters`)

    refreshBtn.disabled = false

    if (res.status !== 200 || res.body === null) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Roster fetch failed',
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
    renderRoster(feedbackEl, res.body)
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
  '/api/campaigns/:campaignId/characters',
  mountCharactersRosterPanel,
)
