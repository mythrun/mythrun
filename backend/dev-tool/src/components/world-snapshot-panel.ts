// myth-exac T23+T24+T25 — world-snapshot-panel.
//
// Post-stage-4 wiki-style inspector. Renders the persisted snapshot
// returned by GET /api/campaigns/:campaignId/world-snapshot as a two-pane
// tree+detail view, and applies stage-7 (coherence_pass) post-snapshot
// deltas in-place so the user watches the world settle without a refetch.
//
// State machine: idle → loading → ready → error (any error code).
// data-state on the panel root reflects the current state for the
// JSDOM verifier.
//
// SSE subscription is shared with status / live-events panels: the
// mythrun.watchcampaign event sets the current campaignId; phase events
// drive idle→loading→ready; finalized events populate the
// synthKey→DB-id maps; entity-updated / edge-added / edge-removed events
// patch the local snapshot in place.
//
// Reconnect rule (per task spec): on stream re-open, if the phase is at
// or beyond world_snapshot_ready we REPLACE the local snapshot from a
// fresh GET — we do not attempt to merge missed deltas.
//
// Module split:
//   - world-snapshot-types.ts: wire mirrors + phase helpers
//   - world-snapshot-render.ts: pure DOM-rendering helpers + delta appliers
//   - world-snapshot-panel.ts (this file): mount + controller (SSE + state)

import { apiCall } from '../api-client.js'
import { openSse, type SseConnection } from '../sse-client.js'
import {
  applyEdgeAdded,
  applyEdgeRemoved,
  applyEntityUpdated,
  renderDetail,
  renderTree,
  renderWorldHeading,
} from './world-snapshot-render.js'
import {
  isPostSnapshotPhase,
  toMutableSnapshot,
  type LocalSnapshot,
  type SseClosePayload,
  type SseLiveEvent,
  type SseSnapshotPayload,
  type WorldSnapshotResponse,
} from './world-snapshot-types.js'

// ---- DOM ----

interface ViewRefs {
  readonly card: HTMLElement
  readonly status: HTMLElement
  readonly worldHeading: HTMLElement
  readonly tree: HTMLElement
  readonly detail: HTMLElement
  readonly retryBtn: HTMLButtonElement
}

function buildView(): ViewRefs {
  const card = document.createElement('section')
  card.className = 'card'
  // Idle on mount — no campaign selected. The verify harness keys on the
  // post-mount steady state being 'idle'.
  card.setAttribute('data-state', 'idle')

  const title = document.createElement('h2')
  title.textContent = 'GET /api/campaigns/:campaignId/world-snapshot'

  const status = document.createElement('div')
  status.className = 'result'
  status.textContent = '(no campaign watched — fires once phase ≥ world_snapshot_ready)'

  const retryBtn = document.createElement('button')
  retryBtn.textContent = 'Retry'
  retryBtn.style.display = 'none'
  retryBtn.style.marginLeft = '8px'

  const worldHeading = document.createElement('div')
  worldHeading.style.fontFamily = 'var(--mono)'
  worldHeading.style.fontSize = '13px'
  worldHeading.style.marginTop = '8px'

  const splitRow = document.createElement('div')
  splitRow.style.display = 'flex'
  splitRow.style.gap = '12px'
  splitRow.style.marginTop = '12px'
  splitRow.style.alignItems = 'stretch'

  const tree = document.createElement('div')
  tree.style.flex = '0 0 280px'
  tree.style.fontFamily = 'var(--mono)'
  tree.style.fontSize = '12px'
  tree.style.maxHeight = '480px'
  tree.style.overflowY = 'auto'
  tree.style.border = '1px solid var(--border)'
  tree.style.padding = '8px'
  tree.setAttribute('data-region', 'entity-tree')

  const detail = document.createElement('div')
  detail.style.flex = '1 1 auto'
  detail.style.fontFamily = 'var(--mono)'
  detail.style.fontSize = '12px'
  detail.style.maxHeight = '480px'
  detail.style.overflowY = 'auto'
  detail.style.border = '1px solid var(--border)'
  detail.style.padding = '8px'
  detail.setAttribute('data-region', 'entity-detail')
  detail.textContent = '(select an entity)'

  splitRow.appendChild(tree)
  splitRow.appendChild(detail)

  card.appendChild(title)
  card.appendChild(status)
  card.appendChild(retryBtn)
  card.appendChild(worldHeading)
  card.appendChild(splitRow)

  return { card, status, worldHeading, tree, detail, retryBtn }
}

// ---- Controller state ----

