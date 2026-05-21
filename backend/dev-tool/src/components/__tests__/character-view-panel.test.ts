// @vitest-environment jsdom
//
// myth-fn51 P6.C — DOM tests for mountCharacterViewPanel.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import {
  setActiveCampaignId,
  setActiveCharacterId,
} from '../../shell/active-campaign.js'
import { mountCharacterViewPanel } from '../character-view-panel.js'

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

describe('mountCharacterViewPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to ready on 200 with active campaign + character', async () => {
    setActiveCampaignId('camp-1')
    setActiveCharacterId('char-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { id: 'char-1', skills: [], features: [], equipment: [], spells: [] },
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to error on 404', async () => {
    setActiveCampaignId('camp-1')
    setActiveCharacterId('char-1')
    apiCallMock.mockResolvedValueOnce({
      status: 404,
      ok: false,
      body: { code: 'character_not_found' },
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
