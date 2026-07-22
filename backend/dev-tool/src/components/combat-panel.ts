// backend/dev-tool/src/components/combat-panel.ts
//
// MYT-75 Task 10 — combat L1 inspector. The dev-tool stand-in for the
// player combat screen (the real React screen is a Frontend ticket). It
// observes the three new combat frames the session channel emits —
// `mode_change`, `combat_started`, `combat_resolved` — and drives the
// `resume_combat` client frame that flips a resolved-combat session back
// to exploration.
//
// Transport: the session channel is a raw WebSocket (`GET
// /ws/session/:sessionId`), NOT an HTTP SSE stream — so this panel cannot
// use `openSse()` (which speaks the pipeline-status SSE). It mints a
// single-use ws-ticket over HTTP via `apiCall` (which stamps the
// `x-mythrun-dev-sub` identity header), then opens a real browser
// `WebSocket` to `/ws/session/:sessionId?ticket=...`. The handshake reads
// identity from the TICKET payload, never from a header — so the
// header-less browser WebSocket authenticates correctly (mirrors why
// native EventSource is unusable but the ticket flow is fine).
//
// Pattern: action-only. The socket is opened LAZILY on the Connect click,
// not on mount — so the panel reaches `data-state="ready"` synchronously
// and the JSDOM verifier (which has no WebSocket transport) never reaches
// the connect path. This mirrors session-ticket-panel: the dev-tool's WS
// surface is exercised at the HTTP-handshake level by the verifier and at
// the live-socket level by a human / wire smoke. The shell unmounts on
// identity switch, clearing the input; the unmount handler tears the
// socket down so no orphan connection survives a panel swap.

import { apiCall } from '../api-client.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

// ---- Combat frame shapes (mirror of contract/session-events.ts) ----
//
// Duplicated here (rather than imported across the dev-tool / backend src
// boundary) so the dev-tool tsconfig stays self-contained — same
// convention live-events-panel follows for the pipeline-event types. Any
// drift is caught by the backend-side contract tests.

interface ModeChangeFrame {
  readonly type: 'mode_change'
  readonly turnId?: string
  readonly seq?: number
  readonly from: 'exploration' | 'combat'
  readonly to: 'exploration' | 'combat'
  readonly reason: string
}

interface CombatEnemyFrame {
  readonly name: string
  readonly description: string
  readonly count: number
}

interface CombatInitiativeFrame {
  readonly combatant: string
  readonly roll: number
}

interface CombatStartedFrame {
  readonly type: 'combat_started'
  readonly turnId: string
  readonly seq?: number
  readonly enemies: readonly CombatEnemyFrame[]
  readonly initiative: readonly CombatInitiativeFrame[]
}

interface CombatCasualtyFrame {
  readonly name: string
  readonly type: 'pc' | 'npc'
  readonly fate: string
}

interface CombatHpChangeFrame {
  readonly combatant: string
  readonly hpBefore: number
  readonly hpAfter: number
  readonly maxHp: number
}

interface CombatResolvedFrame {
  readonly type: 'combat_resolved'
  readonly turnId: string
  readonly seq?: number
  readonly narration: string
  readonly outcome: 'victory' | 'defeat' | 'flee' | 'other'
  readonly casualties: readonly CombatCasualtyFrame[]
  readonly hpChanges: readonly CombatHpChangeFrame[]
}

export type CombatFrame =
  | ModeChangeFrame
  | CombatStartedFrame
  | CombatResolvedFrame

/** The combat-relevant frame types this inspector renders. Any other
 *  server frame on the channel (presence, chat, mechanical) is ignored —
 *  the inspector is scoped to the L1 combat surface. */
export const COMBAT_FRAME_TYPES = [
  'mode_change',
  'combat_started',
  'combat_resolved',
] as const

interface TicketResponse {
  readonly ticket: string
  readonly expiresAt: string
}

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = body.code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

/** Narrow a parsed JSON value to one of the combat frame shapes. Returns
 *  null for any non-combat frame (presence / chat / mechanical) or any
 *  value that isn't an object with a known combat `type`. Structural
 *  validation only (ZFC exception) — no semantic interpretation. */
export function classifyCombatFrame(value: unknown): CombatFrame | null {
  if (typeof value !== 'object' || value === null) return null
  const t = (value as { type?: unknown }).type
  if (typeof t !== 'string') return null
  if (!(COMBAT_FRAME_TYPES as readonly string[]).includes(t)) return null
  return value as CombatFrame
}

/** One-line summary for a combat frame, used as the rendered card header.
 *  Pure — exported so the test can assert the rendering without a socket. */
