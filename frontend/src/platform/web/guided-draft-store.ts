import type { SessionDraftStore } from '@mythrun/client-core'

// Web realization of the SessionDraftStore port (MYT-89 §11) — the guided-create
// draft backed by sessionStorage (tab-scoped, cleared on tab close), so a reload
// of the create flow re-prefills the in-progress picks but a fresh tab starts
// clean. Lives under src/platform/web/** (the one place web globals are allowed,
// R1); the client-core draft accessor reaches it only through the injected port.
// A native shell swaps an in-app store behind the same contract.
export function createWebSessionDraftStore(): SessionDraftStore {
  return {
    get: (key) => sessionStorage.getItem(key),
    set: (key, value) => { sessionStorage.setItem(key, value) },
    remove: (key) => { sessionStorage.removeItem(key) },
  }
}
