import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createWebSecureStorage } from './secure-storage.ts'

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. Node 25 ships the
// experimental Web Storage API on by default, so a non-functional built-in
// `localStorage` (no `getItem`/`setItem`, requires `--localstorage-file`) is
// installed on `globalThis` and shadows the real `Storage` jsdom would provide
// (`localStorage === window.localStorage` resolves to the same broken object).
// The production impl legitimately uses the browser's real `localStorage`, which
// works in a real browser; here we install a functional in-memory `Storage` onto
// the global so the test exercises the impl through the same global the browser
// uses. Mirrors the `ui/vitest.setup.ts` precedent of shimming jsdom gaps in test
// scope only.
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

// These assertions exercise the async wrapper end-to-end (set → get round-trips
// the value; remove → get resolves null), so the test fails if the impl forgets
// to await/return or wires the wrong store method.
describe('createWebSecureStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips a value: set then get resolves the stored string', async () => {
    const storage = createWebSecureStorage()
    await storage.set('k', 'v')
    await expect(storage.get('k')).resolves.toBe('v')
  })

  it('get resolves null for an absent key', async () => {
    const storage = createWebSecureStorage()
    await expect(storage.get('missing')).resolves.toBeNull()
  })

  it('remove deletes the key: get after remove resolves null', async () => {
    const storage = createWebSecureStorage()
    await storage.set('k', 'v')
    await storage.remove('k')
    await expect(storage.get('k')).resolves.toBeNull()
  })
})
