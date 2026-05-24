// @vitest-environment jsdom
//
// MYT-54 T15 — DOM tests for mountCharacterCreationProgressPanel.
// Exercises the PanelHandle contract (root + unmount), the data-state
// lifecycle (ready → loading → ready on 200, error on non-2xx), and
// the active-campaign gate (no fetch when none picked).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountCharacterCreationProgressPanel } from '../character-creation-progress-panel.js'

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

describe('mountCharacterCreationProgressPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountCharacterCreationProgressPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountCharacterCreationProgressPanel(parent)
    expect(parent.children.length).toBe(1)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to ready on 200 and surfaces the per-status summary', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        campaignId: 'camp-1',
        totalMembers: 3,
        concepts: [
          { userId: 'u1', displayName: 'Alice', status: 'completed', submittedAt: 't' },
          { userId: 'u2', displayName: 'Bob',   status: 'processing', submittedAt: 't' },
        ],
        missing: [{ userId: 'u3', displayName: 'Carol' }],
      },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountCharacterCreationProgressPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(apiCallMock).toHaveBeenCalledWith(
      '/api/campaigns/camp-1/character-creation-progress',
    )
    expect(handle.root.textContent).toContain('2 concepts')
    expect(handle.root.textContent).toContain('1 completed')
    expect(handle.root.textContent).toContain('1 processing')
    expect(handle.root.textContent).toContain('1 missing')
    expect(handle.root.textContent).toContain('Carol')
  })

  it('transitions to error on non-2xx response', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 403,
      ok: false,
      body: { code: 'forbidden' },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountCharacterCreationProgressPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
    expect(handle.root.textContent).toContain('403')
    expect(handle.root.textContent).toContain('forbidden')
  })

  it('shows the active-campaign prompt and does not fetch when none picked', async () => {
    const parent = makeParent()
    const handle = mountCharacterCreationProgressPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(apiCallMock).not.toHaveBeenCalled()
    expect(handle.root.textContent).toContain('requires an active campaign')
  })

  it('unmount removes the click listener so later clicks do nothing', async () => {
    setActiveCampaignId('camp-1')
    const parent = makeParent()
    const handle = mountCharacterCreationProgressPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    handle.unmount()
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(apiCallMock).not.toHaveBeenCalled()
    expect(parent.children.length).toBe(0)
  })
})
