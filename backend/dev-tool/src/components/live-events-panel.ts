// Live SSE event inspector. Chronological event log + derived current-
// entity inventory. Subscribes to /api/campaigns/:id/status/stream via
// openSse (auth header stamped by the sse-client; identity-switcher
// updates routed in via the mythrun.closewatch event) and renders every
// event the bridge forwards.
//
// Design split: pure helpers (truncation, inventory reducer, cap
// application, compact-line classification) are exported so the test
// file can exercise them without needing a DOM. The mountLiveEventsPanel
// function is the thin DOM wrapper that wires those helpers to the
// SSE stream + the rendered card list. No graph, no SVG — per the
// MYT-52 design doc §6 "live-events inspector, NO graph" decision.
//
// All event payload types mirror backend/src/contract/pipeline-events.ts.
// They are duplicated here (rather than imported across the dev-tool /
// backend src boundary) so the dev-tool tsconfig stays self-contained;
// any drift between the two surfaces is caught by the bridge tests on
// the backend side.

import { openSse, type SseConnection } from '../sse-client.js'

// ---- Event payload shapes (mirror of pipeline-events.ts) ----

export type LiveEvent =
  | { type: 'phase'; phase: string }
  | { type: 'stage-started'; stage: string; userId: string | null; startedAt: string }
  | {
      type: 'stage-completed'
      stage: string
      userId: string | null
      durationMs: number
      costUsd: number
    }
  | {
      type: 'stage-failed'
      stage: string
      userId: string | null
      errorCode: string
      willRetry: boolean
    }
  | { type: 'cost-update'; cumulativeUsd: number }
  | { type: 'job-failed'; jobType: string; errorCode: string }
  | { type: 'stage-reset'; stage: string }
  | { type: 'entity-added'; synthKey: string; entityKind: string; data: Record<string, unknown> }
  | { type: 'entity-updated'; synthKey: string; patch: Record<string, unknown> }
  | { type: 'entity-removed'; synthKey: string; reason: string }
  | {
      type: 'edge-added'
      synthKey: string
      from: string
      to: string
      relationship: string
      description?: string
    }
  | { type: 'edge-removed'; synthKey: string; reason: string }
  | { type: 'finalized'; synthKey: string; entityId: string }

/** Synthetic placeholder card emitted at the position of the oldest event
 *  remaining after a cap-eviction. Not a wire-format event; the type prefix
 *  is namespaced with `__` to make it impossible to collide with a real
 *  PipelineSseEvent arm. */
export interface PlaceholderEntry {
  readonly kind: 'placeholder'
  readonly droppedCount: number
}

export interface EventEntry {
  readonly kind: 'event'
  readonly event: LiveEvent
}

export type LogEntry = EventEntry | PlaceholderEntry

// ---- Constants ----

export const MAX_EVENTS = 2000
export const EVICT_BATCH = 100
export const STRING_TRUNCATE_LEN = 80

// All event-type arms. Used to seed the filter-chip set so unknown future
// arms still render (they just don't get a chip until the contract adds them).
export const KNOWN_EVENT_TYPES = [
  'phase',
  'stage-started',
  'stage-completed',
  'stage-failed',
  'cost-update',
  'job-failed',
  'stage-reset',
  'entity-added',
  'entity-updated',
  'entity-removed',
  'edge-added',
  'edge-removed',
  'finalized',
] as const

// ---- Pure helpers (testable without DOM) ----

/** Truncates strings to STRING_TRUNCATE_LEN + ellipsis if longer. Non-string
 *  input is JSON-stringified first so the rule applies uniformly to nested
 *  primitives within the object/array helpers. JSON.stringify returns
 *  undefined for functions / undefined values — falls back to empty string. */
export function truncateString(value: unknown, max = STRING_TRUNCATE_LEN): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** Resolve the primary key per the design rule: `name` → `synthKey` → first
 *  key alphabetically. Returns null if the object has no own enumerable keys. */
export function primaryKeyOf(obj: Record<string, unknown>): string | null {
  if ('name' in obj) return 'name'
  if ('synthKey' in obj) return 'synthKey'
  const keys = Object.keys(obj).sort()
  return keys.length === 0 ? null : (keys[0] ?? null)
}

