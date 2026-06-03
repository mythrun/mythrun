// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
vi.mock('../../api-client.js', () => ({ apiCall: vi.fn() }))
import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountSessionPrepTriggerPanel } from '../session-prep-trigger-panel.js'

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

describe('mountSessionPrepTriggerPanel', () => {
  it('returns a PanelHandle in the parent with data-state ready', () => {
    const parent = makeParent()
    const handle = mountSessionPrepTriggerPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })
  it('unmount removes the panel', () => {
    const parent = makeParent()
    mountSessionPrepTriggerPanel(parent).unmount()
    expect(parent.children.length).toBe(0)
  })
  it('transitions to ready on 202', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({ status: 202, ok: true, body: { campaignId: 'camp-1', sessionNumber: 1 }, latencyMs: 9 })
    const parent = makeParent()
    const handle = mountSessionPrepTriggerPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })
  it('transitions to error on non-2xx', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({ status: 403, ok: false, body: { code: 'not_campaign_owner' }, latencyMs: 9 })
    const parent = makeParent()
    const handle = mountSessionPrepTriggerPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
