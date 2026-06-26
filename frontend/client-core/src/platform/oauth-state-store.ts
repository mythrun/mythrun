// A platform-capability port (R1): the DOM-free client brain persists the
// single-use OAuth `state` triple through this contract, never `sessionStorage`
// directly. The web impl (sessionStorage-backed) lands in @mythrun/web under
// src/platform/web/** (the sanctioned web-globals carve-out); a native shell can
// satisfy the same surface later. `take` is a single-use read+delete (CSRF +
// replay defense); a corrupt/absent payload yields null.
import type { AuthStateData } from '../auth/oauth.ts'

export interface OAuthStateStore {
  /** Persist the triple keyed by the opaque `state`. */
  set(state: string, payload: AuthStateData): void
  /** Read AND delete the triple for `state` (single-use); null if absent/corrupt. */
  take(state: string): AuthStateData | null
}
