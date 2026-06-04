// @vitest-environment jsdom
//
// MYT-65 — DOM tests for mountSessionMessagesPanel. Exercises the
// PanelHandle contract (root + unmount) and the data-state cycle
// (ready → loading → ready on 200, error on non-2xx, no fetch on
// empty sessionId, afterSeq query passthrough).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { mountSessionMessagesPanel } from '../session-messages-panel.js'

const apiCallMock = vi.mocked(apiCall)

interface GlobalDom {
  document?: Document | undefined
  window?: Window | undefined
  localStorage?: Storage | undefined
  HTMLElement?: typeof HTMLElement | undefined
  CustomEvent?: typeof CustomEvent | undefined
}

const g = globalThis as unknown as GlobalDom
let saved: GlobalDom = {}
let dom: JSDOM

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  saved = {
    document: g.document,
    window: g.window,
    localStorage: g.localStorage,
    HTMLElement: g.HTMLElement,
    CustomEvent: g.CustomEvent,
  }
  g.document = dom.window.document
  g.window = dom.window as unknown as Window
  g.localStorage = dom.window.localStorage
  g.HTMLElement = dom.window.HTMLElement
  g.CustomEvent = dom.window.CustomEvent
})

afterAll(() => {
  g.document = saved.document
  g.window = saved.window
  g.localStorage = saved.localStorage
  g.HTMLElement = saved.HTMLElement
  g.CustomEvent = saved.CustomEvent
})

function makeParent(): HTMLElement {
  const p = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(p)
  return p
}

function inputs(root: HTMLElement): { id: HTMLInputElement; afterSeq: HTMLInputElement } {
  const all = root.querySelectorAll('input')
  const id = all[0]
  const afterSeq = all[1]
  if (id === undefined || afterSeq === undefined) throw new Error('expected two inputs')
  return { id, afterSeq }
}

beforeEach(() => {
  dom.window.document.body.replaceChildren()
  apiCallMock.mockReset()
  dom.window.localStorage.clear()
})

describe('mountSessionMessagesPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountSessionMessagesPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountSessionMessagesPanel(parent)
    expect(parent.children.length).toBe(1)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('does not fetch on empty sessionId', () => {
    const parent = makeParent()
    const handle = mountSessionMessagesPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    expect(apiCallMock).not.toHaveBeenCalled()
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('fetches without afterSeq query when the field is blank', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { messages: [] },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountSessionMessagesPanel(parent)
    const { id } = inputs(handle.root)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    id.value = 'sess-1'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(apiCallMock).toHaveBeenCalledWith('/api/sessions/sess-1/messages')
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.textContent).toContain('0 message(s)')
  })

  it('appends the afterSeq query when provided', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { messages: [{ seq: 6 }] },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountSessionMessagesPanel(parent)
    const { id, afterSeq } = inputs(handle.root)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    id.value = 'sess-1'
    afterSeq.value = '5'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(apiCallMock).toHaveBeenCalledWith('/api/sessions/sess-1/messages?afterSeq=5')
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.textContent).toContain('1 message(s)')
  })

  it('transitions to error on non-2xx response', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 400,
      ok: false,
      body: { code: 'bad_after_seq' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountSessionMessagesPanel(parent)
    const { id } = inputs(handle.root)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    id.value = 'sess-1'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
