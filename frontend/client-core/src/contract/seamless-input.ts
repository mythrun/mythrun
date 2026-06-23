import type { BaseProps } from './index.ts'

/**
 * Borderless "ghost" text input for the calm, one-question-at-a-time creation
 * flow (the Typeform-style conversational form used in Mythrun's world-creation
 * screens). The visible question is the `label` (rendered as a prominent,
 * programmatically-ASSOCIATED `<label htmlFor>` above the field — the persistent
 * WCAG 3.3.2 label); below it the field reads as "just the answer text + a
 * blinking caret", with no visible box.
 *
 * WORKING NAME — `SeamlessInput`. If renamed in review, the name lives in one
 * obvious place: this contract file + the component dir/files that mirror it.
 *
 * Renders a REAL native control (form control + a11y) — never a contentEditable
 * div: a single-line `<input>` by default, a multi-line auto-growing
 * `<textarea>` when `multiline` is set (world-creation prose can be long). The
 * neutral `onChange(value)` (§9 — the web impl pulls `e.target.value`) hands the
 * consumer a plain string, so the contract never leaks the DOM `ChangeEvent`,
 * and the surface carries no `className`/`style`/raw DOM events.
 *
 * Controlled when `value` is supplied; uncontrolled with `defaultValue`
 * otherwise (the standard `value`/`defaultValue`/`onChange` shape, §9).
 *
 * The field auto-associates with its label via an internally-generated `id`
 * (`useId`) when `id` is not supplied, so the question always names the answer
 * for assistive tech with zero consumer wiring.
 */
export interface SeamlessInputProps extends BaseProps {
  /**
   * The question — the visible, persistent, programmatically-associated label
   * above the field (WCAG 3.3.2). Required: it is the field's accessible name
   * and the prompt the flow poses. An i18n key the consumer resolves.
   */
  label: string
  /** Controlled value. When supplied the field is controlled. */
  value?: string
  /** Uncontrolled initial value. Ignored when `value` is supplied. */
  defaultValue?: string
  /** Neutral value callback — receives the new string, not a DOM event (§9). */
  onChange?: (value: string) => void
  /**
   * Placeholder — a FAINT hint only (never the label, §6). An i18n key the
   * consumer resolves.
   */
  placeholder?: string
  /**
   * Multi-line answer: render a native `<textarea>` that auto-grows with its
   * content (long world-creation prose) instead of the single-line `<input>`.
   * Default `false`.
   */
  multiline?: boolean
  /** Form field name (submitted with the form). */
  name?: string
  /**
   * Element id — binds the visible `<label htmlFor>` to the field. Auto-generated
   * via `useId` when omitted, so the association always holds.
   */
  id?: string
  /**
   * Ids of the elements that DESCRIBE this control (helper / error text). A
   * portable a11y RELATIONSHIP (web → `aria-describedby`, native →
   * `accessibilityDescribedBy` later), not a raw DOM attribute. Space-join
   * multiple ids.
   */
  describedBy?: string
  /** Disabled state: the native `disabled` attribute + muted token styling. */
  disabled?: boolean
  /** Marks the field required (native `required` + `aria-required`). */
  required?: boolean
}
