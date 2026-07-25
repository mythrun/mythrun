import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  WORLD_CONCEPT_DRAFT_KEY,
  readWorldConceptDraft,
  writeWorldConceptDraft,
  clearWorldConceptDraft,
  useWorldConceptDraft,
} from './world-concept-draft.ts'
import type { SessionDraftStore } from './guided-draft.ts'

// The FREEFORM world-concept draft (myth-5fi4q) — the campaign-create screen's
// other half, which used to hold the player's typed world in plain `useState`
// while its guided sibling had persisted picks since §11. The store is INJECTED
// (the character-draft shape), so every case here hands its own fake and there is
// no global to reset.

/** An in-memory SessionDraftStore standing in for the web localStorage impl. */
function memStore(): SessionDraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value)
    },
    remove: (key) => {
      map.delete(key)
    },
  }
}

const CONCEPT = 'A drowned archive city where the tides read the books'

describe('world-concept draft persistence seam', () => {
  it('round-trips the concept through the store', () => {
    const store = memStore()
    writeWorldConceptDraft(store, CONCEPT)
    expect(readWorldConceptDraft(store)).toBe(CONCEPT)
  })

  it('clears the persisted concept', () => {
    const store = memStore()
    writeWorldConceptDraft(store, CONCEPT)
    clearWorldConceptDraft(store)
    expect(readWorldConceptDraft(store)).toBeNull()
    expect(store.map.size).toBe(0)
  })

  it('reads null and no-ops writes when there is no store', () => {
    expect(readWorldConceptDraft(null)).toBeNull()
    expect(() => {
      writeWorldConceptDraft(null, CONCEPT)
    }).not.toThrow()
    expect(() => {
      clearWorldConceptDraft(null)
    }).not.toThrow()
  })

  it('reads null on an absent key', () => {
    expect(readWorldConceptDraft(memStore())).toBeNull()
  })

  it('yields null on a corrupt or foreign stored payload', () => {
    const store = memStore()
    store.set(WORLD_CONCEPT_DRAFT_KEY, '{ not json')
    expect(readWorldConceptDraft(store)).toBeNull()
    store.set(WORLD_CONCEPT_DRAFT_KEY, JSON.stringify({ picks: [] }))
    expect(readWorldConceptDraft(store)).toBeNull()
  })
})

describe('useWorldConceptDraft', () => {
  it('seeds `initial` from the store ONCE, then writes through on update', () => {
    const store = memStore()
    writeWorldConceptDraft(store, CONCEPT)
    const { result } = renderHook(() => useWorldConceptDraft(store))
    expect(result.current.initial).toBe(CONCEPT)

    act(() => {
      result.current.update('Something else entirely')
    })
    expect(readWorldConceptDraft(store)).toBe('Something else entirely')
    // `initial` is the mount snapshot — it does not chase the live value.
    expect(result.current.initial).toBe(CONCEPT)
  })

  it('seeds empty when nothing is persisted, and clears on demand', () => {
    const store = memStore()
    const { result } = renderHook(() => useWorldConceptDraft(store))
    expect(result.current.initial).toBe('')
    act(() => {
      result.current.update(CONCEPT)
    })
    act(() => {
      result.current.clear()
    })
    expect(readWorldConceptDraft(store)).toBeNull()
  })

  // The actions always target the LATEST store identity, so a re-render handing a
  // fresh store object never writes into the dead one.
  it('writes into the store handed on the most recent render', () => {
    const first = memStore()
    const second = memStore()
    const { result, rerender } = renderHook(({ store }) => useWorldConceptDraft(store), {
      initialProps: { store: first },
    })
    rerender({ store: second })
    act(() => {
      result.current.update(CONCEPT)
    })
    expect(readWorldConceptDraft(second)).toBe(CONCEPT)
    expect(first.map.size).toBe(0)
  })

  it('degrades to non-persistent when no store is configured', () => {
    const { result } = renderHook(() => useWorldConceptDraft(null))
    expect(result.current.initial).toBe('')
    expect(() => {
      act(() => {
        result.current.update(CONCEPT)
        result.current.clear()
      })
    }).not.toThrow()
  })
})