export function summarizeCombatFrame(frame: CombatFrame): string {
  switch (frame.type) {
    case 'mode_change':
      return `mode_change     ${frame.from} → ${frame.to}  (${frame.reason})`
    case 'combat_started':
      return `combat_started  ${String(frame.enemies.length)} enemy group(s), ${String(frame.initiative.length)} in initiative`
    case 'combat_resolved':
      return `combat_resolved ${frame.outcome}  ${String(frame.casualties.length)} casualt(y/ies), ${String(frame.hpChanges.length)} hp change(s)`
  }
}

function appendDetailLines(card: HTMLElement, frame: CombatFrame): void {
  const lines: string[] = []
  if (frame.type === 'combat_started') {
    for (const e of frame.enemies) {
      lines.push(`enemy: ${e.name} ×${String(e.count)} — ${e.description}`)
    }
    for (const i of frame.initiative) {
      lines.push(`init: ${i.combatant} rolled ${String(i.roll)}`)
    }
  } else if (frame.type === 'combat_resolved') {
    lines.push(`narration: ${frame.narration}`)
    for (const c of frame.casualties) {
      lines.push(`casualty: ${c.name} (${c.type}) — ${c.fate}`)
    }
    for (const h of frame.hpChanges) {
      lines.push(
        `hp: ${h.combatant} ${String(h.hpBefore)} → ${String(h.hpAfter)} / ${String(h.maxHp)}`,
      )
    }
  }
  for (const text of lines) {
    const line = document.createElement('div')
    line.style.fontSize = '11px'
    line.style.color = 'var(--fg-muted)'
    line.style.marginLeft = '8px'
    line.textContent = text
    card.appendChild(line)
  }
}

/** Build the WS URL for a sessionId + ticket. Relative to the page origin
 *  (Vite proxies /ws/* to the backend); ws://host for http, wss://host for
 *  https. The dev sub is carried by the ticket payload, not a header — so
 *  the header-less browser WebSocket authenticates from the ticket alone. */
export function buildWsUrl(sessionId: string, ticket: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const enc = encodeURIComponent(ticket)
  return `${proto}//${window.location.host}/ws/session/${sessionId}?ticket=${enc}`
}

/** The static DOM the panel builds on mount. Extracted so mountCombatPanel
 *  stays focused on socket wiring (keeps the mount fn under the line cap). */
interface CombatDom {
  readonly idInput: HTMLInputElement
  readonly connectBtn: HTMLButtonElement
  readonly resumeBtn: HTMLButtonElement
  readonly disconnectBtn: HTMLButtonElement
  readonly statusLine: HTMLDivElement
  readonly modeLine: HTMLDivElement
  readonly log: HTMLDivElement
  readonly idle: HTMLDivElement
}

function buildCombatDom(actionEl: HTMLElement, feedbackEl: HTMLElement): CombatDom {
  const idInput = document.createElement('input')
  idInput.type = 'text'
  idInput.placeholder = 'sessionId (paste a UUID)'
  idInput.style.width = '100%'
  idInput.style.marginBottom = '8px'
  actionEl.appendChild(idInput)

  const connectBtn = document.createElement('button')
  connectBtn.textContent = 'Connect'
  connectBtn.style.marginRight = '6px'
  actionEl.appendChild(connectBtn)

  const resumeBtn = document.createElement('button')
  resumeBtn.textContent = 'Resume (resume_combat)'
  resumeBtn.style.marginRight = '6px'
  resumeBtn.disabled = true
  actionEl.appendChild(resumeBtn)

  const disconnectBtn = document.createElement('button')
  disconnectBtn.textContent = 'Disconnect'
  disconnectBtn.disabled = true
  actionEl.appendChild(disconnectBtn)

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginTop = '8px'
  note.textContent =
    'Opens a real WebSocket to the session channel (mints a ws-ticket first) and renders mode_change / combat_started / combat_resolved frames. Resume sends resume_combat to flip a resolved-combat session back to exploration.'
  actionEl.appendChild(note)

  const statusLine = document.createElement('div')
  statusLine.style.fontSize = '12px'
  statusLine.style.color = 'var(--fg-muted)'
  statusLine.style.marginBottom = '8px'
  statusLine.textContent = 'socket: disconnected'
  feedbackEl.appendChild(statusLine)

  const modeLine = document.createElement('div')
  modeLine.style.fontSize = '12px'
  modeLine.style.color = 'var(--fg-emphasis)'
  modeLine.style.marginBottom = '8px'
  modeLine.textContent = 'mode: (unknown — no mode_change seen yet)'
  feedbackEl.appendChild(modeLine)

  const log = document.createElement('div')
  log.setAttribute('data-region', 'combat-log')
  feedbackEl.appendChild(log)

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(no combat frames yet)'
  log.appendChild(idle)

  return { idInput, connectBtn, resumeBtn, disconnectBtn, statusLine, modeLine, log, idle }
}

