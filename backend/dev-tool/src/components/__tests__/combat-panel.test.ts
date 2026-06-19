// @vitest-environment jsdom
//
// MYT-75 Task 10 — DOM tests for mountCombatPanel (the combat L1
// inspector). Exercises the PanelHandle contract (root + unmount), the
// data-state cycle (ready → loading → ready on a 200 ws-ticket mint,
// error on a non-2xx mint, no mint on empty sessionId), the live-socket
// frame rendering (mode_change / combat_started / combat_resolved), the
// resume_combat send, and the pure exported helpers (classifyCombatFrame,
// summarizeCombatFrame, buildWsUrl).
//
// The session channel is a real WebSocket, so the panel opens a browser
// `WebSocket` on the Connect click; JSDOM has none, so the test installs
// a controllable FakeWebSocket on the global before the connect path runs.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import {
  mountCombatPanel,
  classifyCombatFrame,
  summarizeCombatFrame,
  buildWsUrl,
  COMBAT_FRAME_TYPES,
  type CombatFrame,
} from '../combat-panel.js'

const apiCallMock = vi.mocked(apiCall)

interface GlobalDom {
  document?: Document | undefined
  window?: Window | undefined
  localStorage?: Storage | undefined
  HTMLElement?: typeof HTMLElement | undefined
  CustomEvent?: typeof CustomEvent | undefined
  WebSocket?: typeof WebSocket | undefined
}

const g = globalThis as unknown as GlobalDom
let saved: GlobalDom = {}
let dom: JSDOM

// ---- Controllable WebSocket stub ----
//
// Captures the constructed instance so a test can drive onopen / onmessage
// / onclose and assert send() payloads. readyState starts CONNECTING; the
// test flips it to OPEN by calling triggerOpen.

const WS_OPEN = 1

class FakeWebSocket {
  static readonly OPEN = WS_OPEN
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  triggerOpen(): void {
    this.readyState = WS_OPEN
    this.onopen?.({})
  }

  triggerMessage(data: unknown): void {
    this.onmessage?.({ data })
  }

  triggerClose(): void {
    this.onclose?.({})
  }

  triggerError(): void {
    this.onerror?.({})
  }
}

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  saved = {
    document: g.document,
    window: g.window,
    localStorage: g.localStorage,
    HTMLElement: g.HTMLElement,
    CustomEvent: g.CustomEvent,
    WebSocket: g.WebSocket,
  }
  g.document = dom.window.document
  g.window = dom.window as unknown as Window
  g.localStorage = dom.window.localStorage
  g.HTMLElement = dom.window.HTMLElement
  g.CustomEvent = dom.window.CustomEvent
  g.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterAll(() => {
  g.document = saved.document
  g.window = saved.window
  g.localStorage = saved.localStorage
  g.HTMLElement = saved.HTMLElement
  g.CustomEvent = saved.CustomEvent
  g.WebSocket = saved.WebSocket
})

function makeParent(): HTMLElement {
  const p = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(p)
  return p
}

beforeEach(() => {
  dom.window.document.body.replaceChildren()
  apiCallMock.mockReset()
  dom.window.localStorage.clear()
  FakeWebSocket.instances = []
})

function buttons(root: HTMLElement): {
  connect: HTMLButtonElement
  resume: HTMLButtonElement
  disconnect: HTMLButtonElement
} {
  const all = [...root.querySelectorAll('button')]
  const connect = all[0]
  const resume = all[1]
  const disconnect = all[2]
  if (connect === undefined || resume === undefined || disconnect === undefined) {
    throw new Error('expected three buttons')
  }
  return { connect, resume, disconnect }
}

describe('classifyCombatFrame', () => {
  it('returns the frame for each known combat type', () => {
    for (const t of COMBAT_FRAME_TYPES) {
      const v = { type: t }
      expect(classifyCombatFrame(v)).toBe(v)
    }
  })

  it('returns null for non-combat / malformed values', () => {
    expect(classifyCombatFrame(null)).toBeNull()
    expect(classifyCombatFrame(42)).toBeNull()
    expect(classifyCombatFrame({})).toBeNull()
    expect(classifyCombatFrame({ type: 123 })).toBeNull()
    expect(classifyCombatFrame({ type: 'player_message' })).toBeNull()
  })
})

