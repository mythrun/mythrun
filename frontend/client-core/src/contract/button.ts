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
 * `loading` shows a Spinner alongside the (still-visible) label, sets
 * `aria-busy`, and makes the control non-interactive. `disabled` does the same
 * minus the spinner, with token-swap muted styling.
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
  /** Busy state: Spinner + `aria-busy`, label stays visible, non-interactive. */
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