/** Compact-line summary for an object field per §6 truncation rule:
 *  `${primaryKey}: ${truncatedValue} (${otherKeyCount} other fields)`.
 *  Empty objects render as `{}`. */
export function summarizeObject(obj: Record<string, unknown>): string {
  const pk = primaryKeyOf(obj)
  if (pk === null) return '{}'
  const value = obj[pk]
  const truncated = truncateString(value)
  const otherCount = Object.keys(obj).length - 1
  return `${pk}: ${truncated} (${String(otherCount)} other fields)`
}

/** Compact-line summary for an array field: `${field}: [${array.length}]`. */
export function summarizeArray(field: string, arr: readonly unknown[]): string {
  return `${field}: [${String(arr.length)}]`
}

// ---- Inventory reducer (pure) ----

export interface InventoryRow {
  readonly synthKey: string
  readonly kind: string
  readonly name: string | null
  readonly displayId: string
  readonly state: Record<string, unknown>
  readonly lastEventIndex: number
}

export interface Inventory {
  readonly rows: readonly InventoryRow[]
  readonly edgeCount: number
}

/** Apply RFC 7396 JSON Merge Patch semantics for top-level keys. Per the
 *  design contract (§5.2 D7 / pipeline-events.ts), nested objects and arrays
 *  REPLACE wholesale — we do NOT recurse. Null values delete the key. */
function applyMergePatch(
  state: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  // Copy over existing entries except those the patch deletes (null = delete
  // per RFC 7396). The Record-with-string-key spread route through
  // `delete` is forbidden by typescript-eslint's no-dynamic-delete rule;
  // rebuilding the object via Object.entries + omit keeps the rule happy
  // and avoids a non-null assertion.
  const dropKeys = new Set<string>(
    Object.entries(patch)
      .filter(([, v]) => v === null)
      .map(([k]) => k),
  )
  for (const [k, v] of Object.entries(state)) {
    if (!dropKeys.has(k)) next[k] = v
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null) next[k] = v
  }
  return next
}

/** Derive current-entity inventory from the chronological event log.
 *  Pure function: clearing/repacking the input array clears the output. */
export function deriveInventory(entries: readonly LogEntry[]): Inventory {
  const byKey = new Map<string, InventoryRow>()
  let edgeCount = 0
  entries.forEach((entry, index) => {
    if (entry.kind !== 'event') return
    const e = entry.event
    if (e.type === 'entity-added') {
      const nameVal = e.data.name
      const name = typeof nameVal === 'string' ? nameVal : null
      byKey.set(e.synthKey, {
        synthKey: e.synthKey,
        kind: e.entityKind,
        name,
        displayId: e.synthKey,
        state: { ...e.data },
        lastEventIndex: index,
      })
    } else if (e.type === 'entity-updated') {
      const existing = byKey.get(e.synthKey)
      if (!existing) return
      const nextState = applyMergePatch(existing.state, e.patch)
      const patchName = e.patch.name
      const nextName =
        typeof patchName === 'string'
          ? patchName
          : patchName === null
            ? null
            : existing.name
      byKey.set(e.synthKey, {
        ...existing,
        state: nextState,
        name: nextName,
        lastEventIndex: index,
      })
    } else if (e.type === 'entity-removed') {
      byKey.delete(e.synthKey)
    } else if (e.type === 'stage-reset') {
      const prefix = `${e.stage}/`
      for (const key of [...byKey.keys()]) {
        if (key.startsWith(prefix)) byKey.delete(key)
      }
    } else if (e.type === 'finalized') {
      const existing = byKey.get(e.synthKey)
      if (!existing) return
      byKey.set(e.synthKey, {
        ...existing,
        displayId: e.entityId,
        lastEventIndex: index,
      })
    } else if (e.type === 'edge-added') {
      edgeCount += 1
    } else if (e.type === 'edge-removed') {
      edgeCount -= 1
    }
  })
  const rows = [...byKey.values()].sort((a, b) => b.lastEventIndex - a.lastEventIndex)
  return { rows, edgeCount }
}

// ---- Event cap ----