describe('summarizeCombatFrame', () => {
  it('summarizes mode_change', () => {
    const f: CombatFrame = {
      type: 'mode_change',
      from: 'exploration',
      to: 'combat',
      reason: 'ambush',
    }
    expect(summarizeCombatFrame(f)).toContain('exploration → combat')
    expect(summarizeCombatFrame(f)).toContain('ambush')
  })

  it('summarizes combat_started', () => {
    const f: CombatFrame = {
      type: 'combat_started',
      turnId: 't1',
      enemies: [{ name: 'Goblin', description: 'small', count: 3 }],
      initiative: [{ combatant: 'Goblin', roll: 12 }],
    }
    expect(summarizeCombatFrame(f)).toContain('combat_started')
    expect(summarizeCombatFrame(f)).toContain('1 enemy group')
  })

  it('summarizes combat_resolved', () => {
    const f: CombatFrame = {
      type: 'combat_resolved',
      turnId: 't1',
      narration: 'The party prevails.',
      outcome: 'victory',
      casualties: [{ name: 'Goblin', type: 'npc', fate: 'slain' }],
      hpChanges: [{ combatant: 'Hero', hpBefore: 10, hpAfter: 7, maxHp: 12 }],
    }
    expect(summarizeCombatFrame(f)).toContain('victory')
  })
})

describe('buildWsUrl', () => {
  it('uses ws:// for http origins and encodes the ticket', () => {
    const url = buildWsUrl('sess-1', 'tok en/+')
    expect(url.startsWith('ws://')).toBe(true)
    expect(url).toContain('/ws/session/sess-1?ticket=')
    expect(url).toContain(encodeURIComponent('tok en/+'))
  })

  it('uses wss:// for https origins', () => {
    // JSDOM's location.protocol isn't redefinable; swap the global window
    // for a stub exposing an https location for the duration of the call
    // (buildWsUrl reads window.location off the global).
    const savedWindow = g.window
    g.window = { location: { protocol: 'https:', host: 'example.test' } } as unknown as Window
    try {
      const url = buildWsUrl('sess-1', 'tok')
      expect(url.startsWith('wss://')).toBe(true)
      expect(url).toContain('example.test')
    } finally {
      g.window = savedWindow
    }
  })
})

