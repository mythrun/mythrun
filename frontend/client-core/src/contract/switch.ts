import type { BaseProps } from './index.ts'

/**
 * Switch — a binary on/off toggle (distinct from Checkbox: a Switch takes effect
 * immediately, a Checkbox stages a form value). The web impl wraps the unstyled
 * Radix `Switch` primitive (keyboard toggle, ARIA `switch`/`aria-checked`, hidden
 * form input), styled with our tokens; the native impl swaps `rn-primitives`
 * behind the same contract. Platform-neutral: `onChange` is the neutral checked
 * callback (§9 — receives the new boolean, never a DOM event), and the surface
 * carries no `className`/`style`/raw DOM events.
 *
 * Controlled when `checked` is supplied; uncontrolled with `defaultChecked`
 * otherwise (the standard controlled/uncontrolled shape, §9).
 *
 * The optional inline `label` is a convenience for simple cases; full field
 * labelling is {@link FormFieldProps}'s job.
 */
export interface SwitchProps extends BaseProps {
  /** Controlled checked state. When supplied the Switch is controlled. */
  checked?: boolean
  /** Uncontrolled initial checked state. Ignored when `checked` is supplied. */
  defaultChecked?: boolean
  /** Neutral checked callback — receives the new boolean, not a DOM event (§9). */
  onChange?: (checked: boolean) => void
  /** Disabled state: a non-interactive control + muted token styling. */
  disabled?: boolean
  /** Element id — lets a consumer-supplied `<label htmlFor>` bind to it. */
  id?: string
  /** Form field name (submitted with the form via Radix's hidden input). */
  name?: string
  /** Optional inline label (an i18n key). Full labelling is FormField's job. */
  label?: string
}
