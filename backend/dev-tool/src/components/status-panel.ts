// Paste-input campaignId + Watch/Stop buttons + live phase/stage display.
// The first SSE frame is the snapshot (event: snapshot); subsequent
// frames are live events (event defaults to 'message' for the bridge's
// pub/sub forward). Unknown event types are silently ignored — entity-*
// and edge-* events arrive once MYT-51 streaming stages ship; the live
// graph that renders them lands in MYT-52.
//
// Auth: openSse stamps `x-mythrun-dev-sub` from the identity switcher.
// The browser-native EventSource API can't set custom headers, which
// is why this panel uses a fetch-based SSE reader instead.

import { openSse, type SseConnection } from '../sse-client.js'

interface StageEntry {
  readonly stage: string
  readonly status: string
  readonly userId: string | null
  readonly costUsd: number
}

interface Snapshot {
  readonly phase: string
  readonly stages: readonly StageEntry[]
  readonly cumulativeCostUsd: number
}

interface LiveEvent {
  readonly type?: string
  readonly phase?: string
  readonly cumulativeUsd?: number
}

interface CloseEvent {
  readonly reason?: string
}

function renderSnapshot(
  snap: Snapshot,
  phaseEl: HTMLElement,
  stagesEl: HTMLElement,
  costEl: HTMLElement,
): void {
  phaseEl.textContent = `phase: ${snap.phase}`
  stagesEl.textContent = snap.stages
    .map(
      (s) =>
        `${s.stage.padEnd(28)} ${s.status.padEnd(10)} ${s.userId ?? '-'} $${s.costUsd.toFixed(4)}`,
    )
    .join('\n')
  costEl.textContent = `cumulative cost: $${snap.cumulativeCostUsd.toFixed(4)}`
}

function applyLiveEvent(parsed: LiveEvent, phaseEl: HTMLElement, costEl: HTMLElement): void {
  if (parsed.type === 'phase' && typeof parsed.phase === 'string') {
    phaseEl.textContent = `phase: ${parsed.phase}`
  } else if (parsed.type === 'cost-update' && typeof parsed.cumulativeUsd === 'number') {
    costEl.textContent = `cumulative cost: $${parsed.cumulativeUsd.toFixed(4)}`
  }
  // stage-started / stage-completed / stage-failed / job-failed: future
  // enhancement (re-render stage list incrementally). For Phase 0 we rely
  // on the snapshot frame on each reconnect for stage state.
}

export function mountStatusPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'

  const title = document.createElement('h2')
  title.textContent = 'Pipeline status'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'campaignId (paste a UUID)'
  input.style.width = '320px'

  const watchBtn = document.createElement('button')
  watchBtn.textContent = 'Watch'

  const stopBtn = document.createElement('button')
  stopBtn.textContent = 'Stop'
  stopBtn.disabled = true

  const phaseEl = document.createElement('div')
  phaseEl.className = 'result'
  phaseEl.textContent = '(no campaign watched)'

  const stagesEl = document.createElement('pre')
  stagesEl.className = 'result'

  const costEl = document.createElement('div')
  costEl.className = 'result'

  let conn: SseConnection | null = null

  function close(): void {
    if (conn) {
      conn.close()
      conn = null
    }
    watchBtn.disabled = false
    stopBtn.disabled = true
    input.disabled = false
  }

  function watch(): void {
    const id = input.value.trim()
    if (!id) return
    watchBtn.disabled = true
    stopBtn.disabled = false
    input.disabled = true
    phaseEl.textContent = `phase: (connecting to /api/campaigns/${id}/status/stream)`
    stagesEl.textContent = ''
    costEl.textContent = ''

    conn = openSse(`/api/campaigns/${id}/status/stream`, {
      onEvent: (ev) => {
        if (ev.event === 'snapshot') {
          try {
            renderSnapshot(JSON.parse(ev.data) as Snapshot, phaseEl, stagesEl, costEl)
          } catch (err) {
            phaseEl.textContent = `error parsing snapshot: ${err instanceof Error ? err.message : String(err)}`
          }
        } else if (ev.event === 'close') {
          try {
            const payload = JSON.parse(ev.data) as CloseEvent
            phaseEl.textContent = `phase: (server closed — reason: ${payload.reason ?? 'unknown'})`
          } catch {
            phaseEl.textContent = 'phase: (server closed)'
          }
          close()
        } else if (ev.event === 'message') {
          try {
            applyLiveEvent(JSON.parse(ev.data) as LiveEvent, phaseEl, costEl)
          } catch {
            // Ignore unparseable frames.
          }
        }
        // Unknown event types (entity-*, edge-*) are forwarded by the
        // bridge but not rendered here — MYT-52 lands the live-graph UI.
      },
      onError: (err) => {
        phaseEl.textContent = `phase: (connection error: ${err.message})`
        close()
      },
    })
  }

  watchBtn.addEventListener('click', watch)
  stopBtn.addEventListener('click', close)

  const inputRow = document.createElement('div')
  inputRow.style.display = 'flex'
  inputRow.style.gap = '8px'
  inputRow.style.marginBottom = '12px'
  inputRow.appendChild(input)
  inputRow.appendChild(watchBtn)
  inputRow.appendChild(stopBtn)

  card.appendChild(title)
  card.appendChild(inputRow)
  card.appendChild(phaseEl)
  card.appendChild(stagesEl)
  card.appendChild(costEl)
  parent.appendChild(card)
}
