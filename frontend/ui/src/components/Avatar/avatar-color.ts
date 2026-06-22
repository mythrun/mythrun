import { AVATAR_COLORS } from '@mythrun/client-core/tokens/scales'
import type { AvatarColor } from '@mythrun/client-core/contract'

// Pure, deterministic auto-assignment of an avatar pigment from a name. No DOM,
// no Math.random, no Date — the SAME name always maps to the SAME pigment, so a
// person's chip color is stable across renders / sessions / devices. The Avatar
// uses this only when no explicit `color` prop is given.

/**
 * The 12 curated pigment names, in token order — derived from the single source
 * (`AVATAR_COLORS` in scales.ts) so this can never drift from the palette. The
 * `as` cast is the one place we assert the keys ARE `AvatarColor[]`: the contract
 * union and the token record are authored to the same 12 names (kept honest by
 * scales.test.ts asserting the exact name set), so the cast is sound.
 */
export const AVATAR_COLOR_NAMES = Object.keys(AVATAR_COLORS) as readonly AvatarColor[]

/**
 * A small stable djb2 hash over the name's char codes → a non-negative index
 * into {@link AVATAR_COLOR_NAMES}. djb2 (`h * 33 + c`) gives a good spread over
 * short strings; `>>> 0` keeps it an unsigned 32-bit int so the modulo is always
 * in range. Deterministic by construction — the texture of a name maps to one
 * fixed pigment.
 */
export function avatarColorFor(name: string): AvatarColor {
  let h = 5381
  for (let i = 0; i < name.length; i++) {
    h = (((h << 5) + h) + name.charCodeAt(i)) >>> 0 // h * 33 + c, unsigned
  }
  const index = h % AVATAR_COLOR_NAMES.length
  // `index` is always 0..length-1, so the access is in-range; the `?? 'ember'`
  // keeps it total for `noUncheckedIndexedAccess` without a banned non-null `!`.
  return AVATAR_COLOR_NAMES[index] ?? 'ember'
}
