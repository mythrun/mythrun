// Live SSE event inspector. Chronological event log + derived current-
// entity inventory. The live SSE feed is owned by the wire-log drawer
// (see shell/drawer/subscriptions.ts); this panel mount is now a
// minimal placeholder pointing the user to the drawer.
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
//
// myth-rdwq P6.B: the panel mount path is now a minimal placeholder —
// live events are owned by the wire-log drawer (spec §6). The pure
// reducer helpers (deriveInventory, derivePlaceholderBuffer, compactLine,
// applyCap, truncateString, primaryKeyOf, summarizeObject,
// summarizeArray) are PRESERVED below: they're test-covered + the drawer
// will reuse them once it adopts reducer-based rendering.

import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'

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
  | {
      type: 'entity-added'
      synthKey: string
      entityKind: string
      data: Record<string, unknown>
      /** Stage 4b ghost reconciliation key. Present on entity-added events
       *  emitted by entity_consolidation for ghost entities materialised
       *  from a stage-4 placeholder reference. When set, the live-events
       *  panel drains its placeholder-edge buffer for any edge whose
       *  `from` or `to` equals this id, patching the endpoint to the
       *  new entity's synthKey. Absent for stage 2-3 entities. */
      placeholderId?: string
    }
  | { type: 'entity-updated'; synthKey: string; patch: Record<string, unknown> }
  | { type: 'entity-removed'; synthKey: string; reason: string }
  | {
      type: 'edge-added'
      synthKey: string
      /** `from` / `to` are real UUIDs once both endpoints are persisted,
       *  but Stage 4 may emit a placeholder string (`new-NNN`) on either
       *  end when the relationship references a phantom entity that
       *  hasn't materialised yet. derivePlaceholderBuffer buffers any
       *  such edge until the matching ghost entity-added event arrives. */
      from: string
      to: string
      relationship: string
      description?: string
    }
  | { type: 'edge-removed'; synthKey: string; reason: string }
  // myth-imxg: per-fact wire events. Mirror of pipeline-events.ts fact-*
  // arms. entitySynthKey points back at the owning entity's synthKey
  // (same map entity-updated uses); factId is the row's UUID. Inventory
  // reducer ignores these — fact rendering lives in the wire-log drawer.
  | {
      type: 'fact-added'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
  | { type: 'fact-removed'; entitySynthKey: string; factId: string }
  | {
      type: 'fact-updated'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
  | { type: 'finalized'; synthKey: string; entityId: string }

/** Synthetic placeholder card emitted at the position of the oldest event
 *  remaining after a cap-eviction. Not a wire-format event; the type prefix
 *  is namespaced with `__` to make it impossible to collide with a real
 *  PipelineSseEvent arm. */
interface PlaceholderEntry {
  readonly kind: 'placeholder'
  readonly droppedCount: number
}

interface EventEntry {
  readonly kind: 'event'
  readonly event: LiveEvent
}

export type LogEntry = EventEntry | PlaceholderEntry

// ---- Constants ----

export const MAX_EVENTS = 2000
export const EVICT_BATCH = 100
const STRING_TRUNCATE_LEN = 80

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
  'fact-added',
  'fact-removed',
  'fact-updated',
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

interface InventoryRow {
  readonly synthKey: string
  readonly kind: string
  readonly name: string | null
  readonly displayId: string
  readonly state: Record<string, unknown>
  readonly lastEventIndex: number
}

interface Inventory {
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
 *  Pure function: clearing/repacking the input array clears the output.
 *
 *  edgeCount semantics: counts only edges that derivePlaceholderBuffer
 *  considers RENDERED. Edges whose endpoints are unresolved placeholder
 *  strings (`new-NNN`) are buffered, not counted. This keeps the
 *  "N entities • M edges" summary honest while a stage-4 / stage-4b
 *  ghost reconciliation is in flight. */
export function deriveInventory(entries: readonly LogEntry[]): Inventory {
  const byKey = new Map<string, InventoryRow>()
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
    }
    // edge-added / edge-removed edgeCount is delegated to
    // derivePlaceholderBuffer; we compute the rendered set there and
    // count it below so the summary stays consistent with what the
    // user sees in the log.
  })
  const rows = [...byKey.values()].sort((a, b) => b.lastEventIndex - a.lastEventIndex)
  const edgeCount = derivePlaceholderBuffer(entries).rendered.length
  return { rows, edgeCount }
}

// ---- Placeholder edge buffer (Phase 5.3) ----

/** Edge endpoint placeholder marker: stage-4 (entity_relationships) may
 *  emit edge-added with `from` / `to` set to `new-NNN` when the
 *  relationship references a phantom entity. Stage 4b
 *  (entity_consolidation) later emits entity-added carrying the same
 *  string in `placeholderId`. */
function isPlaceholderId(id: string): boolean {
  return id.startsWith('new-')
}

interface RenderedEdge {
  /** Stable identity for the edge — its synthKey. Used so edge-removed
   *  can drop the entry by id regardless of which endpoint was buffered. */
  readonly synthKey: string
  /** Reconciled source endpoint. If the wire payload carried a placeholder
   *  string here, it has been patched to the resolved entity's synthKey. */
  readonly from: string
  /** Reconciled target endpoint. See `from`. */
  readonly to: string
  readonly relationship: string
}

interface PlaceholderBuffer {
  /** Edges whose endpoints are fully resolved — what the renderer shows. */
  readonly rendered: readonly RenderedEdge[]
  /** Edges still waiting on one or more placeholder endpoints to materialise. */
  readonly bufferedCount: number
}

