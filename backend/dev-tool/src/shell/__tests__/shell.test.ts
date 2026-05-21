// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mountShell, registerPanelMount } from '../shell.js'
import type { PanelHandle } from '../../components/_shared/panel-skeleton.js'

// Note: the JSDOM env from the pragma provides document/window/localStorage,
// but Node 25's bare localStorage stub may override JSDOM's. Apply the same
// MapStorage shim pattern other shell tests use if needed.

function ensureDom(): void {
  // Document/window are already set up by JSDOM env from the pragma.
  // If localStorage methods are missing, install a Map-backed shim.
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
  // Make sure <header> and <main> exist.
  if (!document.querySelector('header')) {
    const h = document.createElement('header')
    document.body.appendChild(h)
  }
  if (!document.querySelector('main')) {
    const m = document.createElement('main')
    document.body.appendChild(m)
  }
}

describe('mountShell', () => {
  it('mounts banner + sidebar + main + drawer into document', () => {
    ensureDom()
    mountShell()
    expect(document.querySelector('[data-region="banner"]')).not.toBeNull()
    expect(document.querySelector('nav')).not.toBeNull()
    expect(document.querySelector('[data-region="main"]')).not.toBeNull()
    expect(document.querySelector('[data-region="drawer"]')).not.toBeNull()
  })

  it('selecting a sidebar leaf mounts the registered panel and unmounts the previous', () => {
    ensureDom()
    const aRoot = document.createElement('div')
    const bRoot = document.createElement('div')
    const aHandle: PanelHandle = { root: aRoot, unmount: vi.fn() }
    const bHandle: PanelHandle = { root: bRoot, unmount: vi.fn() }
    registerPanelMount('GET', '/api/users/me', (parent) => { parent.appendChild(aRoot); return aHandle })
    registerPanelMount('GET', '/health', (parent) => { parent.appendChild(bRoot); return bHandle })
    mountShell()
    const leafMe = document.querySelector('[data-leaf="GET /api/users/me"]') as HTMLElement
    const leafHealth = document.querySelector('[data-leaf="GET /health"]') as HTMLElement
    leafMe.click()
    expect(aHandle.unmount).not.toHaveBeenCalled()
    leafHealth.click()
    expect(aHandle.unmount).toHaveBeenCalledTimes(1)
  })
})
