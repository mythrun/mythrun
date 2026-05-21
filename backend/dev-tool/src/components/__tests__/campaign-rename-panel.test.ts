// @vitest-environment jsdom
//
// myth-ukpc P6.A — DOM tests for mountCampaignRenamePanel. Exercises
// the PanelHandle contract (root + unmount) and the data-state cycle
// (ready → loading → ready on 200, error on non-2xx).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountCampaignRenamePanel } from '../campaign-rename-panel.js'

const apiCallMock = vi.mocked(apiCall)

interface GlobalDom {
  document?: Document
  window?: Window
  localStorage?: Storage
  HTMLElement?: typeof HTMLElement
  CustomEvent?: typeof CustomEvent
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

afterEach(() => {
  setActiveCampaignId(null)
})

describe('mountCampaignRenamePanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountCampaignRenamePanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountCampaignRenamePanel(parent)
    expect(parent.children.length).toBe(1)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to error on non-2xx response', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 404,
      ok: false,
      body: { code: 'campaign_not_found' },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountCampaignRenamePanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'new name'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })

  it('transitions to ready on 200', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { campaignId: 'camp-1', name: 'new name' },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountCampaignRenamePanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'new name'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })
})
