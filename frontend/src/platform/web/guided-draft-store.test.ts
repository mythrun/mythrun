import { afterEach, describe, expect, it } from 'vitest'
import { createWebSessionDraftStore } from './guided-draft-store.ts'

afterEach(() => {
  sessionStorage.clear()
})

describe('createWebSessionDraftStore', () => {
  it('round-trips a value through sessionStorage', () => {
    const store = createWebSessionDraftStore()
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
  })
  it('returns null for an absent key', () => {
    expect(createWebSessionDraftStore().get('nope')).toBeNull()
  })
  it('removes a value', () => {
    const store = createWebSessionDraftStore()
    store.set('k', 'v')
    store.remove('k')
    expect(store.get('k')).toBeNull()
  })
})
