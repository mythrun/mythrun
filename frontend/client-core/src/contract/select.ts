import type { BaseProps } from './index.ts'

/** Token control size → `--control-sm/md/lg` (32 / 40 / 48px visual height). */
export type SelectSize = 'sm' | 'md' | 'lg'

/**
 * A single choice in a {@link SelectProps} list. `value` is the stable string
 * the consumer keys on (submitted / compared); `label` is an i18n KEY the
 * consumer resolves to display text.
 */
export interface SelectOption {
  /** Stable value — what `onChange` reports and `value`/`defaultValue` match. */
  value: string
  /** Display text — an i18n key the consumer resolves. */
  label: string
}

/**
 * Single-select dropdown. The web impl wraps the unstyled Radix `Select`
 * primitive (focus management, keyboard nav, ARIA, portalled listbox), styled
 * 100% with our tokens; the native impl swaps `rn-primitives` behind the same
 * contract. Platform-neutral: `onChange` is the neutral value callback (§9 —
 * receives the selected string, never a DOM event), and the surface carries no
 * `className`/`style`/raw DOM events.
 *
 * Controlled when `value` is supplied; uncontrolled with `defaultValue`
 * otherwise (the standard `value`/`defaultValue`/`onChange` shape, §9).
 *
 * `invalid` sets `aria-invalid` on the trigger + the danger-border token (and a
 * danger focus ring). Labelling is {@link FormFieldProps}'s job in real use —
 * the bare Select takes `id`/`name` so a consumer-supplied `<label htmlFor>` can
 * bind it.
 */
export interface SelectProps extends BaseProps {
  /** The choices. `label` is an i18n key; `value` is the stable selected string. */
  options: readonly SelectOption[]
  /** Controlled value. When supplied the Select is controlled. */
  value?: string
  /** Uncontrolled initial value. Ignored when `value` is supplied. */
  defaultValue?: string
  /** Neutral value callback — receives the selected string, not a DOM event (§9). */
  onChange?: (value: string) => void
  /** Placeholder shown when nothing is selected — an i18n key the consumer resolves. */
  placeholder?: string
  /** Token control size. Default `md`. */
  size?: SelectSize
  /** Invalid state: sets `aria-invalid` + the danger border/focus tokens on the trigger. */
  invalid?: boolean
  /** Disabled state: a non-interactive trigger + muted token styling. */
  disabled?: boolean
  /** Form field name (submitted with the form via Radix's hidden input). */
  name?: string
  /** Element id — lets a consumer-supplied `<label htmlFor>` bind to the trigger. */
  id?: string
  /**
   * Ids of the elements that DESCRIBE this control (helper / error text). A
   * portable a11y RELATIONSHIP (web → `aria-describedby` on the trigger, native →
   * `accessibilityDescribedBy` later), not a raw DOM attribute. {@link FormFieldProps}
   * sets this to its helper/error region ids; space-join multiple ids.
   */
  describedBy?: string
}
