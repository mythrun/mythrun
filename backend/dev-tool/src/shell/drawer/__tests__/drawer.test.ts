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

  const noop = (): void => undefined
  const noopUnsubscribe = (): (() => void) => noop
  const emptySubscriptions = {
    subscribe: noop,
    unsubscribe: noop,
    list: (): string[] => [],
    closeAll: noop,
  }
  const emptyBus = { publish: noop, subscribe: noopUnsubscribe }
  const emptyBuffer = {
    push: noop,
    items: (): DrawerEvent[] => [],
    size: (): number => 0,
    clear: noop,
  }

  it('mounts with data-state=ready (idle pattern) and event count 0', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: emptyBuffer,
    })
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.getAttribute('data-region')).toBe('drawer')
    expect(handle.root.textContent).toContain('0')
    handle.unmount()
  })

  it('unmount removes the drawer from DOM', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: emptyBuffer,
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
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: {
        push: (e) => { buffer.push(e) },
        items: () => buffer,
        size: () => buffer.length,
        clear: () => { buffer = [] },
      },
    })
    const clearBtn = handle.root.querySelector<HTMLElement>('button[data-action="clear"]')
    expect(clearBtn).not.toBeNull()
    if (clearBtn === null) throw new Error('clearBtn missing')
    clearBtn.click()
    expect(buffer).toEqual([])
    handle.unmount()
  })

  it('pause button toggles paused state and persists to localStorage', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: emptyBuffer,
    })
    const pauseBtn = handle.root.querySelector<HTMLElement>('button[data-action="pause"]')
    expect(pauseBtn).not.toBeNull()
    if (pauseBtn === null) throw new Error('pauseBtn missing')
    pauseBtn.click()
    expect(localStorage.getItem('devtool.drawer.paused')).toBe('true')
    pauseBtn.click()
    expect(localStorage.getItem('devtool.drawer.paused')).toBe('false')
    handle.unmount()
  })

  // myth-wirepayload: rows render an inline summary derived from the
  // event payload (which stage / which entity name / which relationship)
  // and disclose the full JSON via <details> on click. Below tests the
  // public shape: summaries appear in row text; the JSON payload renders
  // when the row is opened.
  it('row text includes a stage name for stage-started events', () => {
    const parent = withDom()
    const buffer: DrawerEvent[] = [
      {
        campaignId: 'c01234567',
        type: 'stage-started',
        data: { type: 'stage-started', stage: 'world_and_factions', userId: null, startedAt: '2026-05-25T18:00:00Z' },
        receivedAt: 0,
      },
    ]
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: {
        push: () => undefined,
        items: () => buffer,
        size: () => buffer.length,
        clear: () => undefined,
      },
    })
    expect(handle.root.textContent).toContain('world_and_factions')
    handle.unmount()
  })

  it('row text includes the relationship verb + endpoint short ids for edge-added', () => {
    const parent = withDom()
    const buffer: DrawerEvent[] = [
      {
        campaignId: 'c01234567',
        type: 'edge-added',
        data: {
          type: 'edge-added',
          synthKey: 'entity_relationships/relationships/3',
          from: '019e6047-aaaa-bbbb-cccc-dddddddddddd',
          to: 'new-007',
          relationship: 'allied_with',
        },
        receivedAt: 0,
      },
    ]
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: {
        push: () => undefined,
        items: () => buffer,
        size: () => buffer.length,
        clear: () => undefined,
      },
    })
    const text = handle.root.textContent
    expect(text).toContain('allied_with')
    expect(text).toContain('019e6047…')
    expect(text).toContain('new-007')
    handle.unmount()
  })

  // myth-imxg T13: per-fact wire events render with topic + content snippet.
  // Symmetric with edge-added: the drawer's <summary> shows the relationship-
  // class identifier (topic) + a truncated content fragment so an operator
  // can scan facts at a glance without expanding the JSON.
  it('renders fact-added events with topic + content fragment', () => {
    const parent = withDom()
    const buffer: DrawerEvent[] = [
      {
        campaignId: 'c01234567',
        type: 'fact-added',
        data: {
          type: 'fact-added',
          entitySynthKey: 'world_and_factions/npcs/3',
          factId: '019e6047-aaaa-bbbb-cccc-dddddddddddd',
          topic: 'duties',
          content: 'Walks the cloister at dawn, lighting the altar candles.',
          accessLevel: 'known',
        },
        receivedAt: 0,
      },
    ]
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: {
        push: () => undefined,
        items: () => buffer,
        size: () => buffer.length,
        clear: () => undefined,
      },
    })
    const text = handle.root.textContent
    expect(text).toContain('+ fact')
    expect(text).toContain('duties')
    expect(text).toContain('Walks the cloister')
    handle.unmount()
  })

  it('renders fact-removed events with the factId', () => {
    const parent = withDom()
    const buffer: DrawerEvent[] = [
      {
        campaignId: 'c01234567',
        type: 'fact-removed',
        data: {
          type: 'fact-removed',
          entitySynthKey: 'world_and_factions/npcs/3',
          factId: '019e6047-aaaa-bbbb-cccc-dddddddddddd',
        },
        receivedAt: 0,
      },
    ]
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: {
        push: () => undefined,
        items: () => buffer,
        size: () => buffer.length,
        clear: () => undefined,
      },
    })
    const text = handle.root.textContent
    expect(text).toContain('− fact')
    expect(text).toContain('019e6047')
    handle.unmount()
  })

  it('renders fact-updated events with the new content fragment', () => {
    const parent = withDom()
    const buffer: DrawerEvent[] = [
      {
        campaignId: 'c01234567',
        type: 'fact-updated',
        data: {
          type: 'fact-updated',
          entitySynthKey: 'world_and_factions/npcs/3',
          factId: '019e6047-aaaa-bbbb-cccc-dddddddddddd',
          topic: 'duties',
          content: 'Walks the cloister at dusk, snuffing the altar candles.',
          accessLevel: 'known',
        },
        receivedAt: 0,
      },
    ]
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: {
        push: () => undefined,
        items: () => buffer,
        size: () => buffer.length,
        clear: () => undefined,
      },
    })
    const text = handle.root.textContent
    expect(text).toContain('~ fact')
    expect(text).toContain('duties')
    expect(text).toContain('Walks the cloister')
    handle.unmount()
  })

  it('opening a row renders the full JSON payload (lazy via <details>)', () => {
    const parent = withDom()
    const buffer: DrawerEvent[] = [
      {
        campaignId: 'c01234567',
        type: 'entity-added',
        data: { type: 'entity-added', synthKey: 'world_and_factions/factions/2', entityKind: 'faction', name: 'The Silvermark' },
        receivedAt: 0,
      },
    ]
    const handle = mountDrawer(parent, {
      subscriptions: emptySubscriptions,
      bus: emptyBus,
      buffer: {
        push: () => undefined,
        items: () => buffer,
        size: () => buffer.length,
        clear: () => undefined,
      },
    })
    const det = handle.root.querySelector<HTMLDetailsElement>('details')
    if (det === null) throw new Error('details missing')
    // Closed: only summary text present, no <pre>.
    expect(det.querySelector('pre')).toBeNull()
    det.open = true
    det.dispatchEvent(new Event('toggle'))
    const pre = det.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('"synthKey"')
    expect(pre?.textContent).toContain('"The Silvermark"')
    handle.unmount()
  })
})
