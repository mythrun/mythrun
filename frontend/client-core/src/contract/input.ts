import type { BaseProps } from './index.ts'

/** Token control size → `--control-sm/md/lg` (32 / 40 / 48px visual height). */
export type InputSize = 'sm' | 'md' | 'lg'

/** Native input modes the design system supports. `search` gets the native
 * clear affordance; `password` masks; `email` hints the soft keyboard. */
export type InputType = 'text' | 'email' | 'password' | 'search'

/**
 * Single-line text input. Renders a native `<input>` (real form control +
 * a11y) — never a contentEditable div. Platform-neutral: `onChange` is the
 * neutral value callback (§9 — the web impl extracts `e.target.value`; the
 * contract never exposes the DOM `ChangeEvent`), and the surface carries no
 * `className`/`style`/raw DOM events.
 *
 * Controlled when `value` is supplied; uncontrolled with `defaultValue`
 * otherwise (the standard `value`/`defaultValue`/`onChange` shape, §9).
 *
 * `invalid` sets BOTH `aria-invalid` and the danger-border token (and a danger
 * focus ring). Labelling is {@link FormFieldProps}'s job in real use — the bare
 * Input takes `id`/`name` so a consumer-supplied `<label htmlFor>` can bind it.
 */
export interface InputProps extends BaseProps {
  /** Controlled value. When supplied the input is controlled. */
  value?: string
  /** Uncontrolled initial value. Ignored when `value` is supplied. */
  defaultValue?: string
  /** Neutral value callback — receives the new string, not a DOM event (§9). */
  onChange?: (value: string) => void
  /** Placeholder — an i18n key the consumer resolves. */
  placeholder?: string
  /** Native input type. Default `text`. */
  type?: InputType
  /** Form field name (submitted with the form). */
  name?: string
  /** Element id — lets a consumer-supplied `<label htmlFor>` bind to it. */
  id?: string
  /**
   * Ids of the elements that DESCRIBE this control (helper / error text). A
   * portable a11y RELATIONSHIP (web → `aria-describedby`, native →
   * `accessibilityDescribedBy` later), not a raw DOM attribute. {@link FormFieldProps}
   * sets this to its helper/error region ids; space-join multiple ids.
   */
  describedBy?: string
  /** Token control size. Default `md`. */
  size?: InputSize
  /** Invalid state: sets `aria-invalid` + the danger border/focus tokens. */
  invalid?: boolean
  /** Disabled state: the native `disabled` attribute + muted token styling. */
  disabled?: boolean
  /** Read-only state: the native `readOnly` attribute (value visible, not editable). */
  readOnly?: boolean
  /** Marks the field required (native `required` + `aria-required`). */
  required?: boolean
}
