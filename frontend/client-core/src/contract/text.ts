import type { BaseProps } from './index.ts'

/**
 * The four type ROLES a {@link Text} can carry — the brand's machine/prose
 * split at the body altitude. `prose-body` is narrative serif; the `ui-*` and
 * `data` roles are the monospace UI register. Headings live in {@link Heading}.
 * Each role maps to a full static token class string in the web impl.
 */
export type TextRole = 'prose-body' | 'ui-label' | 'ui-caption' | 'data'

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
}
