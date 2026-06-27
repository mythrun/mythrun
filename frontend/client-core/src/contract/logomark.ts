import type { BaseProps } from './index.ts'

/**
 * Logomark color treatment (brand guidelines → "The mark → Mark color variants"):
 *  - `'ink'` — paper-900 ink (theme-driven via the `--ink` token; flips to cream
 *    on the dark field). The default, and the treatment used inside lockups.
 *  - `'ember'` — the `ember-600` brand accent (#8A5A3C). Used when the mark appears
 *    ALONE on a cream field, without a wordmark. Same in both themes (an accent).
 */
export type LogomarkTone = 'ink' | 'ember'

/**
 * The canonical Mythrun MARK — the 64-logical pixel-art logomark (brand guidelines
 * → "The mark"). PIXEL ART: it must scale CRISP (no smooth interpolation), so the
 * impl renders it with `shape-rendering: crispEdges` (the SVG equivalent of
 * nearest-neighbor for the vector pixel grid). Theme-driven via `currentColor`.
 *
 * Platform-neutral (§9 / R2): no className/style/DOM events. The rendered HEIGHT
 * comes in as a neutral `size` number (the mark is square, 1:1). Minimum legible
 * size is 48px (below that the 32 favicon is used — out of this component's scope).
 */
export interface LogomarkProps extends Omit<BaseProps, 'children'> {
  /**
   * Accessible name for the mark (an i18n KEY the consumer resolves). Required:
   * the mark is a meaningful image.
   */
  'aria-label': string
  /** Rendered height in CSS pixels (the mark is square). Default `64`; min `48`. */
  size?: number
  /** Color treatment. Default `'ink'` (theme-driven); `'ember'` for the mark alone. */
  tone?: LogomarkTone
}
