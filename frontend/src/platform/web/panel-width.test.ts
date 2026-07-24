import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readPanelWidth, writePanelWidth } from './panel-width.ts'

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

describe('readPanelWidth', () => {
  it('round-trips a persisted width', () => {
    writePanelWidth('wiki', 421.6)
    // write rounds to a whole px
    expect(readPanelWidth('wiki', 320)).toBe(422)
  })

  it('falls back when the key is absent', () => {
    expect(readPanelWidth('nope', 320)).toBe(320)
  })

  it('falls back on a non-numeric stored value', () => {
    localStorage.setItem('wiki', 'garbage')
    expect(readPanelWidth('wiki', 320)).toBe(320)
  })

  it('falls back when the store throws (private mode)', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readPanelWidth('wiki', 320)).toBe(320)
  })
})

describe('writePanelWidth', () => {
  it('degrades without throwing when the store throws (quota exceeded)', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => {
      writePanelWidth('wiki', 400)
    }).not.toThrow()
  })
})
