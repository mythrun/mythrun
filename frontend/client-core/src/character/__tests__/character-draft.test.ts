import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { SessionDraftStore } from '../../create/guided-draft.ts'
import {
  characterDraftKey,
  clearCharacterDraft,
  readCharacterDraft,
  useCharacterDraft,
  writeCharacterDraft,
} from '../character-draft.ts'

/** An in-memory fake of the injected port — the same surface the web localStorage
 *  impl satisfies. Exposes the backing map so tests can assert the raw payload. */
function fakeStore(): SessionDraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v)
    },
    remove: (k) => {
      map.delete(k)
    },
  }
}

const CAMPAIGN = '019f9007-1d6d-7494-82d7-9cff2f76b4c9'

describe('character-draft pure logic', () => {
  it('keys the draft per campaign', () => {
    expect(characterDraftKey(CAMPAIGN)).toBe(`mythrun_character_draft:${CAMPAIGN}`)
    expect(characterDraftKey('other')).not.toBe(characterDraftKey(CAMPAIGN))
  })

  it('returns null for an absent draft', () => {
    expect(readCharacterDraft(fakeStore(), CAMPAIGN)).toBeNull()
  })

  it('round-trips the freeform concept + grounding', () => {
    const store = fakeStore()
    writeCharacterDraft(store, CAMPAIGN, { conceptText: 'A tired sellsword with a debt' })
    writeCharacterDraft(store, CAMPAIGN, { groundingText: 'I followed the smoke down the valley' })
    expect(readCharacterDraft(store, CAMPAIGN)).toEqual({
      conceptText: 'A tired sellsword with a debt',
      groundingText: 'I followed the smoke down the valley',
    })
  })

  it('a patch never clobbers the OTHER in-progress field (read-merge-write)', () => {
    const store = fakeStore()
    writeCharacterDraft(store, CAMPAIGN, { conceptText: 'concept' })
    // Writing grounding must preserve the already-typed concept.
    writeCharacterDraft(store, CAMPAIGN, { groundingText: 'grounding' })
    expect(readCharacterDraft(store, CAMPAIGN)).toEqual({
      conceptText: 'concept',
      groundingText: 'grounding',
    })
    // And a later concept edit preserves the grounding.
    writeCharacterDraft(store, CAMPAIGN, { conceptText: 'concept v2' })
    expect(readCharacterDraft(store, CAMPAIGN)).toEqual({
      conceptText: 'concept v2',
      groundingText: 'grounding',
    })
  })

  it('merges guided picks field-by-field without dropping earlier picks', () => {
    const store = fakeStore()
    writeCharacterDraft(store, CAMPAIGN, { guided: { className: 'Rogue' } })
    writeCharacterDraft(store, CAMPAIGN, { guided: { species: 'Human' } })
    expect(readCharacterDraft(store, CAMPAIGN)?.guided).toEqual({
      className: 'Rogue',
      species: 'Human',
    })
  })

  it('preserves an over-length concept verbatim (drafts have no length cap)', () => {
    const store = fakeStore()
    const long = 'x'.repeat(5000)
    writeCharacterDraft(store, CAMPAIGN, { conceptText: long })
    expect(readCharacterDraft(store, CAMPAIGN)?.conceptText).toBe(long)
  })

  it('scopes drafts per campaign (no cross-campaign bleed)', () => {
    const store = fakeStore()
    writeCharacterDraft(store, CAMPAIGN, { conceptText: 'mine' })
    expect(readCharacterDraft(store, 'other-campaign')).toBeNull()
  })

  it('clears only when asked (a fail/start-over path does NOT clear)', () => {
    const store = fakeStore()
    writeCharacterDraft(store, CAMPAIGN, { conceptText: 'survives a failure' })
    // The draft is still present after a hypothetical failure + start-over (no clear).
    expect(readCharacterDraft(store, CAMPAIGN)?.conceptText).toBe('survives a failure')
    clearCharacterDraft(store, CAMPAIGN)
    expect(readCharacterDraft(store, CAMPAIGN)).toBeNull()
  })

  it('degrades to a null read / no-op write when unconfigured (store === null)', () => {
    expect(readCharacterDraft(null, CAMPAIGN)).toBeNull()
    expect(() => {
      writeCharacterDraft(null, CAMPAIGN, { conceptText: 'x' })
    }).not.toThrow()
    expect(() => {
      clearCharacterDraft(null, CAMPAIGN)
    }).not.toThrow()
  })

  it('treats a corrupt stored payload as no draft (never throws)', () => {
    const store = fakeStore()
    store.set(characterDraftKey(CAMPAIGN), '{not valid json')
    expect(readCharacterDraft(store, CAMPAIGN)).toBeNull()
  })
})

describe('useCharacterDraft', () => {
  it('snapshots the persisted draft once at mount', () => {
    const store = fakeStore()
    writeCharacterDraft(store, CAMPAIGN, { conceptText: 'restored', groundingText: 'ground' })
    const { result } = renderHook(() => useCharacterDraft(store, CAMPAIGN))
    expect(result.current.initial).toEqual({ conceptText: 'restored', groundingText: 'ground' })
  })

  it('update() persists a merge that a later read (and remount) sees', () => {
    const store = fakeStore()
    const { result } = renderHook(() => useCharacterDraft(store, CAMPAIGN))
    act(() => {
      result.current.update({ conceptText: 'typed as they went' })
    })
    // A fresh mount (the player returning to the flow) restores the typed words.
    const { result: reopened } = renderHook(() => useCharacterDraft(store, CAMPAIGN))
    expect(reopened.current.initial.conceptText).toBe('typed as they went')
  })

  it('clear() drops the draft', () => {
    const store = fakeStore()
    writeCharacterDraft(store, CAMPAIGN, { conceptText: 'gone soon' })
    const { result } = renderHook(() => useCharacterDraft(store, CAMPAIGN))
    act(() => {
      result.current.clear()
    })
    expect(readCharacterDraft(store, CAMPAIGN)).toBeNull()
  })

  it('returns a stable handle across re-renders (no effect churn)', () => {
    const store = fakeStore()
    const { result, rerender } = renderHook(() => useCharacterDraft(store, CAMPAIGN))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
