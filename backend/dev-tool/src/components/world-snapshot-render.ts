// myth-exac T23+T24+T25 — pure DOM-rendering helpers for the
// world-snapshot panel.
//
// Separated from the panel module so the controller (state machine +
// SSE wiring) stays focused. All functions here are deterministic
// pure-DOM authors: they read a LocalSnapshot + selection, mutate the
// passed-in containers, and never touch state.

import type {
  EntityHierarchyRow,
  EntityRow,
  EntityType,
  LocalSnapshot,
  VocabularyEntry,
  VocabularyEntrySource,
  VocabularyRegistry,
} from './world-snapshot-types.js'

const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  faction: 'Factions',
  location: 'Locations',
  npc: 'NPCs',
  item: 'Items',
}

const ENTITY_TYPE_ORDER: readonly EntityType[] = [
  'faction',
  'location',
  'npc',
  'item',
]

function groupByType(entities: readonly EntityRow[]): Map<EntityType, EntityRow[]> {
  const map = new Map<EntityType, EntityRow[]>()
  for (const t of ENTITY_TYPE_ORDER) map.set(t, [])
  for (const e of entities) {
    const bucket = map.get(e.entityType)
    if (bucket) bucket.push(e)
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name))
  }
  return map
}

// Build a parent→children map for locations from entity_hierarchy.
// Other entity types currently don't nest; the spec calls out locations.
function buildLocationChildren(
  entities: readonly EntityRow[],
  hierarchy: readonly EntityHierarchyRow[],
): { roots: EntityRow[]; childrenOf: Map<string, EntityRow[]> } {
  const locById = new Map<string, EntityRow>()
  for (const e of entities) {
    if (e.entityType === 'location') locById.set(e.id, e)
  }
  const childrenOf = new Map<string, EntityRow[]>()
  const childIds = new Set<string>()
  for (const h of hierarchy) {
    const parent = locById.get(h.parentEntityId)
    const child = locById.get(h.childEntityId)
    if (!parent || !child) continue
    const arr = childrenOf.get(parent.id) ?? []
    arr.push(child)
    childrenOf.set(parent.id, arr)
    childIds.add(child.id)
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name))
  }
  const roots = [...locById.values()]
    .filter((e) => !childIds.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { roots, childrenOf }
}

function buildTreeRow(
  e: EntityRow,
  depth: number,
  selected: boolean,
  onClick: () => void,
): HTMLElement {
  const row = document.createElement('div')
  row.style.padding = '2px 4px'
  row.style.paddingLeft = `${String(depth * 16)}px`
  row.style.cursor = 'pointer'
  if (selected) {
    row.style.background = 'var(--ok-bg)'
    row.style.borderLeft = '2px solid var(--ok-border)'
  }
  // textContent — LLM-authored name, never innerHTML.
  row.textContent = e.name
  row.dataset.entityId = e.id
  row.addEventListener('click', onClick)
  return row
}

export function renderTree(
  treeEl: HTMLElement,
  snap: LocalSnapshot,
  selectedId: string | null,
  onSelect: (id: string) => void,
): void {
  treeEl.replaceChildren()
  const grouped = groupByType(snap.entities)
  const locStruct = buildLocationChildren(snap.entities, snap.entityHierarchy)

  for (const t of ENTITY_TYPE_ORDER) {
    const bucket = grouped.get(t) ?? []
    const header = document.createElement('div')
    header.style.color = 'var(--fg-muted)'
    header.style.marginTop = '6px'
    header.textContent = `▼ ${ENTITY_TYPE_LABELS[t]} (${String(bucket.length)})`
    treeEl.appendChild(header)

    if (t === 'location') {
      // Render hierarchy: roots first, then recurse children with
      // indentation. Any location not reachable from a root (orphaned by
      // a partial hierarchy) is shown at root level so the user still
      // sees it.
      const seen = new Set<string>()
      const renderLoc = (e: EntityRow, depth: number): void => {
        if (seen.has(e.id)) return
        seen.add(e.id)
        treeEl.appendChild(
          buildTreeRow(e, depth, selectedId === e.id, () => {
            onSelect(e.id)
          }),
        )
        const kids = locStruct.childrenOf.get(e.id) ?? []
        for (const k of kids) renderLoc(k, depth + 1)
      }
      for (const root of locStruct.roots) renderLoc(root, 1)
      for (const e of bucket) {
        if (!seen.has(e.id)) renderLoc(e, 1)
      }
    } else {
      for (const e of bucket) {
        treeEl.appendChild(
          buildTreeRow(e, 1, selectedId === e.id, () => {
            onSelect(e.id)
          }),
        )
      }
    }
  }
}

