// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountCampaignDeletePanel } from '../campaign-delete-panel.js'

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

describe('mountCampaignDeletePanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    setActiveCampaignId('camp-1')
    const parent = makeParent()
    const handle = mountCampaignDeletePanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('disables submit when there is no active campaign', () => {
    const parent = makeParent()
    const handle = mountCampaignDeletePanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    expect(btn.disabled).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    setActiveCampaignId('camp-1')
    const parent = makeParent()
    const handle = mountCampaignDeletePanel(parent)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('confirmation mismatch keeps state ready (no fetch)', async () => {
    setActiveCampaignId('camp-1')
    const parent = makeParent()
    const handle = mountCampaignDeletePanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'delete wrong-id'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(apiCallMock).not.toHaveBeenCalled()
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to ready on 204 with correct confirmation', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 204,
      ok: true,
      body: null,
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountCampaignDeletePanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'delete camp-1'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(apiCallMock).toHaveBeenCalledOnce()
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to error on 409', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 409,
      ok: false,
      body: { code: 'still_generating' },
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountCampaignDeletePanel(parent)
    const input = handle.root.querySelector('input')
    const btn = handle.root.querySelector('button')
    if (input === null || btn === null) throw new Error('expected input + button')
    input.value = 'delete camp-1'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
