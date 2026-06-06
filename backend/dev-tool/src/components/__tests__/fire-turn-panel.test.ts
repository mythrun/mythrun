// @vitest-environment jsdom
//
// MYT-66 — DOM tests for mountFireTurnPanel. Exercises the PanelHandle
// contract (root + unmount) and the data-state cycle (ready → loading →
// ready on 202, error on non-2xx, no fetch when either input is empty).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import { mountFireTurnPanel } from '../fire-turn-panel.js'
import type { PanelHandle } from '../_shared/panel-skeleton.js'

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

describe('mountFireTurnPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountFireTurnPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountFireTurnPanel(parent)
    expect(parent.children.length).toBe(1)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  function inputsAndButton(
    handle: PanelHandle,
  ): { campaignInput: HTMLInputElement; triggerInput: HTMLInputElement; btn: HTMLButtonElement } {
    const inputs = handle.root.querySelectorAll('input')
    const btn = handle.root.querySelector('button')
    const campaignInput = inputs[0]
    const triggerInput = inputs[1]
    if (campaignInput === undefined || triggerInput === undefined || btn === null) {
      throw new Error('expected two inputs + button')
    }
    return { campaignInput, triggerInput, btn }
  }

  it('does not fetch when campaignId is empty', () => {
    const parent = makeParent()
    const handle = mountFireTurnPanel(parent)
    const { triggerInput, btn } = inputsAndButton(handle)
    // Only triggerText filled; campaignId blank.
    triggerInput.value = 'the door creaks open'
    btn.click()
    expect(apiCallMock).not.toHaveBeenCalled()
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('does not fetch when triggerText is empty', () => {
    const parent = makeParent()
    const handle = mountFireTurnPanel(parent)
    const { campaignInput, btn } = inputsAndButton(handle)
    campaignInput.value = 'camp-1'
    btn.click()
    expect(apiCallMock).not.toHaveBeenCalled()
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to ready on 202 and posts the trigger body', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 202,
      ok: true,
      body: { turnId: 'turn-1' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountFireTurnPanel(parent)
    const { campaignInput, triggerInput, btn } = inputsAndButton(handle)
    campaignInput.value = 'camp-1'
    triggerInput.value = 'the door creaks open'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(apiCallMock).toHaveBeenCalledWith('/api/dev/campaigns/camp-1/fire-turn', {
      method: 'POST',
      body: JSON.stringify({ triggerText: 'the door creaks open' }),
    })
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to error on 409 no_active_session', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 409,
      ok: false,
      body: { code: 'no_active_session' },
      latencyMs: 5,
    })
    const parent = makeParent()
    const handle = mountFireTurnPanel(parent)
    const { campaignInput, triggerInput, btn } = inputsAndButton(handle)
    campaignInput.value = 'camp-1'
    triggerInput.value = 'the door creaks open'
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })
})