function appendSectionHeader(parent: HTMLElement, text: string): void {
  const h = document.createElement('div')
  h.style.fontWeight = '600'
  h.style.marginTop = '10px'
  h.style.marginBottom = '4px'
  h.textContent = text
  parent.appendChild(h)
}

function appendLine(
  parent: HTMLElement,
  text: string,
  bold = false,
  color?: string,
): void {
  const row = document.createElement('div')
  if (bold) row.style.fontWeight = '600'
  if (color !== undefined) row.style.color = color
  row.style.whiteSpace = 'pre-wrap'
  row.textContent = text
  parent.appendChild(row)
}

function renderDetailProse(detailEl: HTMLElement, snap: LocalSnapshot, entityId: string): void {
  const kernels = snap.proseKernels.filter((k) => k.entityId === entityId)
  if (kernels.length === 0) return
  appendSectionHeader(detailEl, 'Prose kernel')
  for (const k of kernels) {
    const block = document.createElement('div')
    block.style.whiteSpace = 'pre-wrap'
    block.style.marginBottom = '8px'
    block.textContent = k.content
    detailEl.appendChild(block)
  }
}

function renderDetailFacts(detailEl: HTMLElement, snap: LocalSnapshot, entityId: string): void {
  const facts = snap.facts.filter((f) => f.entityId === entityId)
  appendSectionHeader(detailEl, `Facts (${String(facts.length)})`)
  if (facts.length === 0) {
    appendLine(detailEl, '(none)', false, 'var(--fg-muted)')
    return
  }
  for (const f of facts) {
    const row = document.createElement('div')
    row.style.marginBottom = '6px'
    const tag = document.createElement('span')
    tag.style.color = 'var(--fg-muted)'
    tag.textContent = `[${f.accessLevel}] ${f.topic}: `
    const body = document.createElement('span')
    body.style.whiteSpace = 'pre-wrap'
    body.textContent = f.content
    row.appendChild(tag)
    row.appendChild(body)
    detailEl.appendChild(row)
  }
}

function renderDetailRelationships(
  detailEl: HTMLElement,
  snap: LocalSnapshot,
  entityId: string,
): void {
  const outgoing = snap.relationships.filter((r) => r.sourceEntityId === entityId)
  const incoming = snap.relationships.filter((r) => r.targetEntityId === entityId)
  appendSectionHeader(
    detailEl,
    `Relationships (${String(outgoing.length)} out, ${String(incoming.length)} in)`,
  )
  if (outgoing.length === 0 && incoming.length === 0) {
    appendLine(detailEl, '(none)', false, 'var(--fg-muted)')
    return
  }
  const nameById = new Map(snap.entities.map((e) => [e.id, e.name]))
  for (const r of outgoing) {
    const targetName = nameById.get(r.targetEntityId) ?? r.targetEntityId
    appendLine(detailEl, `→ ${r.relationshipType} ${targetName}: ${r.description}`)
  }
  for (const r of incoming) {
    const sourceName = nameById.get(r.sourceEntityId) ?? r.sourceEntityId
    appendLine(detailEl, `← ${sourceName} ${r.relationshipType} (this): ${r.description}`)
  }
}

function renderDetailStatBlock(
  detailEl: HTMLElement,
  snap: LocalSnapshot,
  entity: EntityRow,
): void {
  // Best-effort match on stat block whose name matches the entity name.
  // entities.stat_block_id isn't part of the wire shape today; when the
  // backend exposes it the lookup becomes a direct id join.
  const statBlock = snap.statBlocks.find((s) => s.name === entity.name)
  if (!statBlock) return
  appendSectionHeader(detailEl, 'Stat block')
  appendLine(
    detailEl,
    `CR: ${statBlock.cr ?? '-'}  AC: ${String(statBlock.armorClass)}  HP: ${String(statBlock.hitPoints)}`,
  )
  appendLine(
    detailEl,
    `STR ${String(statBlock.str)} DEX ${String(statBlock.dex)} CON ${String(statBlock.con)} INT ${String(statBlock.int)} WIS ${String(statBlock.wis)} CHA ${String(statBlock.cha)}`,
  )
  if (statBlock.skills !== null) appendLine(detailEl, `skills: ${statBlock.skills}`)
  if (statBlock.senses !== null) appendLine(detailEl, `senses: ${statBlock.senses}`)
  if (statBlock.languages !== null) appendLine(detailEl, `langs:  ${statBlock.languages}`)
}

