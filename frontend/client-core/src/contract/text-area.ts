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
  /** Native character cap — hard-limits typing AND paste (the chat-composer
   *  server-cap mirror; MYT-102 QA F1). */
  maxLength?: number
  /** Element id — lets a consumer-supplied `<label htmlFor>` bind to it. */
  id?: string
  /**
   * Ids of the elements that DESCRIBE this control (helper / error text). A
   * portable a11y RELATIONSHIP (web → `aria-describedby`, native →
   * `accessibilityDescribedBy` later), not a raw DOM attribute. {@link FormFieldProps}
   * sets this to its helper/error region ids; space-join multiple ids.
   */
  describedBy?: string
  /** Token control size. Default `md` (sets the per-line min-height). */
  size?: InputSize
  /**
   * Type face. `ui` (default) = the mono `font-ui` DATA face (form fields, dev
   * readouts). `prose` = the serif `font-body` USER-AUTHORED-PROSE face with the
   * branded ember caret — the single canonical face a player's own writing wears
   * across the funnel (world/character concept) and the play composer (ux-run1
   * myth-xs9tc). Never mono for player prose; mono there reads as a code field.
   */
  face?: 'ui' | 'prose'
  /** Visible text rows (native `rows`). Drives the auto-height. */
  rows?: number
  /**
   * Auto-grow mode (the chat-composer pattern). When `true` the textarea sizes
   * to its CONTENT — starting at {@link minRows} lines, growing as the user
   * types newlines or long prose wraps, then capping at {@link maxRows} and
   * scrolling. `rows` is IGNORED in favour of `minRows`/`maxRows` (the underlying
   * `field-sizing: content` ignores the `rows` attribute). Default `false`
   * (fixed height from `rows`, the unchanged behaviour). Enter-vs-Shift+Enter is
   * the consumer's keydown concern, not this prop's.
   */
  autoSize?: boolean
  /** Auto-grow floor: minimum visible rows when `autoSize`. Default `1`. */
  minRows?: number
  /** Auto-grow cap: rows shown before the textarea scrolls when `autoSize`. Default `8`. */
  maxRows?: number
  /** Invalid state: sets `aria-invalid` + the danger border/focus tokens. */
  invalid?: boolean
  /** Disabled state: the native `disabled` attribute + muted token styling. */
  disabled?: boolean
  /** Read-only state: the native `readOnly` attribute (value visible, not editable). */
  readOnly?: boolean
  /** Marks the field required (native `required` + `aria-required`). */
  required?: boolean
}
