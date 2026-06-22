import type { BaseProps } from './index.ts'
import type { IconName } from './icon.ts'
import type { ButtonVariant, ButtonSize } from './button.ts'

/**
 * Icon-only action button. Renders a real `<button aria-label={label}>` carrying
 * the accessible name, with a DECORATIVE Icon inside (the button owns the name,
 * not the glyph) — this avoids the #1 icon-button a11y bug, a nameless control.
 *
 * `label` is REQUIRED (an i18n key → the accessible name). The hit-target is
 * ≥44px even at `sm` (icon-only controls have no text to pad the tap area). Same
 * variants / focus ring / state matrix as {@link ButtonProps}. `children`
 * (inherited from {@link BaseProps}) is unused — the glyph is the content.
 */
export interface IconButtonProps extends BaseProps {
  /** Which glyph to render (a closed, typed union — typos are compile errors). */
  icon: IconName
  /** Accessible name (an i18n KEY the consumer supplies). REQUIRED — the button
   * carries this as its name, and the inner Icon is decorative. */
  label: string
  /** Visual emphasis tier. Default `primary`. */
  variant?: ButtonVariant
  /** Token control size. Default `md`. (Hit-target stays ≥44px at every size.) */
  size?: ButtonSize
  /** Busy state: Spinner replaces the icon + `aria-busy`, non-interactive. */
  loading?: boolean
  /** Disabled state: the native `disabled` attribute + muted token styling. */
  disabled?: boolean
  /** Platform-neutral activation callback. Web maps this to `onClick`. */
  onPress?: () => void
}