interface ControllerState {
  campaignId: string | null
  phase: string | null
  snapshot: LocalSnapshot | null
  selectedEntityId: string | null
  /** synthKey → entityId (resolved from finalized events). */
  synthKeyToEntityId: Map<string, string>
  /** synthKey → relationshipId (resolved from finalized events). */
  synthKeyToRelationshipId: Map<string, string>
  conn: SseConnection | null
  /** Pending re-fetch token: any in-flight fetch whose token mismatches
   *  the controller's current token is discarded on resolve. Prevents a
   *  late response from a stale (campaign-switched-away) fetch from
   *  clobbering the fresh state. */
  fetchToken: number
}

function createInitialState(): ControllerState {
  return {
    campaignId: null,
    phase: null,
    snapshot: null,
    selectedEntityId: null,
    synthKeyToEntityId: new Map(),
    synthKeyToRelationshipId: new Map(),
    conn: null,
    fetchToken: 0,
  }
}

// ---- Mount ----

export function mountWorldSnapshotPanel(parent: HTMLElement): void {
  const refs = buildView()
  parent.appendChild(refs.card)
  attachController(refs)
}

function attachController(refs: ViewRefs): void {
  const state = createInitialState()

  function setState(s: 'idle' | 'loading' | 'ready' | 'error'): void {
    refs.card.setAttribute('data-state', s)
    refs.retryBtn.style.display = s === 'error' ? 'inline-block' : 'none'
  }

  function selectEntity(id: string | null): void {
    state.selectedEntityId = id
    if (state.snapshot) {
      renderTree(refs.tree, state.snapshot, id, (eid) => {
        selectEntity(eid)
      })
      renderDetail(refs.detail, state.snapshot, id)
    }
  }

  function renderAll(): void {
    if (state.snapshot) {
      renderWorldHeading(refs.worldHeading, state.snapshot)
      renderTree(refs.tree, state.snapshot, state.selectedEntityId, (eid) => {
        selectEntity(eid)
      })
      renderDetail(refs.detail, state.snapshot, state.selectedEntityId)
    } else {
      renderWorldHeading(refs.worldHeading, null)
      refs.tree.replaceChildren()
      refs.detail.replaceChildren()
      refs.detail.textContent = '(select an entity)'
    }
  }

  function resetSnapshot(): void {
    state.snapshot = null
    state.selectedEntityId = null
    state.synthKeyToEntityId = new Map()
    state.synthKeyToRelationshipId = new Map()
    renderAll()
  }

  async function fetchSnapshot(): Promise<void> {
    if (state.campaignId === null) return
    const id = state.campaignId
    state.fetchToken += 1
    const token = state.fetchToken
    setState('loading')
    refs.status.textContent = `loading snapshot for ${id}...`

    const res = await apiCall<WorldSnapshotResponse>(`/api/campaigns/${id}/world-snapshot`)

    // Stale-response guard: campaign switched or controller reset while
    // the fetch was in flight.
    if (token !== state.fetchToken) return

    if (res.status === 200 && res.body !== null) {
      state.snapshot = toMutableSnapshot(res.body)
      // Preserve selection if the entity still exists; otherwise drop.
      if (
        state.selectedEntityId !== null &&
        !state.snapshot.entities.some((e) => e.id === state.selectedEntityId)
      ) {
        state.selectedEntityId = null
      }
      refs.status.textContent =
        `snapshot loaded (${String(state.snapshot.entities.length)} entities, ` +
        `${String(state.snapshot.relationships.length)} relationships)`
      setState('ready')
      renderAll()
      return
    }

    refs.status.textContent = `error ${String(res.status)}: ${res.error ?? JSON.stringify(res.body)}`
    setState('error')
  }

  function handleFinalized(synthKey: string, entityId: string): void {
    // Stage-prefix tells us which map to populate. entity_relationships/
    // is a relationship synthKey; world_and_factions/ and
    // locations_and_npcs/ are entity synthKeys.
    if (synthKey.startsWith('entity_relationships/')) {
      state.synthKeyToRelationshipId.set(synthKey, entityId)
      // If we stub-rendered an edge with the synthKey as its id, upgrade
      // it to the real DB id now.
      if (state.snapshot) {
        const idx = state.snapshot.relationships.findIndex((r) => r.id === synthKey)
        if (idx >= 0) {
          const existing = state.snapshot.relationships[idx]
          if (existing) {
            state.snapshot.relationships[idx] = { ...existing, id: entityId }
            renderAll()
          }
        }
      }
    } else {
      state.synthKeyToEntityId.set(synthKey, entityId)
    }
  }

  function handleSseEvent(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const t = (raw as { type?: unknown }).type
    if (typeof t !== 'string') return
    const ev = raw as SseLiveEvent
    if (ev.type === 'phase') {
      const prev = state.phase
      state.phase = ev.phase
      // First crossing into post-snapshot territory → fetch.
      if (
        !isPostSnapshotPhase(prev) &&
        isPostSnapshotPhase(ev.phase) &&
        state.snapshot === null
      ) {
        void fetchSnapshot()
      }
      return
    }
    if (ev.type === 'finalized') {
      handleFinalized(ev.synthKey, ev.entityId)
      return
    }
    // Post-snapshot deltas only apply if we already have a snapshot.
    if (!state.snapshot) return
    if (ev.type === 'entity-updated') {
      const entityId = state.synthKeyToEntityId.get(ev.synthKey)
      if (entityId === undefined) return
      applyEntityUpdated(state.snapshot, entityId, ev.patch)
      renderAll()
      return
    }
    if (ev.type === 'edge-added') {
      applyEdgeAdded(state.snapshot, ev, (sk) => state.synthKeyToEntityId.get(sk) ?? null)
      renderAll()
      return
    }
    // ev.type === 'edge-removed' is the only remaining arm.
    const relId = state.synthKeyToRelationshipId.get(ev.synthKey) ?? ev.synthKey
    applyEdgeRemoved(state.snapshot, relId)
    renderAll()
  }

  function closeStream(): void {
    if (state.conn) {
      state.conn.close()
      state.conn = null
    }
  }

  function handleSnapshotFrame(data: string): void {
    try {
      const snap = JSON.parse(data) as SseSnapshotPayload
      state.phase = snap.phase
      // Reconnect rule: if we were already in a post-snapshot phase and
      // have a local snapshot, REPLACE it from a fresh GET to pick up
      // anything we missed while disconnected. The first snapshot frame
      // (initial connect) also lands here — if phase is post-snapshot
      // and we have no local snapshot yet, fetch.
      if (isPostSnapshotPhase(snap.phase)) {
        if (state.snapshot !== null) {
          // Re-fetch on reconnect (snapshot frame seen with an existing
          // snapshot ≡ a reconnect — see spec rule "REPLACE local
          // snapshot from a fresh GET").
          resetSnapshot()
        }
        void fetchSnapshot()
      }
    } catch {
      // Ignore unparseable snapshot frame; live messages still drive
      // phase transitions.
    }
  }

  function handleCloseFrame(data: string): void {
    try {
      const payload = JSON.parse(data) as SseClosePayload
      refs.status.textContent =
        `${refs.status.textContent} • (server closed: ${payload.reason ?? 'unknown'})`
    } catch {
      // ignore
    }
    closeStream()
  }

  function openStream(campaignId: string): void {
    closeStream()
    state.conn = openSse(`/api/campaigns/${campaignId}/status/stream`, {
      onEvent: (ev) => {
        if (ev.event === 'snapshot') {
          handleSnapshotFrame(ev.data)
          return
        }
        if (ev.event === 'close') {
          handleCloseFrame(ev.data)
          return
        }
        if (ev.event === 'message') {
          try {
            handleSseEvent(JSON.parse(ev.data))
          } catch {
            // Ignore unparseable frames.
          }
        }
      },
      onError: () => {
        // Don't flip the panel state to 'error' on a stream error — the
        // snapshot itself may be loaded and useful. Surface in the
        // status line.
        refs.status.textContent = `${refs.status.textContent} • (stream error)`
        closeStream()
      },
    })
  }

  // ---- External events ----

  // mythrun.watchcampaign fires when the user clicks Watch on the create
  // / details panel. We piggy-back on the same event the status +
  // live-events panels listen to, so all three panels track the same
  // campaign without a separate input.
  window.addEventListener('mythrun.watchcampaign', (e) => {
    const id = (e as CustomEvent<string>).detail
    if (typeof id !== 'string' || id.length === 0) return
    state.campaignId = id
    state.phase = null
    resetSnapshot()
    setState('idle')
    refs.status.textContent = `watching ${id} (waiting for world_snapshot_ready)`
    openStream(id)
  })

  // mythrun.closewatch: identity switch / explicit stop. Reset everything.
  window.addEventListener('mythrun.closewatch', () => {
    closeStream()
    state.campaignId = null
    state.phase = null
    resetSnapshot()
    setState('idle')
    refs.status.textContent = '(no campaign watched — fires once phase ≥ world_snapshot_ready)'
  })

  refs.retryBtn.addEventListener('click', () => {
    if (state.campaignId !== null) void fetchSnapshot()
  })
}
