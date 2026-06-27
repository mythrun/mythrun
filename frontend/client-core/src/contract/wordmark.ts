import type { BaseProps } from './index.ts'

/**
 * The Mythrun WORDMARK — the "Mythrun" logotype in the locked Tyma Garamont
 * letterforms (brand guidelines → "Typography → Wordmark typeface"; deployed from
 * the export, never typeset fresh). Theme-driven via `currentColor` set to the
 * `--ink` token (ink on the light field, cream on the dark — the token flips).
 *
 * Platform-neutral (§9 / R2): no className/style/DOM events. The rendered HEIGHT
 * comes in as a neutral `size` number; the width is derived from the locked aspect
 * so the letterforms never distort.
 */
export interface WordmarkProps extends Omit<BaseProps, 'children'> {
  /**
   * Accessible name for the wordmark (an i18n KEY the consumer resolves). Required:
   * the wordmark is a meaningful image.
   */
  'aria-label': string
  /** Rendered height in CSS pixels; width tracks the locked aspect. Default `48`. */
  size?: number
}
