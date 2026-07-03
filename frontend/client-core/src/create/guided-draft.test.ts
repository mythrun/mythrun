import { afterEach, describe, expect, it } from 'vitest'
import {
  configureGuidedDraft,
  readGuidedDraft,
  writeGuidedDraft,
  clearGuidedDraft,
  type GuidedDraft,
  type SessionDraftStore,
} from './guided-draft.ts'

// An in-memory SessionDraftStore standing in for the web sessionStorage impl.
function memStore(): SessionDraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (key) => map.get(key) ?? null,
    set: (key, value) => { map.set(key, value) },
    remove: (key) => { map.delete(key) },
  }
}

const DRAFT: GuidedDraft = {
  picks: [
    { title: 'Dark Souls', whyILikeIt: 'the oppressive melancholy' },
    { title: 'Dune', whyILikeIt: '' },
    { title: '', whyILikeIt: '' },
  ],
  step: 2,
}

afterEach(() => { configureGuidedDraft(null) })

describe('guided-draft persistence seam', () => {
  it('round-trips a draft through the configured store', () => {
    configureGuidedDraft(memStore())
    writeGuidedDraft(DRAFT)
    expect(readGuidedDraft()).toEqual(DRAFT)
  })

  it('clears the persisted draft', () => {
    const store = memStore()
    configureGuidedDraft(store)
    writeGuidedDraft(DRAFT)
    clearGuidedDraft()
    expect(readGuidedDraft()).toBeNull()
    expect(store.map.size).toBe(0)
  })

  it('reads null and no-ops writes when no store is configured', () => {
    // Unconfigured (the default / a native shell before boot wiring / tests).
    expect(readGuidedDraft()).toBeNull()
    expect(() => { writeGuidedDraft(DRAFT) }).not.toThrow()
    expect(() => { clearGuidedDraft() }).not.toThrow()
  })

  it('yields null on a corrupt or structurally-invalid stored payload', () => {
    const store = memStore()
    configureGuidedDraft(store)
    store.set('mythrun_guided_draft', '{ not json')
    expect(readGuidedDraft()).toBeNull()
    store.set('mythrun_guided_draft', JSON.stringify({ picks: [], step: 9 }))
    expect(readGuidedDraft()).toBeNull()
  })
})
