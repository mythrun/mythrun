// Paste-input campaignId + Watch/Stop buttons + live phase/stage display.
// Opens an EventSource on /api/campaigns/{id}/status/stream. The first
// SSE frame is the snapshot (event: snapshot); subsequent frames are
// live events. Unknown event types are silently ignored — entity-* and
// edge-* events arrive once MYT-51 streaming stages ship; the live
// graph that renders them lands in MYT-52.
//
// Auth note: EventSource is same-origin (Vite dev server proxies
// /api/* to the backend), so the browser carries cookies automatically.
// The dev-tool identity header (x-mythrun-dev-sub) cannot be set on
// EventSource (the API takes no headers init), so this panel relies on
// the bypass route's fallback identity in dev — matching how the SSE
// surface is gated in production (Cognito session cookie).

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

function applyLiveEvent(
  parsed: LiveEvent,
  phaseEl: HTMLElement,
  costEl: HTMLElement,
): void {
  if (parsed.type === 'phase' && typeof parsed.phase === 'string') {
    phaseEl.textContent = `phase: ${parsed.phase}`
  } else if (
    parsed.type === 'cost-update' &&
    typeof parsed.cumulativeUsd === 'number'
  ) {
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

  let source: EventSource | null = null

  function close(): void {
    if (source) {
      source.close()
      source = null
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
    const es = new EventSource(`/api/campaigns/${id}/status/stream`)
    source = es

    es.addEventListener('snapshot', (e: MessageEvent<string>): void => {
      try {
        renderSnapshot(JSON.parse(e.data) as Snapshot, phaseEl, stagesEl, costEl)
      } catch (err) {
        phaseEl.textContent = `error parsing snapshot: ${err instanceof Error ? err.message : String(err)}`
      }
    })

    es.addEventListener('message', (e: MessageEvent<string>): void => {
      try {
        applyLiveEvent(JSON.parse(e.data) as LiveEvent, phaseEl, costEl)
      } catch {
        // Ignore unparseable frames (keepalive comments don't fire onmessage anyway).
      }
    })

    es.addEventListener('close', (e: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(e.data) as CloseEvent
        phaseEl.textContent = `phase: (server closed — reason: ${payload.reason ?? 'unknown'})`
      } catch {
        phaseEl.textContent = 'phase: (server closed)'
      }
      close()
    })

    es.onerror = (): void => {
      if (source?.readyState === EventSource.CLOSED) {
        phaseEl.textContent = 'phase: (connection closed)'
        close()
      }
    }
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
