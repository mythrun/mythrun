// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
vi.mock('../../api-client.js', () => ({ apiCall: vi.fn() }))
import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountSessionPrepViewPanel } from '../session-prep-view-panel.js'

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
  saved = { document: g.document, window: g.window, localStorage: g.localStorage, HTMLElement: g.HTMLElement, CustomEvent: g.CustomEvent }
  g.document = dom.window.document; g.window = dom.window as unknown as Window
  g.localStorage = dom.window.localStorage; g.HTMLElement = dom.window.HTMLElement; g.CustomEvent = dom.window.CustomEvent
})
afterAll(() => { g.document = saved.document; g.window = saved.window; g.localStorage = saved.localStorage; g.HTMLElement = saved.HTMLElement; g.CustomEvent = saved.CustomEvent })
function makeParent(): HTMLElement { const p = dom.window.document.createElement('div'); dom.window.document.body.appendChild(p); return p }
beforeEach(() => { dom.window.document.body.replaceChildren(); apiCallMock.mockReset(); dom.window.localStorage.clear() })
afterEach(() => { setActiveCampaignId(null) })

describe('mountSessionPrepViewPanel', () => {
  it('returns a PanelHandle in the parent with data-state ready', () => {
    const parent = makeParent()
    const handle = mountSessionPrepViewPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })
  it('unmount removes the panel', () => {
    const parent = makeParent()
    mountSessionPrepViewPanel(parent).unmount()
    expect(parent.children.length).toBe(0)
  })
  it('transitions to ready on 200', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({ status: 200, ok: true, body: { id: 'prep-1', sessionNumber: 1, ftContext: 'x', snapshotId: null, createdAt: '2026-01-01T00:00:00.000Z' }, latencyMs: 9 })
    const parent = makeParent()
    const handle = mountSessionPrepViewPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'prep-1'
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })
  it('transitions to error on non-2xx', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({ status: 404, ok: false, body: { code: 'prep_not_found' }, latencyMs: 9 })
    const parent = makeParent()
    const handle = mountSessionPrepViewPanel(parent)
    const input = handle.root.querySelector('input')
    if (input === null) throw new Error('expected input')
    input.value = 'prep-1'
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
