// @vitest-environment jsdom
//
// myth-fn51 P6.C — DOM tests for mountCharactersRosterPanel.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import {
  getActiveCharacterId,
  setActiveCampaignId,
  setActiveCharacterId,
} from '../../shell/active-campaign.js'
import { mountCharactersRosterPanel } from '../characters-roster-panel.js'

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
  setActiveCharacterId(null)
})

describe('mountCharactersRosterPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountCharactersRosterPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountCharactersRosterPanel(parent)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('renders members on 200 and "view" click sets activeCharacterId', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        members: [
          { userId: 'u1', displayName: 'Alice', conceptStatus: 'completed', characterId: 'char-1' },
          { userId: 'u2', displayName: 'Bob', conceptStatus: 'pending' },
        ],
      },
      latencyMs: 6,
    })
    const parent = makeParent()
    const handle = mountCharactersRosterPanel(parent)
    const refreshBtn = handle.root.querySelector('button')
    if (refreshBtn === null) throw new Error('expected refresh button')
    refreshBtn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    // The "view" button shows up only for the completed row.
    const allButtons = handle.root.querySelectorAll('button')
    // refresh + one "view" button = 2.
    expect(allButtons.length).toBe(2)
    allButtons[1]!.click()
    expect(getActiveCharacterId()).toBe('char-1')
  })

  it('transitions to error on 500', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 500,
      ok: false,
      body: { code: 'internal_error' },
      latencyMs: 6,
    })
    const parent = makeParent()
    const handle = mountCharactersRosterPanel(parent)
    const refreshBtn = handle.root.querySelector('button')
    if (refreshBtn === null) throw new Error('expected refresh button')
    refreshBtn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
