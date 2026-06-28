import type { ServerFrame } from '@mythrun/contract/events'

// Pure, framework-free test doubles + fixtures for the WS session client tests
// (Task 5 lifecycle + Task 6 reconnect/dedup). Kept out of the `.test.ts` file so
// each test file stays readable + under the per-file line budget. NO vitest / msw
// / DOM here — just a `WebSocket` test double, frame builders, and a reference
// flow reducer. This file ships nowhere (client-core has no build; the package
// `exports` map omits `src/realtime/**`).

export interface CloseLike {
  code?: number
  reason?: string
}

/** A minimal `WebSocket` test double. The client drives it through the standard
 *  `onopen`/`onmessage`/`onclose` property handlers + `send`/`close`; a test
 *  drives the "server side" through `open()`/`emit()` and reads `url`/`sent`. */
export class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  static last(): MockWebSocket {
    const ws = MockWebSocket.instances.at(-1)
    if (ws === undefined) throw new Error('no MockWebSocket has been constructed')
    return ws
  }

  readyState = MockWebSocket.CONNECTING
  readonly url: string
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: CloseLike) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: code ?? 1006, reason: reason ?? '' })
  }

  // --- test-side drivers (the "server") ---
  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

// --- ServerFrame builders (Task 6 reconnect/dedup) ---------------------------

export function pm(seq: number, text = `m${String(seq)}`): Extract<ServerFrame, { type: 'player_message' }> {
  return { type: 'player_message', seq, userId: 'u', displayName: 'D', characterName: 'C', text }
}

export function reconnectFrame(
  messages: ServerFrame[],
): Extract<ServerFrame, { type: 'session_reconnect' }> {
  return { type: 'session_reconnect', messages, participants: [], mode: 'exploration' }
}

export function liveSkill(turnId: string, skill: string): Extract<ServerFrame, { type: 'skill_check' }> {
  return {
    type: 'skill_check', turnId, characterName: 'C', skill, context: 'a tense moment',
    roll: 12, roll2: null, rollType: 'normal', modifier: 2, total: 14, dc: 10,
    outcomeTier: 'success', constraint: 'you slip past',
  }
}
export function rowSkill(
  seq: number,
  turnId: string,
  skill: string,
): Extract<ServerFrame, { type: 'skill_check' }> {
  return { ...liveSkill(turnId, skill), seq }
}
export function liveLedger(turnId: string): Extract<ServerFrame, { type: 'ledger_update' }> {
  return { type: 'ledger_update', turnId, characterName: 'C', kind: 'hp', summary: '-3 hp', hp: 7, maxHp: 10 }
}
export function rowLedger(seq: number, turnId: string): Extract<ServerFrame, { type: 'ledger_update' }> {
  return { ...liveLedger(turnId), seq }
}
export function combatStarted(): Extract<ServerFrame, { type: 'combat_started' }> {
  return {
    type: 'combat_started', turnId: '',
    enemies: [{ name: 'Goblin', description: 'small + mean', count: 2 }],
    initiative: [{ combatant: 'Goblin', roll: 12 }],
  }
}
export function combatResolved(): Extract<ServerFrame, { type: 'combat_resolved' }> {
  return { type: 'combat_resolved', turnId: '', narration: 'won', outcome: 'victory', casualties: [], hpChanges: [] }
}

// --- reference flow reducer --------------------------------------------------

/** A minimal reference renderer modeling a flow reducer: it proves the transport
 *  emits a frame stream a turnId-keyed consumer renders WITHOUT duplicates.
 *  DM-turn frames accrue under their turnId; a `session_reconnect` is a
 *  whole-turn-REPLACE batch (clear each turnId it carries, then re-apply); combat
 *  frames (turnId '') key on the LATEST, not turnId; player_messages upsert by seq. */
export interface RenderState {
  messages: Map<number, ServerFrame>
  turns: Map<string, ServerFrame[]>
  combat: ServerFrame | null
}

export function newRenderState(): RenderState {
  return { messages: new Map(), turns: new Map(), combat: null }
}

export function applyFrame(state: RenderState, frame: ServerFrame): void {
  if (frame.type === 'session_reconnect') {
    for (const m of frame.messages) {
      const t = (m as { turnId?: string }).turnId
      if (typeof t === 'string' && t !== '') state.turns.delete(t)
    }
    for (const m of frame.messages) applyFrame(state, m)
    return
  }
  if (frame.type === 'combat_started' || frame.type === 'combat_resolved') {
    state.combat = frame
    return
  }
  const turnId = (frame as { turnId?: string }).turnId
  if (typeof turnId === 'string' && turnId !== '') {
    const arr = state.turns.get(turnId) ?? []
    arr.push(frame)
    state.turns.set(turnId, arr)
    return
  }
  const seq = (frame as { seq?: number }).seq
  if (typeof seq === 'number') state.messages.set(seq, frame)
}
