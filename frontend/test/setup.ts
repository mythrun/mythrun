import { beforeEach, vi } from 'vitest'
import { IntersectionObserverStub } from './intersection-observer-stub.ts'

// jsdom has no IntersectionObserver. Stubbed globally so every web suite can
// mount components that observe (AppFrame's scroll-elevation sentinel renders
// on nearly every route). The class lives in its own module so tests can
// import it and drive callbacks.
//
// Registered per-test (beforeEach), NOT once at module load: several suites
// call vi.unstubAllGlobals() in afterEach (use-prefers-reduced-motion,
// streaming-fetch, dev-cost-ticker, knowledge-panel), which would silently
// strip a load-time stub for every test after the first in those files. The
// re-arm also resets the recorded instances so each test drives only its own
// observers.
beforeEach(() => {
  IntersectionObserverStub.instances = []
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})
