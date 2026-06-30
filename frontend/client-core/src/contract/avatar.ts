import type { BaseProps } from './index.ts'

/** Token avatar size → `--control-sm/md/lg` (32 / 40 / 48px). Default `md`. */
export type AvatarSize = 'sm' | 'md' | 'lg'

/**
 * The 12 curated avatar pigments — the "scribe's pigments". Each is a muted,
 * parchment-compatible hue that (a) stays distinguishable, (b) does NOT collide
 * with the status colors, and (c) carries paper-50 initials at ≥4.5:1 (WCAG AA
 * for 16px-bold = normal text). The web design system emits each as a
 * `--color-avatar-<name>` token → a `bg-avatar-<name>` Tailwind utility; the
 * single hex source is `@mythrun/client-core/tokens/scales`'s `AVATAR_COLORS`.
 *
 * A name (not a hex) keeps the contract platform-neutral: it is a neutral string
 * union, so a typo is a compile error and the native impl maps the same names.
 */
export type AvatarColor =
  | 'ember'
  | 'sienna'
  | 'ochre'
  | 'moss'
  | 'pine'
  | 'verdigris'
  | 'lapis'
  | 'iris'
  | 'heather'
  | 'rose'
  | 'umber'
  | 'slate'

/**
 * A small identity image with a deterministic fallback. When `src` resolves it
 * renders the image (its accessible name is `name`); when `src` is absent or
 * fails to load it falls back to 1–2 INITIALS derived from `name`, drawn on a
 * token surface. Either way the avatar carries `name` as its accessible label,
 * so the identity is never silent to assistive tech.
 *
 * Avatars are the brand's one sanctioned ROUND shape (like the radio dot) — a
 * conventional affordance the flat-1-bit register makes an explicit exception
 * for. The contract stays platform-neutral (§9): no className/style/DOM events;
 * `name` is plain identity text (not an i18n chrome key — it's the user's name).
 */
export interface AvatarProps extends BaseProps {
  /** The identity this avatar represents — its accessible name AND the source
   *  of the initials fallback. Required so the avatar is never nameless. */
  name: string
  /** Optional image URL. When it loads, the image renders (alt = `name`); on a
   *  missing/broken `src` the initials fallback shows instead. */
  src?: string
  /** Token size → `--control-sm/md/lg`. Default `md`. */
  size?: AvatarSize
  /** Pigment for the INITIALS fallback chip (a `bg-avatar-<color>` token).
   *  Omit to auto-assign a stable pigment derived from `name` — the same name
   *  always maps to the same color. An explicit `color` overrides the
   *  auto-assignment. (No effect when an image is shown.) */
  color?: AvatarColor
}

/**
 * Lays out a row of {@link AvatarProps Avatar}s as an overlapping cluster, each
 * separated by a token ring so the stack reads as distinct faces. When the
 * child count exceeds `max`, the first `max` render and a trailing `+N` overflow
 * chip stands in for the remainder.
 *
 * Platform-neutral (§9): `children` are Avatars; no className/style/DOM events.
 */
export interface AvatarGroupProps extends BaseProps {
  /** Cap on how many avatars render before collapsing the rest into `+N`.
   *  Omit to render every child. */
  max?: number
  /** The token surface the cluster sits on — selects the overlap-ring color so
   *  the ring matches the background and reads as a clean separation, not a
   *  mismatched halo. `'bg'` (default) rings in the PAGE color; `'surface'`
   *  rings in the CARD color, for a cluster placed on a Card. */
  surface?: 'bg' | 'surface'
  /** The Avatars to cluster — inherited from {@link BaseProps} as `children`. */
  children?: BaseProps['children']
}
