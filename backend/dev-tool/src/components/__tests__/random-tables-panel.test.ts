// @vitest-environment jsdom
//
// myth-rdwq P6.B — DOM tests for mountRandomTablesPanel.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountRandomTablesPanel } from '../random-tables-panel.js'

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

describe('mountRandomTablesPanel', () => {
  it('returns a PanelHandle whose root is in the parent with data-state="ready"', () => {
    const parent = makeParent()
    const handle = mountRandomTablesPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountRandomTablesPanel(parent)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to ready on 200', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { tables: [] },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountRandomTablesPanel(parent)
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
    const handle = mountRandomTablesPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })

  // myth-94bu: domain-aware renderer asserts.
  it('renders each table as a section with roll-range rows', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        tables: [
          {
            id: 't-1',
            name: 'Forest Encounters',
            category: 'encounter',
            entries: [
              { rollMin: 1, rollMax: 3, content: 'A pack of wolves' },
              { rollMin: 4, rollMax: 4, content: 'A lost merchant' },
            ],
          },
          {
            id: 't-2',
            name: 'Tavern Rumors',
            category: 'rumor',
            entries: [{ rollMin: 1, rollMax: 1, content: 'The well is cursed' }],
          },
        ],
      },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountRandomTablesPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    const text = handle.root.textContent
    expect(text).toContain('Random tables (2)')
    expect(text).toContain('Forest Encounters')
    expect(text).toContain('[encounter]')
    expect(text).toContain('1–3')
    expect(text).toContain('A pack of wolves')
    expect(text).toContain('Tavern Rumors')
    expect(text).toContain('The well is cursed')
    // Each table renders its own <table>.
    expect(handle.root.querySelectorAll('table').length).toBe(2)
    // Raw JSON disclosure preserved.
    expect(handle.root.querySelector('details')).not.toBeNull()
  })

  it('renders empty-state when there are no tables', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { tables: [] },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountRandomTablesPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.textContent).toContain('Random tables (0)')
    expect(handle.root.textContent).toContain('(no random tables for this world)')
  })
})
