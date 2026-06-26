import { afterEach, describe, expect, it } from 'vitest'
import { createWebOAuthStateStore } from './oauth-state-store.ts'

afterEach(() => {
  sessionStorage.clear()
})

describe('createWebOAuthStateStore', () => {
  it('set then take returns the payload once (single-use)', () => {
    const store = createWebOAuthStateStore()
    store.set('st', { provider: 'google', returnTo: '/join/x', verifier: 'v1' })
    expect(store.take('st')).toEqual({ provider: 'google', returnTo: '/join/x', verifier: 'v1' })
    expect(store.take('st')).toBeNull()
  })
  it('take returns null for an unknown state', () => {
    expect(createWebOAuthStateStore().take('nope')).toBeNull()
  })
  it('take returns null (and clears) when the stored value is corrupt JSON', () => {
    const store = createWebOAuthStateStore()
    sessionStorage.setItem('mythrun_oauth_state:bad', '{not json')
    expect(store.take('bad')).toBeNull()
  })
})
