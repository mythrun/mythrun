// @vitest-environment jsdom
//
// myth-rdwq P6.B — DOM tests for mountHierarchyPanel. Exercises the
// PanelHandle contract (root + unmount) and the data-state cycle
// (ready → loading → ready on 200, error on non-2xx).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountHierarchyPanel } from '../hierarchy-panel.js'

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

afterEach(() => {
  setActiveCampaignId(null)
})

describe('mountHierarchyPanel', () => {
  it('returns a PanelHandle whose root is in the parent with data-state="ready"', () => {
    const parent = makeParent()
    const handle = mountHierarchyPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountHierarchyPanel(parent)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to ready on 200', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { rows: [] },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountHierarchyPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to error on non-2xx', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 404,
      ok: false,
      body: { code: 'campaign_not_found' },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountHierarchyPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })

  // myth-94bu: domain-aware renderer asserts.
  it('renders the parent-child tree with relation count + truncated ids', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        hierarchy: [
          { id: 'h-1', parentEntityId: 'parent-aaaaaaaa-1', childEntityId: 'child-bbbbbbbb-1' },
          { id: 'h-2', parentEntityId: 'parent-aaaaaaaa-1', childEntityId: 'child-bbbbbbbb-2' },
        ],
      },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountHierarchyPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    const text = handle.root.textContent
    expect(text).toContain('Hierarchy (2 relations)')
    expect(text).toContain('parent-a') // truncated id prefix of the root
    expect(text).toContain('2 children')
    expect(text).toContain('child-bb')
    // Raw JSON disclosure is preserved as a footer.
    expect(handle.root.querySelector('details')).not.toBeNull()
  })

  it('renders the empty-state line when hierarchy is empty', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { hierarchy: [] },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountHierarchyPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.textContent).toContain('Hierarchy (0 relations)')
    expect(handle.root.textContent).toContain('(no parent-child relations yet)')
  })
})
