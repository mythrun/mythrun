import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore } from './session.ts'

// The session store is the client brain's single source of truth for "who is
// the player, and where are they in the auth lifecycle." Three states only:
// unauthenticated (no identity), onboarding-required (identity known, profile
// not yet finalised), ready (fully provisioned). The store is DOM-free so the
// same logic drives web today and a native shell later.

// The store is a module-level singleton; reset it to its default between tests
// so ordering can't leak state. `setState(_, true)` replaces (not merges).
const initial = useSessionStore.getInitialState()
beforeEach(() => {
  useSessionStore.setState(initial, true)
})

describe('useSessionStore', () => {
  it('starts unauthenticated with no sub', () => {
    const { status, sub } = useSessionStore.getState()
    expect(status).toBe('unauthenticated')
    expect(sub).toBeNull()
  })

  it('setOnboardingRequired(sub) moves to onboarding-required and records the sub', () => {
    useSessionStore.getState().setOnboardingRequired('sub-123')
    const { status, sub } = useSessionStore.getState()
    expect(status).toBe('onboarding-required')
    expect(sub).toBe('sub-123')
  })

  it('setReady(sub) moves to ready and records the sub', () => {
    useSessionStore.getState().setReady('sub-456')
    const { status, sub } = useSessionStore.getState()
    expect(status).toBe('ready')
    expect(sub).toBe('sub-456')
  })

  it('setUnauthenticated() returns to the default and clears the sub', () => {
    useSessionStore.getState().setReady('sub-789')
    useSessionStore.getState().setUnauthenticated()
    const { status, sub } = useSessionStore.getState()
    expect(status).toBe('unauthenticated')
    expect(sub).toBeNull()
  })

  it('walks the full lifecycle: unauthenticated → onboarding-required → ready → unauthenticated', () => {
    const store = useSessionStore.getState()

    expect(store.status).toBe('unauthenticated')

    store.setOnboardingRequired('player-1')
    expect(useSessionStore.getState()).toMatchObject({
      status: 'onboarding-required',
      sub: 'player-1',
    })

    store.setReady('player-1')
    expect(useSessionStore.getState()).toMatchObject({ status: 'ready', sub: 'player-1' })

    store.setUnauthenticated()
    expect(useSessionStore.getState()).toMatchObject({ status: 'unauthenticated', sub: null })
  })
})
