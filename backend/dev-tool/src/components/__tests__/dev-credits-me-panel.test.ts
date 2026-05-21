// @vitest-environment jsdom
//
// myth-c1gr P6.E — DOM tests for mountDevCreditsMePanel. Exercises
// the PanelHandle contract (root + unmount) and the data-state cycle
// (ready → loading → ready on 200, error on non-2xx).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { mountDevCreditsMePanel } from '../dev-credits-me-panel.js'

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
  g.HTMLElement = dom.window.HTMLElement as unknown as typeof HTMLElement
  g.CustomEvent = dom.window.CustomEvent as unknown as typeof CustomEvent
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

beforeEach(() => {
  dom.window.document.body.replaceChildren()
  apiCallMock.mockReset()
  dom.window.localStorage.clear()
})

describe('mountDevCreditsMePanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountDevCreditsMePanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountDevCreditsMePanel(parent)
    expect(parent.children.length).toBe(1)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to error on non-2xx response', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 401,
      ok: false,
      body: { code: 'no_dev_identity' },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountDevCreditsMePanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })

  it('transitions to ready on 200', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { balances: [], recent: [] },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountDevCreditsMePanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })
})
