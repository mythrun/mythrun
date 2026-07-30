import { vi } from 'vitest'

// jsdom has no IntersectionObserver. Minimal stub: constructible, records
// instances so tests can drive callbacks; observe/disconnect are spies.
// Registered globally in ./setup.ts; tests import the class to reach the
// latest instance (`IntersectionObserverStub.instances.at(-1)`) and drive
// its callback.
export class IntersectionObserverStub implements IntersectionObserver {
  static instances: IntersectionObserverStub[] = []
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  constructor(public callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = (): IntersectionObserverEntry[] => []
}