export function mountCombatPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /ws/session/:sessionId (combat L1)',
  })

  const {
    idInput,
    connectBtn,
    resumeBtn,
    disconnectBtn,
    statusLine,
    modeLine,
    log,
    idle,
  } = buildCombatDom(actionEl, feedbackEl)

  setState('ready')

  // The single live socket. Null when disconnected. Kept in closure so the
  // Resume button can send over it and unmount can tear it down.
  let socket: WebSocket | null = null

  function setConnected(connected: boolean): void {
    connectBtn.disabled = connected
    resumeBtn.disabled = !connected
    disconnectBtn.disabled = !connected
    statusLine.textContent = connected ? 'socket: connected' : 'socket: disconnected'
  }

  function renderFrame(frame: CombatFrame): void {
    if (idle.parentNode !== null) idle.remove()
    if (frame.type === 'mode_change') {
      modeLine.textContent = `mode: ${frame.to} (from ${frame.from})`
    }
    const card = document.createElement('div')
    card.style.borderLeft = '2px solid var(--border-soft)'
    card.style.padding = '4px 8px'
    card.style.marginBottom = '6px'
    const header = document.createElement('div')
    header.style.fontFamily = 'var(--mono)'
    header.style.fontSize = '12px'
    header.style.color = 'var(--fg-emphasis)'
    header.textContent = summarizeCombatFrame(frame)
    card.appendChild(header)
    appendDetailLines(card, frame)
    appendJsonDisclosure(card, frame)
    log.appendChild(card)
  }

  function handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // non-JSON frame — ignore (the inspector only reads combat frames)
    }
    const frame = classifyCombatFrame(parsed)
    if (frame !== null) renderFrame(frame)
  }

  function teardownSocket(): void {
    if (socket !== null) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
      socket = null
    }
    setConnected(false)
  }

  function openSocket(sessionId: string, ticket: string): void {
    const ws = new WebSocket(buildWsUrl(sessionId, ticket))
    socket = ws
    ws.onopen = (): void => {
      if (socket !== ws) return
      setConnected(true)
    }
    ws.onmessage = (ev: MessageEvent): void => {
      if (socket !== ws) return
      if (typeof ev.data === 'string') handleMessage(ev.data)
    }
    ws.onclose = (): void => {
      if (socket !== ws) return
      socket = null
      setConnected(false)
      statusLine.textContent = 'socket: closed by server'
    }
    ws.onerror = (): void => {
      if (socket !== ws) return
      statusLine.textContent = 'socket: error (see console)'
    }
  }

  async function connect(): Promise<void> {
    const sessionId = idInput.value.trim()
    if (sessionId.length === 0) {
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = 'paste a sessionId first'
      log.replaceChildren(m)
      return
    }
    teardownSocket()
    setState('loading')
    connectBtn.disabled = true
    // Mint a single-use ws-ticket. apiCall stamps the dev-sub header so the
    // mint route authorizes; the ticket then carries identity into the WS
    // handshake (which reads the ticket payload, not a header).
    const res = await apiCall<TicketResponse>(`/api/sessions/${sessionId}/ws-ticket`, {
      method: 'POST',
    })
    if (res.status !== 200 || res.body === null) {
      setState('error')
      connectBtn.disabled = false
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: 'ws-ticket mint failed (cannot open combat socket)',
        raw: res.body,
      })
      return
    }
    setState('ready')
    openSocket(sessionId, res.body.ticket)
  }

  function sendResume(): void {
    if (socket?.readyState !== WebSocket.OPEN) {
      statusLine.textContent = 'socket: not open — connect first'
      return
    }
    socket.send(JSON.stringify({ type: 'resume_combat' }))
    statusLine.textContent = 'socket: connected — resume_combat sent'
  }

  const onConnect = (): void => {
    void connect()
  }
  const onResume = (): void => {
    sendResume()
  }
  const onDisconnect = (): void => {
    teardownSocket()
  }
  connectBtn.addEventListener('click', onConnect)
  resumeBtn.addEventListener('click', onResume)
  disconnectBtn.addEventListener('click', onDisconnect)

  return {
    root,
    unmount: () => {
      connectBtn.removeEventListener('click', onConnect)
      resumeBtn.removeEventListener('click', onResume)
      disconnectBtn.removeEventListener('click', onDisconnect)
      teardownSocket()
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount('GET', '/ws/session/:sessionId', mountCombatPanel)
