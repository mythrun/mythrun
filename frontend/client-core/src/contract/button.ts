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
 */
export interface ButtonProps extends BaseProps {
  /** Visual emphasis tier. Default `primary`. */
  variant?: ButtonVariant
  /** Token control size. Default `md`. */
  size?: ButtonSize
  /** Busy state: Spinner + `aria-busy`, label stays visible, non-interactive. */
  loading?: boolean
  /** Disabled state: the native `disabled` attribute + muted token styling. */
  disabled?: boolean
  /** Platform-neutral activation callback. Web maps this to `onClick`. */
  onPress?: () => void
  /** Native button behaviour. Default `button` (does not submit a form). */
  type?: ButtonType
}
