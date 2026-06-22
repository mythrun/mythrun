import type { BaseProps } from './index.ts'

/**
 * Badge intent. `neutral` (the default) is the quiet brand chip — `--surface`
 * over a `--border-strong` edge with `--ink` text. The four severities reuse
 * the §4 status-intent triad (a faint `--surface-{intent}` tint with the AA
 * `--text-{intent}` ink), so a badge reads at a glance without leaning on color
 * alone.
 */
export type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

/**
 * A small inline status chip — a count, a state label, a tag. Mono `font-ui`
 * (a badge is data, not prose), flat (`rounded-none`, no shadow — the §3 1-bit
 * register), tight padding. A leaf with no ARIA role: the chip's TEXT carries
 * the meaning, so it announces as its content (color is reinforcement, never the
 * sole signal).
 *
 * Platform-neutral (§9): `children` is the label (i18n content); no
 * className/style/DOM events.
 */
export interface BadgeProps extends BaseProps {
  /** Intent → the token bg/text/border triad. Default `neutral`. */
  variant?: BadgeVariant
  /** The chip label — inherited from {@link BaseProps} as `children`. */
  children?: BaseProps['children']
}