/** Replay the chronological event log to produce the current set of
 *  rendered edges + the count of edges still buffered awaiting placeholder
 *  reconciliation. Pure function: same input → same output.
 *
 *  Placeholder resolution rules:
 *  - An edge-added event with no placeholder endpoint renders immediately.
 *  - An edge-added event with one or more `new-NNN` endpoints is buffered.
 *  - An entity-added event with a `placeholderId` (Stage 4b ghost) maps
 *    that id to the new entity's synthKey for all subsequent lookups.
 *  - An edge is "rendered" once every placeholder endpoint it carries has
 *    a resolved synthKey in the map (the buffer scan happens at the end,
 *    so order between the edge and the ghost doesn't matter — both
 *    arrival orders yield the same result).
 *  - edge-removed by synthKey drops the edge from either the buffer or
 *    the rendered list (repair-dropped or coherence-deleted both flow
 *    through the same delete path).
 *  - stage-reset of `entity_relationships` (the stage that owns these
 *    edges) is forwarded but unhandled here — the reset event also
 *    clears the stage's entities via deriveInventory, and synthKey
 *    prefix matching on `entity_relationships/` drops any orphan
 *    edges from the buffer + rendered set. */
export function derivePlaceholderBuffer(entries: readonly LogEntry[]): PlaceholderBuffer {
  // placeholderId → resolved entity synthKey. Populated by entity-added
  // events carrying a placeholderId field.
  const resolutions = new Map<string, string>()
  // synthKey → edge payload. The lookup-by-synthKey is what edge-removed
  // walks; a Map keeps it O(1). Insertion order is iteration order, so
  // rendered output stays chronological.
  const edges = new Map<
    string,
    { from: string; to: string; relationship: string }
  >()

  for (const entry of entries) {
    if (entry.kind !== 'event') continue
    const e = entry.event
    if (e.type === 'entity-added' && e.placeholderId !== undefined) {
      resolutions.set(e.placeholderId, e.synthKey)
      continue
    }
    if (e.type === 'edge-added') {
      edges.set(e.synthKey, { from: e.from, to: e.to, relationship: e.relationship })
      continue
    }
    if (e.type === 'edge-removed') {
      edges.delete(e.synthKey)
      continue
    }
    if (e.type === 'stage-reset') {
      // Mirror deriveInventory's stage-reset semantics for orphan edges:
      // drop any edge whose synthKey is under the reset stage's prefix.
      const prefix = `${e.stage}/`
      for (const key of [...edges.keys()]) {
        if (key.startsWith(prefix)) edges.delete(key)
      }
    }
  }

  // Reconcile: walk edges in insertion order, classify as rendered or
  // buffered based on whether every placeholder endpoint has a resolution.
  const rendered: RenderedEdge[] = []
  let bufferedCount = 0
  for (const [synthKey, edge] of edges) {
    const resolvedFrom = resolveEndpoint(edge.from, resolutions)
    const resolvedTo = resolveEndpoint(edge.to, resolutions)
    if (resolvedFrom === null || resolvedTo === null) {
      bufferedCount += 1
      continue
    }
    rendered.push({
      synthKey,
      from: resolvedFrom,
      to: resolvedTo,
      relationship: edge.relationship,
    })
  }
  return { rendered, bufferedCount }
}

/** Resolve an edge endpoint: real ids pass through; placeholder ids look
 *  up the resolutions map. Returns null when a placeholder hasn't been
 *  resolved yet — caller treats null as "buffer this edge." */
function resolveEndpoint(endpoint: string, resolutions: Map<string, string>): string | null {
  if (!isPlaceholderId(endpoint)) return endpoint
  return resolutions.get(endpoint) ?? null
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

interface CompactLine {
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
    case 'fact-added':
      return {
        primary: `fact-added      ${event.entitySynthKey}  [${event.topic}]`,
        detail: `content: ${truncateString(event.content)}`,
      }
    case 'fact-removed':
      return {
        primary: `fact-removed    ${event.entitySynthKey}  ${event.factId}`,
        detail: '',
      }
    case 'fact-updated':
      return {
        primary: `fact-updated    ${event.entitySynthKey}  [${event.topic}]`,
        detail: `content: ${truncateString(event.content)}`,
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
//
// myth-rdwq P6.B: minimal placeholder panel. The live SSE feed is owned
// by the wire-log drawer (spec §6); this panel just points the user there.
// The drawer's bus is currently encapsulated inside `mountShell()` (not
// exported), so we don't subscribe here. Phase-7 work will move the
// reducer helpers above into the drawer renderer.

export function mountLiveEventsPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/status/stream',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Live SSE feed is owned by the wire-log drawer (spec §6).'
  actionEl.appendChild(note)

  const placeholder = document.createElement('div')
  placeholder.style.color = 'var(--fg-muted)'
  placeholder.style.fontSize = '12px'
  const id = getActiveCampaignId()
  if (id === null) {
    placeholder.textContent =
      '(this endpoint requires an active campaign — pick one in GET /api/campaigns/mine)'
  } else {
    placeholder.textContent =
      '(events for this campaign appear in the wire-log drawer on the right — the panel-level live feed is being replaced by the drawer)'
  }
  feedbackEl.appendChild(placeholder)

  setState('ready')

  return {
    root,
    unmount: () => {
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId/status/stream', mountLiveEventsPanel)