/** Apply the 2000-event FIFO cap. When the log exceeds MAX_EVENTS, drop the
 *  oldest EVICT_BATCH event entries (placeholder cards survive eviction and
 *  are merged) and insert one synthetic `[…N earlier events dropped]`
 *  placeholder at the position of the oldest remaining entry. The total
 *  dropped count accumulates across evictions. */
export function applyCap(entries: readonly LogEntry[]): readonly LogEntry[] {
  if (entries.length <= MAX_EVENTS) return entries
  const overflow = entries.length - MAX_EVENTS
  // Drop at least overflow + (EVICT_BATCH - 1) so a single overflow event
  // triggers a clean EVICT_BATCH-sized eviction rather than a per-event
  // shuffle. Cap to entries.length so we don't underflow.
  const dropCount = Math.min(entries.length, Math.max(overflow, EVICT_BATCH))
  const dropped = entries.slice(0, dropCount)
  const remaining = entries.slice(dropCount)
  const droppedEvents = dropped.filter((e): e is EventEntry => e.kind === 'event').length
  const carriedDropped = dropped
    .filter((e): e is PlaceholderEntry => e.kind === 'placeholder')
    .reduce((sum, e) => sum + e.droppedCount, 0)
  const placeholder: PlaceholderEntry = {
    kind: 'placeholder',
    droppedCount: droppedEvents + carriedDropped,
  }
  return [placeholder, ...remaining]
}

// ---- Compact-line classification ----

export interface CompactLine {
  readonly primary: string
  readonly detail: string
}

/** One-line compact summary for an event, used to render the event-card
 *  header. Detail line is empty for events whose primary line already says
 *  everything. */
export function compactLine(event: LiveEvent): CompactLine {
  switch (event.type) {
    case 'phase':
      return { primary: `phase           ${event.phase}`, detail: '' }
    case 'stage-started':
      return { primary: `stage-started   ${event.stage}`, detail: '' }
    case 'stage-completed':
      return {
        primary: `stage-completed ${event.stage}  $${event.costUsd.toFixed(4)}`,
        detail: `duration: ${String(event.durationMs)}ms`,
      }
    case 'stage-failed':
      return {
        primary: `stage-failed    ${event.stage}  ${event.errorCode}`,
        detail: event.willRetry ? 'will retry' : 'terminal',
      }
    case 'cost-update':
      return { primary: `cost-update     $${event.cumulativeUsd.toFixed(4)}`, detail: '' }
    case 'job-failed':
      return { primary: `job-failed      ${event.jobType}  ${event.errorCode}`, detail: '' }
    case 'stage-reset':
      return { primary: `stage-reset     ${event.stage}`, detail: '' }
    case 'entity-added': {
      const nameVal = event.data.name
      const name = typeof nameVal === 'string' ? truncateString(nameVal) : '(unnamed)'
      return {
        primary: `entity-added    ${event.synthKey}  ${event.entityKind}`,
        detail: `name: ${name}`,
      }
    }
    case 'entity-updated': {
      const fieldCount = Object.keys(event.patch).length
      return {
        primary: `entity-updated  ${event.synthKey}  (${String(fieldCount)} fields)`,
        detail: summarizePatchDetail(event.patch),
      }
    }
    case 'entity-removed':
      return {
        primary: `entity-removed  ${event.synthKey}`,
        detail: `reason: ${event.reason}`,
      }
    case 'edge-added':
      return {
        primary: `edge-added      ${event.from} -> ${event.to}`,
        detail: `relationship: ${event.relationship}`,
      }
    case 'edge-removed':
      return {
        primary: `edge-removed    ${event.synthKey}`,
        detail: `reason: ${event.reason}`,
      }
    case 'finalized':
      return {
        primary: `finalized       ${event.synthKey}`,
        detail: `entityId: ${event.entityId}`,
      }
  }
}

/** Build the detail line for an entity-updated patch: pick the first key
 *  alphabetically and summarize its value per the truncation rule. */
function summarizePatchDetail(patch: Record<string, unknown>): string {
  const keys = Object.keys(patch).sort()
  const key = keys[0]
  if (key === undefined) return '(empty patch)'
  const value = patch[key]
  if (Array.isArray(value)) return summarizeArray(key, value)
  if (value !== null && typeof value === 'object') {
    return `${key}: ${summarizeObject(value as Record<string, unknown>)}`
  }
  return `${key}: ${truncateString(value)}`
}

