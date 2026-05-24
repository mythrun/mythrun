// backend/dev-tool/src/components/status-panel.ts
//
// myth-rdwq P6.B — GET /api/campaigns/:campaignId/status.
// Refactored to the panel-skeleton shape (action pane + feedback pane,
// PanelHandle return).
//
// Action: Refresh button.
// Feedback: pipeline_runs status snapshot (phase + stage table +
// cumulative cost). The live SSE feed migrated to the wire-log drawer
// per spec §6; this panel just renders the polled snapshot.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

interface StageEntry {
  readonly stage: string
  readonly status: string
  readonly userId: string | null
  readonly costUsd: number
  // myth-zeiw: timestamps for per-stage duration. ISO-8601 on the wire;
  // null for stages that haven't started (pending) or haven't completed
  // (running). Duration is computed locally so the running-stage cell
  // can tick every 1s without re-fetching.
  readonly startedAt: string | null
  readonly completedAt: string | null
}

interface StatusSnapshot {
  readonly phase: string
  readonly stages: readonly StageEntry[]
  readonly cumulativeCostUsd: number
}

// Format a millisecond delta as "Ns" or "Nm Ms" (e.g. 42s, 3m 12s).
// myth-zeiw: tiny helper, no i18n, mono-friendly.
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${String(totalSec)}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m)}m ${String(s)}s`
}

// Compute the duration cell for a stage at the given `now`. Running
// rows count up from started_at; completed rows are fixed; pending /
// failed-without-completion / unknown render an em-dash. Failed rows
// with both timestamps surface as "failed @ <duration>" so the user
// can see how long the stage burned before giving up.
function durationCell(s: StageEntry, now: number): string {
  // Treat undefined the same as null. Older snapshot bodies (and the
  // pre-myth-zeiw test fixtures) carry neither field; the row should
  // still render with an em-dash fallback rather than NaN.
  const startedAt = s.startedAt ?? null
  const completedAt = s.completedAt ?? null
  if (s.status === 'completed' && startedAt !== null && completedAt !== null) {
    const started = Date.parse(startedAt)
    const completed = Date.parse(completedAt)
    return formatDuration(completed - started)
  }
  if (s.status === 'running' && startedAt !== null) {
    const started = Date.parse(startedAt)
    return formatDuration(now - started)
  }
  if (s.status === 'failed' && startedAt !== null && completedAt !== null) {
    const started = Date.parse(startedAt)
    const completed = Date.parse(completedAt)
    return `failed @ ${formatDuration(completed - started)}`
  }
  return '—'
}

function renderStageRows(snap: StatusSnapshot, now: number): string {
  return snap.stages
    .map((s) => {
      const stage = s.stage.padEnd(28)
      const status = s.status.padEnd(10)
      const user = (s.userId ?? '-').padEnd(38)
      const cost = `$${s.costUsd.toFixed(4)}`.padEnd(10)
      const dur = durationCell(s, now)
      return `${stage} ${status} ${user} ${cost} ${dur}`
    })
    .join('\n')
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

function isSnapshot(body: unknown): body is StatusSnapshot {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return (
    typeof b.phase === 'string' &&
    Array.isArray(b.stages) &&
    typeof b.cumulativeCostUsd === 'number'
  )
}

interface RenderedSnapshot {
  // The DOM nodes holding each piece of the rendered snapshot. The 3s
  // poll's in-place update + the 1s local tick both rewrite these
  // nodes' textContent so durations count up + new stages appear
  // without re-flowing the rest of the panel.
  readonly phaseEl: HTMLDivElement
  readonly stagesEl: HTMLPreElement
  readonly costEl: HTMLDivElement
  snap: StatusSnapshot
}

function renderSnapshot(parent: HTMLElement, snap: StatusSnapshot): RenderedSnapshot {
  const phaseEl = document.createElement('div')
  phaseEl.style.fontFamily = 'var(--mono)'
  phaseEl.textContent = `phase: ${snap.phase}`
  parent.appendChild(phaseEl)

  const stagesEl = document.createElement('pre')
  stagesEl.style.fontFamily = 'var(--mono)'
  stagesEl.style.fontSize = '12px'
  stagesEl.style.marginTop = '8px'
  // myth-timer-overflow fix: pre has fixed-width fields (padEnd) that
  // overflow the container in narrower pages. Allow horizontal scroll
  // inside the <pre> instead of pushing the duration cell off-screen.
  stagesEl.style.overflowX = 'auto'
  stagesEl.style.whiteSpace = 'pre'
  stagesEl.style.maxWidth = '100%'
  stagesEl.setAttribute('data-role', 'stage-table')
  stagesEl.textContent = renderStageRows(snap, Date.now())
  parent.appendChild(stagesEl)

  const costEl = document.createElement('div')
  costEl.style.marginTop = '8px'
  costEl.textContent = `cumulative cost: $${snap.cumulativeCostUsd.toFixed(4)}`
  parent.appendChild(costEl)

  return { phaseEl, stagesEl, costEl, snap }
}

export function mountStatusPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/campaigns/:campaignId/status',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Polled snapshot of pipeline_runs. The live SSE feed lives in the wire-log drawer.'
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

  // myth-zeiw: most-recently-rendered snapshot, captured so the 1s tick
  // can recompute running-stage durations without re-fetching. Null
  // until the first successful fetch lands.
  let lastRendered: RenderedSnapshot | null = null

  async function refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      feedbackEl.replaceChildren()
      lastRendered = null
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent =
        '(this endpoint requires an active campaign — pick one in GET /api/campaigns/mine)'
      feedbackEl.appendChild(m)
      return
    }
    // myth-jitter fix: only wipe + rebuild on the FIRST fetch (no
    // lastRendered yet) or when the user clicked Refresh explicitly.
    // Auto-refresh polls update the existing snapshot in place so the
    // DOM doesn't flash + the scroll position doesn't reset.
    const isFirstOrUserDriven = !opts.silent || lastRendered === null
    if (isFirstOrUserDriven) {
      setState('loading')
      feedbackEl.replaceChildren()
      lastRendered = null
      refreshBtn.disabled = true
    }

    const res = await apiCall(`/api/campaigns/${id}/status`)

    refreshBtn.disabled = false

    if (res.status !== 200 || !isSnapshot(res.body)) {
      // Errors always wipe + rerender — the panel is in a different
      // state now and the user needs to see it.
      feedbackEl.replaceChildren()
      lastRendered = null
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'Status fetch failed',
        raw: res.body,
      })
      return
    }

    setState('ready')
    if (lastRendered !== null) {
      // In-place update: snap → re-render stage rows + phase + cost
      // without removing the DOM. The JSON disclosure is left as-is
      // (it's snapshot-of-last-click anyway; user can re-expand to
      // see the live body, or click Refresh for a full re-render).
      lastRendered.snap = res.body
      lastRendered.stagesEl.textContent = renderStageRows(res.body, Date.now())
      lastRendered.phaseEl.textContent = `phase: ${res.body.phase}`
      lastRendered.costEl.textContent = `cumulative cost: $${res.body.cumulativeCostUsd.toFixed(4)}`
      return
    }
    lastRendered = renderSnapshot(feedbackEl, res.body)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  const onClick = (): void => {
    void refresh()
  }
  refreshBtn.addEventListener('click', onClick)

  // myth-0nmz: auto-refresh on a 3s interval while the panel is mounted.
  // The drawer's SSE bus exists but no plumbing pipes events into per-
  // panel callbacks today (a known gap the workflow-page reorg will fix);
  // polling at 3s gives the user a live-ish view during world-gen without
  // re-architecting per-panel subscription plumbing.
  void refresh()
  const pollTimer = setInterval(() => {
    void refresh({ silent: true })
  }, 3000)

  // myth-zeiw: 1s local tick. Re-renders the stage-table textContent of
  // the last-fetched snapshot so running-stage durations count up
  // visibly between the 3s server polls. Touches the same <pre> node
  // (data-role="stage-table"); no fetch, no re-flow of the rest of the
  // panel. If the snapshot has no running stages the recompute is a
  // no-op string rebuild — cheap and not worth gating.
  const tickTimer = setInterval(() => {
    if (lastRendered === null) return
    lastRendered.stagesEl.textContent = renderStageRows(lastRendered.snap, Date.now())
  }, 1000)

  return {
    root,
    unmount: () => {
      clearInterval(pollTimer)
      clearInterval(tickTimer)
      refreshBtn.removeEventListener('click', onClick)
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId/status', mountStatusPanel)
