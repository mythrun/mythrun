import type { AuthStateData, OAuthStateStore } from '@mythrun/client-core'

// Web realization of the OAuthStateStore port — the single-use OAuth `state`
// triple backed by sessionStorage (cleared on tab close; scoped to the tab that
// began the flow). Lives under src/platform/web/** (the one place web globals are
// allowed, R1); the client-core OAuth helper reaches it only through the injected
// port. `take` is read+delete with corrupt-payload→null. A native shell swaps an
// in-app secure store behind the same contract.
const STATE_KEY_PREFIX = 'mythrun_oauth_state:'

export function createWebOAuthStateStore(): OAuthStateStore {
  return {
    set: (state, payload) => {
      sessionStorage.setItem(STATE_KEY_PREFIX + state, JSON.stringify(payload))
    },
    take: (state) => {
      const key = STATE_KEY_PREFIX + state
      const raw = sessionStorage.getItem(key)
      if (raw === null) return null
      sessionStorage.removeItem(key)
      try {
        return JSON.parse(raw) as AuthStateData
      } catch {
        return null
      }
    },
  }
}
