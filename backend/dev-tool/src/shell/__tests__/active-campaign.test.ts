// Node 25 ships a partial global `localStorage` that lacks the full
// Storage methods (getItem/setItem/removeItem/clear). It's also
// non-configurable, so JSDOM can't override it cleanly. We override
// it ourselves with a Map-backed stub via Object.defineProperty so
// the production code's bare `localStorage` reference resolves to a
// working Storage implementation under vitest.

import { describe, it, expect, beforeEach, vi } from 'vitest'

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

import { getActiveCampaignId, setActiveCampaignId, onActiveCampaignChanged } from '../active-campaign.js'

describe('active-campaign', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing stored', () => {
    expect(getActiveCampaignId()).toBeNull()
  })

  it('set + get round-trips and notifies subscribers', () => {
    const cb = vi.fn()
    onActiveCampaignChanged(cb)
    setActiveCampaignId('019e-aaaa')
    expect(getActiveCampaignId()).toBe('019e-aaaa')
    expect(cb).toHaveBeenCalledWith('019e-aaaa')
  })

  it('setActiveCampaignId(null) clears the value', () => {
    setActiveCampaignId('019e-bbbb')
    setActiveCampaignId(null)
    expect(getActiveCampaignId()).toBeNull()
  })

  it('returns an unsubscribe fn that stops notifications', () => {
    const cb = vi.fn()
    const off = onActiveCampaignChanged(cb)
    setActiveCampaignId('1')
    off()
    setActiveCampaignId('2')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('1')
  })
})
