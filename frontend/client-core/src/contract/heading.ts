import type { BaseProps } from './index.ts'

/** The six semantic heading levels — render `h1`..`h6`. */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/**
 * The VISUAL heading roles, decoupled from the semantic level (standard
 * DS practice — a page may want an `h2` that reads at `display` size, or an
 * `h1` at `title` size). Serif family throughout. `headline` is the
 * page-question step between `display` and `heading` — a flow screen's one
 * framing question (ux-run2 myth-aynpf).
 */
export type HeadingRole = 'display' | 'headline' | 'heading' | 'title'

/**
 * Section heading primitive. `level` selects the semantic element (`h1`..`h6`,
 * for document outline + a11y); `role` selects the visual size/weight,
 * independent of the level. Serif. No `className`/`style` — the element is
 * chosen from the fixed `level` enum, not passed through.
 */
export interface HeadingProps extends BaseProps {
  /** Semantic heading level — renders the matching `h1`..`h6`. */
  level: HeadingLevel
  /** Visual role (size/weight). Default `heading`. */
  role?: HeadingRole
}
