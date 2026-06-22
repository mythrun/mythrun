import type { BaseProps } from './index.ts'
import type { InputSize } from './input.ts'

/**
 * Multi-line text input. Renders a native `<textarea>` (real form control +
 * a11y). Mirrors {@link InputProps} minus `type`, plus `rows` — same neutral
 * `onChange(value)` (§9), same controlled/uncontrolled shape, same
 * invalid/disabled/read-only/focus behaviour and token styling.
 *
 * `invalid` sets BOTH `aria-invalid` and the danger-border token. Labelling is
 * {@link FormFieldProps}'s job in real use; the bare TextArea takes `id`/`name`
 * so a consumer-supplied `<label htmlFor>` can bind it.
 */
export interface TextAreaProps extends BaseProps {
  /** Controlled value. When supplied the textarea is controlled. */
  value?: string
  /** Uncontrolled initial value. Ignored when `value` is supplied. */
  defaultValue?: string
  /** Neutral value callback — receives the new string, not a DOM event (§9). */
  onChange?: (value: string) => void
  /** Placeholder — an i18n key the consumer resolves. */
  placeholder?: string
  /** Form field name (submitted with the form). */
  name?: string
  /** Element id — lets a consumer-supplied `<label htmlFor>` bind to it. */
  id?: string
  /** Token control size. Default `md` (sets the per-line min-height). */
  size?: InputSize
  /** Visible text rows (native `rows`). Drives the auto-height. */
  rows?: number
  /** Invalid state: sets `aria-invalid` + the danger border/focus tokens. */
  invalid?: boolean
  /** Disabled state: the native `disabled` attribute + muted token styling. */
  disabled?: boolean
  /** Read-only state: the native `readOnly` attribute (value visible, not editable). */
  readOnly?: boolean
  /** Marks the field required (native `required` + `aria-required`). */
  required?: boolean
}
