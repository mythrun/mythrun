// @vitest-environment jsdom
//
// myth-mbdc: drawer UI shell test. Uses JSDOM for document/window
// and a MapStorage shim for localStorage — Node 25's bare global
// localStorage lacks the full Storage interface (no clear()), and
// the dev-tool localStorage convention (P3.1) expects a real
// Storage. Pattern mirrors active-campaign.test.ts.

import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountDrawer } from '../drawer.js'
import type { DrawerEvent } from '../subscriptions.js'

class MapStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length(): number { return this.map.size }
  clear(): void { this.map.clear() }
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }
  removeItem(key: string): void { this.map.delete(key) }
  setItem(key: string, value: string): void { this.map.set(key, value) }
}

function withDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  ;(globalThis as unknown as { window: Window }).window = dom.window as unknown as Window
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MapStorage(),
    configurable: true,
    writable: true,
  })
  const r = dom.window.document.getElementById('r')
  if (r === null) throw new Error('test setup')
  return r
}

describe('drawer.mountDrawer', () => {
  beforeEach(() => {
    // Each test calls withDom() to install a fresh document + storage.
  })

  it('mounts with data-state=ready (idle pattern) and event count 0', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: { subscribe: () => {}, unsubscribe: () => {}, list: () => [], closeAll: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      buffer: { push: () => {}, items: () => [], size: () => 0, clear: () => {} },
    })
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.getAttribute('data-region')).toBe('drawer')
    expect(handle.root.textContent).toContain('0')
    handle.unmount()
  })

  it('unmount removes the drawer from DOM', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: { subscribe: () => {}, unsubscribe: () => {}, list: () => [], closeAll: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      buffer: { push: () => {}, items: () => [], size: () => 0, clear: () => {} },
    })
    handle.unmount()
    expect(parent.querySelector('[data-region="drawer"]')).toBeNull()
  })

  it('clear button empties the buffer and re-renders', () => {
    const parent = withDom()
    let buffer: DrawerEvent[] = [
      { campaignId: 'c', type: 'phase', data: {}, receivedAt: 0 },
    ]
    const handle = mountDrawer(parent, {
      subscriptions: { subscribe: () => {}, unsubscribe: () => {}, list: () => [], closeAll: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      buffer: {
        push: (e) => { buffer.push(e) },
        items: () => buffer,
        size: () => buffer.length,
        clear: () => { buffer = [] },
      },
    })
    const clearBtn = handle.root.querySelector('button[data-action="clear"]') as HTMLButtonElement
    expect(clearBtn).not.toBeNull()
    clearBtn.click()
    expect(buffer).toEqual([])
    handle.unmount()
  })

  it('pause button toggles paused state and persists to localStorage', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: { subscribe: () => {}, unsubscribe: () => {}, list: () => [], closeAll: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      buffer: { push: () => {}, items: () => [], size: () => 0, clear: () => {} },
    })
    const pauseBtn = handle.root.querySelector('button[data-action="pause"]') as HTMLButtonElement
    expect(pauseBtn).not.toBeNull()
    pauseBtn.click()
    expect(localStorage.getItem('devtool.drawer.paused')).toBe('true')
    pauseBtn.click()
    expect(localStorage.getItem('devtool.drawer.paused')).toBe('false')
    handle.unmount()
  })
})
