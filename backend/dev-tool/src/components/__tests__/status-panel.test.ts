// @vitest-environment jsdom
//
// myth-rdwq P6.B — DOM tests for the refactored mountStatusPanel.
// Exercises the PanelHandle contract + the data-state cycle.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { setActiveCampaignId } from '../../shell/active-campaign.js'
import { mountStatusPanel } from '../status-panel.js'

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

describe('mountStatusPanel', () => {
  it('returns a PanelHandle whose root is in the parent with data-state="ready"', () => {
    const parent = makeParent()
    const handle = mountStatusPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountStatusPanel(parent)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to ready on 200 with a valid snapshot', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        phase: 'world_snapshot_ready',
        stages: [
          { stage: 'concept_intake', status: 'completed', userId: null, costUsd: 0.0042 },
        ],
        cumulativeCostUsd: 0.0042,
      },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountStatusPanel(parent)
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
    const handle = mountStatusPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })

  // myth-zeiw: per-stage duration cell.
  it('renders fixed duration for a completed stage', async () => {
    setActiveCampaignId('camp-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        phase: 'world_snapshot_ready',
        stages: [
          {
            stage: 'concept_intake',
            status: 'completed',
            userId: null,
            costUsd: 0.0042,
            startedAt: '2026-05-12T00:00:00.000Z',
            // 42 seconds after startedAt → expect "42s".
            completedAt: '2026-05-12T00:00:42.000Z',
          },
        ],
        cumulativeCostUsd: 0.0042,
      },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountStatusPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    const stageTable = handle.root.querySelector('pre[data-role="stage-table"]')
    if (stageTable === null) throw new Error('expected stage-table')
    expect(stageTable.textContent).toContain('42s')
    handle.unmount()
  })

  // myth-zeiw: running-stage duration is a count-up that's hard to test
  // deterministically (it ticks against wall-clock). Pin started_at a
  // small known delta in the past and assert that the rendered cell is
  // either "0s" or "1s" — both are valid for a stage that started <2s
  // ago at the moment of assert. The point is: a duration string lands
  // in the row at all (≥ 0 seconds), not "—".
  it('renders a duration string for a running stage', async () => {
    setActiveCampaignId('camp-1')
    const startedAt = new Date(Date.now() - 1000).toISOString()
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        phase: 'world_gen',
        stages: [
          {
            stage: 'world_and_factions',
            status: 'running',
            userId: null,
            costUsd: 0,
            startedAt,
            completedAt: null,
          },
        ],
        cumulativeCostUsd: 0,
      },
      latencyMs: 10,
    })
    const parent = makeParent()
    const handle = mountStatusPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    // Tiny wait so the rendered duration is meaningfully non-zero.
    await new Promise((r) => setTimeout(r, 20))
    const stageTable = handle.root.querySelector('pre[data-role="stage-table"]')
    if (stageTable === null) throw new Error('expected stage-table')
    const text = stageTable.textContent
    // A duration cell was rendered — not the em-dash fallback.
    expect(text).not.toContain('—')
    // The cell formats as "Ns" with N >= 0 (a small int) since the
    // stage started ~1s ago. Regex tolerates "0s" / "1s" / "2s" — the
    // assertion is shape, not exact value.
    expect(text).toMatch(/\b\d+s\b/)
    handle.unmount()
  })
})
