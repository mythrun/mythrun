import type { BaseProps } from './index.ts'

/**
 * The checked model — a boolean, or the third `'indeterminate'` state (mixed),
 * mirroring Radix's tri-state model platform-neutrally. Indeterminate is
 * expressed AS a value (`checked: 'indeterminate'`), not a separate flag, so the
 * native impl translates one field.
 */
export type CheckedState = boolean | 'indeterminate'

/**
 * Checkbox. The web impl wraps the unstyled Radix `Checkbox` primitive (keyboard
 * toggle, ARIA `aria-checked`/`mixed`, hidden form input), styled with our
 * tokens; the native impl swaps `rn-primitives` behind the same contract.
 * Platform-neutral: `onChange` is the neutral checked callback (§9 — receives the
 * new {@link CheckedState}, never a DOM event), and the surface carries no
 * `className`/`style`/raw DOM events.
 *
 * Controlled when `checked` is supplied; uncontrolled with `defaultChecked`
 * otherwise (the standard controlled/uncontrolled shape, §9).
 *
 * `invalid` sets `aria-invalid` + the danger-border token. The optional inline
 * `label` is a convenience for simple cases; full field labelling (helper/error/
 * required) is {@link FormFieldProps}'s job.
 */
export interface CheckboxProps extends BaseProps {
  /** Controlled checked state — `true` / `false` / `'indeterminate'`. */
  checked?: CheckedState
  /** Uncontrolled initial checked state. Ignored when `checked` is supplied. */
  defaultChecked?: boolean
  /** Neutral checked callback — receives the new {@link CheckedState}, not a DOM event (§9). */
  onChange?: (checked: CheckedState) => void
  /** Disabled state: a non-interactive control + muted token styling. */
  disabled?: boolean
  /** Invalid state: sets `aria-invalid` + the danger border token. */
  invalid?: boolean
  /** Element id — lets a consumer-supplied `<label htmlFor>` bind to it. */
  id?: string
  /**
   * Ids of the elements that DESCRIBE this control (helper / error text). A
   * portable a11y RELATIONSHIP (web → `aria-describedby`, native →
   * `accessibilityDescribedBy` later), not a raw DOM attribute. {@link FormFieldProps}
   * sets this to its helper/error region ids; space-join multiple ids.
   */
  describedBy?: string
  /** Form field name (submitted with the form via Radix's hidden input). */
  name?: string
  /** Optional inline label (an i18n key). Full labelling is FormField's job. */
  label?: string
}
