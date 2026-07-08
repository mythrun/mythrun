import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useWikiNavigation, type WikiLocation } from '../use-wiki-navigation.ts'

// useWikiNavigation (MYT-89 Phase D, D3): the wiki's platform-neutral history
// stack. No router, no DOM — just a `{ current, back }` reducer over
// `WikiLocation`s. These tests pin the browse journey (push/back), the `home`
// reset, `canBack` depth, per-entry scroll retention (the drawer stays mounted
// across close, so the reader's scroll on each visited page must survive a
// navigate-away-and-back), the same-entity no-op (a double-tapped RELATED link
// must not build a two-deep stack of one page), and stable action identities
// (D4 lists these in effect deps).

/** Narrow `current` to the entity variant for scroll assertions; throws (fails
 *  the test) if the hook is unexpectedly sitting on `home`. */
function asEntity(loc: WikiLocation): Extract<WikiLocation, { type: 'entity' }> {
  if (loc.type !== 'entity') throw new Error(`expected an entity location, got ${loc.type}`)
  return loc
}

describe('useWikiNavigation', () => {
  it('starts at home with no back history', () => {
    const { result } = renderHook(() => useWikiNavigation())
    expect(result.current.current).toEqual({ type: 'home' })
    expect(result.current.canBack).toBe(false)
  })

  it('push moves to an entity page at scroll 0 and unlocks back', () => {
    const { result } = renderHook(() => useWikiNavigation())
    act(() => { result.current.push('entity-a'); })
    expect(result.current.current).toEqual({ type: 'entity', entityId: 'entity-a', scroll: 0 })
    expect(result.current.canBack).toBe(true)
  })

  it('push(A) → push(B) → back() returns to A, then back() returns home', () => {
    const { result } = renderHook(() => useWikiNavigation())
    act(() => { result.current.push('entity-a'); })
    act(() => { result.current.push('entity-b'); })
    expect(asEntity(result.current.current).entityId).toBe('entity-b')

    act(() => { result.current.back(); })
    expect(asEntity(result.current.current).entityId).toBe('entity-a')
    expect(result.current.canBack).toBe(true)

    act(() => { result.current.back(); })
    expect(result.current.current).toEqual({ type: 'home' })
    expect(result.current.canBack).toBe(false)
  })

  it('canBack reflects stack depth as it grows and shrinks', () => {
    const { result } = renderHook(() => useWikiNavigation())
    expect(result.current.canBack).toBe(false)
    act(() => { result.current.push('entity-a'); })
    expect(result.current.canBack).toBe(true)
    act(() => { result.current.push('entity-b'); })
    expect(result.current.canBack).toBe(true)
    act(() => { result.current.back(); })
    expect(result.current.canBack).toBe(true)
    act(() => { result.current.back(); })
    expect(result.current.canBack).toBe(false)
  })

  it('back() at home is a no-op', () => {
    const { result } = renderHook(() => useWikiNavigation())
    act(() => { result.current.back(); })
    expect(result.current.current).toEqual({ type: 'home' })
    expect(result.current.canBack).toBe(false)
  })

  it('home() resets the whole stack (canBack false afterwards)', () => {
    const { result } = renderHook(() => useWikiNavigation())
    act(() => { result.current.push('entity-a'); })
    act(() => { result.current.push('entity-b'); })
    act(() => { result.current.home(); })
    expect(result.current.current).toEqual({ type: 'home' })
    expect(result.current.canBack).toBe(false)
  })

  it('retains each entry scroll across a navigate-away-and-back', () => {
    const { result } = renderHook(() => useWikiNavigation())
    act(() => { result.current.push('entity-a'); })
    act(() => { result.current.setScroll(300); })
    act(() => { result.current.push('entity-b'); })
    act(() => { result.current.setScroll(150); })

    act(() => { result.current.back(); })
    const restored = asEntity(result.current.current)
    expect(restored.entityId).toBe('entity-a')
    expect(restored.scroll).toBe(300)
  })

  it('setScroll on the home page is a no-op (home carries no scroll)', () => {
    const { result } = renderHook(() => useWikiNavigation())
    const before = result.current.current
    act(() => { result.current.setScroll(80); })
    // Same location reference (state bailed out) — pins the docblock's
    // "no re-render on a no-op update" claim, not just an equal value.
    expect(result.current.current).toBe(before)
    expect(result.current.canBack).toBe(false)
  })

  it('push of the same entity as current is a no-op (no two-deep same page)', () => {
    const { result } = renderHook(() => useWikiNavigation())
    act(() => { result.current.push('entity-a'); })
    const afterFirst = result.current.current
    act(() => { result.current.push('entity-a'); })
    // Same location reference (state bailed out) — the stack did not grow.
    expect(result.current.current).toBe(afterFirst)
    expect(result.current.canBack).toBe(true)
    // A single back() reaches home, proving there is only one entry above home.
    act(() => { result.current.back(); })
    expect(result.current.current).toEqual({ type: 'home' })
    expect(result.current.canBack).toBe(false)
  })

  it('same-entity push at depth 2 is still a no-op (bail-out keys on current)', () => {
    const { result } = renderHook(() => useWikiNavigation())
    act(() => { result.current.push('entity-a'); })
    act(() => { result.current.push('entity-b'); })
    act(() => { result.current.push('entity-b'); })
    // A single back() lands on A — the redundant B push added no entry.
    act(() => { result.current.back(); })
    expect(asEntity(result.current.current).entityId).toBe('entity-a')
  })

  it('a same-entity push preserves the current entry scroll', () => {
    const { result } = renderHook(() => useWikiNavigation())
    act(() => { result.current.push('entity-a'); })
    act(() => { result.current.setScroll(220); })
    act(() => { result.current.push('entity-a'); })
    expect(asEntity(result.current.current).scroll).toBe(220)
  })

  it('exposes stable action identities across renders', () => {
    const { result } = renderHook(() => useWikiNavigation())
    const first = {
      push: result.current.push,
      home: result.current.home,
      back: result.current.back,
      setScroll: result.current.setScroll,
    }
    act(() => { result.current.push('entity-a'); })
    expect(result.current.push).toBe(first.push)
    expect(result.current.home).toBe(first.home)
    expect(result.current.back).toBe(first.back)
    expect(result.current.setScroll).toBe(first.setScroll)
  })
})