// ---- DOM mount ----

interface CloseFramePayload {
  readonly reason?: string
}

// Filter-chip kinds. The chips collapse the 13 event arms into 5 broad
// buckets so the user has a reasonable number of toggles. Unknown future
// arms fall through to "other."
type FilterChip = 'phase' | 'stage' | 'entity' | 'edge' | 'other'

function chipFor(eventType: string): FilterChip {
  if (eventType === 'phase' || eventType === 'cost-update') return 'phase'
  if (eventType.startsWith('stage-')) return 'stage'
  if (eventType.startsWith('entity-') || eventType === 'finalized') return 'entity'
  if (eventType.startsWith('edge-')) return 'edge'
  return 'other'
}

export function mountLiveEventsPanel(parent: HTMLElement): void {
  const view = buildView()
  parent.appendChild(view.card)
  attachController(view)
}

interface ViewRefs {
  readonly card: HTMLElement
  readonly statusEl: HTMLElement
  readonly logEl: HTMLElement
  readonly inventoryEl: HTMLElement
  readonly summaryEl: HTMLElement
  readonly chipButtons: ReadonlyMap<FilterChip, HTMLButtonElement>
}

function buildView(): ViewRefs {
  const card = document.createElement('section')
  card.className = 'card'

  const title = document.createElement('h2')
  title.textContent = 'Live SSE events'

  const chipRow = document.createElement('div')
  chipRow.style.display = 'flex'
  chipRow.style.gap = '6px'
  chipRow.style.marginBottom = '8px'
  chipRow.style.flexWrap = 'wrap'

  const chips: [FilterChip, string][] = [
    ['phase', 'phase'],
    ['stage', 'stage'],
    ['entity', 'entity'],
    ['edge', 'edge'],
    ['other', 'other'],
  ]
  const chipButtons = new Map<FilterChip, HTMLButtonElement>()
  for (const [key, label] of chips) {
    const btn = document.createElement('button')
    btn.textContent = `${label} ✓`
    btn.dataset.chip = key
    btn.dataset.active = 'true'
    chipRow.appendChild(btn)
    chipButtons.set(key, btn)
  }

  const statusEl = document.createElement('div')
  statusEl.className = 'result'
  statusEl.textContent = '(no campaign watched)'

  const logEl = document.createElement('div')
  logEl.style.fontFamily = 'var(--mono)'
  logEl.style.fontSize = '12px'
  logEl.style.maxHeight = '300px'
  logEl.style.overflowY = 'auto'
  logEl.style.border = '1px solid var(--border)'
  logEl.style.padding = '8px'
  logEl.style.marginTop = '8px'

  const summaryEl = document.createElement('div')
  summaryEl.className = 'result'
  summaryEl.style.marginTop = '12px'
  summaryEl.textContent = '0 entities • 0 edges'

  const inventoryEl = document.createElement('div')
  inventoryEl.style.fontFamily = 'var(--mono)'
  inventoryEl.style.fontSize = '12px'
  inventoryEl.style.marginTop = '4px'

  card.appendChild(title)
  card.appendChild(chipRow)
  card.appendChild(statusEl)
  card.appendChild(logEl)
  card.appendChild(summaryEl)
  card.appendChild(inventoryEl)

  return { card, statusEl, logEl, inventoryEl, summaryEl, chipButtons }
}

