// backend/dev-tool/src/components/hierarchy-panel.ts
//
// myth-rdwq P6.B — GET /api/campaigns/:campaignId/hierarchy.
// Rehomed from the old character-creation panel's "Other views" section.
// Action: Refresh button. Feedback: hierarchy tree view + raw JSON disclosure.
//
// myth-94bu: domain-aware renderer — replaces the raw JSON dump with an
// indented tree of parent→child entity relationships. The endpoint
// returns flat (parentEntityId, childEntityId) pairs from the
// entity_hierarchy table, so the tree shown here is structural only
// (entity ids, not names — name resolution lives in the world-snapshot
// view). Raw JSON is preserved as a collapsible footer.

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

interface HierarchyRow {
  readonly id: string
  readonly parentEntityId: string
  readonly childEntityId: string
}

function parseHierarchy(body: unknown): readonly HierarchyRow[] {
  if (typeof body !== 'object' || body === null) return []
  if (!('hierarchy' in body)) return []
  const raw = body.hierarchy
  if (!Array.isArray(raw)) return []
  const out: HierarchyRow[] = []
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue
    const rec = r as Record<string, unknown>
    if (
      typeof rec.id === 'string' &&
      typeof rec.parentEntityId === 'string' &&
      typeof rec.childEntityId === 'string'
    ) {
      out.push({
        id: rec.id,
        parentEntityId: rec.parentEntityId,
        childEntityId: rec.childEntityId,
      })
    }
  }
  return out
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function renderHierarchyTree(
  parent: HTMLElement,
  rows: readonly HierarchyRow[],
): void {
  const section = document.createElement('section')
  section.style.marginTop = '8px'

  const heading = document.createElement('h2')
  heading.style.fontSize = '12px'
  heading.style.fontWeight = '600'
  heading.style.color = 'var(--fg-emphasis)'
  heading.style.margin = '0 0 6px 0'
  heading.textContent = `Hierarchy (${String(rows.length)} relations)`
  section.appendChild(heading)

  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.style.color = 'var(--fg-muted)'
    empty.style.fontSize = '12px'
    empty.textContent = '(no parent-child relations yet)'
    section.appendChild(empty)
    parent.appendChild(section)
    return
  }

  // Build parent→children map. Roots are parents that never appear as a
  // child in any row.
  const childrenOf = new Map<string, string[]>()
  const childIds = new Set<string>()
  const allIds = new Set<string>()
  for (const r of rows) {
    const arr = childrenOf.get(r.parentEntityId) ?? []
    arr.push(r.childEntityId)
    childrenOf.set(r.parentEntityId, arr)
    childIds.add(r.childEntityId)
    allIds.add(r.parentEntityId)
    allIds.add(r.childEntityId)
  }
  const roots: string[] = []
  for (const id of allIds) {
    if (!childIds.has(id)) roots.push(id)
  }
  roots.sort()

  const list = document.createElement('div')
  list.style.fontFamily = 'var(--mono)'
  list.style.fontSize = '12px'
  list.style.lineHeight = '1.5'

  const seen = new Set<string>()
  const renderNode = (entityId: string, depth: number): void => {
    if (seen.has(entityId)) return
    seen.add(entityId)
    const kids = childrenOf.get(entityId) ?? []
    const row = document.createElement('div')
    row.style.paddingLeft = `${String(depth * 16)}px`
    row.style.color = 'var(--fg-default)'
    const marker = kids.length > 0 ? '▾' : '—'
    const tail = kids.length > 0 ? ` (${String(kids.length)} children)` : ''
    row.textContent = `${marker} ${shortId(entityId)}${tail}`
    row.title = entityId
    list.appendChild(row)
    for (const child of kids) renderNode(child, depth + 1)
  }
  for (const r of roots) renderNode(r, 0)
  // Surface any orphans (entities not reachable from a root — defensive
  // against cycles or stale rows).
  for (const id of allIds) {
    if (!seen.has(id)) renderNode(id, 0)
  }

  section.appendChild(list)
  parent.appendChild(section)
}

export function mountHierarchyPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/hierarchy',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent = 'Persisted entity_hierarchy rows for the active campaign.'
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

    const res = await apiCall(`/api/campaigns/${id}/hierarchy`)

    refreshBtn.disabled = false

    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Hierarchy fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} hierarchy loaded`
    feedbackEl.appendChild(summary)
    renderHierarchyTree(feedbackEl, parseHierarchy(res.body))
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

registerPanelMount('GET', '/api/campaigns/:campaignId/hierarchy', mountHierarchyPanel)
