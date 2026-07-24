import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWebLocalDraftStore } from './character-draft-store.ts'

// The jsdom env here lacks a functional localStorage; install the same
// in-memory Storage the sibling route tests use (reveal/campaign-detail idiom).
class MemStorage {
  private readonly store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  get length(): number {
    return this.store.size
  }
}
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('createWebLocalDraftStore', () => {
  it('round-trips a value through localStorage', () => {
    const store = createWebLocalDraftStore()
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
  })

  it('returns null for an absent key', () => {
    expect(createWebLocalDraftStore().get('nope')).toBeNull()
  })

  it('removes a value', () => {
    const store = createWebLocalDraftStore()
    store.set('k', 'v')
    store.remove('k')
    expect(store.get('k')).toBeNull()
  })

  // The degrade-to-non-persistent contract: a disabled/full store (Safari private
  // mode setItem throw; quota exceeded) must never throw into the create flow.
  it('degrades without throwing when the store is disabled (every call throws)', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const store = createWebLocalDraftStore()
    expect(() => {
      store.set('k', 'v')
    }).not.toThrow()
    expect(store.get('k')).toBeNull()
    expect(() => {
      store.remove('k')
    }).not.toThrow()
  })
})
