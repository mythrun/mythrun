import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePanelWidth } from './use-panel-width.ts'

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
})

describe('usePanelWidth', () => {
  it('seeds from the default when nothing is persisted', () => {
    const { result } = renderHook(() => usePanelWidth('wiki-w', 280, 560, 360))
    expect(result.current.width).toBe(360)
  })

  it('seeds from the persisted value, CLAMPED to [min, max]', () => {
    localStorage.setItem('wiki-w', '9999')
    const { result } = renderHook(() => usePanelWidth('wiki-w', 280, 560, 360))
    expect(result.current.width).toBe(560)
  })

  it('onResize clamps, updates, and persists', () => {
    const { result } = renderHook(() => usePanelWidth('wiki-w', 280, 560, 360))
    act(() => {
      result.current.onResize(500)
    })
    expect(result.current.width).toBe(500)
    expect(localStorage.getItem('wiki-w')).toBe('500')

    act(() => {
      result.current.onResize(100) // below min → clamps to the floor
    })
    expect(result.current.width).toBe(280)
    expect(localStorage.getItem('wiki-w')).toBe('280')
  })
})
