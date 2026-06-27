import type { BaseProps } from './index.ts'

/**
 * The brand's PRIMARY (stacked) lockup — the mark above the wordmark, monochrome
 * `ink`-on-cream (brand guidelines → "The lockups → Primary lockup (stacked)").
 * The default brand application: site headers, the sign-in title composition.
 *
 * Theme-driven: the artwork paints in `currentColor` and the component sets the
 * color to the `--ink` token, so it is ink on the light field and cream on the
 * dark field (the token flips under `.dark`). Decorative artwork inside, but the
 * lockup IS the accessible name of the screen's brand identity, so the element
 * carries `role="img"` + an `aria-label` (an i18n key the consumer resolves).
 *
 * Platform-neutral (§9 / R2): no className/style/DOM events. The rendered HEIGHT
 * comes in as a neutral `size` number (the locked 1032:778 aspect is preserved
 * by the component); `aria-label` is the only required field.
 */
export interface LockupProps extends Omit<BaseProps, 'children'> {
  /**
   * Accessible name for the lockup (an i18n KEY the consumer resolves) — the
   * brand identity it stands for. Required: the lockup is a meaningful image.
   */
  'aria-label': string
  /**
   * Rendered height in CSS pixels. The width is derived from the locked 1032:778
   * aspect ratio, so the composition never distorts. Default `128`.
   */
  size?: number
}
