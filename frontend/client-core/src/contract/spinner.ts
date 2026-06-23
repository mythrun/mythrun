import type { BaseProps } from './index.ts'

/**
 * An indeterminate, in-progress indicator. Per the brand's motion rule (§4 —
 * "only opacity/fades animate, nothing spins/slides/bounces"), the web impl is
 * an OPACITY-PULSE, never a rotating spinner. Platform-neutral: a token size +
 * an optional screen-reader label.
 *
 * `children` (inherited from {@link BaseProps}) is unused — a Spinner is a leaf.
 */
export interface SpinnerProps extends BaseProps {
  /**
   * Token size. `xs` is the 12px in-button slot (crisp 1px dither cells), then
   * `sm`/`md`/`lg` step up the icon scale (24/36/48px). Default `md`.
   */
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /**
   * Screen-reader text announced while busy. The consumer supplies an i18n key
   * (real localization happens in the app); the impl provides a sensible
   * fallback (`'Loading'`) so a bare `<Spinner />` is never silent to AT.
   */
  label?: string
}
