// @vitest-environment jsdom
//
// myth-fn51 P6.C — DOM tests for mountSubmitCharacterConceptPanel.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountSubmitCharacterConceptPanel } from '../submit-character-concept-panel.js'

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

describe('mountSubmitCharacterConceptPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountSubmitCharacterConceptPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountSubmitCharacterConceptPanel(parent)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to ready on 201', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 201,
      ok: true,
      body: { conceptId: 'concept-1', status: 'queued' },
      latencyMs: 8,
    })
    const parent = makeParent()
    const handle = mountSubmitCharacterConceptPanel(parent)
    const textareas = handle.root.querySelectorAll('textarea')
    const concept = textareas[0]
    const arrival = textareas[1]
    if (concept === undefined || arrival === undefined) throw new Error('expected two textareas')
    concept.value = 'a memorable character concept long enough to satisfy the validator'
    arrival.value = 'arriving at the tavern with one coin and a borrowed cloak'
    const submitBtn = handle.root.querySelector('button')
    if (submitBtn === null) throw new Error('expected button')
    submitBtn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to error on 422', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 422,
      ok: false,
      body: { code: 'concept_too_short' },
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountSubmitCharacterConceptPanel(parent)
    const submitBtn = handle.root.querySelector('button')
    if (submitBtn === null) throw new Error('expected button')
    submitBtn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