describe('mountCombatPanel', () => {
  it('returns a PanelHandle whose root is in the parent and is ready on mount', () => {
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    expect(parent.children.length).toBe(1)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('does not mint a ticket on empty sessionId', () => {
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    buttons(handle.root).connect.click()
    expect(apiCallMock).not.toHaveBeenCalled()
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.textContent).toContain('paste a sessionId first')
  })

  it('mints a ticket and opens a socket on connect, then renders combat frames', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { ticket: 'tok-1', expiresAt: '2030-01-01T00:00:00Z' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'sess-1'
    const { connect, resume } = buttons(handle.root)
    connect.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(apiCallMock).toHaveBeenCalledWith('/api/sessions/sess-1/ws-ticket', {
      method: 'POST',
    })
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    const ws = FakeWebSocket.instances[0]
    if (ws === undefined) throw new Error('expected a socket')
    expect(ws.url).toContain('/ws/session/sess-1?ticket=tok-1')

    // Before open the resume button is disabled; after open it enables.
    expect(resume.disabled).toBe(true)
    ws.triggerOpen()
    expect(resume.disabled).toBe(false)
    expect(handle.root.textContent).toContain('socket: connected')

    // mode_change updates the mode line; combat_started / combat_resolved
    // render cards with their detail lines.
    ws.triggerMessage(
      JSON.stringify({
        type: 'mode_change',
        from: 'exploration',
        to: 'combat',
        reason: 'ambush',
      }),
    )
    expect(handle.root.textContent).toContain('mode: combat (from exploration)')

    ws.triggerMessage(
      JSON.stringify({
        type: 'combat_started',
        turnId: 't1',
        enemies: [{ name: 'Goblin', description: 'small green', count: 2 }],
        initiative: [{ combatant: 'Goblin', roll: 14 }],
      }),
    )
    expect(handle.root.textContent).toContain('enemy: Goblin ×2')
    expect(handle.root.textContent).toContain('init: Goblin rolled 14')

    ws.triggerMessage(
      JSON.stringify({
        type: 'combat_resolved',
        turnId: 't1',
        narration: 'The party wins.',
        outcome: 'victory',
        casualties: [{ name: 'Goblin', type: 'npc', fate: 'slain' }],
        hpChanges: [{ combatant: 'Hero', hpBefore: 10, hpAfter: 6, maxHp: 12 }],
      }),
    )
    expect(handle.root.textContent).toContain('narration: The party wins.')
    expect(handle.root.textContent).toContain('casualty: Goblin (npc) — slain')
    expect(handle.root.textContent).toContain('hp: Hero 10 → 6 / 12')

    // Non-combat / non-JSON frames are ignored (no throw, no card).
    ws.triggerMessage(JSON.stringify({ type: 'player_message', text: 'hi' }))
    ws.triggerMessage('not json{')

    handle.unmount()
  })

  it('sends resume_combat over the open socket on the Resume click', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { ticket: 'tok-2', expiresAt: '2030-01-01T00:00:00Z' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'sess-2'
    const { connect, resume } = buttons(handle.root)
    connect.click()
    await new Promise((r) => setTimeout(r, 0))
    const ws = FakeWebSocket.instances[0]
    if (ws === undefined) throw new Error('expected a socket')
    ws.triggerOpen()

    resume.click()
    expect(ws.sent).toEqual([JSON.stringify({ type: 'resume_combat' })])
    expect(handle.root.textContent).toContain('resume_combat sent')
  })

  it('reports when resume is clicked with no open socket', () => {
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    // resume is disabled until connected; invoke directly to cover the guard.
    const { resume } = buttons(handle.root)
    resume.disabled = false
    resume.click()
    expect(handle.root.textContent).toContain('connect first')
  })

  it('transitions to error when the ticket mint fails', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 403,
      ok: false,
      body: { code: 'not_campaign_member' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'sess-3'
    buttons(handle.root).connect.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
    expect(handle.root.textContent).toContain('not_campaign_member')
    expect(FakeWebSocket.instances.length).toBe(0)
  })

  it('falls back to "unknown" code when the error body has no code field', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 500,
      ok: false,
      body: { somethingElse: true },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'sess-6'
    buttons(handle.root).connect.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
    expect(handle.root.textContent).toContain('unknown')
  })

  it('ignores late callbacks from a superseded socket (reconnect)', async () => {
    apiCallMock.mockResolvedValue({
      status: 200,
      ok: true,
      body: { ticket: 'tok-r', expiresAt: '2030-01-01T00:00:00Z' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'sess-7'
    const { connect, disconnect } = buttons(handle.root)

    connect.click()
    await new Promise((r) => setTimeout(r, 0))
    const socketA = FakeWebSocket.instances[0]
    if (socketA === undefined) throw new Error('expected socket A')
    socketA.triggerOpen()
    // Capture socket A's handler closures BEFORE teardown detaches them on
    // the instance — the closures still close over the panel's `socket` ref,
    // so invoking them after a reconnect exercises the `socket !== ws` stale
    // guards.
    const aOpen = socketA.onopen
    const aMessage = socketA.onmessage
    const aClose = socketA.onclose
    const aError = socketA.onerror

    // Disconnect re-enables the Connect button (and nulls A's instance
    // handlers); then reconnect mints a fresh ticket + opens socket B.
    disconnect.click()
    connect.click()
    await new Promise((r) => setTimeout(r, 0))
    const socketB = FakeWebSocket.instances[1]
    if (socketB === undefined) throw new Error('expected socket B')
    socketB.triggerOpen()
    const modeText = handle.root.textContent

    // Fire socket A's stale closures — each should early-return (guard hit),
    // leaving the panel state unchanged.
    aOpen?.({})
    aMessage?.({
      data: JSON.stringify({ type: 'mode_change', from: 'combat', to: 'exploration', reason: 'x' }),
    })
    aClose?.({})
    aError?.({})
    expect(handle.root.textContent).toBe(modeText)
    // Socket B is still the live one (not nulled by A's stale onclose).
    expect(handle.root.textContent).toContain('socket: connected')

    apiCallMock.mockReset()
  })

  it('disconnect tears the socket down and re-enables connect', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { ticket: 'tok-4', expiresAt: '2030-01-01T00:00:00Z' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'sess-4'
    const { connect, disconnect } = buttons(handle.root)
    connect.click()
    await new Promise((r) => setTimeout(r, 0))
    const ws = FakeWebSocket.instances[0]
    if (ws === undefined) throw new Error('expected a socket')
    ws.triggerOpen()
    expect(connect.disabled).toBe(true)

    disconnect.click()
    expect(ws.closed).toBe(true)
    expect(connect.disabled).toBe(false)
    expect(handle.root.textContent).toContain('socket: disconnected')
  })

  it('handles a server-initiated close and an error event', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { ticket: 'tok-5', expiresAt: '2030-01-01T00:00:00Z' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountCombatPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'sess-5'
    buttons(handle.root).connect.click()
    await new Promise((r) => setTimeout(r, 0))
    const ws = FakeWebSocket.instances[0]
    if (ws === undefined) throw new Error('expected a socket')
    ws.triggerOpen()
    ws.triggerError()
    expect(handle.root.textContent).toContain('socket: error')
    ws.triggerClose()
    expect(handle.root.textContent).toContain('closed by server')
  })
})
