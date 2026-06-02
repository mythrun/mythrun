// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mountShell } from '../shell.js'

// myth-0smu: the shell now mounts workflow pages (Campaigns / World /
// Characters / Users & Access / Billing / System) instead of individual
// (endpoint × method) panels. Tests pinned to the workflow layer.

function ensureDom(): void {
  const ls = (globalThis as { localStorage?: { clear?: () => void } }).localStorage
  if (ls === undefined || typeof ls.clear !== 'function') {
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
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MapStorage(),
      configurable: true,
      writable: true,
    })
  }
  if (!document.querySelector('header')) {
    const h = document.createElement('header')
    document.body.appendChild(h)
  }
  if (!document.querySelector('main')) {
    const m = document.createElement('main')
    document.body.appendChild(m)
  }
}

// fetch may be unset in the JSDOM env; the header-chrome polls
// /health and /api/campaigns/mine on mount. Stub it to return a
// minimal valid shape so the shell mount completes without errors.
function stubFetch(): void {
  ;(globalThis as { fetch?: unknown }).fetch = vi.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : ''
    if (url.includes('/health')) {
      return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    }
    if (url.includes('/api/campaigns/mine')) {
      return Promise.resolve(new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
}

describe('mountShell', () => {
  it('mounts header chrome + banner + sidebar + main + drawer into document', () => {
    ensureDom()
    stubFetch()
    mountShell()
    expect(document.querySelector('[data-region="header-chrome"]')).not.toBeNull()
    expect(document.querySelector('[data-region="banner"]')).not.toBeNull()
    expect(document.querySelector('nav')).not.toBeNull()
    expect(document.querySelector('[data-region="main"]')).not.toBeNull()
    expect(document.querySelector('[data-region="drawer"]')).not.toBeNull()
  })

  // MYT-62 T7: the live session-prep prose view mounts inside the drawer,
  // with two labeled panes fed by the second (prose) subscription manager.
  it('mounts the session-prep prose view (ft_context + sd_playbook panes) inside the drawer', () => {
    ensureDom()
    stubFetch()
    mountShell()
    const drawer = document.querySelector('[data-region="drawer"]')
    expect(drawer).not.toBeNull()
    const proseView = drawer?.querySelector('[data-region="prose-view"]')
    expect(proseView).not.toBeNull()
    expect(proseView?.querySelector('[data-prose-field="ft_context"]')).not.toBeNull()
    expect(proseView?.querySelector('[data-prose-field="sd_playbook"]')).not.toBeNull()
  })

  it('default workflow is Campaigns; sidebar shows one leaf per workflow', () => {
    ensureDom()
    stubFetch()
    mountShell()
    const leaves = document.querySelectorAll('[data-leaf]')
    expect(leaves.length).toBeGreaterThanOrEqual(6)
    // Default workflow id is persisted in localStorage by selectWorkflow.
    expect(localStorage.getItem('devtool.selectedWorkflow')).toBe('campaigns')
  })
})
