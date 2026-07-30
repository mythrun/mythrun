import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/** Visual emphasis tier. `primary` = the page's main action (accent fill);
 * `secondary` = a bordered neutral action; `ghost` = a low-emphasis text action. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost'

/** Token control size → `--control-sm/md/lg` (32 / 40 / 48px visual height).
 * The interactive hit-target is always ≥44px regardless of visual size (§4). */
export type ButtonSize = 'sm' | 'md' | 'lg'

/** Native button behaviour. `submit` triggers an enclosing form; default `button`
 * never does. (No `reset` — the design system has no use for it.) */
export type ButtonType = 'button' | 'submit'

/**
 * Text/label action button. Renders a real `<button>` (native keyboard +
 * a11y) — never a div-button. Platform-neutral: `onPress` is the activation
 * callback (web maps it to `onClick`), and the surface carries no
 * `className`/`style`/DOM events.
 *
 * `busy` shows a Spinner beside the label (swapped to `busyLabel` when given),
 * sets `aria-busy`, and makes the control non-interactive. `disabled` does the
 * same minus the spinner. Both wear the muted non-interactive treatment — a
 * disabled or busy button NEVER carries the accent fill; the full accent is
 * reserved for an enabled primary, so "clickable" and "accent" stay synonymous
 * (myth-skbzw). `loading` is the legacy alias of `busy`; both keep working.
 *
 * `icon` is a native LEADING-icon slot (the contained-button-with-icon
 * convention): a ~18-20px decorative element rendered before the label with the
 * canonical 8px gap. Use it for provider sign-in marks (Google/Discord) or a
 * leading glyph — never hand-place an icon as a child, which doesn't get the
 * slot's spacing.
 */
export interface ButtonProps extends BaseProps {
  /** Visual emphasis tier. Default `primary`. */
  variant?: ButtonVariant
  /** Token control size. Default `md`. */
  size?: ButtonSize
  /**
   * Leading-icon slot — a ~18-20px element rendered before the label with the
   * canonical 8px gap (the contained-button-with-icon convention). Decorative
   * (the label carries the meaning); supply an already-sized mark/glyph.
   */
  icon?: ReactNode
  /**
   * Trailing-icon slot — the mirror of `icon`, rendered AFTER the label with
   * the same gap. For triggers whose affordance follows the label (the header
   * menu's chevron). Decorative; the label carries the meaning.
   */
  iconTrailing?: ReactNode
  /**
   * Single-line label: no wrap, ellipsis, capped at 16rem. For labels made of
   * unbounded user data (the header menu trigger is the display name — the
   * default grow-taller wrapping would fold the bar). Also opts the control
   * back IN to flex shrink (the base is `shrink-0`; truncate swaps it for
   * `shrink min-w-0`): a truncating label is explicitly the row's designated
   * shrinker, so a too-narrow row ellipsizes the label instead of overflowing.
   * Off by default.
   */
  truncate?: boolean
  /**
   * Bleed the control's own start padding (negative inline-start margin equal
   * to the size's horizontal padding) so its VISIBLE left edge — the glyph or
   * label — sits flush on the content grid. For ghost controls seated on a text
   * column (the funnel's Back affordances): the hit-area padding otherwise
   * indents the glyph ~12-24px off the grid the headings sit on (ux-run3
   * myth-4jbmr). Hit area is unchanged; only the seat shifts.
   */
  flush?: 'start'
  /**
   * Busy state: Spinner + `aria-busy`, non-interactive, muted (no accent fill —
   * the control visibly stands down while the system works, and snaps back to
   * its full treatment when re-enabled). The label stays visible (`busyLabel`
   * replaces it when given, e.g. "Saving" while a form submits).
   */
  busy?: boolean
  /** Label shown in place of `children` while `busy`. Ignored when idle. */
  busyLabel?: string
  /** Legacy alias of `busy` (pre-myth-skbzw call sites). Prefer `busy`. */
  loading?: boolean
  /** Disabled state: the native `disabled` attribute + muted token styling. */
  disabled?: boolean
  /** Platform-neutral activation callback. Web maps this to `onClick`. */
  onPress?: () => void
  /** Native button behaviour. Default `button` (does not submit a form). */
  type?: ButtonType
  /**
   * Disclosure state — for a toggle that shows/hides a region (the WAI-ARIA
   * disclosure pattern). `true` when the controlled region is shown, `false`
   * when hidden; pair with `aria-controls`. Forwarded straight to the control
   * (a native impl maps it to the platform's expanded accessibility state).
   */
  'aria-expanded'?: boolean
  /**
   * The id of the region a disclosure toggle shows/hides — the `aria-controls`
   * half of the pattern, pointing at the controlled content. Pair with
   * `aria-expanded`.
   */
  'aria-controls'?: string
  /**
   * Pressed (toggle) state — for a button that toggles on/off rather than firing
   * a one-shot action (the WAI-ARIA button toggle pattern): `true` when the
   * control is pressed/selected, `false` when released. Use it to surface a
   * selected state to assistive tech for a segmented single-select (e.g.
   * PackList's à-la-carte quantity presets). Forwarded straight to the control
   * (a native impl maps it to the platform's pressed/selected accessibility
   * state).
   */
  'aria-pressed'?: boolean
}
