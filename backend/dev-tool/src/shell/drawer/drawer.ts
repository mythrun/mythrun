// backend/dev-tool/src/shell/drawer/drawer.ts
//
// myth-mbdc: right-side persistent wire-log drawer. UI shell for
// the subscriptions / buffer / event-bus trio. Collapsible; default
// open. Pause + clear + export controls land in P4.5.

import type { EventBus } from './event-bus.js'
import type { SubscriptionManager, DrawerEvent } from './subscriptions.js'
import type { RingBuffer } from './buffer.js'

export interface DrawerDeps {
  readonly subscriptions: SubscriptionManager
  readonly bus: EventBus<DrawerEvent>
  readonly buffer: RingBuffer<DrawerEvent>
}

export interface DrawerHandle {
  readonly root: HTMLElement
  unmount(): void
}

const STORAGE_OPEN = 'devtool.drawer.open'
const STORAGE_PAUSED = 'devtool.drawer.paused'

function fmtTime(receivedAt: number): string {
  const d = new Date(receivedAt)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function shortId(v: unknown): string {
  if (typeof v !== 'string') return String(v)
  if (v.startsWith('new-')) return v
  if (v.length >= 8) return `${v.slice(0, 8)}…`
  return v
}

function fmtCost(v: unknown): string {
  if (typeof v !== 'number') return '?'
  return `$${v.toFixed(4)}`
}

function fmtDuration(ms: unknown): string {
  if (typeof ms !== 'number') return '?'
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  const s = Math.round(ms / 100) / 10
  return `${s.toFixed(1)}s`
}

/** Truncate a content blob to ~40 chars + ellipsis for the inline fact
 *  summary. Full content remains one click away in the JSON disclosure. */
function shortContent(v: unknown): string {
  if (typeof v !== 'string') return String(v)
  return v.length > 40 ? `${v.slice(0, 40)}…` : v
}

/**
 * Produce a one-line summary of the most useful fields for a given event
 * type. Returns null when no inline summary is available (the row will
 * still expand to show the raw payload).
 *
 * The summary is intentionally a SHORT STRING — full payload is still
 * one click away in the disclosure. Optimize for "what is happening?" at
 * a glance: which stage, which entity name, which relationship, etc.
 */
function summarize(e: DrawerEvent): string | null {
  const d = e.data
  switch (e.type) {
    case 'snapshot': {
      const phase = typeof d.phase === 'string' ? d.phase : '?'
      const stages = Array.isArray(d.stages) ? `${String(d.stages.length)} stages` : ''
      return [phase, stages].filter(Boolean).join(' · ')
    }
    case 'phase':
      return typeof d.phase === 'string' ? d.phase : null
    case 'stage-started':
      return typeof d.stage === 'string' ? d.stage : null
    case 'stage-completed': {
      const stage = typeof d.stage === 'string' ? d.stage : '?'
      return `${stage} · ${fmtDuration(d.durationMs)} · ${fmtCost(d.costUsd)}`
    }
    case 'stage-failed': {
      const stage = typeof d.stage === 'string' ? d.stage : '?'
      const code = typeof d.errorCode === 'string' ? d.errorCode : '?'
      const retry = d.willRetry === true ? ' (will retry)' : ''
      return `${stage} · ${code}${retry}`
    }
    case 'stage-reset':
      return typeof d.stage === 'string' ? d.stage : null
    case 'cost-update':
      return fmtCost(d.cumulativeUsd)
    case 'job-failed': {
      const job = typeof d.jobType === 'string' ? d.jobType : '?'
      const code = typeof d.errorCode === 'string' ? d.errorCode : '?'
      return `${job} · ${code}`
    }
    case 'entity-added': {
      const kind = typeof d.entityKind === 'string' ? d.entityKind : '?'
      const name = typeof d.name === 'string' ? d.name : '?'
      return `${kind}: ${name}`
    }
    case 'entity-updated':
      return typeof d.synthKey === 'string' ? d.synthKey : null
    case 'entity-removed': {
      const key = typeof d.synthKey === 'string' ? d.synthKey : '?'
      const reason = typeof d.reason === 'string' ? d.reason : '?'
      return `${key} · ${reason}`
    }
    case 'edge-added': {
      const rel = typeof d.relationship === 'string' ? d.relationship : '?'
      const from = shortId(d.from)
      const to = shortId(d.to)
      return `${from} —${rel}→ ${to}`
    }
    case 'edge-removed': {
      const key = typeof d.synthKey === 'string' ? d.synthKey : '?'
      const reason = typeof d.reason === 'string' ? d.reason : '?'
      return `${key} · ${reason}`
    }
    // myth-imxg: per-fact wire events. Glyphs (+ / − / ~) signal the
    // add/remove/update flavor at a glance; topic identifies the
    // semantic slot; content snippet shows the new prose. fact-removed
    // has no content — just the factId so the operator can grep for it.
    case 'fact-added': {
      const topic = typeof d.topic === 'string' ? d.topic : '?'
      const content = shortContent(d.content)
      return `+ fact [${topic}] ${content}`
    }
    case 'fact-removed': {
      const id = shortId(d.factId)
      return `− fact ${id}`
    }
    case 'fact-updated': {
      const topic = typeof d.topic === 'string' ? d.topic : '?'
      const content = shortContent(d.content)
      return `~ fact [${topic}] ${content}`
    }
    case 'finalized': {
      // synthKey is `stage/path/index`; entity id resolves a placeholder.
      const key = typeof d.synthKey === 'string' ? d.synthKey : '?'
      return key
    }
    case 'close': {
      const reason = typeof d.reason === 'string' ? d.reason : '?'
      return reason
    }
    default:
      return null
  }
}

function renderRow(e: DrawerEvent): HTMLElement {
  const details = document.createElement('details')
  details.style.marginBottom = '4px'
  details.style.cursor = 'pointer'

  const summary = document.createElement('summary')
  summary.style.listStyle = 'none'
  summary.style.outline = 'none'
  summary.style.userSelect = 'text'
  // Hide the default disclosure triangle Safari/Firefox add to <summary>.
  summary.style.display = 'block'

  const ts = document.createElement('span')
  ts.style.color = 'var(--fg-muted)'
  ts.textContent = fmtTime(e.receivedAt)
  summary.appendChild(ts)

  const type = document.createElement('span')
  type.style.color = 'var(--accent)'
  type.style.marginLeft = '6px'
  type.textContent = e.type
  summary.appendChild(type)

  const summaryText = summarize(e)
  if (summaryText !== null) {
    const sep = document.createElement('span')
    sep.style.color = 'var(--fg-subtle)'
    sep.style.marginLeft = '4px'
    sep.textContent = '·'
    summary.appendChild(sep)

    const inline = document.createElement('span')
    inline.style.color = 'var(--fg-emphasis)'
    inline.style.marginLeft = '4px'
    inline.textContent = summaryText
    summary.appendChild(inline)
  }

  const cid = document.createElement('span')
  cid.style.color = 'var(--fg-muted)'
  cid.style.marginLeft = '6px'
  cid.style.opacity = '0.6'
  cid.textContent = `· ${e.campaignId.slice(0, 8)}`
  summary.appendChild(cid)

  details.appendChild(summary)

  // Lazy-render the payload disclosure on first open. Keeps the DOM
  // light when the buffer hits 500 events and the operator never
  // expands any of them.
  let payloadRendered = false
  details.addEventListener('toggle', () => {
    if (payloadRendered || !details.open) return
    payloadRendered = true
    const pre = document.createElement('pre')
    pre.style.margin = '4px 0 0 12px'
    pre.style.padding = '6px 8px'
    pre.style.background = 'var(--bg-default)'
    pre.style.border = '1px solid var(--border-soft)'
    pre.style.borderRadius = '3px'
    pre.style.fontSize = '10px'
    pre.style.lineHeight = '1.4'
    pre.style.whiteSpace = 'pre-wrap'
    pre.style.wordBreak = 'break-all'
    pre.style.color = 'var(--fg-emphasis)'
    pre.textContent = JSON.stringify(e.data, null, 2)
    details.appendChild(pre)
  })

  return details
}

export function mountDrawer(parent: HTMLElement, deps: DrawerDeps): DrawerHandle {
  const root = document.createElement('aside')
  root.setAttribute('data-region', 'drawer')
  root.setAttribute('data-state', 'ready')
  root.style.flex = '0 0 320px'
  root.style.borderLeft = '1px solid var(--border-soft)'
  root.style.background = 'var(--bg-elevated)'
  root.style.display = 'flex'
  root.style.flexDirection = 'column'
  root.style.maxHeight = '100vh'

  const header = document.createElement('div')
  header.style.padding = '6px 10px'
  header.style.borderBottom = '1px solid var(--border-soft)'
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = 'center'
  const title = document.createElement('div')
  title.className = 'label-small'
  title.style.color = 'var(--fg-emphasis)'
  title.textContent = `WIRE LOG · ${String(deps.buffer.size())}`
  header.appendChild(title)
  root.appendChild(header)

  const list = document.createElement('div')
  list.style.padding = '6px 10px'
  list.style.overflow = 'auto'
  list.style.flex = '1'
  list.style.fontSize = '10px'
  list.style.lineHeight = '1.4'
  root.appendChild(list)

  let paused = localStorage.getItem(STORAGE_PAUSED) === 'true'

  function render(): void {
    list.replaceChildren()
    for (const e of deps.buffer.items()) {
      list.appendChild(renderRow(e))
    }
    title.textContent = `WIRE LOG · ${String(deps.buffer.size())}`
  }

  const unsubBus = deps.bus.subscribe((event) => {
    deps.buffer.push(event)
    if (!paused) {
      render()
      list.scrollTop = list.scrollHeight
    }
  })

  render()

  const controls = document.createElement('div')
  controls.style.display = 'flex'
  controls.style.gap = '4px'

  const pauseBtn = document.createElement('button')
  pauseBtn.className = 'secondary'
  pauseBtn.setAttribute('data-action', 'pause')
  pauseBtn.textContent = paused ? '▶' : '⏸'
  pauseBtn.title = paused ? 'resume' : 'pause'
  pauseBtn.addEventListener('click', () => {
    paused = !paused
    localStorage.setItem(STORAGE_PAUSED, String(paused))
    pauseBtn.textContent = paused ? '▶' : '⏸'
    pauseBtn.title = paused ? 'resume' : 'pause'
    if (!paused) render()
  })
  controls.appendChild(pauseBtn)

  const clearBtn = document.createElement('button')
  clearBtn.className = 'secondary'
  clearBtn.setAttribute('data-action', 'clear')
  clearBtn.textContent = '↻'
  clearBtn.title = 'clear buffer'
  clearBtn.addEventListener('click', () => {
    deps.buffer.clear()
    render()
  })
  controls.appendChild(clearBtn)

  const exportBtn = document.createElement('button')
  exportBtn.className = 'secondary'
  exportBtn.setAttribute('data-action', 'export')
  exportBtn.textContent = '▸'
  exportBtn.title = 'export to clipboard'
  exportBtn.addEventListener('click', () => {
    const json = deps.buffer.items().map((e) => JSON.stringify(e)).join('\n')
    void navigator.clipboard.writeText(json)
  })
  controls.appendChild(exportBtn)

  header.appendChild(controls)

  // Apply persisted open/collapsed state
  if (localStorage.getItem(STORAGE_OPEN) === 'false') {
    root.style.flex = '0 0 36px'
    list.style.display = 'none'
    header.style.justifyContent = 'center'
  }

  parent.appendChild(root)

  return {
    root,
    unmount: () => {
      unsubBus()
      parent.removeChild(root)
    },
  }
}
