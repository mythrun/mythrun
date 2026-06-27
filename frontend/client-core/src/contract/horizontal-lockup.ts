import type { BaseProps } from './index.ts'

/**
 * The SECONDARY (horizontal, mark-on-right) lockup — wordmark on the left, mark on
 * the right (brand guidelines → "The lockups → Secondary lockup"). Used where
 * horizontal space is abundant but vertical space is limited (nav bars, narrow
 * headers, email signatures). Monochrome ink-on-cream, theme-driven via
 * `currentColor` set to the `--ink` token (flips to cream on the dark field).
 *
 * Platform-neutral (§9 / R2): no className/style/DOM events. The rendered HEIGHT
 * comes in as a neutral `size` number; the width is derived from the locked
 * 3.85:1-ish aspect so the composition never distorts.
 */
export interface HorizontalLockupProps extends Omit<BaseProps, 'children'> {
  /**
   * Accessible name for the lockup (an i18n KEY the consumer resolves). Required:
   * the lockup is a meaningful image.
   */
  'aria-label': string
  /** Rendered height in CSS pixels; width tracks the locked aspect. Default `56`. */
  size?: number
}
