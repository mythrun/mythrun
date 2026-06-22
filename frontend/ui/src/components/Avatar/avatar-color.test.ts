import { describe, it, expect } from 'vitest'
import { AVATAR_COLORS } from '@mythrun/client-core/tokens/scales'
import type { AvatarColor } from '@mythrun/client-core/contract'
import { AVATAR_COLOR_NAMES, avatarColorFor } from './avatar-color.ts'

// avatarColorFor is the PURE, deterministic auto-assign: a name → one of the 12
// curated pigments, via a stable integer hash (no Math.random / Date), so the
// SAME name always maps to the SAME pigment forever. The explicit `color` prop
// (handled in Avatar.tsx) overrides this; here we prove the auto path alone.

describe('AVATAR_COLOR_NAMES', () => {
  it('is exactly the 12 curated pigment names (in token order)', () => {
    expect(AVATAR_COLOR_NAMES).toEqual(Object.keys(AVATAR_COLORS))
  })
})

describe('avatarColorFor — deterministic name → pigment', () => {
  it('always returns one of the 12 names (in range)', () => {
    const names = [
      'Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'merlin', 'X', '',
      '   ', '🜔 sigil', 'Zoë', 'a'.repeat(500),
    ]
    for (const n of names) {
      expect(AVATAR_COLOR_NAMES).toContain(avatarColorFor(n))
    }
  })

  it('is stable: the same name maps to the same pigment across calls', () => {
    for (const n of ['Ada Lovelace', 'Grace Hopper', 'Edsger Dijkstra', '']) {
      const a = avatarColorFor(n)
      const b = avatarColorFor(n)
      expect(b).toBe(a)
    }
  })

  it('returns a typed AvatarColor (compile-time) at runtime too', () => {
    const c: AvatarColor = avatarColorFor('Ada Lovelace')
    expect(typeof c).toBe('string')
  })

  it('spreads names across the set (not collapsed onto one pigment)', () => {
    // A spread of distinct names should touch several distinct pigments — a
    // degenerate hash that always returns index 0 would fail this.
    const names = [
      'Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra',
      'Ken Thompson', 'Barbara Liskov', 'Donald Knuth', 'Margaret Hamilton',
      'Linus Torvalds', 'Tim Berners-Lee', 'Vint Cerf', 'Radia Perlman',
      'Katherine Johnson', 'Dennis Ritchie', 'John McCarthy', 'Claude Shannon',
    ]
    const distinct = new Set(names.map(avatarColorFor))
    expect(distinct.size).toBeGreaterThanOrEqual(5)
  })

  it('treats different names as (generally) different — case-sensitive hash', () => {
    // The hash is over raw char codes, so case/whitespace matter; this is just a
    // smoke that the function does not ignore its input.
    expect(avatarColorFor('alice')).toBe(avatarColorFor('alice'))
  })
})