function attachController(refs: ViewRefs): void {
  let entries: LogEntry[] = []
  const activeChips = new Set<FilterChip>(['phase', 'stage', 'entity', 'edge', 'other'])
  let conn: SseConnection | null = null

  function reset(): void {
    if (conn) {
      conn.close()
      conn = null
    }
    entries = []
    activeChips.clear()
    for (const k of ['phase', 'stage', 'entity', 'edge', 'other'] as FilterChip[]) {
      activeChips.add(k)
    }
    for (const [key, btn] of refs.chipButtons.entries()) {
      btn.textContent = `${key} ✓`
      btn.dataset.active = 'true'
    }
    refs.statusEl.textContent = '(no campaign watched)'
    render()
  }

  function render(): void {
    refs.logEl.replaceChildren()
    for (const entry of entries) {
      const cardEl = renderEntry(entry, activeChips)
      if (cardEl) refs.logEl.appendChild(cardEl)
    }
    const inv = deriveInventory(entries)
    refs.summaryEl.textContent = `${String(inv.rows.length)} entities • ${String(inv.edgeCount)} edges`
    refs.inventoryEl.replaceChildren()
    for (const row of inv.rows) {
      const rowEl = document.createElement('div')
      rowEl.textContent = `${row.displayId}  ${row.kind}  ${row.name ?? '(unnamed)'}`
      refs.inventoryEl.appendChild(rowEl)
    }
    refs.logEl.scrollTop = refs.logEl.scrollHeight
  }

  function pushEvent(event: LiveEvent): void {
    entries = [...entries, { kind: 'event', event }]
    const capped = applyCap(entries)
    entries = capped as LogEntry[]
    render()
  }

  for (const [key, btn] of refs.chipButtons.entries()) {
    btn.addEventListener('click', () => {
      if (activeChips.has(key)) {
        activeChips.delete(key)
        btn.textContent = `${key} ✗`
        btn.dataset.active = 'false'
      } else {
        activeChips.add(key)
        btn.textContent = `${key} ✓`
        btn.dataset.active = 'true'
      }
      render()
    })
  }

  window.addEventListener('mythrun.watchcampaign', (e) => {
    const id = (e as CustomEvent<string>).detail
    if (typeof id !== 'string' || id.length === 0) return
    if (conn) conn.close()
    entries = []
    refs.statusEl.textContent = `watching ${id}`
    render()
    conn = openSse(`/api/campaigns/${id}/status/stream`, {
      onEvent: (ev) => {
        if (ev.event === 'snapshot') return
        if (ev.event === 'close') {
          try {
            const payload = JSON.parse(ev.data) as CloseFramePayload
            refs.statusEl.textContent = `(server closed — reason: ${payload.reason ?? 'unknown'})`
          } catch {
            refs.statusEl.textContent = '(server closed)'
          }
          if (conn) {
            conn.close()
            conn = null
          }
          return
        }
        if (ev.event === 'message') {
          try {
            pushEvent(JSON.parse(ev.data) as LiveEvent)
          } catch {
            // Ignore unparseable frames.
          }
        }
      },
      onError: (err) => {
        refs.statusEl.textContent = `(connection error: ${err.message})`
        if (conn) {
          conn.close()
          conn = null
        }
      },
    })
  })

  window.addEventListener('mythrun.closewatch', () => {
    reset()
  })
}

function renderEntry(entry: LogEntry, activeChips: ReadonlySet<FilterChip>): HTMLElement | null {
  if (entry.kind === 'placeholder') {
    const el = document.createElement('div')
    el.style.color = 'var(--fg-muted)'
    el.textContent = `[…${String(entry.droppedCount)} earlier events dropped]`
    return el
  }
  const event = entry.event
  const chip = chipFor(event.type)
  if (!activeChips.has(chip)) return null
  const compact = compactLine(event)
  const wrapper = document.createElement('div')
  wrapper.style.padding = '2px 0'
  wrapper.style.borderBottom = '1px solid var(--border)'

  const primary = document.createElement('div')
  primary.textContent = compact.primary
  primary.style.cursor = 'pointer'

  const detail = document.createElement('div')
  detail.style.color = 'var(--fg-muted)'
  detail.style.marginLeft = '12px'
  detail.textContent = compact.detail

  const expanded = document.createElement('pre')
  expanded.style.display = 'none'
  expanded.style.background = 'var(--bg)'
  expanded.style.padding = '6px'
  expanded.style.fontSize = '11px'
  expanded.textContent = JSON.stringify(event, null, 2)

  primary.addEventListener('click', () => {
    expanded.style.display = expanded.style.display === 'none' ? 'block' : 'none'
  })

  wrapper.appendChild(primary)
  if (compact.detail !== '') wrapper.appendChild(detail)
  wrapper.appendChild(expanded)
  return wrapper
}
