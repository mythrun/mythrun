// @vitest-environment jsdom
//
// MYT-54 T16 — DOM tests for mountFinalizeCharacterCreationPanel.
// Exercises the PanelHandle contract (root + unmount) and the data-state
// cycle (ready → loading → ready on 202, error on non-2xx). Also verifies
// the empty-textarea-sends-null body shape and the no-active-campaign
// guard.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountFinalizeCharacterCreationPanel } from '../finalize-character-creation-panel.js'

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

describe('mountFinalizeCharacterCreationPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountFinalizeCharacterCreationPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
    expect(typeof handle.unmount).toBe('function')
  })

  it('on 202: POSTs notes body and transitions to ready', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 202,
      ok: true,
      body: { campaignId: 'camp-1', jobId: 'job-xyz' },
      latencyMs: 12,
    })
    const parent = makeParent()
    const handle = mountFinalizeCharacterCreationPanel(parent)
    const textarea = handle.root.querySelector('textarea')
    const btn = handle.root.querySelector('button')
    if (textarea === null || btn === null) throw new Error('expected textarea + button')
    textarea.value = 'Alice and Bob are siblings.'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(apiCallMock).toHaveBeenCalledTimes(1)
    const [path, init] = apiCallMock.mock.calls[0] ?? []
    expect(path).toBe('/api/campaigns/camp-1/finalize-character-creation')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ pre_integration_notes: 'Alice and Bob are siblings.' }))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('empty textarea sends pre_integration_notes: null', async () => {
    setActiveCampaignId('camp-2')
    apiCallMock.mockResolvedValueOnce({
      status: 202,
      ok: true,
      body: { campaignId: 'camp-2', jobId: 'job-empty' },
      latencyMs: 8,
    })
    const parent = makeParent()
    const handle = mountFinalizeCharacterCreationPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(apiCallMock).toHaveBeenCalledTimes(1)
    const [, init] = apiCallMock.mock.calls[0] ?? []
    expect(init?.body).toBe(JSON.stringify({ pre_integration_notes: null }))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('on 409 not_in_setup: transitions to error and renders error block', async () => {
    setActiveCampaignId('camp-3')
    apiCallMock.mockResolvedValueOnce({
      status: 409,
      ok: false,
      body: { code: 'not_in_setup', message: 'Campaign is not in setup' },
      latencyMs: 9,
    })
    const parent = makeParent()
    const handle = mountFinalizeCharacterCreationPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(handle.root.getAttribute('data-state')).toBe('error')
    // The error block surfaces the status + code in plain text (no
    // dedicated selector — see _shared/error-block.ts), so assert on
    // the rendered content rather than a separate marker element.
    expect(handle.root.textContent).toContain('409')
    expect(handle.root.textContent).toContain('not_in_setup')
  })

  it('no active campaign: shows prompt and does not call apiCall', async () => {
    setActiveCampaignId(null)
    const parent = makeParent()
    const handle = mountFinalizeCharacterCreationPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(apiCallMock).not.toHaveBeenCalled()
    // The panel never leaves 'ready' since no fetch is attempted.
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.textContent).toContain('requires an active campaign')
  })

  it('unmount removes the panel root and disables further clicks', () => {
    const parent = makeParent()
    const handle = mountFinalizeCharacterCreationPanel(parent)
    expect(parent.children.length).toBe(1)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    handle.unmount()
    expect(parent.children.length).toBe(0)
    // Re-click after unmount must NOT trigger an apiCall (listener removed).
    btn.click()
    expect(apiCallMock).not.toHaveBeenCalled()
  })
})
