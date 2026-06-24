import { create } from 'zustand'

// The session store: the client brain's single source of truth for the player's
// auth lifecycle. It is intentionally tiny and DOM-free — `zustand`'s store
// holds plain state + transition actions, no web globals — so the same logic
// drives the web shell today and a native shell later (R1). The web/native
// adapters that ACQUIRE identity (OAuth callback, token refresh) call these
// transitions; the store itself stays platform-agnostic.

/**
 * The three auth states, in lifecycle order:
 * - `unauthenticated` — no identity (logged out / pre-login).
 * - `onboarding-required` — identity known, profile not yet finalised.
 * - `ready` — fully provisioned; the app is playable.
 */
export type SessionStatus = 'unauthenticated' | 'onboarding-required' | 'ready'

export interface SessionState {
  status: SessionStatus
  /** The Cognito `sub` of the signed-in player, or `null` when unauthenticated. */
  sub: string | null
  /** Transition to logged-out: clears the sub. */
  setUnauthenticated: () => void
  /** Transition to "identity known, profile incomplete". */
  setOnboardingRequired: (sub: string) => void
  /** Transition to fully-provisioned. */
  setReady: (sub: string) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'unauthenticated',
  sub: null,
  setUnauthenticated: () => {
    set({ status: 'unauthenticated', sub: null })
  },
  setOnboardingRequired: (sub) => {
    set({ status: 'onboarding-required', sub })
  },
  setReady: (sub) => {
    set({ status: 'ready', sub })
  },
}))
