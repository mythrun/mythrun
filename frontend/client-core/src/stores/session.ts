import { create } from 'zustand'

// The session store: the client brain's single source of truth for the player's
// auth lifecycle. Tiny + DOM-free (R1) so the same logic drives web today and a
// native shell later. The platform adapters that ACQUIRE identity (the session
// adapter on the callback + on-load bootstrap) call these transitions.

/**
 * The four auth states, in lifecycle order:
 * - `initializing` — boot: the on-load refresh has not settled yet (jwt mode).
 *   `RequireAuth` shows a splash, NOT a redirect, while in this state.
 * - `unauthenticated` — no identity (logged out / pre-login / refresh failed).
 * - `onboarding-required` — identity known, profile not yet finalised.
 * - `ready` — fully provisioned; the app is playable.
 */
export type SessionStatus = 'initializing' | 'unauthenticated' | 'onboarding-required' | 'ready'

export interface SessionState {
  status: SessionStatus
  /** The Cognito `sub` of the signed-in player, or `null` when not ready/onboarding. */
  sub: string | null
  /** True after an `account_suspended` rejection — the sign-in screen surfaces a notice. */
  suspended: boolean
  /** Return to the boot state (used by logout-then-rebootstrap paths / tests). */
  setInitializing: () => void
  /** Transition to logged-out: clears the sub and the suspended flag. */
  setUnauthenticated: () => void
  /** Logged-out due to suspension: unauthenticated + the suspended notice flag. */
  setSuspended: () => void
  /** Transition to "identity known, profile incomplete". */
  setOnboardingRequired: (sub: string) => void
  /** Transition to fully-provisioned. */
  setReady: (sub: string) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'initializing',
  sub: null,
  suspended: false,
  setInitializing: () => {
    set({ status: 'initializing', sub: null, suspended: false })
  },
  setUnauthenticated: () => {
    set({ status: 'unauthenticated', sub: null, suspended: false })
  },
  setSuspended: () => {
    set({ status: 'unauthenticated', sub: null, suspended: true })
  },
  setOnboardingRequired: (sub) => {
    set({ status: 'onboarding-required', sub, suspended: false })
  },
  setReady: (sub) => {
    set({ status: 'ready', sub, suspended: false })
  },
}))
