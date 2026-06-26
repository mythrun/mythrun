import type { BaseProps } from './index.ts'

/**
 * The curated set of glyphs the design system ships today. A CLOSED union — a
 * typo'd name (`'chevrn-right'`) is a compile error, not a silent blank. Extend
 * this as components need more glyphs; the impl maps each name to a glyph from
 * the swappable source (today Pixelarticons; a Pro/Nucleo swap is one file).
 */
export type IconName =
  | 'close'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'plus'
  | 'minus'
  | 'check'
  | 'menu'
  | 'search'
  | 'external-link'
  // Chrome affordance (MYT-97) — the app-frame settings gear (an icon-only
  // IconButton, so a long display name can't shove a text label off-screen).
  | 'settings'
  // Status-intent severities (MYT-82 W3c — Banner / Toast). `check` (above)
  // doubles as the success glyph; these add the other three severities.
  | 'info'
  | 'warning-diamond'
  | 'square-alert'
  // Theme toggle (MYT-84) — the FAB's sun (light) / moon (dark) glyphs.
  | 'sun'
  | 'moon'

/** Token icon size → `--icon-sm/md/lg` (16 / 20 / 24px). Default `md`. */
export type IconSize = 'sm' | 'md' | 'lg'

/**
 * The a11y half of the Icon contract, as a discriminated pair (exactly one of):
 *  - `label`: an accessible name (an i18n KEY the consumer supplies). The icon
 *    is exposed to assistive tech as `role="img"` with that name.
 *  - `decorative`: the icon adds no information beyond adjacent text, so it is
 *    hidden from the a11y tree (`aria-hidden`). This is also the DEFAULT when
 *    neither is given — a bare `<Icon name="…" />` is decorative.
 *
 * Encoded with `never` guards so a consumer can't supply both at once.
 */
type IconA11y =
  | { label: string; decorative?: never }
  | { label?: never; decorative?: boolean }

/**
 * A single glyph rendered at a token size, tinted by the current text color
 * (`currentColor`). Platform-neutral: no `className`/`style`/DOM events. The
 * glyph source is swappable behind this contract (the `name → glyph` map lives
 * in the web impl). `children` (inherited from {@link BaseProps}) is unused — an
 * Icon is a leaf glyph.
 */
export type IconProps = BaseProps & {
  /** Which glyph to render (a closed, typed union — typos are compile errors). */
  name: IconName
  /** Token size. Default `md` → `--icon-md` (20px). */
  size?: IconSize
} & IconA11y
