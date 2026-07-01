import type { BaseProps } from './index.ts'

/**
 * The type ROLES a {@link Text} can carry — the brand's machine/prose split at
 * the body altitude. `prose-body` is narrative serif and `subtitle` its italic,
 * muted sub-line (a title's "world · creator"); the `ui-*`, `data`, and `meta`
 * roles are the monospace UI register, with `meta` the quiet muted record line
 * (smaller than `data`, the ink ledger value). Headings live in {@link Heading}.
 * Each role maps to a full static token class string in the web impl.
 */
export type TextRole = 'prose-body' | 'subtitle' | 'ui-label' | 'ui-caption' | 'data' | 'meta'

/**
 * Inline/block text primitive. Applies a typographic ROLE (family + size +
 * weight + tracking) from the token scale; the visual role is decoupled from
 * the semantic element. `as` picks the semantic element from a fixed enum — it
 * is NOT a polymorphic DOM passthrough, so no `className`/`style` leaks.
 */
export interface TextProps extends BaseProps {
  /** Typographic role. Default `prose-body`. */
  role?: TextRole
  /** Semantic element. `span` (inline, default) or `p` (block paragraph). */
  as?: 'span' | 'p'
  /** Truncate to a single line with a trailing ellipsis when the text overflows its container. */
  truncate?: boolean
  /**
   * Hold the text's intrinsic width in a flex row — never shrink below its
   * content (flex-shrink:0), the way Button/Icon do. Use for a short fixed label
   * or value (a wordmark, a credit balance) that must not be squeezed; the
   * flexible sibling (a `truncate` Text) absorbs the row's shrink instead.
   * Without it, a single-token label squeezed below its width spills its box and
   * collides with the next item.
   */
  noShrink?: boolean
}
