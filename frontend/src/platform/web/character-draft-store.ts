import type { SessionDraftStore } from '@mythrun/client-core'

// Web realization of the draft-store port for CHARACTER creation, backed by
// localStorage — NOT sessionStorage like the campaign guided-picks draft
// (src/platform/web/guided-draft-store.ts). Character creation is a higher-
// investment surface: the player writes freeform prose, then waits on a ~30s LLM
// pipeline that CAN fail, and the failure surface explicitly invites "Start over".
// localStorage keeps their OWN written words across a reload, a tab close, or a
// crash — never lost, which is the whole point of this fix.
//
// Lives under src/platform/web/** (the one place web globals are allowed, R1); the
// client-core draft accessor reaches it only through the injected port. Every call
// is wrapped: a disabled or full store (Safari private mode historically threw on
// setItem; quota-exceeded anywhere) degrades to non-persistent rather than throwing
// into the create flow. A native shell swaps an in-app store behind the same contract.
export function createWebLocalDraftStore(): SessionDraftStore {
  return {
    get: (key) => {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value)
      } catch {
        // private mode / quota exceeded — degrade to non-persistent, never crash.
      }
    },
    remove: (key) => {
      try {
        localStorage.removeItem(key)
      } catch {
        // ignore — a store that can't remove also can't have persisted.
      }
    },
  }
}
