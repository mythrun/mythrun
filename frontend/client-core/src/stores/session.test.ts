import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore } from './session.ts'

// The session store is the client brain's single source of truth for "who is
// the player, and where are they in the auth lifecycle." Four states:
// initializing (boot — the on-load refresh has not settled yet, jwt mode),
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
  it('starts initializing (jwt boot default) with no sub and not suspended', () => {
    const { status, sub, suspended } = useSessionStore.getState()
    expect(status).toBe('initializing')
    expect(sub).toBeNull()
    expect(suspended).toBe(false)
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

  it('walks the full lifecycle: initializing → onboarding-required → ready → unauthenticated', () => {
    const store = useSessionStore.getState()

    expect(store.status).toBe('initializing')

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

describe('session store — initializing + suspended (MYT-84)', () => {
  beforeEach(() => {
    useSessionStore.setState({ status: 'initializing', sub: null, suspended: false })
  })

  it('defaults to initializing with no sub and not suspended', () => {
    const s = useSessionStore.getState()
    expect(s.status).toBe('initializing')
    expect(s.sub).toBeNull()
    expect(s.suspended).toBe(false)
  })

  it('setReady moves to ready and carries the sub, clearing suspended', () => {
    useSessionStore.getState().setSuspended()
    useSessionStore.getState().setReady('sub-123')
    const s = useSessionStore.getState()
    expect(s.status).toBe('ready')
    expect(s.sub).toBe('sub-123')
    expect(s.suspended).toBe(false)
  })

  it('setOnboardingRequired moves to onboarding-required with the sub', () => {
    useSessionStore.getState().setOnboardingRequired('sub-9')
    expect(useSessionStore.getState().status).toBe('onboarding-required')
    expect(useSessionStore.getState().sub).toBe('sub-9')
  })

  it('setSuspended is unauthenticated + suspended, sub cleared', () => {
    useSessionStore.getState().setReady('sub-1')
    useSessionStore.getState().setSuspended()
    const s = useSessionStore.getState()
    expect(s.status).toBe('unauthenticated')
    expect(s.sub).toBeNull()
    expect(s.suspended).toBe(true)
  })

  it('setUnauthenticated clears suspended', () => {
    useSessionStore.getState().setSuspended()
    useSessionStore.getState().setUnauthenticated()
    expect(useSessionStore.getState().suspended).toBe(false)
  })

  it('setInitializing returns to the boot state', () => {
    useSessionStore.getState().setReady('sub-1')
    useSessionStore.getState().setInitializing()
    expect(useSessionStore.getState().status).toBe('initializing')
    expect(useSessionStore.getState().sub).toBeNull()
  })
})
