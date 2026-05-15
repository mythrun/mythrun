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
  stage: string
  status: string
  userId: string | null
  costUsd: number
}

interface Snapshot {
  readonly phase: string
  readonly stages: readonly StageEntry[]
  readonly cumulativeCostUsd: number
}

interface LiveEvent {
  readonly type?: string
  // Phase events:
  readonly phase?: string
  // Cost-update events:
  readonly cumulativeUsd?: number
  // Stage-* events:
  readonly stage?: string
  readonly userId?: string | null
  readonly costUsd?: number
  readonly errorCode?: string
}

interface CloseEvent {
  readonly reason?: string
}

function renderStages(stages: readonly StageEntry[], stagesEl: HTMLElement): void {
  stagesEl.textContent = stages
    .map(
      (s) =>
        `${s.stage.padEnd(28)} ${s.status.padEnd(10)} ${s.userId ?? '-'} $${s.costUsd.toFixed(4)}`,
    )
    .join('\n')
}

function findOrAppendStage(stages: StageEntry[], stage: string, userId: string | null): StageEntry {
  const existing = stages.find((s) => s.stage === stage && s.userId === userId)
  if (existing) return existing
  const row: StageEntry = { stage, status: 'pending', userId, costUsd: 0 }
  stages.push(row)
  return row
}

// Mutates the stages array in place from a stage-* lifecycle event and
// re-renders. Snapshot frame populates initial state; subsequent
// stage-started / stage-completed / stage-failed events patch the rows
// they reference. This is the fix for "stage table frozen at snapshot
// state while phase + cumulative cost progress."
function applyStageEvent(parsed: LiveEvent, stages: StageEntry[], stagesEl: HTMLElement): boolean {
  if (typeof parsed.stage !== 'string' || parsed.stage.length === 0) return false
  const userId = parsed.userId ?? null
  const row = findOrAppendStage(stages, parsed.stage, userId)
  if (parsed.type === 'stage-started') {
    row.status = 'running'
  } else if (parsed.type === 'stage-completed') {
    row.status = 'completed'
    if (typeof parsed.costUsd === 'number') row.costUsd = parsed.costUsd
  } else if (parsed.type === 'stage-failed') {
    row.status = 'failed'
  } else {
    return false
  }
  renderStages(stages, stagesEl)
  return true
}

export function mountStatusPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'
  // Event-driven panel: nothing fetches on mount; the watcher only
  // activates when the create panel dispatches mythrun.watchcampaign
  // or the user clicks Watch. data-state="idle" is the verify harness's
  // signal that the panel reached its mount-time steady state.
  card.setAttribute('data-state', 'idle')

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
  // Per-watch mutable state. Snapshot frame populates this; subsequent
  // stage-* / phase / cost-update events patch it. Closing the stream
  // does NOT clear it — the user keeps seeing the last-known state until
  // they click Watch again on the same or a different campaign.
  let stages: StageEntry[] = []

  function close(): void {
    if (conn) {
      conn.close()
      conn = null
    }
    watchBtn.disabled = false
    stopBtn.disabled = true
    input.disabled = false
  }

  function applyMessage(parsed: LiveEvent): void {
    if (parsed.type === 'phase' && typeof parsed.phase === 'string') {
      phaseEl.textContent = `phase: ${parsed.phase}`
      return
    }
    if (parsed.type === 'cost-update' && typeof parsed.cumulativeUsd === 'number') {
      costEl.textContent = `cumulative cost: $${parsed.cumulativeUsd.toFixed(4)}`
      return
    }
    if (
      parsed.type === 'stage-started' ||
      parsed.type === 'stage-completed' ||
      parsed.type === 'stage-failed'
    ) {
      applyStageEvent(parsed, stages, stagesEl)
    }
    // Unknown event types (entity-*, edge-*) silently ignored — the
    // bridge forwards them but MYT-52's live-graph UI is where they land.
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
    stages = []

    conn = openSse(`/api/campaigns/${id}/status/stream`, {
      onEvent: (ev) => {
        if (ev.event === 'snapshot') {
          try {
            const snap = JSON.parse(ev.data) as Snapshot
            phaseEl.textContent = `phase: ${snap.phase}`
            // Clone into a mutable array the live events can patch.
            stages = snap.stages.map((s) => ({
              stage: s.stage,
              status: s.status,
              userId: s.userId,
              costUsd: s.costUsd,
            }))
            renderStages(stages, stagesEl)
            costEl.textContent = `cumulative cost: $${snap.cumulativeCostUsd.toFixed(4)}`
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
            applyMessage(JSON.parse(ev.data) as LiveEvent)
          } catch {
            // Ignore unparseable frames.
          }
        }
      },
      onError: (err) => {
        phaseEl.textContent = `phase: (connection error: ${err.message})`
        close()
      },
    })
  }

  watchBtn.addEventListener('click', watch)
  stopBtn.addEventListener('click', close)

  // External triggers (MYT-51 T13).
  //
  // mythrun.watchcampaign: dispatched by the create panel on 201 — drop
  // the new campaignId into the input + start watching its SSE stream.
  //
  // mythrun.closewatch: dispatched by main.ts on identity-switch (per
  // Kraken-Imp6 — switching identity must close any open SSE stream so
  // the new identity's first call doesn't share an EventSource with the
  // previous identity's snapshot).
  window.addEventListener('mythrun.watchcampaign', (e) => {
    const id = (e as CustomEvent<string>).detail
    if (typeof id !== 'string' || id.length === 0) return
    close()
    input.value = id
    watch()
  })
  window.addEventListener('mythrun.closewatch', () => {
    close()
    input.value = ''
    phaseEl.textContent = '(no campaign watched)'
    stagesEl.textContent = ''
    costEl.textContent = ''
  })

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
