// @vitest-environment jsdom
//
// myth-lhp99 — DOM tests for mountSessionRecapPanel. Exercises the
// PanelHandle contract (root + unmount) and the data-state cycle
// (ready → loading → ready on 200 for the null / pending / ready recap
// shapes, error on non-2xx, no fetch on empty campaignId).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { mountSessionRecapPanel } from '../session-recap-panel.js'

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

beforeEach(() => {
  dom.window.document.body.replaceChildren()
  apiCallMock.mockReset()
  dom.window.localStorage.clear()
})

describe('mountSessionRecapPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountSessionRecapPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountSessionRecapPanel(parent)
    expect(parent.children.length).toBe(1)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('does not fetch on empty campaignId', () => {
    const parent = makeParent()
    const handle = mountSessionRecapPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    expect(apiCallMock).not.toHaveBeenCalled()
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to ready on 200 with a null recap (none state)', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { recap: null },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountSessionRecapPanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'camp-1'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(apiCallMock).toHaveBeenCalledWith('/api/sessions/camp-1/recap')
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.textContent).toContain('no ended session yet')
  })

  it('transitions to ready on 200 with a pending recap', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { recap: { sessionNumber: 2, endedAt: '2026-07-01T00:00:00.000Z', status: 'pending' } },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountSessionRecapPanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'camp-1'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.textContent).toContain('session 2 ended — analysis pending')
  })

  it('transitions to ready on 200 with a ready recap', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        recap: {
          sessionNumber: 3,
          endedAt: '2026-07-02T00:00:00.000Z',
          status: 'ready',
          summary: 'The party fled the harbor.',
          emergingThreads: ['who tipped off the watch?'],
        },
      },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountSessionRecapPanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'camp-1'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.textContent).toContain('session 3 ended — recap ready')
  })

  it('transitions to error on non-2xx response', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 403,
      ok: false,
      body: { code: 'not_a_member' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountSessionRecapPanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'camp-1'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
