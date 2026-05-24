// backend/dev-tool/src/components/random-tables-panel.ts
//
// myth-rdwq P6.B — GET /api/campaigns/:campaignId/random-tables.
// Rehomed from the old character-creation panel's "Other views" section.
// Action: Refresh button. Feedback: per-table roll-range tables + raw
// JSON disclosure.
//
// myth-94bu: domain-aware renderer — replaces the raw JSON dump with one
// small <table> per random table (roll-range | content). Raw JSON is
// preserved as a collapsible footer.

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

interface RandomTableEntry {
  readonly rollMin: number
  readonly rollMax: number
  readonly content: string
}

interface RandomTable {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly entries: readonly RandomTableEntry[]
}

function parseTables(body: unknown): readonly RandomTable[] {
  if (typeof body !== 'object' || body === null) return []
  if (!('tables' in body)) return []
  const raw = body.tables
  if (!Array.isArray(raw)) return []
  const out: RandomTable[] = []
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) continue
    const rec = t as Record<string, unknown>
    if (
      typeof rec.id !== 'string' ||
      typeof rec.name !== 'string' ||
      typeof rec.category !== 'string'
    ) {
      continue
    }
    const entriesRaw = Array.isArray(rec.entries) ? rec.entries : []
    const entries: RandomTableEntry[] = []
    for (const e of entriesRaw) {
      if (typeof e !== 'object' || e === null) continue
      const er = e as Record<string, unknown>
      if (
        typeof er.rollMin === 'number' &&
        typeof er.rollMax === 'number' &&
        typeof er.content === 'string'
      ) {
        entries.push({
          rollMin: er.rollMin,
          rollMax: er.rollMax,
          content: er.content,
        })
      }
    }
    out.push({ id: rec.id, name: rec.name, category: rec.category, entries })
  }
  return out
}

function renderRandomTables(
  parent: HTMLElement,
  tables: readonly RandomTable[],
): void {
  const section = document.createElement('section')
  section.style.marginTop = '8px'

  const heading = document.createElement('h2')
  heading.style.fontSize = '12px'
  heading.style.fontWeight = '600'
  heading.style.color = 'var(--fg-emphasis)'
  heading.style.margin = '0 0 6px 0'
  heading.textContent = `Random tables (${String(tables.length)})`
  section.appendChild(heading)

  if (tables.length === 0) {
    const empty = document.createElement('div')
    empty.style.color = 'var(--fg-muted)'
    empty.style.fontSize = '12px'
    empty.textContent = '(no random tables for this world)'
    section.appendChild(empty)
    parent.appendChild(section)
    return
  }

  for (const t of tables) {
    const tableHeading = document.createElement('h3')
    tableHeading.style.fontSize = '12px'
    tableHeading.style.fontWeight = '600'
    tableHeading.style.color = 'var(--fg-default)'
    tableHeading.style.margin = '10px 0 4px 0'
    tableHeading.textContent = `${t.name} `
    const cat = document.createElement('span')
    cat.style.color = 'var(--fg-muted)'
    cat.style.fontWeight = '400'
    cat.textContent = `[${t.category}]`
    tableHeading.appendChild(cat)
    section.appendChild(tableHeading)

    if (t.entries.length === 0) {
      const empty = document.createElement('div')
      empty.style.color = 'var(--fg-muted)'
      empty.style.fontSize = '12px'
      empty.textContent = '(no entries)'
      section.appendChild(empty)
      continue
    }

    const tableEl = document.createElement('table')
    tableEl.style.borderCollapse = 'collapse'
    tableEl.style.fontSize = '12px'
    tableEl.style.fontFamily = 'var(--mono)'
    tableEl.style.width = '100%'

    const thead = document.createElement('thead')
    const headerRow = document.createElement('tr')
    const thRoll = document.createElement('th')
    thRoll.textContent = 'Roll'
    thRoll.style.textAlign = 'left'
    thRoll.style.padding = '2px 8px 2px 0'
    thRoll.style.color = 'var(--fg-muted)'
    thRoll.style.fontWeight = '500'
    thRoll.style.borderBottom = '1px solid var(--border-soft)'
    const thEntry = document.createElement('th')
    thEntry.textContent = 'Entry'
    thEntry.style.textAlign = 'left'
    thEntry.style.padding = '2px 0'
    thEntry.style.color = 'var(--fg-muted)'
    thEntry.style.fontWeight = '500'
    thEntry.style.borderBottom = '1px solid var(--border-soft)'
    headerRow.appendChild(thRoll)
    headerRow.appendChild(thEntry)
    thead.appendChild(headerRow)
    tableEl.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const e of t.entries) {
      const tr = document.createElement('tr')
      const tdRoll = document.createElement('td')
      tdRoll.style.padding = '2px 8px 2px 0'
      tdRoll.style.color = 'var(--accent)'
      tdRoll.style.verticalAlign = 'top'
      tdRoll.style.whiteSpace = 'nowrap'
      tdRoll.textContent =
        e.rollMin === e.rollMax
          ? String(e.rollMin)
          : `${String(e.rollMin)}–${String(e.rollMax)}`
      const tdEntry = document.createElement('td')
      tdEntry.style.padding = '2px 0'
      tdEntry.style.color = 'var(--fg-default)'
      tdEntry.textContent = e.content
      tr.appendChild(tdRoll)
      tr.appendChild(tdEntry)
      tbody.appendChild(tr)
    }
    tableEl.appendChild(tbody)
    section.appendChild(tableEl)
  }
  parent.appendChild(section)
}

export function mountRandomTablesPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/random-tables',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'World-scoped random tables resolved for the active campaign.'
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

    const res = await apiCall(`/api/campaigns/${id}/random-tables`)

    refreshBtn.disabled = false

    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Random tables fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} tables loaded`
    feedbackEl.appendChild(summary)
    renderRandomTables(feedbackEl, parseTables(res.body))
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

registerPanelMount('GET', '/api/campaigns/:campaignId/random-tables', mountRandomTablesPanel)