export function renderDetail(
  detailEl: HTMLElement,
  snap: LocalSnapshot,
  entityId: string | null,
): void {
  detailEl.replaceChildren()
  if (entityId === null) {
    detailEl.textContent = '(select an entity)'
    return
  }
  const entity = snap.entities.find((e) => e.id === entityId)
  if (!entity) {
    detailEl.textContent = '(entity not in snapshot — may have been removed)'
    return
  }
  appendLine(detailEl, `name: ${entity.name}`, true)
  appendLine(detailEl, `kind: ${entity.entityType}`)
  appendLine(detailEl, `access: ${entity.accessLevel}`)
  renderDetailProse(detailEl, snap, entityId)
  renderDetailFacts(detailEl, snap, entityId)
  renderDetailRelationships(detailEl, snap, entityId)
  renderDetailStatBlock(detailEl, snap, entity)
}

export function renderWorldHeading(headingEl: HTMLElement, snap: LocalSnapshot | null): void {
  if (snap === null) {
    headingEl.textContent = ''
    return
  }
  const parts = [`world: ${snap.world.name}`]
  if (snap.world.tone !== null && snap.world.tone.length > 0) {
    parts.push(`tone: ${snap.world.tone}`)
  }
  if (snap.world.era !== null && snap.world.era.length > 0) {
    parts.push(`era: ${snap.world.era}`)
  }
  headingEl.textContent = parts.join(' • ')
}

// ---- Glossary (myth-pfke) ----

const SOURCE_LABELS: Record<VocabularyEntrySource, string> = {
  stage_1_5: 'From world creation',
  consolidation: 'From consolidation',
  scribe_runtime: 'From play',
}

const SOURCE_ORDER: readonly VocabularyEntrySource[] = [
  'stage_1_5',
  'consolidation',
  'scribe_runtime',
]

function groupEntriesBySource(
  entries: readonly VocabularyEntry[],
): Map<VocabularyEntrySource, VocabularyEntry[]> {
  const map = new Map<VocabularyEntrySource, VocabularyEntry[]>()
  for (const src of SOURCE_ORDER) map.set(src, [])
  for (const entry of entries) map.get(entry.source)?.push(entry)
  return map
}

export function renderGlossarySection(
  container: HTMLElement,
  registry: VocabularyRegistry,
): void {
  container.replaceChildren()
  const heading = document.createElement('h3')
  heading.textContent = 'Glossary'
  container.appendChild(heading)

  if (registry.entries.length === 0 && registry.adjacent_franchises.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No vocabulary registered for this world.'
    container.appendChild(empty)
    return
  }

  if (registry.adjacent_franchises.length > 0) {
    const sub = document.createElement('p')
    sub.textContent = `Adjacent franchises: ${registry.adjacent_franchises.join(', ')}`
    container.appendChild(sub)
  }

  const grouped = groupEntriesBySource(registry.entries)
  for (const source of SOURCE_ORDER) {
    const group = grouped.get(source) ?? []
    if (group.length === 0) continue
    const groupHeading = document.createElement('h4')
    groupHeading.textContent = `${SOURCE_LABELS[source]} (${String(group.length)})`
    container.appendChild(groupHeading)

    const dl = document.createElement('dl')
    for (const entry of group) {
      const dt = document.createElement('dt')
      dt.textContent = entry.term
      dl.appendChild(dt)

      const dd = document.createElement('dd')
      const avoidance = entry.avoids !== undefined ? ` (use instead of "${entry.avoids}")` : ''
      const usage = entry.usage_notes !== undefined ? ` — ${entry.usage_notes}` : ''
      // textContent: never innerHTML. Server-returned strings flow through
      // the DOM as literal text — XSS-safe.
      dd.textContent = `${entry.definition}${avoidance}${usage}`
      dl.appendChild(dd)
    }
    container.appendChild(dl)
  }
}
